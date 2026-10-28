// The sender guard is self-contained so it can run in a ChatGPT renderer over CDP.
// Production Windows modifies only the recognized native-dispatch request payload;
// authentication forms, saved drafts and the visible composer remain untouched.
export function installCiiGuard(prefixInput, options = {}) {

  const prefixValue = String(prefixInput || "");
  if (!prefixValue.trim()) return "SPARK_CII_EMPTY_CONFIG";
  const allowed = () => {
    if (location.protocol === "file:") return options.fixture === true;
    if (location.protocol === "app:" && location.hostname === "-" &&
        location.pathname === "/index.html") return true;
    if (location.origin !== "https://chatgpt.com") return false;
    return !/^\/(auth|login|verify|oauth|sso|mfa|challenge|account|settings|billing|checkout|security)(\/|$)/i.test(location.pathname);
  };
  if (!allowed()) return "SPARK_CII_ORIGIN_REJECTED";

  const previous = window.__sparkCiiGuard;
  if (previous?.getState?.().enabled === true) {
    if (previous.getState().implementation === "0.0.2" &&
        previous.getState().transportRevision === "native-dispatch-v1" &&
        typeof previous.configure === "function") {
      previous.configure(prefixValue);
      return "SPARK_CII_ALREADY";
    }
    // A v1 guard rewrites the editor. Remove its handlers before installing
    // v2; otherwise the old implementation keeps corrupting user drafts.
    if (typeof previous.disable !== "function") return "SPARK_CII_LEGACY_NOT_REMOVABLE";
    try { previous.disable(); } catch { return "SPARK_CII_LEGACY_DISABLE_FAILED"; }
    if (window.__sparkCiiGuard?.getState?.().enabled === true) {
      return "SPARK_CII_LEGACY_STILL_ACTIVE";
    }
  }

  let prefix = prefixValue;
  let enabled = true;
  // Windows Desktop production uses the mutable shared renderer dispatcher
  // immediately before the frozen Electron preload bridge. Composer/React
  // rewriting stays fixture-only. This mirrors Android: mutate only egress data.
  const legacyFixtureMode = options.fixture === true || location.protocol === "file:" ||
    !!window.__sparkCiiFixtureHost || !!window.__sparkCiiFixtureDispatch ||
    (location.protocol === "app:" && !window.electronBridge);
  const nativeDispatchProduction = location.protocol === "app:" &&
    location.hostname === "-" && location.pathname === "/index.html" &&
    !!window.electronBridge;
  let masked = 0;
  let maskErrors = 0;
  let maskQueued = false;
  const state = { intercepted: 0, forwarded: 0, blocked: 0, status: "READY" };
  let refreshedAt = Date.now();
  let attemptId = 0;
  let traceSeq = 0;
  let traceQueue = [];
  let traceOverflow = 0;
  let earlyForwardedSeen = 0;
  // Volatile, renderer-only; never part of getState/trace/audit/recorder.
  let lastOutboundText = null;
  // Bounded metadata queue. No message text or injected instructions are retained.
  function trace(event, id = 0, reason = "", channel = "") {
    if (traceQueue.length >= 256) { traceQueue.shift(); traceOverflow += 1; }
    traceQueue.push({ seq: ++traceSeq, at: new Date().toISOString(),
      event, attemptId: id, reason, channel });
  }
  const editorSelectors = [
    "#prompt-textarea",
    "#mobile-composer-prompt",
    "textarea[aria-label='Chat with ChatGPT']",
    "[data-testid='prompt-textarea']",
    "div.ProseMirror[contenteditable='true'][role='textbox']",
    "[contenteditable='true'][role='textbox'][aria-label='Ask ChatGPT']"
  ].join(",");
  const sendSelectors = [
    "button[data-testid='send-button']",
    "button[aria-label='Send']",
    "button[aria-label='Send message']",
    "button[aria-label='Send prompt']",
    "button[type='submit']"
  ].join(",");
  const visualMarker = "spark-cii-display-masked";
  const richPrefixMarker = "spark-cii-rich-prefix-hidden";
  const styleId = "spark-cii-display-css";

  function isVisible(element) {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function isSafeForm(form) {
    if (!form || !form.matches("form")) return false;
    if (form.closest("[data-auth],#otp-login-form,[data-testid='login-form']")) return false;
    if (form.querySelector("input[autocomplete='one-time-code'],input[name*='otp' i]")) return false;
    return true;
  }
  function visibleEditors() {
    if (!enabled || !allowed()) return [];
    return Array.from(document.querySelectorAll(editorSelectors)).filter((element) => {
      const form = element.closest("form");
      return isSafeForm(form) && isVisible(element) &&
        (element.tagName === "TEXTAREA" || element.isContentEditable === true ||
          element.getAttribute("contenteditable") === "true");
    });
  }
  function activeEditor() {
    const candidates = visibleEditors();
    // Never guess when two visible composers could submit different messages.
    return candidates.length === 1 ? candidates[0] : null;
  }
  function isSendClick(target, element) {
    if (!target?.closest || !element) return false;
    const button = target.closest("button");
    const form = element.closest("form");
    return !!(button && form && form.contains(button) &&
      (button.form === form || (!button.form && form.contains(button))) &&
      button.matches(sendSelectors) && isVisible(button));
  }
  function clean(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/\r/g, "").replace(/\n+$/g, "");
  }
  function read(element) {
    if (!element) return "";
    if (element.tagName === "TEXTAREA") return clean(element.value);
    if (element.classList?.contains("ProseMirror") && element.children?.length) {
      const blocks = Array.from(element.children);
      if (blocks.every((block) => block.tagName === "P")) {
        return clean(blocks.map((block) => String(block.innerText || "").replace(/\n+$/g, "")).join("\n"));
      }
    }
    return clean(element.innerText);
  }
  // Renderer egress adapters: never write to the composer, focus it, or
  // synthesize a Send event. Only a recognized outbound message payload
  // can receive the prefix. Unknown transports are NOT assumed protected.
  const outgoing = { patched: 0, unsupported: 0, intent: 0, lastChannel: "NONE",
    pendingIntents: [], olderMisses: 0 };
  const originals = [];
  const hooks = { websocket: false, messagePort: false, fetch: false, nativeView: false, nativeDispatch: false };
  const nativeView = { status: "LEGACY_DISABLED", observedUnrecognized: 0 };
  const nativeDispatch = { status: "NOT_DISCOVERED", observedUnrecognized: 0 };

  function prefixed(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    return text.startsWith(prefix + "\n\n") ? text : prefix + "\n\n" + text;
  }
  function transformRpc(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        (!["turn/start", "turn/steer", "turn/addUserMessage",
          "thread/queue/add", "thread/queue/update"].includes(data.method))) return null;
    const inputs = data.params?.input;
    if (!Array.isArray(inputs) || inputs.length !== 1) return null;
    const item = inputs[0];
    if (!item || item.type !== "text" || typeof item.text !== "string" ||
        (Array.isArray(item.text_elements) && item.text_elements.length > 0)) return null;
    const next = prefixed(item.text);
    if (!next) return null;
    if (next === item.text) return { value: data, unchanged: true };
    return { value: {
      ...data,
      params: { ...data.params, input: [{ ...item, text: next }] }
    }, unchanged: false };
  }
  function transformFrame(frame) {
    if (typeof frame !== "string" || frame.length > 2_000_000) return null;
    let value;
    try { value = JSON.parse(frame); } catch { return null; }
    const rpc = transformRpc(value);
    if (!rpc) return null;
    return { value: rpc.unchanged ? frame : JSON.stringify(rpc.value),
      unchanged: rpc.unchanged };
  }
  function transformChatHttp(url, method, body) {
    if (String(method).toUpperCase() !== "POST" ||
        typeof body !== "string" || body.length > 2_000_000) return null;
    let endpoint;
    try { endpoint = new URL(String(url), location.href); } catch { return null; }
    const onChat = endpoint.origin === "https://chatgpt.com" &&
      /^\/backend-api\/(?:f\/)?conversation\/?$/.test(endpoint.pathname);
    const onLocal = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname);
    if (!onChat && !onLocal) return null;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (onLocal) {
      const rpc = transformRpc(parsed);
      return rpc ? { value: rpc.unchanged ? body : JSON.stringify(rpc.value),
        unchanged: rpc.unchanged } : null;
    }
    if (!Array.isArray(parsed?.messages) || parsed.messages.length !== 1) return null;
    const message = parsed.messages[0];
    const parts = message?.content?.parts;
    if (message?.author?.role !== "user" || !Array.isArray(parts) ||
        parts.length !== 1 || typeof parts[0] !== "string") return null;
    const next = prefixed(parts[0]);
    if (!next) return null;
    if (next === parts[0]) return { value: body, unchanged: true };
    const patched = {
      ...parsed, messages: [{
        ...message, content: { ...message.content, parts: [next] }
      }]
    };
    return { value: JSON.stringify(patched), unchanged: false };
  }
  // The Codex Desktop renderer dispatches view messages through a mutable
  // postMessage adapter immediately before its frozen Electron preload bridge.
  // Recognize only known text-turn shapes; never alter editor state or arbitrary
  // IPC/worker messages.
  function transformViewMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const type = message.type;
    if (type === "mcp-request") {
      const rpc = transformRpc(message.request);
      if (!rpc) return null;
      return { value: rpc.unchanged ? message :
        { ...message, request: rpc.value }, unchanged: rpc.unchanged };
    }
    if (!["start-turn-for-host", "steer-turn-for-host",
        "send-follow-up-message", "start-conversation"].includes(type)) return null;
    for (const key of ["attachments", "files", "images", "audio", "imageInputs",
        "fileAttachments", "attachedFileIds"]) {
      if (Array.isArray(message[key]) && message[key].length > 0) return null;
    }
    if (typeof message.prompt === "string") {
      const content = prefixed(message.prompt);
      if (!content) return null;
      return { value: content === message.prompt ? message :
        { ...message, prompt: content }, unchanged: content === message.prompt };
    }
    const input = message.input;
    if (Array.isArray(input) && input.length === 1 && input[0]?.type === "text" &&
        typeof input[0]?.text === "string") {
      const content = prefixed(input[0].text);
      if (!content) return null;
      return { value: content === input[0].text ? message :
        { ...message, input: [{ ...input[0], text: content }] },
        unchanged: content === input[0].text };
    }
    return null;
  }
  // Actual Desktop app-server path: HQt.enqueueRequest calls the shared
  // renderer dispatcher as dispatchMessage("mcp-request", {request, hostId, ...}).
  // This two-argument signature is distinct from legacy postMessage(payload).
  function transformNativeDispatch(type, payload) {
    if (type !== "mcp-request" || !payload ||
        typeof payload !== "object" || Array.isArray(payload)) return null;
    const changed = transformRpc(payload.request);
    if (!changed) return null;
    return { value: changed.unchanged ? payload :
      { ...payload, request: changed.value }, unchanged: changed.unchanged };
  }
  function runSyntheticEnvelopeCheck() {
    // In-memory only. No send API or user input is touched.
    const originalText = "first line\nsecond line";
    const envelope = {
      type: "mcp-request",
      request: { id: "cii-dry-run", method: "turn/start", params: {
        threadId: "dry-run", input: [{ type: "text", text: originalText }]
      } }
    };
    const before = JSON.stringify(envelope);
    const modified = transformNativeDispatch("mcp-request", {request: envelope.request});
    const expected = prefix + "\n\n" + originalText;
    const copyText = modified?.value?.request?.params?.input?.[0]?.text;
    const second = modified ? transformNativeDispatch("mcp-request", modified.value) : null;
    return !!modified && copyText === expected &&
      envelope.request.params.input[0].text === originalText &&
      JSON.stringify(envelope) === before &&
      modified.value.request.id === envelope.request.id &&
      modified.value.request.params.threadId === envelope.request.params.threadId &&
      second?.unchanged === true &&
      second.value.request.params.input[0].text === expected;
  }
  function outboundPlainText(payload) {
    let value = payload;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return null; }
    }
    if (!value || typeof value !== "object") return null;
    const body = value.request || value;
    const rpc = body?.params?.input?.[0]?.text;
    if (typeof rpc === "string") return rpc;
    const part = body?.messages?.[0]?.content?.parts?.[0];
    if (typeof part === "string") return part;
    if (typeof body.prompt === "string") return body.prompt;
    const input = body.input?.[0]?.text;
    return typeof input === "string" ? input : null;
  }
  function recordPatch(channel, unchanged, deliveredPayload = null) {
    const transmittedText = outboundPlainText(deliveredPayload);
    // One bounded in-memory value for on-screen debugging. Never log/return
    // this from CII getState or from a CDP watcher result.
    if (typeof transmittedText === "string") {
      lastOutboundText = {
        at: new Date().toISOString(), channel, source: "LOCAL_CLIENT_API_CALL",
        ciiMatched: transmittedText.startsWith(prefix + "\n\n"),
        text: transmittedText.slice(0, 100_000),
        fullChars: transmittedText.length,
        truncated: transmittedText.length > 100_000
      };
    }

    const now = Date.now();
    for (let i = outgoing.pendingIntents.length - 1; i >= 0; i--) {
      if (now - outgoing.pendingIntents[i] <= 10000) {
        outgoing.pendingIntents.splice(i, 1);
        break;
      }
    }
    outgoing.patched += 1;
    outgoing.lastChannel = channel;
    state.forwarded += 1; // An outbound API call, NOT server acceptance.
    state.status = "EGRESS_PATCHED_UNCONFIRMED";
    trace("PREFIX_VERIFIED", attemptId || ++attemptId,
      unchanged ? "ALREADY_PRESENT" : "EGRESS_PATCHED", channel);
  }
  function installEgressHooks() {
    try {
      const WS = window.WebSocket;
      if (WS?.prototype && typeof WS.prototype.send === "function") {
        const original = WS.prototype.send;
        const wrapper = function(data) {
          const url = String(this?.url || "");
          let eligible = false;
          try {
            const endpoint = new URL(url);
            eligible = endpoint.protocol === "ws:" || endpoint.protocol === "wss:";
            eligible = eligible && (
              ["127.0.0.1", "localhost", "::1", "[::1]", "chatgpt.com"].includes(endpoint.hostname) ||
              endpoint.hostname.endsWith(".chatgpt.com")
            );
          } catch {}
          const changed = eligible ? transformFrame(data) : null;
          if (changed) {
            const result = original.call(this, changed.value);
            recordPatch("WEBSOCKET", changed.unchanged, changed.value);
            return result;
          }
          return original.apply(this, arguments);
        };
        WS.prototype.send = wrapper;
        if (WS.prototype.send === wrapper) {
          originals.push(() => {
            if (WS.prototype.send === wrapper) WS.prototype.send = original;
          });
          hooks.websocket = true;
        }
      }
    } catch {}
    try {
      const MP = window.MessagePort;
      if (MP?.prototype && typeof MP.prototype.postMessage === "function") {
        const original = MP.prototype.postMessage;
        const wrapper = function(data, ...args) {
          const transformed = typeof data === "string" ? transformFrame(data) :
            data && typeof data === "object" ? transformRpc(data) : null;
          if (transformed) {
            const result = original.call(this, transformed.value, ...args);
            recordPatch("MESSAGE_PORT", transformed.unchanged, transformed.value);
            return result;
          }
          return original.call(this, data, ...args);
        };
        MP.prototype.postMessage = wrapper;
        originals.push(() => {
          if (MP.prototype.postMessage === wrapper) MP.prototype.postMessage = original;
        });
        hooks.messagePort = true;
      }
    } catch {}
    try {
      if (typeof window.fetch === "function") {
        const original = window.fetch;
        const wrapper = async function(input, init) {
          const endpoint = typeof input === "string" ? input : input?.url || String(input);
          const method = init?.method ?? input?.method ?? "GET";
          let body = typeof init?.body === "string" ? init.body : null;
          const InputRequest = window.Request;
          if (body === null && InputRequest && input instanceof InputRequest) {
            try { body = await input.clone().text(); } catch {}
          }
          const changed = transformChatHttp(endpoint, method, body);
          if (!changed) return original.apply(this, arguments);
          if (InputRequest && input instanceof InputRequest) {
            const modifiedRequest = new InputRequest(input, { body: changed.value });
            const { body: ignoredBody, ...rest } = init || {};
            const result = original.call(this, modifiedRequest, Object.keys(rest).length ? rest : undefined);
            recordPatch("FETCH", changed.unchanged, changed.value);
            return result;
          }
          if (typeof init?.body !== "string") return original.apply(this, arguments);
          const result = original.call(this, input, { ...init, body: changed.value });
          recordPatch("FETCH", changed.unchanged, changed.value);
          return result;
        };
        window.fetch = wrapper;
        if (window.fetch === wrapper) {
          originals.push(() => {
            if (window.fetch === wrapper) window.fetch = original;
          });
          hooks.fetch = true;
        }
      }
    } catch {}
  }
  async function installNativeViewHook() {
    // Legacy fixture contract only. Production v5 must not hook the unused
    // postMessage store: that was the false-positive readiness defect in v4.
    if (options.bridgeFixture !== true || !window.__sparkCiiFixtureHost) {
      nativeView.status = "LEGACY_DISABLED";
      return;
    }
    if (!enabled || location.protocol !== "app:") {
      nativeView.status = "NOT_APPLICABLE";
      return;
    }
    try {
      let transport = null;
      if (options.bridgeFixture === true && window.__sparkCiiFixtureHost) {
        transport = window.__sparkCiiFixtureHost;
      } else {
        const entry = Array.from(document.scripts || []).find((script) =>
          /^app:\/\/-\/assets\/index-[0-9a-f]+\.js$/.test(script.src))?.src;
        if (!entry) throw new Error("ENTRY_NOT_FOUND");
        const response = await window.fetch(entry);
        if (!response.ok) throw new Error("ENTRY_FETCH_FAILED");
        const bootstrap = await response.text();
        const shared = [...new Set(Array.from(
          bootstrap.matchAll(/\.\/app-shared-[0-9a-f]+\.js/g), (match) => match[0]
        ))];
        if (shared.length !== 1) throw new Error("SHARED_BUNDLE_AMBIGUOUS");
        const module = await import(new URL(shared[0], entry).href);
        const candidates = Object.entries(module).filter(([, value]) =>
          value && typeof value === "object" &&
          ["postMessage", "getState", "setState"].every((key) =>
            Object.prototype.hasOwnProperty.call(value, key)) &&
          Object.getOwnPropertyDescriptor(value, "postMessage")?.writable === true
        );
        if (candidates.length !== 1) throw new Error("BRIDGE_OBJECT_AMBIGUOUS");
        transport = candidates[0][1];
      }
      if (!enabled || typeof transport?.postMessage !== "function") return;
      const original = transport.postMessage;
      const wrapper = function(message) {
        const transformed = transformViewMessage(message);
        if (transformed) {
          const result = original.call(this, transformed.value);
          nativeView.status = "MATCHED_OUTBOUND";
          recordPatch("NATIVE_VIEW", transformed.unchanged, transformed.value);
          return result;
        }
        if (message && typeof message === "object" &&
            (["start-turn-for-host", "steer-turn-for-host",
              "send-follow-up-message", "start-conversation"].includes(message.type) ||
            (message.type === "mcp-request" &&
              ["turn/start", "turn/steer", "turn/addUserMessage",
                "thread/queue/add", "thread/queue/update"].includes(message.request?.method)))) {
          nativeView.observedUnrecognized += 1;
          nativeView.status = "RECOGNIZED_TYPE_UNKNOWN_SHAPE";
        }
        return original.apply(this, arguments);
      };
      transport.postMessage = wrapper;
      if (transport.postMessage !== wrapper) throw new Error("BRIDGE_NOT_WRITABLE");
      originals.push(() => {
        if (transport.postMessage === wrapper) transport.postMessage = original;
      });
      hooks.nativeView = true;
      nativeView.status = "ARMED_UNVERIFIED";
      if (state.status !== "EGRESS_PATCHED_UNCONFIRMED") {
        state.status = "NATIVE_VIEW_ARMED_UNVERIFIED";
      }
    } catch {
      nativeView.status = "UNAVAILABLE";
      hooks.nativeView = false;
    }
  }
  async function installNativeDispatchHook() {
    if (!enabled || location.protocol !== "app:") {
      nativeDispatch.status = "NOT_APPLICABLE";
      return;
    }
    try {
      let dispatcher;
      if (options.nativeDispatchFixture === true && window.__sparkCiiFixtureDispatch) {
        dispatcher = window.__sparkCiiFixtureDispatch;
      } else {
        const entry = Array.from(document.scripts || []).find((script) =>
          /^app:\/\/-\/assets\/index-[0-9a-f]+\.js$/.test(script.src))?.src;
        if (!entry) throw new Error("ENTRY_NOT_FOUND");
        const response = await window.fetch(entry);
        if (!response.ok) throw new Error("ENTRY_FETCH_FAILED");
        const bootstrap = await response.text();
        const shared = [...new Set(Array.from(
          bootstrap.matchAll(/\.\/app-shared-[0-9a-f]+\.js/g), (match) => match[0]
        ))];
        if (shared.length !== 1) throw new Error("SHARED_BUNDLE_AMBIGUOUS");
        const module = await import(new URL(shared[0], entry).href);
        // The real enqueueRequest callback calls this single exported event
        // dispatcher. A similarly shaped postMessage store is NOT the sender.
        const candidates = Object.entries(module).filter(([, value]) =>
          value && typeof value === "object" &&
          typeof value.dispatchMessage === "function" &&
          ["handlers", "bufferedMessages", "handledBufferedMessages"].every((key) =>
            Object.prototype.hasOwnProperty.call(value, key)) &&
          Object.getOwnPropertyDescriptor(value, "dispatchMessage")?.writable === true
        );
        if (candidates.length !== 1) throw new Error("DISPATCHER_AMBIGUOUS");
        dispatcher = candidates[0][1];
      }
      if (!enabled || typeof dispatcher?.dispatchMessage !== "function") return;
      const original = dispatcher.dispatchMessage;
      const wrapper = function(type, payload, ...args) {
        const changed = transformNativeDispatch(type, payload);
        if (changed) {
          const result = original.call(this, type, changed.value, ...args);
          nativeDispatch.status = "MATCHED_OUTBOUND";
          recordPatch("NATIVE_DISPATCH", changed.unchanged, changed.value);
          return result;
        }
        if (type === "mcp-request" &&
            ["turn/start", "turn/steer", "turn/addUserMessage",
              "thread/queue/add", "thread/queue/update"].includes(payload?.request?.method)) {
          nativeDispatch.observedUnrecognized += 1;
          nativeDispatch.status = "UNRECOGNIZED_CHAT_SHAPE";
        }
        return original.apply(this, arguments);
      };
      dispatcher.dispatchMessage = wrapper;
      if (dispatcher.dispatchMessage !== wrapper) throw new Error("DISPATCHER_NOT_WRITABLE");
      originals.push(() => {
        if (dispatcher.dispatchMessage === wrapper) dispatcher.dispatchMessage = original;
      });
      hooks.nativeDispatch = true;
      nativeDispatch.status = "ARMED_UNVERIFIED";
      if (state.status !== "EGRESS_PATCHED_UNCONFIRMED") {
        state.status = "NATIVE_DISPATCH_ARMED_UNVERIFIED";
      }
    } catch {
      nativeDispatch.status = "UNAVAILABLE";
      hooks.nativeDispatch = false;
    }
  }
  if (legacyFixtureMode) {
    installEgressHooks();
    if (!Object.values(hooks).some(Boolean)) state.status = "EGRESS_TRANSPORT_UNAVAILABLE";
    else state.status = "EGRESS_HOOKS_READY_UNVERIFIED";
  } else if (nativeDispatchProduction) {
    state.status = "NATIVE_DISPATCH_DISCOVERY_PENDING";
  } else {
    state.status = "EGRESS_TRANSPORT_UNAVAILABLE";
  }

  // The current ChatGPT Desktop React form submits controller.getText().
  // The keyboard shortcut emits the same controller's "submit" event.
  // Swap ONLY the text returned during those synchronous submit callbacks.
  // The ProseMirror document, selection, DOM and native event remain untouched.
  const composerSubmit = {
    revision: "react-submit-gettext",
    controller: null, emitter: null, formProps: null, form: null, editor: null,
    originalRead: null, wrappedRead: null, originalEmit: null, wrappedEmit: null,
    originalSubmit: null, wrappedSubmit: null, readMethod: null, mode: null,
    imperativeTarget: null, originalImperative: null, wrappedImperative: null,
    scopeDepth: 0, reportedInScope: false, merged: 0,
    status: "NOT_BOUND", readFromLiveController: false
  };
  function submitInScope(callback) {
    if (composerSubmit.scopeDepth++ === 0) composerSubmit.reportedInScope = false;
    try { return callback(); }
    finally { composerSubmit.scopeDepth--; }
  }
  function markComposerArgument(text) {
    composerSubmit.merged++;
    const now = Date.now();
    const index = outgoing.pendingIntents.findLastIndex(at => now - at >= 0 && now - at <= 10_000);
    if (index >= 0) outgoing.pendingIntents.splice(index, 1);
    const truncated = text.length > 100_000;
    lastOutboundText = {
      at: new Date().toISOString(), channel: "COMPOSER_SUBMIT",
      source: "LOCAL_COMPOSER_SUBMIT_ARGUMENT",
      text: text.slice(0, 100_000), truncated, fullChars: text.length,
      ciiMatched: text.startsWith(prefix + "\n\n")
    };
    outgoing.lastChannel = "COMPOSER_SUBMIT";
    state.status = "COMPOSER_ARGUMENT_PREFIXED_SERVER_UNVERIFIED";
    trace("PREFIX_VERIFIED", attemptId || ++attemptId,
      "COMPOSER_ARGUMENT_ONLY", "COMPOSER_SUBMIT");
  }
  function unbindComposerSubmit() {
    const hook = composerSubmit;
    if (hook.formProps?.onSubmit === hook.wrappedSubmit) {
      hook.formProps.onSubmit = hook.originalSubmit;
    }
    if (hook.imperativeTarget?.submit === hook.wrappedImperative) {
      hook.imperativeTarget.submit = hook.originalImperative;
    }
    if (hook.emitter?.emit === hook.wrappedEmit) {
      hook.emitter.emit = hook.originalEmit;
    }
    if (hook.controller && hook.readMethod &&
        hook.controller[hook.readMethod] === hook.wrappedRead) {
      if (hook.hadOwnRead) hook.controller[hook.readMethod] = hook.originalRead;
      else delete hook.controller[hook.readMethod];
    }
    hook.controller = null;
    hook.emitter = null;
    hook.formProps = null;
    hook.form = null;
    hook.editor = null;
    hook.imperativeTarget = null;
    hook.originalImperative = null;
    hook.wrappedImperative = null;
    hook.readMethod = null;
    hook.mode = null;
    hook.wrappedRead = null;
    hook.wrappedEmit = null;
    hook.wrappedSubmit = null;
    hook.originalRead = null;
    hook.originalEmit = null;
    hook.originalSubmit = null;
    hook.scopeDepth = 0;
    hook.reportedInScope = false;
    hook.readFromLiveController = false;
    hook.status = "NOT_BOUND";
  }
  function findComposerSubmitPath(editor, form) {
    const fiberKey = Object.getOwnPropertyNames(form).find(name =>
      name.startsWith("__reactFiber$"));
    let fiber = fiberKey ? form[fiberKey] : null;
    for (let depth = 0; fiber && depth < 105; depth++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      // Standard ChatGPT composer (normal thread and home composer).
      for (const field of ["composerController", "value"]) {
        const candidate = p?.[field];
        if (candidate?.view?.dom === editor &&
            typeof candidate.getText === "function" &&
            typeof candidate.eventEmitter?.emit === "function") {
          return { controller: candidate, method: "getText",
            mode: "STANDARD", imperative: null };
        }
      }
      // Quick-chat/new-window composer uses an imperative ref with
      // submit() -> controller.getPersistedText(), not standard getText().
      let quickController = null;
      let imperative = null;
      let state = fiber.memoizedState;
      for (let index = 0; state && index < 70; index++, state = state.next) {
        const m = state.memoizedState;
        if (m?.view?.dom === editor &&
            typeof m.getPersistedText === "function" &&
            typeof m.eventEmitter?.emit === "function") {
          quickController = m;
        }
        const candidate = m?.current;
        if (candidate && typeof candidate.submit === "function" &&
            typeof candidate.focus === "function" &&
            typeof candidate.blur === "function") {
          imperative = candidate;
        }
      }
      if (quickController && imperative) {
        return { controller: quickController, method: "getPersistedText",
          mode: "QUICK_CHAT", imperative };
      }
    }
    return null;
  }
  function refreshComposerSubmit() {
    if (!enabled) return false;
    if (!legacyFixtureMode) {
      unbindComposerSubmit();
      composerSubmit.status = "DISABLED_NATIVE_DISPATCH";
      return false;
    }
    if (location.protocol !== "app:" && location.protocol !== "file:") return false;
    const editor = activeEditor();
    const form = editor?.closest("form");
    const propKey = form && Object.getOwnPropertyNames(form).find(name =>
      name.startsWith("__reactProps$"));
    const props = propKey ? form[propKey] : null;
    const found = editor && form ? findComposerSubmitPath(editor, form) : null;
    const controller = found?.controller;
    const emitter = controller?.eventEmitter;
    const mode = found?.mode;
    const readMethod = found?.method;
    const imperative = found?.imperative;
    const handler = props?.onSubmit;
    const handlerSource = typeof handler === "function" ?
      Function.prototype.toString.call(handler) : "";
    const originalKnown = mode === "STANDARD" && handlerSource.includes(".getText(");
    const oldCiiWrapper = mode === "STANDARD" &&
      handlerSource.includes("submitInScope(") &&
      handlerSource.includes("originalSubmit.apply(") &&
      typeof controller?.getText === "function" &&
      Function.prototype.toString.call(controller.getText).includes("originalRead.apply(") &&
      typeof emitter?.emit === "function" &&
      Function.prototype.toString.call(emitter.emit).includes("originalEmit.call(");
    const quickKnown = mode === "QUICK_CHAT" &&
      handlerSource.includes(".submit()") &&
      typeof imperative?.submit === "function" &&
      Function.prototype.toString.call(imperative.submit).includes(".getPersistedText(");
    const recognized = originalKnown || oldCiiWrapper || quickKnown;
    const hook = composerSubmit;
    const alreadyBound = hook.controller === controller &&
      hook.editor === editor && hook.form === form &&
      hook.formProps === props && hook.readMethod === readMethod &&
      hook.mode === mode && hook.imperativeTarget === (imperative || null) &&
      controller?.[readMethod] === hook.wrappedRead &&
      emitter?.emit === hook.wrappedEmit &&
      props?.onSubmit === hook.wrappedSubmit &&
      (!imperative || imperative.submit === hook.wrappedImperative);
    if (alreadyBound) return true;
    unbindComposerSubmit();
    if (!editor) {
      hook.status = "NO_VISIBLE_COMPOSER_STANDBY";
      return false;
    }
    if (!form || !controller || !emitter || !props ||
        !recognized || typeof handler !== "function" ||
        typeof controller[readMethod] !== "function" ||
        typeof emitter.emit !== "function" ||
        !emitter.listeners?.get?.("submit")?.size) {
      hook.status = "REACT_SUBMIT_PATH_UNAVAILABLE";
      return false;
    }
    const readDescriptor = Object.getOwnPropertyDescriptor(controller, readMethod);
    const originalRead = controller[readMethod];
    const originalEmit = emitter.emit;
    const originalSubmit = handler;
    const originalImperative = imperative?.submit || null;
    try {
      hook.controller = controller;
      hook.emitter = emitter;
      hook.formProps = props;
      hook.form = form;
      hook.editor = editor;
      hook.mode = mode;
      hook.readMethod = readMethod;
      hook.imperativeTarget = imperative || null;
      hook.hadOwnRead = !!readDescriptor;
      hook.originalRead = originalRead;
      hook.originalEmit = originalEmit;
      hook.originalSubmit = originalSubmit;
      hook.originalImperative = originalImperative;
      hook.wrappedRead = function(...args) {
        const raw = originalRead.apply(this, args);
        if (!enabled || this !== controller || hook.scopeDepth < 1 ||
            typeof raw !== "string") return raw;
        const merged = prefixed(raw);
        if (merged == null) return raw;
        if (!hook.reportedInScope) {
          hook.reportedInScope = true;
          markComposerArgument(merged);
        }
        return merged;
      };
      hook.wrappedEmit = function(type, ...args) {
        return type === "submit" ?
          submitInScope(() => originalEmit.call(this, type, ...args)) :
          originalEmit.call(this, type, ...args);
      };
      hook.wrappedSubmit = function(...args) {
        return submitInScope(() => originalSubmit.apply(this, args));
      };
      if (imperative) {
        hook.wrappedImperative = function(...args) {
          return submitInScope(() => originalImperative.apply(this, args));
        };
      }
      controller[readMethod] = hook.wrappedRead;
      emitter.emit = hook.wrappedEmit;
      props.onSubmit = hook.wrappedSubmit;
      if (imperative) imperative.submit = hook.wrappedImperative;
      if (controller[readMethod] !== hook.wrappedRead ||
          emitter.emit !== hook.wrappedEmit ||
          props.onSubmit !== hook.wrappedSubmit ||
          (imperative && imperative.submit !== hook.wrappedImperative)) {
        throw new Error("REACT_SUBMIT_HOOK_NOT_WRITABLE");
      }
      hook.readFromLiveController = controller.view.dom === editor;
      hook.status = "SUBMIT_TEXT_READ_BOUND";
      return true;
    } catch {
      unbindComposerSubmit();
      hook.status = "REACT_SUBMIT_HOOK_FAILED";
      return false;
    }
  }

  function recordIntent(channel) {
    const editor = activeEditor();
    if (!editor) return;
    const raw = read(editor);
    if (!raw.trim()) return;
    const now = Date.now();
    // A click often follows an Enter/submit event in the same send operation.
    if (outgoing.lastIntentAt && now - outgoing.lastIntentAt < 250) return;
    outgoing.lastIntentAt = now;
    outgoing.intent += 1;
    outgoing.pendingIntents.push(now);
    if (outgoing.pendingIntents.length > 256) {
      outgoing.pendingIntents.shift();
      outgoing.olderMisses += 1;
    }
    state.intercepted += 1;
    trace("MESSAGE_INTERCEPTED", ++attemptId, "", channel);
  }
  function onClick(event) {
    if (!enabled) return;
    refreshComposerSubmit();
    const editor = activeEditor();
    if (editor && isSendClick(event.target, editor)) recordIntent("CLICK");
  }
  function onKeydown(event) {
    if (!enabled || event.key !== "Enter" || event.shiftKey || event.ctrlKey ||
        event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    refreshComposerSubmit();
    const editor = activeEditor();
    if (editor && (event.target === editor || editor.contains(event.target))) recordIntent("ENTER");
  }
  function onSubmit(event) {
    if (!enabled) return;
    refreshComposerSubmit();
    const editor = activeEditor();
    if (editor && event.target === editor.closest("form")) recordIntent("SUBMIT");
  }

  function installMaskStyle() {
    if (!document.head && !document.body) return;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      "." + visualMarker + "{font-size:0!important;line-height:0!important;}",
      "." + visualMarker + "::after{content:attr(data-spark-cii-visible)!important;",
      "display:block!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;",
      "font-family:inherit!important;font-size:var(--spark-cii-font,16px)!important;",
      "line-height:var(--spark-cii-line,24px)!important;color:var(--spark-cii-color,inherit)!important;}",
      "." + richPrefixMarker + "{display:none!important;}"
    ].join("");
    (document.head || document.body).appendChild(style);
  }
  function maskBubble(element) {
    if (!element?.isConnected || element.isContentEditable ||
        element.closest("[data-message-author-role='assistant'],[data-role='assistant'],form") ||
        element.childElementCount !== 0) return;
    const raw = element.textContent || "";
    if (!raw.startsWith(prefix + "\n\n")) return;
    const visible = raw.slice(prefix.length + 2);
    if (!visible.trim()) return;
    const userRole = !!element.closest("[data-message-author-role='user'],[data-role='user'],.user-turn,[class*='group/user-message']");
    const guest = element.tagName === "P" && element.parentElement?.tagName === "BUTTON";
    if (!userRole && !guest) return;
    try {
      if (!element.classList.contains(visualMarker)) {
        const style = getComputedStyle(element);
        element.style.setProperty("--spark-cii-font", style.fontSize);
        element.style.setProperty("--spark-cii-line", style.lineHeight);
        element.style.setProperty("--spark-cii-color", style.color);
        element.classList.add(visualMarker);
        masked += 1;
        trace("DISPLAY_MASKED");
      }
      if (element.getAttribute("data-spark-cii-visible") !== visible) {
        element.setAttribute("data-spark-cii-visible", visible);
      }
    } catch {
      maskErrors += 1;
    }
  }
  // Rendered user messages can preserve the configured instruction prefix
  // as plain text/BR or as Markdown STRONG/BR. Hide ONLY an exact, standalone
  // prefix paragraph; never edit the text payload or the next user paragraph.
  function maskRichBubble(root) {
    if (!root?.isConnected || root.isContentEditable ||
        !root.classList?.contains("rich-text-user-turn") ||
        !root.closest("[class*='group/user-message'],[data-message-author-role='user'],[data-role='user'],.user-turn") ||
        root.closest("form,[data-message-author-role='assistant'],[data-role='assistant']")) return;
    const lines = prefix.split("\n");
    if (!lines.length || lines.length > 8 ||
        lines.some(line => !line.trim())) return;
    const bold = lines.every(line => /^\*\*[^\n]+\*\*$/.test(line));
    if (!bold && lines.some(line => /^\*\*.*\*\*$/.test(line))) return;
    const expected = bold ? lines.map(line => line.slice(2, -2)) : lines;
    const first = root.firstElementChild;
    if (first?.tagName !== "P" || root.children.length < 2 ||
        !Array.from(root.children).slice(1).some(child =>
          String(child.textContent || "").trim())) return;
    const pieces = Array.from(first.childNodes).filter(node =>
      node.nodeType === 1 || String(node.textContent || "").trim());
    const canonical = value => String(value || "").replace(/\u00a0/g, " ");
    let matches = false;
    // Some renderers preserve line breaks in a single plain text node.
    if (!bold && pieces.length === 1 && pieces[0].nodeType === 3) {
      matches = canonical(pieces[0].textContent).replace(/\r\n?/g, "\n") ===
        expected.join("\n");
    } else if (pieces.length === expected.length * 2 - 1) {
      const prefixParts = pieces.filter((_, index) => index % 2 === 0);
      // Historical bubbles may retain Markdown STRONG markup even after the
      // user changes config_cii to plain text. Require one consistent shape.
      const allText = prefixParts.every(part => part.nodeType === 3);
      const allStrong = prefixParts.every(part => part.tagName === "STRONG");
      matches = (allText || allStrong) && pieces.every((part, index) =>
        index % 2 ? part.tagName === "BR" :
          canonical(part.textContent) === expected[index / 2]
      );
    }
    if (!matches) return;
    if (!first.classList.contains(richPrefixMarker)) {
      first.classList.add(richPrefixMarker);
      masked += 1;
      trace("DISPLAY_MASKED");
    }
  }
  function clearDisplayMasks() {
    document.querySelectorAll("." + visualMarker).forEach(element => {
      element.classList.remove(visualMarker);
      element.removeAttribute("data-spark-cii-visible");
      for (const property of ["--spark-cii-font", "--spark-cii-line", "--spark-cii-color"]) {
        element.style.removeProperty(property);
      }
    });
    document.querySelectorAll("." + richPrefixMarker).forEach(element => {
      element.classList.remove(richPrefixMarker);
    });
  }
  function scanMask() {
    maskQueued = false;
    if (!enabled || !allowed() || !document.body) return;
    refreshComposerSubmit();
    installMaskStyle();
    document.querySelectorAll(
      "button > p,[data-message-author-role='user'] p,[data-role='user'] p,.user-turn p,[class*='group/user-message'] .whitespace-pre-wrap"
    ).forEach(maskBubble);
    document.querySelectorAll(".rich-text-user-turn").forEach(maskRichBubble);
  }
  function scheduleMask() {
    if (maskQueued || !enabled) return;
    maskQueued = true;
    setTimeout(scanMask, 90);
  }

  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("submit", onSubmit, true);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(scanMask) : null;
  if (document.body) {
    observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleMask();
    }, { once: true });
  }
  scanMask();

  window.__sparkCiiGuard = {
    configure(value) {
      refreshedAt = Date.now();
      refreshComposerSubmit();
      const changed = prefix !== String(value);
      prefix = String(value);
      if (changed) {
        lastOutboundText = null;
        clearDisplayMasks();
        scanMask();
      }
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      lastOutboundText = null;
      unbindComposerSubmit();
      observer?.disconnect();
      for (const undo of originals.reverse()) { try { undo(); } catch {} }
      for (const [name, listener] of [["click", onClick], ["keydown", onKeydown], ["submit", onSubmit]]) {
        window.removeEventListener(name, listener, true);
      }
      clearDisplayMasks();
      document.getElementById(styleId)?.remove();
      delete window.__sparkCiiGuard;
    },
    getLastOutboundText() {
      if (!enabled) return null;
      const breakpoint = window.__sparkCiiBreakpointLastOutbound;
      if (breakpoint?.ciiMatched === true) return { ...breakpoint };
      const network = window.__sparkCiiEarly?.getLastOutboundText?.();
      return network ? { ...network } : (lastOutboundText ? { ...lastOutboundText } : null);
    },
    getState() {
      if (enabled) refreshComposerSubmit();
      const early = window.__sparkCiiEarly?.getState?.() ?? null;
      const breakpoint = window.__sparkCiiBreakpointState ?? null;
      if (early && Number(early.forwarded) > earlyForwardedSeen) {
        let count = Number(early.forwarded) - earlyForwardedSeen;
        earlyForwardedSeen = Number(early.forwarded);
        while (count-- > 0 && outgoing.pendingIntents.length) outgoing.pendingIntents.shift();
      }
      const breakpointForwarded = Number(breakpoint?.forwarded) || 0;
      const networkForwarded = breakpointForwarded || Number(early?.forwarded) || 0;
      return {
        implementation: "0.0.2", transportRevision: "native-dispatch-v1",
        composerSubmitRevision: legacyFixtureMode ? "react-submit-gettext" : "disabled-native-dispatch",
        enabled, editorReady: !!activeEditor(),
        composerSubmit: { bound: composerSubmit.status === "SUBMIT_TEXT_READ_BOUND",
          status: composerSubmit.status, merged: composerSubmit.merged,
          mode: composerSubmit.mode,
          imperativeHook: composerSubmit.mode !== "QUICK_CHAT" ||
            composerSubmit.imperativeTarget?.submit === composerSubmit.wrappedImperative,
          formHook: composerSubmit.formProps?.onSubmit === composerSubmit.wrappedSubmit,
          enterHook: composerSubmit.emitter?.emit === composerSubmit.wrappedEmit,
          textReadHook: !!composerSubmit.readMethod &&
            composerSubmit.controller?.[composerSubmit.readMethod] === composerSubmit.wrappedRead,
          controllerMatched: composerSubmit.readFromLiveController },
        intercepted: state.intercepted + (Number(early?.intercepted) || 0),
        forwarded: state.forwarded + networkForwarded,
        blocked: state.blocked + (Number(breakpoint?.blocked) || 0) + (Number(early?.blocked) || 0), masked, maskErrors,
        status: breakpoint?.status ?? early?.status ?? state.status,
        outboundModified: outgoing.patched + networkForwarded,
        egressHooks: { ...hooks, dispatchBreakpoint: breakpoint?.installed === true,
          documentStartNetwork: early?.fetchHookReady === true || early?.bridgeHookReady === true },
        outboundPatchObserved: outgoing.patched > 0 || networkForwarded > 0,
        lastEgressChannel: breakpoint?.lastChannel ??
          (early?.lastChannel && early.lastChannel !== "NONE" ? early.lastChannel : outgoing.lastChannel),
        dispatchBreakpoint: breakpoint ? { ...breakpoint } : null,
        earlyEgress: early ? { ...early } : null,
        nativeViewStatus: nativeView.status, nativeViewUnrecognized: nativeView.observedUnrecognized,
        nativeDispatchStatus: nativeDispatch.status,
        nativeDispatchUnrecognized: nativeDispatch.observedUnrecognized,
        suspectedMissingPrefix: outgoing.olderMisses +
          outgoing.pendingIntents.filter((at) => Date.now() - at >= 2000).length,
        dryRunVerified: runSyntheticEnvelopeCheck(),
        tracePending: traceQueue.length, traceOverflow, refreshedAt
      };
    },
    peekTrace() { return { events: traceQueue.slice(), overflow: traceOverflow }; },
    ackTrace(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) return false;
      traceQueue = traceQueue.filter((item) => item.seq > seq);
      traceOverflow = 0;
      return true;
    }
  };
  refreshComposerSubmit();
  // Production app:// pages use native dispatch only. Fixture pages may also
  // exercise the legacy view adapter, but both share the same immutable payload transform.
  window.__sparkCiiGuard.ready = Promise.all([
    legacyFixtureMode ? installNativeViewHook() : Promise.resolve(),
    (legacyFixtureMode || nativeDispatchProduction) ?
      installNativeDispatchHook() : Promise.resolve(),
  ]);
  return "SPARK_CII_READY";
}

export function buildGuardExpression(prefix, options = {}) {
  if (typeof prefix !== "string" || !prefix.trim()) throw new TypeError("Cii prefix must be nonempty.");
  return "(" + installCiiGuard.toString() + ")(" + JSON.stringify(prefix) + "," +
    JSON.stringify({ fixture: options.fixture === true,
      bridgeFixture: options.bridgeFixture === true,
      nativeDispatchFixture: options.nativeDispatchFixture === true }) + ")";
}

export function buildDisableExpression() {
  return "(()=>{if(!window.__sparkCiiGuard)return 'SPARK_CII_INACTIVE';window.__sparkCiiGuard.disable();return 'SPARK_CII_DISABLED'})()";
}

export function buildStatusExpression() {
  return "(()=>window.__sparkCiiGuard?.getState?.() ?? null)()";
}

export function buildReadyExpression() {
  return "(async()=>{const g=window.__sparkCiiGuard;if(!g)return null;await g.ready;return g.getState?.()??null})()";
}

export function buildTraceExpression() {
  return "(()=>window.__sparkCiiGuard?.peekTrace?.() ?? null)()";
}
export function buildTraceAckExpression(seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("Invalid CII trace sequence");
  return "(()=>window.__sparkCiiGuard?.ackTrace?.(" + seq + ") ?? false)()";
}
