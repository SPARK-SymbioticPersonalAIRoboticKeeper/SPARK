// Read-only selected model/effort from the mounted desktop ChatGPT React composer.
// The shell may send chat turns through native Electron IPC rather than renderer
// Network events. This is UI-selection evidence, NOT request/server proof.
// Modeled after public CDP/Fiber readers; no prompts, cookies or chat contents.

export function extractSelectedModelFromFiber(fiber, effortAttribute = null) {
  const slug = (value) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value) ?
      value : null;
  const effort = (value) =>
    typeof value === "string" &&
    /^(?:none|instant|minimal|min|low|standard|medium|extended|high|xhigh|max|ultra|pro)$/i.test(value) ?
      value.toLowerCase() : null;
  const label = (value) =>
    typeof value === "string" &&
    value.length > 0 && value.length <= 80 &&
    /^[\p{L}\p{N} .+_-]+$/u.test(value) ? value.trim() : null;

  let selected = null;
  let power = null;
  for (let current = fiber, depth = 0; current && depth < 65; current = current.return, depth++) {
    // Only inspect explicitly named model-selection props. Never inspect
    // React state or chat message payloads.
    const p = current.memoizedProps;
    if (!p || typeof p !== "object") continue;
    const choice = p.selectedModel;
    if (choice && typeof choice === "object" && slug(choice.slug)) {
      const entry = {
        model: slug(choice.slug),
        effort: effort(choice.thinkingEffort),
        version: slug(choice.versionId),
      };
      if (selected && (selected.model !== entry.model || selected.effort !== entry.effort)) {
        return { status: "conflict", model: null, effort: null };
      }
      selected = entry;
    }
    const lane = p.selectedPowerSelection;
    if (lane && typeof lane === "object" && slug(lane.model)) {
      const entry = {
        model: slug(lane.model),
        effort: effort(lane.reasoningEffort),
        displayModel: label(lane.modelLabel),
        displayEffort: label(lane.sliderLabel) || label(lane.labels?.effort),
        laneId: slug(lane.id),
        isMaximum: lane.isMaximum === true,
      };
      if (power && (power.model !== entry.model || power.effort !== entry.effort)) {
        return { status: "conflict", model: null, effort: null };
      }
      power = entry;
    }
  }

  if (selected && power && (selected.model !== power.model ||
      (selected.effort && power.effort && selected.effort !== power.effort))) {
    return { status: "conflict", model: null, effort: null };
  }

  const nativeEffort = effort(effortAttribute);
  const model = selected?.model || power?.model || null;
  const value = selected?.effort || power?.effort || nativeEffort;
  if (nativeEffort && value && nativeEffort !== value) {
    return { status: "conflict", model: null, effort: null };
  }

  return {
    status: model && value ? "observed" : "partial",
    model, effort: value,
    displayModel: power?.displayModel || null,
    displayEffort: power?.displayEffort || null,
    version: selected?.version || null,
    isMaximumSelection: power ? power.isMaximum : null,
    evidence: {
      model: selected?.model ?
        "React.memoizedProps.selectedModel.slug" :
        power?.model ? "React.memoizedProps.selectedPowerSelection.model" : null,
      effort: selected?.effort ?
        "React.memoizedProps.selectedModel.thinkingEffort" :
        power?.effort ? "React.memoizedProps.selectedPowerSelection.reasoningEffort" :
          nativeEffort ? "DOM.data-selected-reasoning-effort" : null,
    },
  };
}

export function readUiSelectionFromDom(parseFiber) {
  const buttons = Array.from(document.querySelectorAll(
    'button[aria-label="Select ChatGPT model"]',
  )).filter((button) => {
    const r = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return r.width > 0 && r.height > 0 &&
      r.top >= 0 && r.bottom <= window.innerHeight &&
      style.display !== "none" && style.visibility !== "hidden";
  });
  if (buttons.length !== 1) {
    return { status: buttons.length > 1 ? "ambiguous" : "unavailable", model: null, effort: null };
  }
  const button = buttons[0];
  // React private props are observed, not modified. The selector itself is
  // version-sensitive: return unavailable if a future release changes it.
  const key = Object.getOwnPropertyNames(button).find((name) =>
    name.startsWith("__reactFiber$"));
  if (!key) return { status: "no-react-fiber", model: null, effort: null };
  return parseFiber(button[key], button.getAttribute("data-selected-reasoning-effort"));
}

export function ensureUiSubmissionObserver(readSelection, parseFiber) {
  // Renderer-only volatile user text. Never return it from the CDP monitor
  // or forward it to RouteRecorder/metadata/audit files.
  const k = "__sparkRouteUiSelectionObserver_0_0_2";
  if (window[k]?.version === "0.0.2") {
    if (window[k].chatKey !== location.href) {
      window[k].chatKey = location.href;
      window[k].lastDraft = null;
      window[k].observations.length = 0;
    }
    return window[k];
  }
  const state = { version: "0.0.2", observations: [],
    installedAt: new Date().toISOString(), chatKey: location.href,
    lastDraft: null };
  const editorSelector = [
    'textarea[aria-label="Chat with ChatGPT"]',
    '#prompt-textarea',
    '.ProseMirror[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][role="textbox"]'
  ].join(",");
  const visible = (element) => {
    if (!element?.isConnected) return false;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    // Hidden/off-screen React pages can remain mounted with nonzero dimensions.
    if (Number.isFinite(window.innerWidth) && Number.isFinite(window.innerHeight) &&
        (bounds.right <= 0 || bounds.left >= window.innerWidth ||
         bounds.bottom <= 0 || bounds.top >= window.innerHeight)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const readPlainText = (editor) => {
    if (editor.tagName === "TEXTAREA") return editor.value;
    // ProseMirror's simple P blocks correspond to distinct user lines. Do not
    // collapse multiple newlines or insert any extra blank lines.
    const blocks = Array.from(editor.children || []);
    if (blocks.length && blocks.every((block) => block.tagName === "P")) {
      return blocks.map((block) => String(block.innerText ?? block.textContent ?? "")).join("\n");
    }
    return String(editor.innerText ?? editor.textContent ?? "");
  };
  const findEditor = (eventTarget, type) => {
    const target = eventTarget?.nodeType === 1 ? eventTarget : eventTarget?.parentElement;
    if (type === "composer-enter" && target?.closest) {
      const editor = target.closest(editorSelector);
      return visible(editor) ? editor : null;
    }
    const candidates = Array.from(document.querySelectorAll(editorSelector))
      .filter(visible);
    if (candidates.length === 1) return candidates[0];
    if (target?.closest) {
      const form = target.closest("form");
      const own = candidates.filter((editor) => editor.closest("form") === form && form);
      if (own.length === 1) return own[0];
    }
    return null; // Never select from multiple ambiguous composers.
  };
  const capture = (type, target) => {
    const now = Date.now();
    if (state.chatKey !== location.href) {
      state.chatKey = location.href;
      state.lastDraft = null;
      state.observations.length = 0;
    }
    if (state.lastAt && now - state.lastAt < 350) return;
    const editor = findEditor(target, type);
    if (!editor) return;
    const raw = readPlainText(editor);
    if (!raw.trim()) return;
    const selected = readSelection(parseFiber);
    state.lastAt = now;
    const at = new Date(now).toISOString();
    // This is COMPOSER evidence, not the native IPC/network payload.
    state.lastDraft = {
      at, type, source: "DOM_COMPOSER_BEFORE_SEND",
      text: raw.slice(0, 100_000), truncated: raw.length > 100_000
    };
    state.observations.unshift({
      at, type, model: selected.model || null, effort: selected.effort || null,
      modelSource: selected.evidence?.model,
      effortSource: selected.evidence?.effort
    });
    if (state.observations.length > 12) state.observations.length = 12;
  };
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const element = event.target instanceof Element ? event.target : null;
    const button = element?.closest('button[aria-label="Send"],button[aria-label="Send message"],' +
      'button[aria-label="Send prompt"],button[data-testid="send-button"],button[type="submit"]');
    if (button && visible(button) && !button.disabled) {
      capture("composer-send-click", button);
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key !== "Enter" || event.shiftKey ||
        event.ctrlKey || event.metaKey || event.altKey ||
        event.isComposing || event.keyCode === 229) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest(editorSelector)) capture("composer-enter", element);
  }, true);
  document.addEventListener("submit", (event) => {
    if (!event.isTrusted) return;
    const form = event.target instanceof Element ? event.target : null;
    if (form?.querySelector(editorSelector)) capture("composer-submit", form);
  }, true);
  window[k] = state;
  return state;
}
