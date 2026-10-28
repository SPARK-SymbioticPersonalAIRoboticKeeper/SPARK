// Local-only, opt-in route evidence logger. No message text, IDs, credentials or raw packets.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SAFE_MODEL = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_EFFORT = /^(?:none|instant|minimal|min|low|standard|medium|extended|high|xhigh|max|extra_high|ultra|pro)$/i;
const SAFE_STATUS = /^(?:observed|unavailable|awaiting-response|metadata-unavailable|generating|not-reported|conflicting-fields|finished_successfully|in_progress|completed|working|connected|connecting|disconnected|no-react-root|no-active-conversation|query-cache|live-render|partial|unknown|error|idle|active|timeout|failed|success)$/i;
const SAFE_SOURCE = /^(?:(?:assistant\.(?:final|analysis|commentary|assistant)|user)\.metadata|(?:React|DOM|websocket|cdp|response|request)[a-zA-Z0-9_.:-]{0,120})[a-zA-Z0-9_.:-]{0,150}$/;
const OBSERVED_ERRORS = new Set(["MESSAGE_DELIVERY_TIMEOUT", "RESUME_STREAM_UNAVAILABLE", "GENERATION_ERROR", "NETWORK_FAILURE"]);

export function safeChatTitle(value) {
  if (typeof value !== "string") return "Untitled chat";
  const cleaned = value.replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[EMAIL]")
    .replace(/(?:sk-|ghp_|github_pat_|Bearer\s+)[a-z0-9_-]{8,}/gi, "[SECRET]")
    .replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 96);
  return cleaned || "Untitled chat";
}

const safeDate = (value) => {
  if (typeof value !== "string" || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};
const enumValue = (v, matcher = SAFE_STATUS) =>
  typeof v === "string" && matcher.test(v) ? v : null;
const positiveNumber = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e12) : null;
const safeMetadataRows = (rows) => {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 512).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const field = typeof row.field === "string" && /^[a-z][\w.-]{0,90}$/i.test(row.field) ? row.field : null;
    const source = typeof row.source === "string" && row.source.length < 200 &&
      /^(assistant\.(final|analysis|commentary|assistant)\.metadata\.|user\.metadata\.)[\w.-]+$/.test(row.source) ? row.source : null;
    if (!field || !source) return [];
    const type = ["string","number","boolean","null","array","object"].includes(row.type) ? row.type : "unknown";
    const lower = field.toLowerCase();
    const denied = /(?:^|[._-])(?:id|uuid|auth|secret|token|password|content|message|prompt|user|email|session|key|address|text|summary|title|url|ip|cookie|request|trace|file)(?:$|[._-])/i.test(lower);
    let value = "[WITHHELD]";
    if (denied) value = "[REDACTED]";
    else if (type === "boolean" && ["true","false"].includes(String(row.value))) value = String(row.value);
    else if (type === "number" && /^-?\d{1,12}(?:\.\d{1,8})?$/.test(String(row.value))) value = String(row.value);
    else if (type === "null") value = "null";
    else if (type === "string" && /^(?:model_slug|resolved_model_slug|default_model_slug|thinking_effort|resolved_effort|resolved_thinking_effort|resolved_reasoning_effort|cot_version|turn_mode|turn_use_case|warmup_state|message_type|finish_details\.type|reasoning_status|cluster_region|product_experience)$/i.test(field) &&
       /^[a-z0-9._:+-]{1,64}$/i.test(String(row.value))) value = String(row.value);
    return [{field,source,type,value}];
  });
};

export function projectRouteObservation(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const reply = input.response && typeof input.response === "object" ? input.response : {};
  const ui = input.ui && typeof input.ui === "object" ? input.ui : {};
  const lastSend = input.lastSend && typeof input.lastSend === "object" ? input.lastSend : {};
  const network = input.network && typeof input.network === "object" ? input.network : {};
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const errors = Array.isArray(input.uiErrors) ? [...new Set(input.uiErrors.filter(x => OBSERVED_ERRORS.has(x)))].slice(0, 4) : [];
  const responseSource = reply.source && typeof reply.source === "object" ? reply.source : {};
  return {
    observedAt: safeDate(input.observedAt) || new Date().toISOString(),
    chatTitle: safeChatTitle(input.title),
    titleSource: input.titleSource === "active-navigation" ? "active-navigation" :
      input.titleSource === "verified-active-chat" ? "verified-active-chat" :
      input.titleSource === "document-title" ? "document-title" : "unavailable",
    uiErrors: errors,
    uiSend: {
      model: enumValue(lastSend.model, SAFE_MODEL),
      effort: enumValue(lastSend.effort, SAFE_EFFORT),
      observedAt: safeDate(lastSend.at),
      source: lastSend.type === "composer-send-click" || lastSend.type === "composer-enter" ||
        lastSend.type === "composer-submit" ? lastSend.type : "not-observed",
    },
    selected: { model: enumValue(ui.model, SAFE_MODEL), effort: enumValue(ui.effort, SAFE_EFFORT) },
    received: {
      model: enumValue(reply.model, SAFE_MODEL),
      resolvedModel: enumValue(reply.resolvedModel, SAFE_MODEL),
      responseEffort: enumValue(reply.effort, SAFE_EFFORT),
      resolvedEffort: enumValue(reply.resolvedEffort, SAFE_EFFORT),
      resolvedEffortStatus: enumValue(reply.resolvedEffortStatus),
      messageStatus: enumValue(reply.messageStatus),
      observationStatus: enumValue(reply.status),
      createdAt: safeDate(reply.createdAt),
      sourceKind: enumValue(reply.sourceKind, /^(?:live-render|query-cache)$/),
      stale: input.staleResponse === true,
      source: Object.fromEntries(["model","resolvedModel","effort","resolvedEffort"].map(key => [
        key, enumValue(responseSource[key], SAFE_SOURCE),
      ])),
    },
    network: {
      note: "Renderer CDP visibility only; no current-turn wire-level proof",
      events: Array.isArray(network.events) ? network.events.slice(0, 8).map(item => ({
        method: enumValue(item.method, /^(?:POST|GET|WS|WS \(pre-existing\)|PUT|PATCH|DELETE)$/),
        responseStatus: positiveNumber(item.responseStatus),
        chatGeneration: item.chatGeneration === true,
        failure: typeof item.failure === "string" && /^net::ERR_[A-Z0-9_]{1,60}$/.test(item.failure) ?
          item.failure : item.failure ? "NETWORK_FAILURE_REPORTED" : null,
        startedAt: safeDate(item.startedAt), finishedAt: safeDate(item.finishedAt),
        durationMs: positiveNumber(item.durationMs), bytes: positiveNumber(item.bytes),
        streamStatus: enumValue(item.streamStatus, /^(?:not-observed|stream-enabled|stream-unavailable|metadata-streaming|metadata-size-limit)$/),
        canceled: item.canceled === true,
      })) : [],
      state: enumValue(network.state, /^(?:connecting|connected|disconnected|error|idle)$/),
      requests: positiveNumber(network.requests),
      chatRequests: positiveNumber(network.chatRequests),
      failures: positiveNumber(network.failures),
      wsFrames: positiveNumber(network.wsFrames),
      lastEventAt: safeDate(network.lastEventAt),
    },
    metadata: {
      observedFields: positiveNumber(meta.observedFields),
      redactedFields: positiveNumber(meta.redactedFields),
      truncated: meta.truncated === true,
      rows: safeMetadataRows(meta.rows),
    },
  };
}

function fileSlug(title) {
  return safeChatTitle(title).replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[^\p{L}\p{N}_. -]/gu, "_").replace(/\s+/g,"-")
    .replace(/[ .]+$/g,"").slice(0,45) || "Untitled-chat";
}

export class RouteRecorder {
  constructor({logDir, maxBytes = MAX_FILE_BYTES, now = () => new Date()} = {}) {
    if (!logDir || !path.isAbsolute(logDir)) throw new Error("Approved absolute logDir required");
    this.logDir = path.resolve(logDir);
    this.instanceId = randomUUID();
    this.maxBytes = maxBytes;
    this.now = now;
    this.file = null;
    this.filename = null;
    this.startedAt = null;
    this.title = null;
    this.eventsWritten = 0;
    this.bytesWritten = 0;
    this.error = null;
    this.lastFingerprint = null;
    this.lastSnapshotAt = 0;
    this.lastCommandSequence = 0;
  }
  status() {
    return {active: Boolean(this.file),instanceId:this.instanceId,
      file: this.filename,startedAt:this.startedAt,
      eventsWritten:this.eventsWritten,error:this.error,
      lastCommandSequence:this.lastCommandSequence};
  }
  async write(kind, snapshot = null) {
    if (!this.file) return;
    const event = {version:1,event:kind,at:this.now().toISOString(),chatTitle:this.title};
    if (snapshot) event.observation = snapshot;
    const jsonl = JSON.stringify(event) + "\n";
    const size = Buffer.byteLength(jsonl);
    if (this.bytesWritten + size > this.maxBytes) {
      this.error = "LOG_SIZE_LIMIT";
      await this.file.close(); this.file = null;
      return;
    }
    try {
      await this.file.writeFile(jsonl, "utf8");
      this.bytesWritten += size; this.eventsWritten++;
    } catch {
      this.error = "LOG_WRITE_FAILED";
      await this.file.close().catch(() => {}); this.file = null;
    }
  }
  async start(raw) {
    if (this.file) return;
    let location;
    try {location = await lstat(this.logDir);} catch {this.error = "LOG_DIR_NOT_APPROVED";return;}
    if (!location.isDirectory() || location.isSymbolicLink()) {
      this.error = "LOG_DIR_NOT_APPROVED"; return;
    }
    const sample = projectRouteObservation(raw);
    const stamp = this.now().toISOString().replace(/[-:]/g, "");
    this.title = sample.chatTitle;
    this.startedAt = this.now().toISOString();
    this.error = null;
    const name = "route-" + stamp + "-" + fileSlug(this.title) + ".jsonl";
    // Do not overwrite an existing session file or create any directory.
    try { this.file = await open(path.join(this.logDir,name),"wx",0o600); }
    catch (error) {
      this.error = error?.code === "EEXIST" ? "LOG_NAME_COLLISION" : "LOG_OPEN_FAILED";
      return;
    }
    this.filename = name;
    this.bytesWritten = 0; this.eventsWritten = 0;
    this.lastFingerprint = null; this.lastSnapshotAt = 0;
    await this.write("recording-start");
  }
  async stop() {
    if (!this.file) return;
    await this.write("recording-stop");
    if (this.file) { await this.file.close(); this.file = null; }
  }
  async command(cmd, raw) {
    if (!cmd || typeof cmd !== "object" || cmd.instanceId !== this.instanceId ||
        !Number.isSafeInteger(cmd.sequence) || cmd.sequence <= this.lastCommandSequence ||
        !["start","stop"].includes(cmd.action)) return false;
    this.lastCommandSequence = cmd.sequence;
    if (cmd.action === "start") await this.start(raw);
    else await this.stop();
    return true;
  }
  async observe(raw) {
    if (!this.file) return;
    const sample = projectRouteObservation(raw);
    if (sample.chatTitle !== this.title && sample.titleSource !== "unavailable" &&
        sample.chatTitle !== "Untitled chat") {
      await this.stop();
      await this.start(raw);
      if (!this.file) return;
    }
    // Ignore unrelated high-frequency WS counters and clocks for deduplication.
    // Full metadata is written only on evidence changes, not every poll.
    const fingerprint = JSON.stringify({
      title: sample.chatTitle, uiErrors: sample.uiErrors, uiSend: sample.uiSend,
      selected: sample.selected, received: sample.received, metadata: sample.metadata,
      networkState: sample.network.state, networkFailures: sample.network.failures,
      chatRequests: sample.network.chatRequests,
      errorEvents: sample.network.events.filter((event) =>
        event.failure || (event.responseStatus !== null && event.responseStatus >= 400)),
    });
    const now = this.now().getTime();
    if (fingerprint !== this.lastFingerprint) {
      await this.write(sample.uiErrors.length ? "ui-error-observation" : "route-snapshot", sample);
      if (this.file) {this.lastFingerprint = fingerprint;this.lastSnapshotAt = now;}
    } else if (now - this.lastSnapshotAt >= 15_000) {
      await this.write("heartbeat", {
        ...sample, metadata: {...sample.metadata, rows: []},
      });
      if (this.file) this.lastSnapshotAt = now;
    }
  }
  async failure(code = "WATCHER_OBSERVATION_FAILED") {
    if (this.file) await this.write("observer-error", {code:"WATCHER_OBSERVATION_FAILED"});
  }
  async close() { await this.stop(); }
}
