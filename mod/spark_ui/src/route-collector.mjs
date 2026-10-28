import { CdpClient, listTargets } from "./cdp.mjs";
import {
  newRoute, extractRequest, parseEventText, safeHeaders, safeUrl, routeVerdict,
} from "./route-metadata.mjs";

const MAX_RECORDS = 120;
const MAX_EVENT_BYTES = 2_000_000;
const MAX_PENDING_TEXT = 512_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isChatGenerationRequest(url, method, mimeType = "") {
  const path = String(url || "");
  if (!/(?:chatgpt\.com|openai\.com|\/backend-api\/)/i.test(path)) return false;
  return /(?:\/backend-api\/(?:conversation|responses|chat|message)|\/conversation(?:\/|$)|\/responses(?:\/|$)|\/chat\/completions)/i.test(path) &&
    (/^(?:POST|WS)$/i.test(method || "") || /event-stream/i.test(mimeType));
}

export class RouteCollector {
  constructor() {
    this.requests = new Map();
    this.completed = [];
    this.streamBuffers = new Map(); // Ephemeral fragments only; never persisted.
    this.listeners = new Set();
    this.metrics = {
      receivedEvents: 0, requests: 0, chatRequests: 0, failures: 0,
      frames: 0, orphanFrames: 0, sseEvents: 0, streamedResponses: 0,
      lastRequestAt: null, lastChatRequestAt: null, lastNetworkEventAt: null,
    };
    this.capture = {
      state: "connecting", attachedTargets: 0, targetCount: 0,
      lastScanAt: null, lastConnectedAt: null, lastError: null,
      streamSupported: "unknown",
    };
  }
  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(record) { for (const fn of this.listeners) { try { fn(record); } catch {} } }
  ensure(id) {
    if (!this.requests.has(id)) {
      this.requests.set(id, {
        id, url: null, method: null, resourceType: null, startedAt: null,
        observedAt: null, timestampSource: null, startedTimestamp: null,
        responseAt: null, finishedAt: null, wallTimeMs: null,
        responseStatus: null, statusText: null, protocol: null, connectionId: null,
        remoteIPAddress: null, remotePort: null,
        fromDiskCache: null, fromServiceWorker: null, fromPrefetchCache: null,
        mimeType: null, securityState: null, responseHeaders: {},
        requestHeaders: {}, encodedDataLength: 0, decodedDataLength: 0,
        dataChunks: 0, responseBytes: null, failure: null, canceled: null,
        blockedReason: null, corsErrorStatus: null, timing: null,
        chatGeneration: false, streamStatus: "not-observed",
        route: newRoute(), verdict: "UNKNOWN",
        websocket: { framesReceived: 0, framesSent: 0, receivedBytes: 0, sentBytes: 0 },
        evidence: [],
      });
    }
    return this.requests.get(id);
  }
  handle(method, p) {
    this.metrics.receivedEvents++;
    this.metrics.lastNetworkEventAt = new Date().toISOString();
    if (!p?.requestId) return null;
    const r = this.ensure(p.requestId);
    if (!r.observedAt) r.observedAt = this.metrics.lastNetworkEventAt;

    if (method === "Network.requestWillBeSent") {
      if (p.redirectResponse) r.evidence.push("redirect");
      r.url = safeUrl(p.request?.url);
      r.method = p.request?.method ?? null;
      r.resourceType = p.type ?? null;
      r.startedAt = p.wallTime ? new Date(p.wallTime * 1000).toISOString() : this.metrics.lastNetworkEventAt;
      r.timestampSource = p.wallTime ? "Network.requestWillBeSent.wallTime" : "observer-clock";
      r.startedTimestamp = p.timestamp ?? null;
      r.requestHeaders = safeHeaders(p.request?.headers);
      if (typeof p.request?.postData === "string" && p.request.postData.length < MAX_EVENT_BYTES) {
        extractRequest(p.request.postData, r.route);
      }
      r.chatGeneration = isChatGenerationRequest(r.url, r.method);
      r.evidence.push(method);
      this.metrics.requests++;
      this.metrics.lastRequestAt = r.startedAt;
      if (r.chatGeneration) {
        this.metrics.chatRequests++;
        this.metrics.lastChatRequestAt = r.startedAt;
      }
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      r.requestHeaders = { ...r.requestHeaders, ...safeHeaders(p.headers) };
    } else if (method === "Network.responseReceived") {
      const v = p.response ?? {};
      r.responseAt = this.metrics.lastNetworkEventAt;
      r.responseStatus = v.status ?? null; r.statusText = v.statusText ?? null;
      r.protocol = v.protocol ?? null; r.connectionId = v.connectionId ?? null;
      r.remoteIPAddress = v.remoteIPAddress ?? null; r.remotePort = v.remotePort ?? null;
      r.fromDiskCache = v.fromDiskCache ?? null;
      r.fromServiceWorker = v.fromServiceWorker ?? null;
      r.fromPrefetchCache = v.fromPrefetchCache ?? null;
      r.mimeType = v.mimeType ?? null;
      r.securityState = v.securityState ?? null;
      r.responseHeaders = safeHeaders(v.headers);
      r.chatGeneration ||= isChatGenerationRequest(r.url, r.method, r.mimeType);
      r.timing = v.timing ? {
        requestTime: v.timing.requestTime ?? null,
        proxyStart: v.timing.proxyStart ?? null, proxyEnd: v.timing.proxyEnd ?? null,
        dnsStart: v.timing.dnsStart ?? null, dnsEnd: v.timing.dnsEnd ?? null,
        connectStart: v.timing.connectStart ?? null, connectEnd: v.timing.connectEnd ?? null,
        sslStart: v.timing.sslStart ?? null, sslEnd: v.timing.sslEnd ?? null,
        sendStart: v.timing.sendStart ?? null, sendEnd: v.timing.sendEnd ?? null,
        receiveHeadersStart: v.timing.receiveHeadersStart ?? null,
        receiveHeadersEnd: v.timing.receiveHeadersEnd ?? null,
      } : null;
      r.evidence.push(method);
    } else if (method === "Network.responseReceivedExtraInfo") {
      r.responseHeaders = { ...r.responseHeaders, ...safeHeaders(p.headers) };
      if (p.statusCode != null) r.responseStatus = p.statusCode;
    } else if (method === "Network.dataReceived") {
      r.encodedDataLength += p.encodedDataLength || 0;
      r.decodedDataLength += p.dataLength || 0;
      r.dataChunks++;
    } else if (method === "Network.eventSourceMessageReceived") {
      if (typeof p.data === "string" && p.data.length < MAX_EVENT_BYTES) {
        parseEventText(p.data, r.route, "cdp-eventsource");
        this.metrics.sseEvents++;
      }
      r.evidence.push(method);
    } else if (method === "Network.webSocketCreated") {
      r.url = safeUrl(p.url);
      r.method = "WS"; r.resourceType = "WebSocket";
      r.protocol = "websocket"; r.evidence.push(method);
      r.startedAt = this.metrics.lastNetworkEventAt;
      r.timestampSource = "observer-clock";
      r.chatGeneration = false; // A socket is transport, not necessarily a model request.
      this.metrics.requests++;
      this.metrics.lastRequestAt = r.startedAt;
    } else if (method === "Network.webSocketWillSendHandshakeRequest") {
      r.requestHeaders = safeHeaders(p.request?.headers);
    } else if (method === "Network.webSocketHandshakeResponseReceived") {
      r.responseAt = this.metrics.lastNetworkEventAt;
      r.responseStatus = p.response?.status ?? null;
      r.responseHeaders = safeHeaders(p.response?.headers);
    } else if (method === "Network.webSocketFrameReceived" ||
               method === "Network.webSocketFrameSent") {
      const frame = p.response ?? {};
      const received = method.endsWith("Received");
      const frames = received ? "framesReceived" : "framesSent";
      const bytes = received ? "receivedBytes" : "sentBytes";
      r.resourceType ||= "WebSocket";
      r.method ||= "WS (pre-existing)";
      r.protocol ||= "websocket";
      if (!r.startedAt && r.websocket.framesReceived + r.websocket.framesSent === 0) {
        this.metrics.orphanFrames++;
        r.evidence.push("frame-observed-without-handshake");
      }
      r.websocket[frames]++;
      r.websocket[bytes] += typeof frame.payloadData === "string" ?
        (frame.opcode === 2 ? Math.floor(frame.payloadData.length * 0.75)
          : Buffer.byteLength(frame.payloadData, "utf8")) : 0;
      this.metrics.frames++;
      if (typeof frame.payloadData === "string" &&
          frame.payloadData.length < MAX_EVENT_BYTES && frame.opcode !== 2) {
        if (received) parseEventText(frame.payloadData, r.route, "websocket-received");
        else extractRequest(frame.payloadData, r.route, "websocket-sent");
      }
    } else if (method === "Network.webSocketFrameError") {
      r.failure = "WebSocket frame error";
      this.metrics.failures++;
    } else if (method === "Network.webSocketClosed") {
      r.finishedAt = this.metrics.lastNetworkEventAt;
      r.evidence.push(method);
      this.complete(r);
    } else if (method === "Network.loadingFinished") {
      r.finishedAt = this.metrics.lastNetworkEventAt;
      r.responseBytes = p.encodedDataLength ?? r.encodedDataLength;
      if (r.startedTimestamp != null && p.timestamp != null) {
        r.wallTimeMs = Math.round((p.timestamp - r.startedTimestamp) * 1000);
      }
      r.evidence.push(method);
      this.complete(r);
    } else if (method === "Network.loadingFailed") {
      r.finishedAt = this.metrics.lastNetworkEventAt;
      r.failure = p.errorText || "Network.loadingFailed";
      r.canceled = p.canceled ?? false;
      r.blockedReason = p.blockedReason ?? null;
      r.corsErrorStatus = p.corsErrorStatus?.corsError ?? null;
      if (r.startedTimestamp != null && p.timestamp != null) {
        r.wallTimeMs = Math.round((p.timestamp - r.startedTimestamp) * 1000);
      }
      this.metrics.failures++;
      this.complete(r);
    }
    r.verdict = routeVerdict(r.route);
    this.emit(r);
    return r;
  }

  ingestStream(id, textBase64, source = "cdp-stream") {
    const record = this.requests.get(id) ?? this.completed.find((r) => r.id === id);
    if (!record || typeof textBase64 !== "string" || textBase64.length > MAX_EVENT_BYTES * 1.4) return 0;
    let bytes;
    try { bytes = Buffer.from(textBase64, "base64"); }
    catch { return 0; }
    let state = this.streamBuffers.get(id);
    if (!state) {
      state = { decoder: new TextDecoder("utf-8"), pending: "", total: 0 };
      this.streamBuffers.set(id, state);
    }
    state.total += bytes.length;
    if (state.total > MAX_EVENT_BYTES * 4) {
      this.streamBuffers.delete(id);
      record.streamStatus = "metadata-size-limit";
      return 0;
    }
    state.pending += state.decoder.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
    let count = 0;
    for (let at; (at = state.pending.indexOf("\n\n")) >= 0;) {
      const frame = state.pending.slice(0, at);
      state.pending = state.pending.slice(at + 2);
      if (frame.startsWith("data:") || frame.includes("\ndata:")) {
        count += parseEventText(frame + "\n\n", record.route, source);
      }
    }
    if (state.pending.length > MAX_PENDING_TEXT) state.pending = "";
    if (count) {
      this.metrics.sseEvents += count;
      record.streamStatus = "metadata-streaming";
      record.verdict = routeVerdict(record.route);
      this.emit(record);
    }
    return count;
  }
  complete(r) {
    r.verdict = routeVerdict(r.route);
    this.requests.delete(r.id);
    this.streamBuffers.delete(r.id);
    this.completed.unshift(r);
    if (this.completed.length > MAX_RECORDS) this.completed.length = MAX_RECORDS;
  }
  snapshot() {
    const active = [...this.requests.values()].slice(-30);
    const completed = this.completed.slice(0, MAX_RECORDS);
    const records = [...active, ...completed];
    const modelEvidence = records.filter((r) =>
      r.route.requestedModel || r.route.resolvedModel || r.route.serverModel).length;
    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      metrics: { ...this.metrics, modelEvidence },
      capture: { ...this.capture },
      active,
      completed,
    };
  }
}

function streamCandidate(r) {
  return Boolean(r && /(?:text\/event-stream|application\/x-ndjson)/i.test(
    r.mimeType || r.responseHeaders?.["content-type"] || "",
  ) && /(?:chatgpt\.com|openai\.com)/i.test(r.url || ""));
}

export async function attachNetworkMonitor(target, collector = new RouteCollector(), flowObserver = null) {
  const client = new CdpClient(target.webSocketDebuggerUrl, 6000);
  await client.connect();
  const scoped = (id) => target.id + ":" + id;
  client.onEvent = async ({ method, params }) => {
    if (!method?.startsWith("Network.") || !params) return;
    const id = params.requestId && scoped(params.requestId);
    const r = collector.handle(method, id ? { ...params, requestId: id } : params);
    if (!r) return;

    if (method === "Network.requestWillBeSent" &&
        typeof params.request?.postData === "string") {
      flowObserver?.request({
        id, url: params.request.url, method: params.request.method,
        body: params.request.postData, channel: "HTTP", at: r.startedAt,
      });
    }
    if (method === "Network.webSocketFrameSent" &&
        typeof params.response?.payloadData === "string") {
      flowObserver?.request({
        id: id + ":" + (r.websocket?.framesSent || 0), url: r.url,
        method: "WS", body: params.response.payloadData, channel: "WS",
      });
    }
    if (method === "Network.responseReceived") {
      flowObserver?.response({
        id, securityState: params.response?.securityState,
        protocol: params.response?.protocol,
        securityDetails: params.response?.securityDetails,
      });
    }
    if (method === "Network.requestWillBeSent" && params.request?.hasPostData) {
      try {
        const result = await client.send("Network.getRequestPostData",
          { requestId: params.requestId });
        if (typeof result?.postData === "string" && result.postData.length < MAX_EVENT_BYTES) {
          extractRequest(result.postData, r.route);
          flowObserver?.request({
            id, url: params.request.url, method: params.request.method,
            body: result.postData, channel: "HTTP", at: r.startedAt,
          });
          r.verdict = routeVerdict(r.route); collector.emit(r);
        }
      } catch { /* Some bodies are not exposed by CDP. */ }
    }
    if (method === "Network.responseReceived" && streamCandidate(r)) {
      try {
        const result = await client.send("Network.streamResourceContent",
          { requestId: params.requestId });
        collector.capture.streamSupported = "yes";
        r.streamStatus = "stream-enabled";
        if (result.bufferedData) collector.ingestStream(id, result.bufferedData);
      } catch (e) {
        const msg = String(e?.message || "");
        if (/wasn't found|not found|unknown method/i.test(msg)) {
          collector.capture.streamSupported = "no";
        }
        r.streamStatus = "stream-unavailable";
      }
    }
    if (method === "Network.dataReceived" && params.data) {
      collector.ingestStream(id, params.data);
    }
    if (method === "Network.loadingFinished" && r.chatGeneration) {
      try {
        const result = await client.send("Network.getResponseBody",
          { requestId: params.requestId });
        if (typeof result?.body === "string" && result.body.length < MAX_EVENT_BYTES) {
          const body = result.base64Encoded
            ? Buffer.from(result.body, "base64").toString("utf8")
            : result.body;
          parseEventText(body, r.route, "cdp-response-body");
          r.verdict = routeVerdict(r.route); collector.emit(r);
        }
      } catch { /* Streaming bodies may not be available after completion. */ }
    }
  };
  try {
    await client.send("Network.enable", {
      maxTotalBufferSize: 8_000_000, maxResourceBufferSize: 2_000_000,
    });
  } catch (error) { client.close(); throw error; }
  return client;
}

export async function monitorTargets({ host = "127.0.0.1", port, collector, flowObserver = null, isClosed }) {
  const active = new Map();
  try {
    while (!isClosed()) {
      try {
        const targets = await listTargets({ host, port, timeoutMs: 1500 });
        const appTargets = targets.filter((target) =>
          target.url?.startsWith("app://-/index.html") ||
          target.url?.startsWith("app://-/detached-window.html"));
        collector.capture.lastScanAt = new Date().toISOString();
        collector.capture.targetCount = appTargets.length;
        for (const target of appTargets) {
          if (active.has(target.id)) continue;
          try {
            active.set(target.id, await attachNetworkMonitor(target, collector, flowObserver));
            collector.capture.lastConnectedAt = new Date().toISOString();
            collector.capture.lastError = null;
          } catch (error) {
            collector.capture.lastError = "Failed to attach CDP target: " +
              String(error?.message || "").slice(0, 120);
          }
        }
        for (const [id, client] of active) {
          if (!appTargets.some((target) => target.id === id) ||
              client.socket?.readyState !== WebSocket.OPEN) {
            client.close();
            active.delete(id);
          }
        }
        collector.capture.attachedTargets = active.size;
        collector.capture.state = active.size ? "connected" : "disconnected";
      } catch (error) {
        collector.capture.state = "disconnected";
        collector.capture.lastError = "CDP endpoint not available";
        collector.capture.attachedTargets = 0;
      }
      await delay(1500);
    }
  } finally {
    for (const client of active.values()) client.close();
    collector.capture.state = "stopped";
  }
}
