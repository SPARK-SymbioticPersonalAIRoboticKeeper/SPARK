// Content-free, fail-closed UI send gate for CII egress interception.
// It never reads or modifies the user draft or the ProseMirror controller.
export function installEgressGate() {
  const revision = "EGRESS_SEND_GATE_V3";
  const validPage = () =>
    (location.protocol === "app:" && location.hostname === "-" &&
      location.pathname === "/index.html") ||
    (location.origin === "https://chatgpt.com" &&
      !/^\/(auth|login|verify|oauth|sso|mfa|challenge|account|settings|billing|checkout|security)(\/|$)/i.test(location.pathname));
  if (!validPage()) return "SPARK_CII_GATE_WRONG_ORIGIN";
  const previous=window.__sparkCiiGate;
  if(previous?.getState?.().enabled===true){
    if(previous.getState().revision===revision)return "SPARK_CII_GATE_ALREADY";
    previous.disable?.();
    if(window.__sparkCiiGate)return "SPARK_CII_GATE_PREVIOUS_NOT_REMOVABLE";
  }

  let enabled = true;
  let sentIntents = 0;
  let blockedIntents = 0;
  let lastReason = "NOT_OBSERVED";
  let lastChannel = "NONE";
  let lastIntentAt = null;
  const sendSelector = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    'button[type="submit"]'
  ].join(",");
  const editorSelector = [
    "#prompt-textarea",
    "#mobile-composer-prompt",
    "textarea[aria-label='Chat with ChatGPT']",
    "[data-testid='prompt-textarea']",
    "div.ProseMirror[contenteditable='true'][role='textbox']",
    "[contenteditable='true'][role='textbox'][aria-label='Ask ChatGPT']"
  ].join(",");
  function safeForm(form) {
    return !!form?.matches?.("form") &&
      !form.closest("[data-auth],#otp-login-form,[data-testid='login-form']") &&
      !form.querySelector("input[autocomplete='one-time-code'],input[name*='otp' i]");
  }
  function hasComposer(form) {
    return !!form?.querySelector?.(editorSelector);
  }
  function isFresh() {
    const state = globalThis.__sparkCiiBreakpointState;
    const display = window.__sparkCiiDisplayMask?.getState?.();
    return display?.enabled === true &&
      display.version === "CII_DISPLAY_MASK_V1" &&
      state?.implementation === "0.0.2-dispatch-breakpoint" &&
      state.installed === true &&
      state.status !== "ERROR" &&
      Number.isFinite(state.heartbeatAt) &&
      Math.abs(Date.now() - state.heartbeatAt) < 4000;
  }
  function protect(event, channel) {
    if (!enabled) return;
    sentIntents += 1;
    lastChannel = channel;
    lastIntentAt = new Date().toISOString();
    if (isFresh()) { lastReason = "EGRESS_ARMED_UNVERIFIED"; return; }
    blockedIntents += 1;
    lastReason = "BREAKPOINT_NOT_ARMED";
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function onClick(event) {
    if (!enabled) return;
    const button = event.target?.closest?.("button");
    if (!button?.matches?.(sendSelector)) return;
    const form = button.form || button.closest("form");
    if (safeForm(form) && hasComposer(form)) protect(event, "CLICK");
  }
  function onKeydown(event) {
    if (!enabled || event.key !== "Enter" ||
        event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.isComposing || event.keyCode === 229) return;
    const editor = event.target?.closest?.(editorSelector);
    if (editor && safeForm(editor.closest("form")))
      protect(event, "KEYDOWN");
  }
  function onSubmit(event) {
    if (enabled && safeForm(event.target) && hasComposer(event.target))
      protect(event, "SUBMIT");
  }
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("submit", onSubmit, true);
  window.__sparkCiiGate = {
    getState() {
      return {
        stage: "EGRESS_SEND_GATE", revision, enabled,
        armed: isFresh(), blockedIntents, sentIntents,
        lastReason, lastChannel, lastIntentAt
      };
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("submit", onSubmit, true);
      delete window.__sparkCiiGate;
    }
  };
  return previous ? "SPARK_CII_GATE_UPGRADED" : "SPARK_CII_GATE_INSTALLED";
}

export function buildEgressGateExpression() {
  return "(" + installEgressGate.toString() + ")()";
}

export function buildEgressGateDisableExpression() {
  return "(()=>{const g=window.__sparkCiiGate;if(!g)return 'NOT_INSTALLED';" +
    "g.disable();return window.__sparkCiiGate?'DISABLE_FAILED':'DISABLED'})()";
}
