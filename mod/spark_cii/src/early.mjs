// SPARK 0.0.2 CII document-start egress injector.
// Mirrors the proven SPARK_Android design: mutate only the trusted ChatGPT
// conversation request body immediately before network delivery.
export function installCiiEarly(prefixInput, options = {}) {
  const prefixValue = String(prefixInput || "");
  if (!prefixValue.trim()) return "SPARK_CII_EARLY_EMPTY_CONFIG";

  const generation = Number.isSafeInteger(options.generation) ?
    options.generation : 0;
  const disabled = options.disabled === true;
  const currentGeneration = Number(globalThis.__sparkCiiEarlyGeneration) || 0;
  if (generation < currentGeneration) return "SPARK_CII_EARLY_STALE";
  globalThis.__sparkCiiEarlyGeneration = generation;

  const previous = globalThis.__sparkCiiEarly;
  if (disabled) {
    try { previous?.disable?.(); } catch {}
    globalThis.__sparkCiiEarlyDisabledGeneration = generation;
    return "SPARK_CII_EARLY_DISABLED";
  }
  if ((Number(globalThis.__sparkCiiEarlyDisabledGeneration) || 0) > generation) {
    return "SPARK_CII_EARLY_DISABLED_NEWER";
  }
  if (previous?.getState?.().enabled === true &&
      previous.getState().implementation === "0.0.2-network-egress" &&
      typeof previous.configure === "function") {
    previous.configure(prefixValue, generation);
    return "SPARK_CII_EARLY_ALREADY";
  }

  let prefix = prefixValue;
  let enabled = true;
  let underlyingFetch = globalThis.fetch;
  let underlyingBridge = globalThis.__valdiDeviceIntegrity;
  let fetchAccessorInstalled = false;
  let bridgeAccessorInstalled = false;
  let bridgeProxy = null;
  let lastOutboundText = null;
  const startedAt = Date.now();
  const phase = typeof document === "object" &&
    document.readyState === "loading" ? "DOCUMENT_START" : "LATE";
  const state = {
    intercepted: 0,
    forwarded: 0,
    blocked: 0,
    verifiedRewrite: false,
    status: phase === "DOCUMENT_START" ?
      "DOCUMENT_START_INSTALLED" : "LATE_INSTALLED",
    lastEndpoint: "none",
    lastChannel: "NONE",
  };

  function trustedConversation(input, init = null) {
    const raw = typeof input === "string" ? input : input?.url;
    if (!raw) return null;
    let url;
    try {
      const base = location?.protocol === "app:" ?
        "https://chatgpt.com/" : location?.href || "https://chatgpt.com/";
      url = new URL(raw, base);
    } catch { return null; }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" ||
        !(host === "chatgpt.com" || host === "chatgpt-staging.com" ||
          host.endsWith(".chatgpt-staging.com"))) return null;
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (method !== "POST") return null;
    if (url.pathname !== "/backend-api/f/conversation" &&
        url.pathname !== "/backend-api/conversation") return null;
    return url.pathname;
  }

  function userTextSlot(payload) {
    if (!payload || typeof payload !== "object" ||
        !Array.isArray(payload.messages) || payload.messages.length === 0) return null;
    let user = null;
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const candidate = payload.messages[i];
      if (candidate && (candidate.author?.role === "user" ||
          candidate.author === "user" || candidate.role === "user")) {
        user = candidate;
        break;
      }
    }
    const parts = user?.content?.parts;
    if (!Array.isArray(parts)) return null;
    for (let i = 0; i < parts.length; i++) {
      if (typeof parts[i] === "string" && parts[i].trim()) {
        return { get: () => parts[i], set: (value) => { parts[i] = value; } };
      }
      if (parts[i] && typeof parts[i] === "object" &&
          (parts[i].type === "text" || parts[i].type === "input_text") &&
          typeof parts[i].text === "string" && parts[i].text.trim()) {
        return { get: () => parts[i].text,
          set: (value) => { parts[i] = { ...parts[i], text: value }; } };
      }
    }
    return null;
  }

  function prefixed(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    return text.startsWith(prefix + "\n\n") ? text : prefix + "\n\n" + text;
  }

  function rewriteString(body) {
    if (typeof body !== "string") return { status: "UNSUPPORTED_BODY" };
    let payload;
    try { payload = JSON.parse(body); }
    catch { return { status: "INVALID_JSON" }; }
    const slot = userTextSlot(payload);
    if (!slot) return { status: "NO_TEXT_USER_MESSAGE" };
    const original = slot.get();
    const next = prefixed(original);
    if (!next) return { status: "NO_TEXT_USER_MESSAGE" };
    const unchanged = next === original;
    if (!unchanged) slot.set(next);
    const outbound = unchanged ? body : JSON.stringify(payload);
    const actual = unchanged ? original : slot.get();
    return { status: "OK", body: outbound, text: actual, unchanged };
  }

  function recordDelivery(path, channel, result) {
    state.forwarded += 1;
    state.verifiedRewrite = result.text.startsWith(prefix + "\n\n");
    state.lastEndpoint = path;
    state.lastChannel = channel;
    state.status = state.verifiedRewrite ?
      "PREFIX_VERIFIED_BEFORE_NETWORK" : "PREFIX_VERIFY_FAILED";
    lastOutboundText = {
      at: new Date().toISOString(),
      source: "DOCUMENT_START_NETWORK_EGRESS",
      channel,
      ciiMatched: state.verifiedRewrite,
      text: result.text.slice(0, 100000),
      fullChars: result.text.length,
      truncated: result.text.length > 100000,
    };
  }

  function reject(reason) {
    state.blocked += 1;
    state.status = "BLOCKED_" + reason;
    return Promise.reject(new Error("SPARK_CII_BLOCKED_" + reason));
  }

  function guardedFetch(input, init) {
    if (!enabled || typeof underlyingFetch !== "function") {
      return underlyingFetch?.apply(this, arguments);
    }
    const path = trustedConversation(input, init);
    if (!path) return underlyingFetch.apply(this, arguments);
    state.intercepted += 1;
    const context = this;
    const deliver = (body, requestBased, encodeBody = value => value) => {
      const result = rewriteString(body);
      if (result.status === "NO_TEXT_USER_MESSAGE") {
        state.status = "PASS_THROUGH_NO_TEXT_USER_MESSAGE";
        return underlyingFetch.call(context, input, init);
      }
      if (result.status !== "OK" ||
          !result.text.startsWith(prefix + "\n\n")) {
        return reject(result.status);
      }
      try {
        let response;
        if (requestBased) {
          const request = new Request(input, { body: encodeBody(result.body) });
          const rest = init == null ? undefined : { ...init, body: undefined };
          if (rest) delete rest.body;
          response = underlyingFetch.call(context, request, rest);
        } else {
          response = underlyingFetch.call(context, input,
            { ...(init || {}), body: encodeBody(result.body) });
        }
        recordDelivery(path, "FETCH", result);
        return response;
      } catch {
        return reject("REQUEST_REBUILD");
      }
    };
    if (typeof init?.body === "string") return deliver(init.body, false);
    if (decoder && encoder && typeof ArrayBuffer !== "undefined" &&
        init?.body instanceof ArrayBuffer) {
      const raw = decoder.decode(new Uint8Array(init.body));
      return deliver(raw, false, value => {
        const bytes = encoder.encode(value);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      });
    }
    if (decoder && encoder && typeof ArrayBuffer !== "undefined" &&
        ArrayBuffer.isView?.(init?.body)) {
      const view = init.body;
      const raw = decoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return deliver(raw, false, value => encoder.encode(value));
    }
    if (typeof Request !== "undefined" && input instanceof Request &&
        (init == null || init.body == null)) {
      try {
        return input.clone().text().then(
          (body) => deliver(body, true),
          () => reject("REQUEST_BODY_READ"),
        );
      } catch { return reject("REQUEST_CLONE"); }
    }
    return reject("UNSUPPORTED_FETCH_BODY");
  }

  function installFetch() {
    if (typeof underlyingFetch !== "function") return false;
    try {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        enumerable: true,
        get() { return guardedFetch; },
        set(value) {
          if (typeof value === "function" && value !== guardedFetch) {
            underlyingFetch = value;
          }
        },
      });
      fetchAccessorInstalled = globalThis.fetch === guardedFetch;
    } catch {
      try {
        globalThis.fetch = guardedFetch;
        fetchAccessorInstalled = globalThis.fetch === guardedFetch;
      } catch {}
    }
    return fetchAccessorInstalled;
  }

  const decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  function rewriteBridgeRequest(request) {
    if (!request || typeof request !== "object") return null;
    const path = trustedConversation(request.url, { method: request.method });
    if (!path) return null;
    state.intercepted += 1;
    if (!(request.body instanceof Uint8Array) || !decoder || !encoder) {
      return { error: "UNSUPPORTED_BRIDGE_BODY" };
    }
    const result = rewriteString(decoder.decode(request.body));
    if (result.status === "NO_TEXT_USER_MESSAGE") {
      state.status = "PASS_THROUGH_NO_TEXT_USER_MESSAGE";
      return { request, path, passthrough: true };
    }
    if (result.status !== "OK" ||
        !result.text.startsWith(prefix + "\n\n")) {
      return { error: result.status };
    }
    return { request: { ...request, body: encoder.encode(result.body) },
      path, result };
  }

  function wrappedBridge(value) {
    if (!value || typeof value !== "object") return value;
    return new Proxy(value, {
      get(target, property, receiver) {
        if ((property === "request" || property === "stream") &&
            typeof target[property] === "function") {
          return function(requestId, request, ...rest) {
            const changed = rewriteBridgeRequest(request);
            if (!changed) return target[property].call(target, requestId, request, ...rest);
            if (changed.error) return reject(changed.error);
            if (changed.passthrough) {
              return target[property].call(target, requestId, request, ...rest);
            }
            const result = target[property].call(target, requestId, changed.request, ...rest);
            recordDelivery(changed.path,
              property === "stream" ? "OWL_STREAM" : "OWL_REQUEST", changed.result);
            return result;
          };
        }
        const result = Reflect.get(target, property, receiver);
        return typeof result === "function" ? result.bind(target) : result;
      },
    });
  }

  function installBridgeAccessor() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(
        globalThis, "__valdiDeviceIntegrity");
      if (descriptor && descriptor.configurable === false) return false;
      if (underlyingBridge) bridgeProxy = wrappedBridge(underlyingBridge);
      Object.defineProperty(globalThis, "__valdiDeviceIntegrity", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        get() { return bridgeProxy ?? underlyingBridge; },
        set(value) {
          underlyingBridge = value;
          bridgeProxy = wrappedBridge(value);
        },
      });
      bridgeAccessorInstalled = true;
    } catch { bridgeAccessorInstalled = false; }
    return bridgeAccessorInstalled;
  }

  installFetch();
  installBridgeAccessor();
  if (!fetchAccessorInstalled && !bridgeAccessorInstalled) {
    state.status = "NO_EGRESS_HOOK_AVAILABLE";
  }

  globalThis.__sparkCiiEarly = {
    configure(value, nextGeneration = generation) {
      const next = String(value || "");
      if (!next.trim()) return false;
      if (Number.isSafeInteger(nextGeneration) &&
          nextGeneration < (Number(globalThis.__sparkCiiEarlyGeneration) || 0)) {
        return false;
      }
      if (Number.isSafeInteger(nextGeneration)) {
        globalThis.__sparkCiiEarlyGeneration = nextGeneration;
      }
      prefix = next;
      lastOutboundText = null;
      state.verifiedRewrite = false;
      return true;
    },
    disable() {
      enabled = false;
      lastOutboundText = null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
        if (descriptor?.get && globalThis.fetch === guardedFetch) {
          Object.defineProperty(globalThis, "fetch", {
            configurable: true, enumerable: true,
            writable: true, value: underlyingFetch,
          });
        } else if (globalThis.fetch === guardedFetch) {
          globalThis.fetch = underlyingFetch;
        }
      } catch {}
      try {
        const d = Object.getOwnPropertyDescriptor(
          globalThis, "__valdiDeviceIntegrity");
        if (d?.get && d.configurable) {
          Object.defineProperty(globalThis, "__valdiDeviceIntegrity", {
            configurable: true, enumerable: d.enumerable,
            writable: true, value: underlyingBridge,
          });
        }
      } catch {}
      delete globalThis.__sparkCiiEarly;
      return "SPARK_CII_EARLY_DISABLED";
    },
    getState() {
      return {
        implementation: "0.0.2-network-egress",
        enabled,
        phase,
        generation: Number(globalThis.__sparkCiiEarlyGeneration) || generation,
        intercepted: state.intercepted,
        forwarded: state.forwarded,
        blocked: state.blocked,
        status: state.status,
        verifiedRewrite: state.verifiedRewrite,
        lastEndpoint: state.lastEndpoint,
        lastChannel: state.lastChannel,
        fetchHookReady: fetchAccessorInstalled && globalThis.fetch === guardedFetch,
        bridgeHookReady: bridgeAccessorInstalled,
        startedAt,
      };
    },
    getLastOutboundText() {
      return enabled && lastOutboundText ? { ...lastOutboundText } : null;
    },
  };
  return "SPARK_CII_EARLY_READY";
}

export function buildEarlyExpression(prefix, options = {}) {
  if (typeof prefix !== "string" || !prefix.trim()) {
    throw new TypeError("CII prefix must be nonempty.");
  }
  return "(" + installCiiEarly.toString() + ")(" +
    JSON.stringify(prefix) + "," + JSON.stringify(options) + ")";
}

export function buildEarlyStatusExpression() {
  return "(()=>globalThis.__sparkCiiEarly?.getState?.()??null)()";
}

export function buildEarlyOutboundExpression() {
  return "(()=>globalThis.__sparkCiiEarly?.getLastOutboundText?.()??null)()";
}

export function buildEarlyDisableExpression() {
  return "(()=>globalThis.__sparkCiiEarly?.disable?.()??'SPARK_CII_EARLY_NOT_INSTALLED')()";
}
