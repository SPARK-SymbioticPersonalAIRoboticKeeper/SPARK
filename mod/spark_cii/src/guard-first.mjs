// The sender guard is self-contained so it can run in a ChatGPT renderer over CDP.
// It never intercepts network requests, authentication forms, or saved drafts.
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
  if (previous && typeof previous.configure === "function" &&
      previous.getState?.().enabled === true) {
    // Upgrade a running legacy guard without restarting the ChatGPT desktop app.
    // The old guard has no real trace queue; its empty peekTrace was a stub.
    if (previous.getState?.().traceVersion !== 1 ||
        typeof previous.ackTrace !== "function") {
      previous.disable?.();
      if (window.__sparkCiiGuard) return "SPARK_CII_LEGACY_NOT_REMOVABLE";
    } else {
      previous.configure(prefixValue);
      return "SPARK_CII_ALREADY";
    }
  }

  let prefix = prefixValue;
  let enabled = true;
  let busy = false;
  let replaying = false;
  let bypass = false;
  let masked = 0;
  let maskErrors = 0;
  let maskQueued = false;
  const state = { intercepted: 0, forwarded: 0, blocked: 0, status: "READY" };
  // Bounded, content-free per-attempt trace. Read by the watcher over CDP.
  let attemptSequence = 0;
  let traceSequence = 0;
  let traceOverflow = 0;
  let traceQueue = [];
  let lastAttempt = null;
  let lastFailure = null;
  let refreshedAt = Date.now();
  function rememberFailure(attemptId, reason) {
    lastFailure = {attemptId, reason, at: new Date().toISOString()};
  }
  function trace(event, attemptId, reason = "", channel = "") {
    if (traceQueue.length >= 256) {
      traceQueue.shift();
      traceOverflow += 1;
    }
    traceQueue.push({
      seq: ++traceSequence, at: new Date().toISOString(),
      event, attemptId, reason, channel
    });
  }
  function beginAttempt(channel) {
    const id = ++attemptSequence;
    lastAttempt = {
      attemptId: id, channel, at: new Date().toISOString(),
      editor: "NOT_RUN", plan: "NOT_RUN", insert: "NOT_RUN",
      immediate: "NOT_RUN", readback: "NOT_RUN", send: "NOT_RUN",
      result: "PENDING", reason: "NONE"
    };
    trace("SEND_EVENT_SEEN", id, "", channel);
    return id;
  }
  function stage(id, event, field, status, reason = "", channel = "") {
    if (lastAttempt?.attemptId === id) {
      if (field) lastAttempt[field] = status;
      if (reason) lastAttempt.reason = reason;
    }
    trace(event, id, reason, channel);
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
  function activeEditor() {
    if (!enabled || !allowed()) return null;
    const candidates = Array.from(document.querySelectorAll(editorSelectors)).filter((element) => {
      const form = element.closest("form");
      return isSafeForm(form) && isVisible(element) &&
        (element.tagName === "TEXTAREA" || element.isContentEditable === true ||
          element.getAttribute("contenteditable") === "true");
    });
    // Never guess when two visible composers could submit different messages.
    return candidates.length === 1 ? candidates[0] : null;
  }
  function sendButton(element) {
    const form = element?.closest("form");
    return isSafeForm(form) ?
      Array.from(form.querySelectorAll(sendSelectors)).find((button) =>
        button.matches("button") && (button.form === form || (!button.form && form.contains(button))) &&
        isVisible(button)) || null : null;
  }
  function isSendClick(target) {
    if (!target?.closest) return false;
    const button = target.closest("button");
    const form = button?.closest("form");
    return !!(button && isSafeForm(form) &&
      (button.form === form || (!button.form && form.contains(button))) &&
      button.matches(sendSelectors) && isVisible(button));
  }
  function isComposerEnterTarget(target) {
    if (!target) return false;
    return Array.from(document.querySelectorAll(editorSelectors)).some((element) =>
      isVisible(element) && isSafeForm(element.closest("form")) &&
      (target === element || element.contains(target)));
  }
  function clean(text) {
    // Preserve all original line breaks, including intentionally empty lines.
    return String(text || "").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  }
  function read(element) {
    if (!element) return "";
    if (element.tagName === "TEXTAREA") return clean(element.value);
    return "";
  }
  function findProseMirrorController(element) {
    let ancestor = element?.parentElement;
    for (let parents = 0; ancestor && parents < 16; parents += 1, ancestor = ancestor.parentElement) {
      const fiberKey = Object.keys(ancestor).find(key => key.startsWith("__reactFiber$"));
      let fiber = fiberKey && ancestor[fiberKey];
      for (let depth = 0; fiber && depth < 85; depth += 1, fiber = fiber.return) {
        const controller = fiber.memoizedProps?.composerController;
        if (controller?.view?.dom === element &&
            controller.view.state?.doc &&
            typeof controller.getText === "function" &&
            typeof controller.view.dispatch === "function") return controller;
      }
    }
    return null;
  }
  let planFailureReason = "UNSUPPORTED_EDITOR";
  function planProseMirrorInsertion(element) {
    const reject = reason => { planFailureReason = reason; return null; };
    planFailureReason = "PREFIX_PLAN_UNVERIFIED";
    if (!element?.classList?.contains("ProseMirror") ||
        element.querySelector("img,figure,video,audio,[contenteditable='false'],[data-type='attachment']")) {
      return reject("UNSAFE_EDITOR_CONTENT");
    }
    const controller = findProseMirrorController(element);
    const view = controller?.view;
    if (!controller) return reject("CONTROLLER_UNAVAILABLE");
    if (!view || view.isDestroyed || !view.state?.schema?.nodes?.paragraph)
      return reject("PROSEMIRROR_VIEW_UNAVAILABLE");
    const beforeState = view.state;
    const beforeDoc = beforeState.doc;
    // Decline non-text / attachment-bearing documents rather than flattening
    // them into the editor and losing the user's existing structure.
    for (let i = 0; i < beforeDoc.childCount; i += 1) {
      const block = beforeDoc.child(i);
      if (!["paragraph", "ordered_list", "list", "blockquote", "heading", "code_block"].includes(block.type.name))
        return reject("UNSUPPORTED_BLOCK");
      let unsafe = false;
      block.descendants(node => {
        // ProseMirror text nodes are isAtom/isLeaf by definition. They are
        // safe; only non-text atoms (mentions, attachments, etc.) are unsafe.
        if (node.isAtom && !node.isText && node.type.name !== "hard_break") unsafe = true;
        if (node.isLeaf && !node.isText && node.type.name !== "hard_break") unsafe = true;
      });
      if (unsafe) return reject("UNSAFE_INLINE_ATOM");
    }
    if (controller.dictation?.document !== beforeDoc)
      return reject("DICTATION_DOC_MISMATCH");
    const raw = controller.getText(beforeDoc);
    if (typeof raw !== "string" || !raw.trim())
      return reject("EMPTY_DRAFT");
    const full = raw.startsWith(prefix + "\n\n") ? raw : prefix + "\n\n" + raw;
    if (full === raw) return { controller, view, beforeState, beforeDoc,
      afterDoc: beforeDoc, full, already: true, insertedSize: 0 };
    const schema = beforeState.schema;
    const paragraph = value => schema.nodes.paragraph.create(null, value ? schema.text(value) : null);
    const lines = prefix.split("\n");
    if (lines.length > 16 || lines.some(line => !line.trim()))
      return reject("UNSUPPORTED_PREFIX_FORMAT");
    const candidates = [
      [...lines.map(paragraph), paragraph("")],
      [paragraph(prefix)],
      [paragraph(prefix + "\n")],
      [paragraph(prefix + "\n\n")],
    ];
    for (const nodes of candidates) {
      try {
        // Only build the transaction here. No DOM or editor mutation occurs
        // until the outgoing text has been proven byte-for-byte equivalent.
        const tr = beforeState.tr.insert(0, nodes);
        const afterDoc = tr.doc;
        if (afterDoc.childCount !== beforeDoc.childCount + nodes.length) continue;
        let originalPreserved = true;
        for (let i = 0; i < beforeDoc.childCount; i += 1) {
          if (!afterDoc.child(nodes.length + i).eq(beforeDoc.child(i))) {
            originalPreserved = false;
            break;
          }
        }
        if (!originalPreserved || controller.getText(afterDoc) !== full) continue;
        return { controller, view, beforeState, beforeDoc,
          afterDoc, full, transaction: tr, insertedSize: nodes.reduce((sum, node) => sum + node.nodeSize, 0),
          already: false };
      } catch {
        // Try another exact-serialization candidate, never a guessed fallback.
      }
    }
    return reject("PREFIX_SERIALIZATION_MISMATCH");
  }
  function rollbackProseMirror(plan) {
    if (!plan || plan.already || !plan.applied) return true;
    try {
      // Only restore the immutable previous state if nobody has edited the
      // draft since our injection. Never overwrite a subsequent user edit.
      if (!plan.view.state.doc.eq(plan.afterDoc)) return false;
      plan.view.updateState(plan.beforeState);
      return plan.view.state.doc.eq(plan.beforeDoc);
    } catch { return false; }
  }
  function write(element, value) {
    if (!element || element.tagName !== "TEXTAREA" ||
        element.querySelector("img,figure,video,audio,[contenteditable='false'],[data-type='attachment']")) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return read(element) === value;
  }
  function block(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function fail(reason, plan = null, id = lastAttempt?.attemptId ?? 0) {
    const recovered = rollbackProseMirror(plan);
    state.blocked += 1;
    state.status = "BLOCKED_" + reason + (recovered ? "" : "_MANUAL_RECOVERY_REQUIRED");
    const field = /SEND_UNAVAILABLE|CLICK_EXCEPTION/.test(reason) ? "send" :
      /READBACK_MISMATCH/.test(reason) ? "readback" : "insert";
    const failureReason = recovered ? reason : reason + "_MANUAL_RECOVERY_REQUIRED";
    stage(id, "MESSAGE_BLOCKED", field, "FAIL", failureReason);
    rememberFailure(id, failureReason);
    if (lastAttempt?.attemptId === id) lastAttempt.result = "BLOCKED";
    busy = false;
    // Preserve the original user draft on failure. No automatic retries.
    bypass = true;
  }
  function process(event, channel) {
    if (!enabled || replaying) return;
    const id = beginAttempt(channel);
    if (bypass) {
      stage(id, "MESSAGE_BYPASSED", "result", "BYPASSED", "SAFE_BYPASS");
      return;
    }
    const element = activeEditor();
    if (!element) {
      stage(id, "MESSAGE_BYPASSED", "editor", "FAIL", "EDITOR_MISSING_OR_AMBIGUOUS");
      rememberFailure(id, "EDITOR_MISSING_OR_AMBIGUOUS");
      lastAttempt.result = "BYPASSED";
      return; // The native event continues; no guessed injection.
    }
    stage(id, "EDITOR_RESOLVED", "editor", "PASS");
    if (busy) {
      block(event);
      stage(id, "MESSAGE_BLOCKED", "result", "BLOCKED", "BUSY");
      return;
    }
    let plan = null;
    let full = "";
    let already = false;
    if (element.classList?.contains("ProseMirror")) {
      try { plan = planProseMirrorInsertion(element); }
      catch { planFailureReason = "PREFIX_PLAN_EXCEPTION"; plan = null; }
      if (!plan) {
        state.blocked += 1;
        state.status = "BLOCKED_UNSUPPORTED_EDITOR_SAFE_BYPASS";
        bypass = true;
        stage(id, "PREFIX_PLAN_FAILED", "plan", "FAIL", planFailureReason);
        rememberFailure(id, planFailureReason);
        lastAttempt.result = "BYPASSED";
        trace("MESSAGE_BYPASSED", id, planFailureReason, channel);
        return; // Leave the original native event and draft untouched.
      }
      full = plan.full;
      already = plan.already;
    } else {
      const raw = read(element);
      if (!raw.trim()) {
        stage(id, "MESSAGE_BYPASSED", "result", "BYPASSED", "EMPTY_DRAFT");
        return;
      }
      already = raw.startsWith(prefix + "\n\n");
      full = already ? raw : prefix + "\n\n" + raw;
    }
    stage(id, "PREFIX_PLAN_VERIFIED", "plan", "PASS");
    block(event);
    state.intercepted += 1;
    trace("MESSAGE_INTERCEPTED", id, "", channel);
    busy = true;
    if (plan) {
      try {
        if (!already) {
          plan.view.dispatch(plan.transaction);
          plan.applied = true;
        }
        if (!plan.view.state.doc.eq(plan.afterDoc) ||
            plan.controller.getText() !== full) return fail("PROSEMIRROR_WRITE_MISMATCH", plan, id);
      } catch { return fail("PROSEMIRROR_INSERT_EXCEPTION", plan, id); }
    } else if (!already && !write(element, full)) {
      return fail("WRITE_MISMATCH", null, id);
    }
    stage(id, already ? "PREFIX_ALREADY_PRESENT" : "PREFIX_APPLIED",
      "insert", already ? "ALREADY_PRESENT" : "PASS");
    stage(id, "PREFIX_VERIFIED", "immediate", "PASS", "EDITOR_READBACK");
    state.status = "VERIFYING";
    setTimeout(() => {
      if (!enabled) return fail("DISABLED", plan, id);
      const exact = plan ?
        plan.view.state.doc.eq(plan.afterDoc) && plan.controller.getText() === full :
        read(element) === full;
      if (!exact) return fail("READBACK_MISMATCH", plan, id);
      stage(id, "PREFIX_READBACK_VERIFIED", "readback", "PASS", "DELAYED_READBACK");
      const button = sendButton(element);
      if (!button || button.disabled) return fail("SEND_UNAVAILABLE", plan, id);
      stage(id, "SEND_BUTTON_READY", "send", "READY");
      try {
        replaying = true;
        button.click();
        state.forwarded += 1;
        state.status = "FORWARDED";
        stage(id, "MESSAGE_REPLAYED_UNCONFIRMED", "send", "CLICK_CALLED",
          "NETWORK_NOT_OBSERVED");
        if (lastAttempt?.attemptId === id) lastAttempt.result = "LOCAL_SEND_ONLY";
      } catch { fail("CLICK_EXCEPTION", plan, id); }
      finally {
        replaying = false;
        busy = false;
      }
    }, 140);
  }
  function onClick(event) {
    if (enabled && !replaying && isSendClick(event.target)) process(event, "CLICK");
  }
  function onKeydown(event) {
    if (!enabled || replaying || event.key !== "Enter" ||
        event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.isComposing || event.keyCode === 229) return;
    if (isComposerEnterTarget(event.target)) process(event, "KEYDOWN");
  }
  function onSubmit(event) {
    if (!enabled || replaying) return;
    const element = activeEditor();
    const form = event.target;
    if (element?.closest("form") === form ||
        (isSafeForm(form) && form.querySelector?.(editorSelectors))) {
      process(event, "SUBMIT");
    }
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
      "line-height:var(--spark-cii-line,24px)!important;color:var(--spark-cii-color,inherit)!important;}"
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
      }
      if (element.getAttribute("data-spark-cii-visible") !== visible) {
        element.setAttribute("data-spark-cii-visible", visible);
      }
    } catch {
      maskErrors += 1;
    }
  }
  function scanMask() {
    maskQueued = false;
    if (!enabled || !allowed() || !document.body) return;
    installMaskStyle();
    document.querySelectorAll(
      "button > p,[data-message-author-role='user'] p,[data-role='user'] p,.user-turn p,[class*='group/user-message'] .whitespace-pre-wrap"
    ).forEach(maskBubble);
  }
  function scheduleMask() {
    if (maskQueued || !enabled) return;
    maskQueued = true;
    setTimeout(scanMask, 90);
  }

  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("submit", onSubmit, true);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(scheduleMask) : null;
  if (document.body) {
    observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleMask();
    }, { once: true });
  }
  scheduleMask();

  window.__sparkCiiGuard = {
    configure(value) {
      const changed = prefix !== String(value);
      prefix = String(value);
      refreshedAt = Date.now();
      if (changed) scheduleMask();
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      observer?.disconnect();
      for (const [name, listener] of [["click", onClick], ["keydown", onKeydown], ["submit", onSubmit]]) {
        window.removeEventListener(name, listener, true);
      }
      document.querySelectorAll("." + visualMarker).forEach((element) => {
        element.classList.remove(visualMarker);
        element.removeAttribute("data-spark-cii-visible");
        for (const property of ["--spark-cii-font", "--spark-cii-line", "--spark-cii-color"]) {
          element.style.removeProperty(property);
        }
      });
      document.getElementById(styleId)?.remove();
      delete window.__sparkCiiGuard;
    },
    peekTrace() {
      return {events: traceQueue.map(item => ({...item})), overflow: traceOverflow};
    },
    ackTrace(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) return false;
      traceQueue = traceQueue.filter(item => item.seq > seq);
      traceOverflow = 0;
      return true;
    },
    getState() {
      return {
        implementation: "0.0.2", stage: "ORIGINAL_EDITOR_INSERT", sourceCommit: "32530ad",
        traceVersion: 1, refreshedAt,
        enabled, editorReady: !!activeEditor(), safeBypass: bypass,
        intercepted: state.intercepted, forwarded: state.forwarded,
        blocked: state.blocked, masked, maskErrors, status: state.status,
        tracePending: traceQueue.length, traceOverflow,
        lastAttempt: lastAttempt ? {...lastAttempt} : null,
        lastFailure: lastFailure ? {...lastFailure} : null
      };
    }
  };
  return "SPARK_CII_READY";
}

export function buildGuardExpression(prefix, options = {}) {
  if (typeof prefix !== "string" || !prefix.trim()) throw new TypeError("Cii prefix must be nonempty.");
  return "(" + installCiiGuard.toString() + ")(" + JSON.stringify(prefix) + "," +
    JSON.stringify({ fixture: options.fixture === true }) + ")";
}

export function buildDisableExpression() {
  return "(()=>{if(!window.__sparkCiiGuard)return 'SPARK_CII_INACTIVE';window.__sparkCiiGuard.disable();return 'SPARK_CII_DISABLED'})()";
}

export function buildStatusExpression() {
  return "(()=>window.__sparkCiiGuard?.getState?.() ?? null)()";
}
