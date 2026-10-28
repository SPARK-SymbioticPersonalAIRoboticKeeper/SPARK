// Dock the monitor outside the ChatGPT main content rather than floating over the composer.
// This is evaluated in the existing ChatGPT Windows app through the established CDP watcher.

import {
  extractSelectedModelFromFiber, readUiSelectionFromDom,
  ensureUiSubmissionObserver,
} from "./route-ui-selection.mjs";
import {
  readActiveResponseFromDom, readActiveResponseFromReactRoot,
  extractLatestFinalResponse, responsePredatesObservedSend,
} from "./route-response-model.mjs";
import { normalizeLastGood } from "./route-last-good.mjs";

export function chooseRouteDockLayout(viewportWidth, mainLeft, zoom = 1) {
  const safeZoom = Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 4 ? zoom : 1;
  const available = Math.max(0, viewportWidth - mainLeft);
  const minChatWidth = 620;
  const gap = 28;
  const desired = Math.min(420, Math.floor(viewportWidth * 0.34));
  const dockWidth = Math.min(desired, Math.floor(available - minChatWidth - gap));
  if (dockWidth >= 280) {
    return {
      mode: "dock",
      width: dockWidth,
      reserve: Math.ceil((dockWidth + gap) / safeZoom),
    };
  }
  if (available >= minChatWidth + 12 + 16) {
    return { mode: "rail", width: 12, reserve: Math.ceil(24 / safeZoom) };
  }
  return { mode: "hidden", width: 0, reserve: 0 };
}

function renderRouteOverlay(snapshot, chooseLayout, readSelection, parseFiber, watchSubmissions,
  readResponse, scanResponse, extractResponse, responseOlderThanSend) {
  const id = "spark-route-monitor-overlay";
  const previousAttribute = "data-spark-route-original-margin";
  const restoreMain = (element) => {
    if (!element?.hasAttribute(previousAttribute)) return;
    element.style.marginRight = element.getAttribute(previousAttribute);
    element.removeAttribute(previousAttribute);
  };
  // The desktop app keeps hidden/offscreen React pages mounted. The first
  // <main> can be 0x0 even when the active chat is fully visible.
  const main = Array.from(document.querySelectorAll("main")).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width >= 480 && rect.height >= 200 && rect.top < window.innerHeight;
  }) || null;
  const priorMain = document.querySelector("main[" + previousAttribute + "]");
  if (priorMain && priorMain !== main) restoreMain(priorMain);

  let root = document.getElementById(id);
  // Upgrade the earlier floating overlay without requiring a ChatGPT app restart.
  if (root && (!root.querySelector("[data-route-title]") ||
      !root.querySelector("[data-route-record]"))) {
    root.remove();
    root = null;
  }
  // Older versions left a permanent hide flag with no way to reopen.
  // Never honor it: replace the X action with an accessible minimizable tab.
  if (window.__sparkRouteMonitorDismissed) delete window.__sparkRouteMonitorDismissed;
  if (!main) {
    restoreMain(priorMain);
    root?.remove();
    return { installed: false, reason: "main-unavailable" };
  }

  const rawZoom = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--codex-window-zoom"),
  );
  const zoom = Number.isFinite(rawZoom) ? rawZoom : 1;
  const baseLayout = chooseLayout(window.innerWidth, main.getBoundingClientRect().left, zoom);
  const minimized = window.__sparkRouteMonitorMinimized === true;
  const layout = minimized && baseLayout.mode !== "hidden"
    ? { mode: "minimized", width: 12, reserve: Math.ceil(24 / zoom) }
    : baseLayout;
  const rail = layout.mode === "rail";
  const compact = rail || layout.mode === "minimized";

  // Reserve the entire top application toolbar. Share is at y=67..101 on the
  // current Windows app; measure visible top-toolbar controls every refresh.
  const toolbarBottom = Math.max(0, ...Array.from(
    document.querySelectorAll('button[aria-label="Share"]'),
  ).map((button) => button.getBoundingClientRect())
    .filter((r) => r.top >= 0 && r.top < 180 && r.width > 0)
    .map((r) => r.bottom));
  const panelTop = Math.max(130, Math.ceil(toolbarBottom + 18));

  if (layout.mode === "hidden") {
    restoreMain(main);
    root?.remove();
    return { installed: false, reason: "insufficient-window-width" };
  }

  // Preserve the original page margin so a user dismissal restores the normal chat layout.
  if (!main.hasAttribute(previousAttribute)) {
    main.setAttribute(previousAttribute, main.style.marginRight);
  }
  main.style.marginRight = layout.reserve + "px";

  // Runtime geometry is authoritative: fail closed rather than cover the composer.
  const panelLeft = window.innerWidth - layout.width - (compact ? 0 : 12);
  let mainRect = main.getBoundingClientRect();
  if (mainRect.right > panelLeft - 8) {
    const extra = Math.ceil((mainRect.right - (panelLeft - 8)) / zoom) + 2;
    main.style.marginRight = layout.reserve + Math.max(0, extra) + "px";
    mainRect = main.getBoundingClientRect();
  }
  if (mainRect.right > panelLeft - 4 || mainRect.width < 480) {
    restoreMain(main);
    root?.remove();
    return { installed: false, reason: "dock-could-overlap-chat" };
  }

  if (!root) {
    root = document.createElement("aside");
    root.id = id;
    root.setAttribute("aria-label", "SPARK Route Monitor");
    root.innerHTML =
      '<div data-route-header><strong data-route-title></strong>' +
      '<button type="button" data-route-record aria-label="Start route evidence recording">Record</button>' +
      '<button type="button" data-route-close aria-label="Minimize route monitor">−</button>' +
      '<button type="button" data-route-restore aria-label="Restore route monitor" hidden>↗</button>' +
      '</div><div data-route-details></div>';
    document.body?.appendChild(root);
    const header = root.querySelector("[data-route-header]");
    header.style.cssText =
      "box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:6px 9px;" +
      "min-height:38px;border-bottom:1px solid #3f4757;flex-shrink:0";
    const title = root.querySelector("[data-route-title]");
    title.style.cssText =
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const record = root.querySelector("[data-route-record]");
    const close = root.querySelector("[data-route-close]");
    const restore = root.querySelector("[data-route-restore]");
    for (const button of [record, close, restore]) {
      button.style.cssText = "background:#293449;color:#f4f4f6;" +
        "border:1px solid #556174;border-radius:4px;padding:3px 6px;cursor:pointer;flex-shrink:0";
    }
    const details = root.querySelector("[data-route-details]");
    details.style.cssText =
      "box-sizing:border-box;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:7px 10px";
    record.onclick = () => {
      const acknowledged = Number(window.__sparkRouteRecordingStatus?.lastCommandSequence || 0);
      const pending = Number(window.__sparkRouteRecordingCommand?.sequence || 0);
      if (pending > acknowledged) return;
      window.__sparkRouteRecordSequence = Math.max(
        Number(window.__sparkRouteRecordSequence || 0) + 1, Date.now() * 1000,
      );
      window.__sparkRouteRecordingCommand = {
        sequence: window.__sparkRouteRecordSequence,
        action: window.__sparkRouteRecordingStatus?.active ? "stop" : "start",
        instanceId: window.__sparkRouteRecordingStatus?.instanceId,
      };
      record.disabled = true;
      record.textContent = "Saving...";
    };
    close.onclick = () => {
      window.__sparkRouteMonitorMinimized = true;
      details.hidden = true;
      // Next watcher tick repositions the small tab and releases chat space.
      root.style.height = "40px";
    };
    restore.onclick = () => {
      window.__sparkRouteMonitorMinimized = false;
      details.hidden = false;
    };
  }

  root.style.cssText = compact ?
    "box-sizing:border-box;position:fixed;right:0;top:" + panelTop + "px;" +
    "z-index:2147483646;width:12px;height:54px;max-height:54px;min-width:0;" +
    "padding:0;margin:0;overflow:hidden;background:#253149;color:transparent;" +
    "border:0;border-left:2px solid #86a6db;border-radius:5px 0 0 5px;" +
    "box-shadow:none;display:flex;flex-direction:column;pointer-events:auto;cursor:pointer" :
    "box-sizing:border-box;position:fixed;right:12px;top:" + panelTop + "px;bottom:auto;" +
    "z-index:2147483646;width:" + layout.width + "px;max-width:none;" +
    "max-height:calc(100vh - " + (panelTop + 20) + "px);min-width:0;overflow:hidden;" +
    "background:#171b24;color:#f4f4f6;border:1px solid #697487;" +
    "border-radius:8px;font:12px/1.45 Consolas,monospace;" +
    "box-shadow:0 3px 15px #0009;display:flex;flex-direction:column;" +
    "pointer-events:auto;";

  // React composer state provides a concrete model+effort even when the
  // Electron shell's native networking is invisible to renderer CDP.
  const ui = readSelection(parseFiber);
  // Response metadata is bound to the ACTIVE server conversation's current
  // final assistant message, not the current composer's input model selection.
  const response = readResponse(extractResponse, scanResponse);
  const observer = watchSubmissions(readSelection, parseFiber);
  const lastSend = observer.observations[0] || null;
  const staleResponse = responseOlderThanSend(response, lastSend);
  // Only current-chat title and known UI error codes are exported to the local
  // opt-in recorder. Never inspect/return chat body, content or request IDs.
  const activeLink = Array.from(document.querySelectorAll('a[aria-current="page"]'))
    .find((element) => {
      if (!element.closest('nav,aside,[role="navigation"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        element.textContent?.trim().length > 0 && element.textContent.trim().length <= 180;
    });
  const fallbackPageTitle = document.title && !/^(?:ChatGPT|Codex)$/i.test(document.title.trim()) ?
    document.title.trim() : null;
  const chatTitle = activeLink?.textContent?.trim() || response.chatTitle ||
    fallbackPageTitle || "Untitled chat";
  const titleSource = activeLink ? "active-navigation" :
    response.chatTitle && response.chatTitleSource === "verified-active-chat" ?
      "verified-active-chat" : fallbackPageTitle ? "document-title" : "unavailable";
  const uiErrors = [];
  const nodes = document.querySelectorAll('[role="alert"],[class*="error"],p,span,div');
  for (let index = 0; index < Math.min(nodes.length, 2500); index++) {
    const element = nodes[index];
    // Do not classify an error string merely quoted in user/assistant content.
    if (element.closest('[contenteditable="true"],[data-message-author-role],' +
        '[class*="group/user-message"],[class*="group/assistant"],article')) continue;
    const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
    if (text.length > 150 || !/^(?:Message delivery timed out|Resume stream unavailable)/i.test(text)) continue;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (/^Message delivery timed out\. Please try again\.?$/i.test(text) &&
        !uiErrors.includes("MESSAGE_DELIVERY_TIMEOUT")) uiErrors.push("MESSAGE_DELIVERY_TIMEOUT");
    if (/^Resume stream unavailable\.?$/i.test(text) &&
        !uiErrors.includes("RESUME_STREAM_UNAVAILABLE")) uiErrors.push("RESUME_STREAM_UNAVAILABLE");
    if (uiErrors.length === 2) break;
  }
  const recentNetwork = [...(snapshot.active || []), ...(snapshot.recent || [])];
  const recordingObservation = {
    observedAt: new Date().toISOString(), title: chatTitle, titleSource, uiErrors,
    ui: {model:ui.model,effort:ui.effort},
    lastSend: lastSend ? {at:lastSend.at,model:lastSend.model,effort:lastSend.effort,type:lastSend.type} : null,
    response: {
      status:response.status, messageStatus:response.messageStatus,
      model:response.model, resolvedModel:response.resolvedModel,
      effort:response.effort, resolvedEffort:response.resolvedEffort,
      resolvedEffortStatus:response.resolvedEffortStatus, sourceKind:response.sourceKind,
      source:response.source, createdAt:response.createdAt,
    },
    metadata: response.extraMetadata, staleResponse,
    network: {
      state:snapshot.capture?.state, requests:snapshot.metrics?.requests,
      chatRequests:snapshot.metrics?.chatRequests, failures:snapshot.metrics?.failures,
      wsFrames:snapshot.metrics?.frames, lastEventAt:snapshot.metrics?.lastNetworkEventAt,
      events:recentNetwork.filter((item) => item.chatGeneration || item.failure ||
        Number(item.responseStatus) >= 400).slice(0, 8).map((item) => ({
        method:item.method, responseStatus:item.responseStatus,
        failure:item.failure, chatGeneration:item.chatGeneration,
        startedAt:item.startedAt, finishedAt:item.finishedAt,
        durationMs:item.wallTimeMs, bytes:item.responseBytes,
        streamStatus:item.streamStatus, canceled:item.canceled,
      })),
    },
  };
  const title = root.querySelector("[data-route-title]");
  const record = root.querySelector("[data-route-record]");
  const close = root.querySelector("[data-route-close]");
  const restore = root.querySelector("[data-route-restore]");
  const details = root.querySelector("[data-route-details]");
  const recordingState = snapshot.recording || { active: false, lastCommandSequence: 0 };
  window.__sparkRouteRecordingStatus = recordingState;
  if (window.__sparkRouteRecordingCommand?.instanceId !== recordingState.instanceId) {
    window.__sparkRouteRecordingCommand = null;
  }
  const pendingSequence = Number(window.__sparkRouteRecordingCommand?.sequence || 0);
  const logPending = pendingSequence > Number(recordingState.lastCommandSequence || 0);
  const receivedLabel = response.status === "observed" ?
    (response.model || response.resolvedModel || "unknown") : "응답 미관측";
  title.textContent = compact ? "" : "SPARK  ·  수신 " + receivedLabel;
  title.style.color = response.status === "observed" ? "#a8edc6" : "#f4f4f6";
  record.textContent = logPending ? "Saving..." :
    recordingState.active ? "■ Stop log" : "● Record";
  record.disabled = logPending;
  record.title = recordingState.active ? "Stop metadata recording" :
    "Start local metadata recording for this chat";
  record.setAttribute("aria-label", recordingState.active ?
    "Stop route evidence recording" : "Start route evidence recording");
  record.style.background = recordingState.active ? "#70302d" : "#293449";
  root.title = rail ? "Expand window to view routing monitor" :
    layout.mode === "minimized" ? "SPARK monitor minimized — click ↗ to restore" : "";
  record.hidden = compact;
  close.hidden = compact;
  restore.hidden = !compact;
  title.hidden = compact;
  const header = root.querySelector("[data-route-header]");
  header.style.cssText = compact ?
    "position:relative;box-sizing:border-box;width:100%;height:100%;" +
    "min-height:0;padding:0;margin:0;border:0;background:transparent;display:block" :
    "box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:6px 9px;" +
    "min-height:38px;border-bottom:1px solid #3f4757;flex-shrink:0";
  restore.textContent = compact ? "" : "↗";
  restore.title = compact ? "Restore SPARK Route Monitor" : "";
  restore.style.cssText = compact ?
    "position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;" +
    "background:transparent;border:0;color:transparent;cursor:pointer;" +
    "box-sizing:border-box" :
    "background:#293449;color:#f4f4f6;border:1px solid #556174;" +
    "border-radius:4px;padding:3px 6px;cursor:pointer;flex-shrink:0";
  if (compact) details.hidden = true;
  root.style.height = compact ? "54px" : details.hidden ? "40px" :
    Math.max(40, window.innerHeight - panelTop - 20) + "px";
  record.setAttribute("aria-pressed", String(recordingState.active));

  // Never retain stale raw user text in the collapsed diagnostic subtree.
  // When expanded, rebuild from freshly projected CII-visible content.
  if (details.hidden && details.childElementCount) details.replaceChildren();
  if (!details.hidden) {
    const oldScroll = details.scrollTop;
    const outgoingScrolls = Object.fromEntries([
      "data-route-draft-message", "data-route-outbound-message",
      "data-route-rendered-message", "data-route-wire-message"
    ].map((name) => [name, details.querySelector("[" + name + "]")?.scrollTop || 0]));
    details.replaceChildren();

    const metrics = snapshot.metrics || {};
    const capture = snapshot.capture || {};
    const records = [...snapshot.active, ...snapshot.recent];
    const strongest = records.find((rec) =>
      rec.route?.requestedModel || rec.route?.requestedEffort ||
      rec.route?.resolvedModel || rec.route?.serverModel);
    const wire = strongest?.route || {};
    const present = (x) => x == null ? "NOT OBSERVED" : String(x);
    // Semantic lanes: response metadata, independently resolved fields, UI send
    // intent and diagnostics. Color plus labels distinguish direction and source.
    // The top of the panel is a compact evidence summary, not a long checklist.
    // UI model selection, server-returned metadata and underlying execution
    // are deliberately separate facts. Native IPC may be invisible to CDP.
    const overview = document.createElement("section");
    overview.setAttribute("data-route-overview", "");
    overview.style.cssText = "border:1px solid #536779;border-radius:7px;" +
      "background:#192532;padding:10px;margin:1px 0 10px;font:12px/1.45 Consolas,monospace";
    const headline = document.createElement("div");
    headline.style.cssText = "font-weight:700;font-size:13px;color:#e7f0ff;margin-bottom:8px";
    headline.textContent = "송신 의도  →  서버 메시지  →  확인 상태";
    overview.appendChild(headline);
    const lastKnown = snapshot.lastGoodStatus?.lastFinal;
    const responseFinal = response.messageStatus === "finished_successfully";
    const latestReceived = response.status === "observed" && !staleResponse;
    const resultStatus = uiErrors.includes("MESSAGE_DELIVERY_TIMEOUT") ?
      "MESSAGE DELIVERY TIMEOUT · 화면 오류, 원인 미확인" :
      uiErrors.includes("RESUME_STREAM_UNAVAILABLE") ?
        "RESUME STREAM UNAVAILABLE · 화면 오류, 원인 미확인" :
      latestReceived && responseFinal ? "FINISHED · 메시지 완료 (실행 Effort 증명 아님)" :
      latestReceived ? "진행 중 / 서버 상태 미확정" :
      lastSend ? "송신 시도 관측 / 응답 미확인" : "확인된 송수신 없음";
    const activeEffort = response.resolvedEffort ||
      "NOT REPORTED · 실제 적용 Effort 미확인";
    const primaryRows = [
      ["대화", chatTitle, titleSource],
      ["송신 · UI", (ui.model || "미관측") + " / " + (ui.effort || "미관측"),
        "선택값 · 실제 전송 패킷 아님"],
      ["송신 시도", lastSend ? lastSend.at : "미관측",
        lastSend ? "사용자 Send 조작 관측" : "실제 요청 전송 미검증"],
      ["수신 · 응답", latestReceived ?
        (response.model || response.resolvedModel || "모델 미보고") +
        " / " + (response.effort || "effort 미보고") : "현재 응답 미관측",
        latestReceived ? "서버 메시지 메타데이터 · 요청값 반영 가능" :
        "현재 대화와 연결된 응답 증거 없음"],
      ["메시지 결과", resultStatus, responseFinal ?
        "finished_successfully = 메시지 완료만" : "완료 확인되지 않음"],
      ["Resolved Effort", activeEffort,
        response.resolvedEffort ? "독립 필드 보고 · 실제 계산량 미증명" :
          "thinking_effort는 요청 echo일 수 있음"],
      ["네트워크", (capture.state || "unknown") + " / 실패 " + (metrics.failures ?? 0),
        "CDP 백그라운드 관측 · 현재 turn과 직접 연결 미확정"],
      ["기록", recordingState.error ? "LOG ERROR · " + recordingState.error :
        logPending ? "기록 명령 처리 대기" :
        recordingState.active ? "RECORDING · " + (recordingState.eventsWritten || 0) + "건" :
          "STOPPED · 수동 기록 대기",
        recordingState.file || "상단 Record 버튼으로 기록 시작"],
    ];
    for (const [label, value, provenance] of primaryRows) {
      const line = document.createElement("div");
      line.setAttribute("data-route-summary-row", label);
      line.style.cssText = "display:grid;grid-template-columns:112px minmax(0,1fr);" +
        "gap:8px;padding:6px 1px;border-top:1px solid #ffffff16;align-items:start";
      const key = document.createElement("strong");
      key.textContent = label;
      key.style.cssText = "font-size:11px;color:#bcd3ef;font-weight:600";
      const side = document.createElement("div");
      const v = document.createElement("div");
      v.textContent = String(value);
      v.style.cssText = "overflow-wrap:anywhere;color:" +
        (label === "메시지 결과" && uiErrors.length ? "#ffaf9c" :
          label === "메시지 결과" && responseFinal ? "#a8edc6" : "#edf1f7");
      const origin = document.createElement("small");
      origin.textContent = String(provenance);
      origin.style.cssText = "display:block;margin-top:2px;color:#94a8c4;" +
        "font-size:10px;overflow-wrap:anywhere";
      side.append(v, origin);
      line.append(key, side);
      overview.appendChild(line);
    }
    details.appendChild(overview);

    // Volatile on-screen message audit. It is not part of recordingObservation,
    // route snapshots, CII traces or CDP return values. An observed composer
    // draft is NEVER presented as an actual delivered request.
    const draft = observer.lastDraft || null;
    const egressGate = window.__sparkCiiGate?.getState?.() || null;
    const egressBreakpoint = globalThis.__sparkCiiBreakpointState || null;
    const egressOutbound = globalThis.__sparkCiiBreakpointLastOutbound || null;
    const ciiState = egressGate ?
      {enabled:egressGate.enabled,stage:"EGRESS_REQUEST_BOUNDARY",
        gate:egressGate,dispatchBreakpoint:egressBreakpoint} :
      window.__sparkCiiGuard?.getState?.() || null;
    const ciiAttempt = ciiState?.stage === "ORIGINAL_EDITOR_INSERT" ?
      ciiState.lastAttempt || null : null;
    const outbound = window.__sparkCiiGuard?.getLastOutboundText?.() || null;
    const draftAt = Date.parse(draft?.at || "") || 0;
    const outAt = Date.parse(outbound?.at || "") || 0;
    const matchedTime = Boolean(draft && outbound && outAt >= draftAt - 350 &&
      outAt - draftAt <= 10_000);
    const auditBox = document.createElement("section");
    auditBox.setAttribute("data-route-outgoing-message-panel", "");
    auditBox.style.cssText = "border:1px solid #4b7aa5;border-radius:7px;" +
      "background:#152236;padding:10px;margin:0 0 10px;color:#e7f1ff";
    const auditTitle = document.createElement("strong");
    auditTitle.textContent = "송신 메시지 · 원문 / 실제 전송 계층";
    auditTitle.style.cssText = "display:block;font-size:13px;margin-bottom:7px";
    auditBox.appendChild(auditTitle);
    const statusRow = (label, value, warning = false) => {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:105px minmax(0,1fr);" +
        "gap:8px;padding:3px 0;overflow-wrap:anywhere";
      const key = document.createElement("span");
      key.textContent = label;
      key.style.cssText = "color:#accbe7;font-weight:600";
      const text = document.createElement("span");
      text.textContent = value;
      text.style.cssText = "color:" + (warning ? "#ffcb93" : "#e4ecf9");
      row.append(key, text);
      auditBox.appendChild(row);
    };
    statusRow("입력 감지", ciiAttempt ?
      "#" + ciiAttempt.attemptId + " " + ciiAttempt.channel + " · " + ciiAttempt.at :
      draft ? draft.type + " · " + draft.at : "아직 Enter/전송 버튼 관측 없음");
    const ciiLocalVerified = ciiAttempt?.immediate === "PASS" &&
      ciiAttempt?.readback === "PASS";
    statusRow("CII 결합", ciiLocalVerified ?
      (ciiAttempt.insert === "ALREADY_PRESENT" ?
        "기존 Prefix 입력창 검증 PASS · 실제 서버 수신 미확인" :
        "Prefix 입력창 삽입·재확인 PASS · 실제 서버 수신 미확인") :
      matchedTime && outbound?.ciiMatched ?
        (outbound.source === "LOCAL_COMPOSER_SUBMIT_ARGUMENT" ?
          "ChatGPT 제출 인자에 Prefix 결합 확인 · 서버 수신 미확인" :
          "로컬 송신 API에서 Prefix 결합 확인 · 서버 수신 미확인") :
      !ciiState?.enabled ? "CII 비활성 / 현재 창에 가드 없음" :
      "삽입 검증 PASS 미관측 · CII 적용 확인 불가",
      !ciiLocalVerified && !(matchedTime && outbound?.ciiMatched));
    if (ciiState?.stage === "ORIGINAL_EDITOR_INSERT") {
      const step = (label, value) => statusRow(label,
        ciiAttempt ? String(value ?? "NOT_RUN") : "NOT OBSERVED",
        !ciiAttempt || value === "FAIL" || value === "NOT_RUN");
      step("편집기 선택", ciiAttempt?.editor);
      step("Prefix 계획", ciiAttempt?.plan);
      step("Prefix 삽입", ciiAttempt?.insert);
      step("삽입 직후", ciiAttempt?.immediate);
      step("140ms 재검증", ciiAttempt?.readback);
      step("Send 버튼", ciiAttempt?.send);
      statusRow("CII 결과", ciiAttempt ?
        ciiAttempt.result + " / " + ciiAttempt.reason :
        "시도 기록 없음",
        !ciiAttempt || ciiAttempt.result !== "LOCAL_SEND_ONLY");
      statusRow("최근 실패", ciiState.lastFailure ?
        "#" + ciiState.lastFailure.attemptId + " · " + ciiState.lastFailure.reason +
          " · " + ciiState.lastFailure.at : "기록 없음",
        !!ciiState.lastFailure);
      statusRow("CII 추적", "미저장 " + String(ciiState.tracePending ?? "미지원") +
        "건 / 큐 넘침 " + String(ciiState.traceOverflow ?? "미지원") +
        "건 · 원문 저장 안 함");
    }
    if (egressGate) {
      const bp = egressBreakpoint;
      const egAt = Date.parse(egressOutbound?.at || "") || 0;
      const egLinked = Boolean(draft && egAt && egAt >= draftAt - 350 &&
        egAt - draftAt <= 10_000);
      const displayMask = window.__sparkCiiDisplayMask?.getState?.() || null;
      statusRow("말풍선 Prefix 숨김", displayMask?.enabled ?
        "ACTIVE · 마스킹 " + String(displayMask.masked || 0) +
          "건 / 오류 " + String(displayMask.errors || 0) :
        "NOT INSTALLED · 송신 게이트 차단 필요",
        !displayMask?.enabled || Number(displayMask.errors)>0);
      statusRow("Egress Gate", egressGate.armed ?
        "ARMED · 현재 입력 허용 / Prefix 없는 경로의 전송 방지 미확정" :
        "BLOCKING · 전송 경계 미장착/만료로 Enter·Send 차단",
        !egressGate.armed);
      statusRow("Egress 경계", bp?.installed ?
        "startCompletionStream · " + bp.status +
          " · heartbeat " + String(bp.heartbeatAt) :
        "NOT OBSERVED · CDP 브레이크포인트 미장착",!bp?.installed);
      statusRow("Prefix 결합", egLinked && egressOutbound?.prefixVerified === true ?
        "PASS · 해당 요청 객체에 Prefix 결합 / 서버 수신 미확인" :
        "현재 메시지 확인 불가 · 누적 로컬 검증 " +
          String(bp?.forwarded ?? 0) + "건",!egLinked);
      statusRow("차단 원인", egressGate.blockedIntents > 0 ?
        String(egressGate.blockedIntents) + "회 · " + egressGate.lastReason :
        bp?.status === "ERROR" ? "BREAKPOINT_ERROR · 추적 확인 필요" :
        "현재 Gate 차단 0회",egressGate.blockedIntents > 0 ||
          bp?.status === "ERROR");
      statusRow("송신 증거", "로컬 startCompletionStream 요청 객체만 · " +
        "IPC/TLS/서버 수신 NOT OBSERVED");
    }
    statusRow("로컬 송신", outbound ?
      outbound.channel + " · " + outbound.at +
        (matchedTime ? " (직전 입력과 시간 근접)" : " (현재 입력과 연결 미확정)") :
      ciiAttempt?.send === "CLICK_CALLED" ?
        "Send 클릭 호출 확인 · 네트워크/서버 수신 미관측" :
        "NOT OBSERVED · 입력 이벤트만으로 송신 성공을 주장할 수 없음",
      !outbound && ciiAttempt?.send !== "CLICK_CALLED");
    statusRow("누락 진단", ciiState?.stage === "EGRESS_REQUEST_BOUNDARY" ?
      "게이트 차단 " + String(egressGate?.blockedIntents ?? 0) +
        "회 / 요청 Prefix 검증 " + String(egressBreakpoint?.forwarded ?? 0) +
        "회 (누적)" :
      ciiState?.stage === "ORIGINAL_EDITOR_INSERT" ?
      "CII 차단 " + String(ciiState.blocked || 0) +
        "회 / 안전 우회 " + (ciiState.safeBypass ? "ON" : "OFF") :
      ciiState ? String(ciiState.suspectedMissingPrefix ?? 0) +
        "회 의심 / 제출 인자 병합 " + String(ciiState.composerSubmit?.merged ?? 0) +
        "회 / IPC/API 변환 " + String(ciiState.outboundModified ?? 0) +
        "회" : "CII 관측 불가");
    statusRow("계정 Custom Instructions",
      "서버/계정 처리 영역 · 실제 적용 여부를 현재 클라이언트에서 확인할 수 없음");
    const messageBlock = (label, body, source, truncated, name) => {
      const heading = document.createElement("div");
      heading.textContent = label + " · " + source;
      heading.style.cssText = "font-weight:600;color:#c8dff9;" +
        "margin-top:9px;margin-bottom:4px";
      const pre = document.createElement("pre");
      pre.setAttribute(name, "");
      pre.textContent = typeof body === "string" ? body :
        "NOT OBSERVED · 관측된 텍스트 없음";
      pre.style.cssText = "margin:0;max-height:175px;overflow:auto;" +
        "padding:7px;border:1px solid #465e7a;border-radius:4px;" +
        "background:#0b1425;color:#f4f5fa;white-space:pre-wrap;" +
        "overflow-wrap:anywhere;font:12px/1.5 Consolas,monospace";
      auditBox.append(heading, pre);
      if (truncated) {
        const cap = document.createElement("small");
        cap.textContent = "표시 상한 100,000자 · 원문 전체와 일치 여부 확인 불가";
        cap.style.cssText = "color:#ffcb93";
        auditBox.appendChild(cap);
      }
    };
    messageBlock("사용자 원문", draft?.text,
      "입력창 DOM 관측 (송신 본문 아님)", draft?.truncated,
      "data-route-draft-message");
    messageBlock("제출 함수 / 송신 API 전달 내용", outbound?.text,
      outbound?.source === "LOCAL_COMPOSER_SUBMIT_ARGUMENT" ?
        "React 제출 함수 반환 문자열 (서버 수신/네이티브 IPC 패킷 아님)" :
      outbound ? "클라이언트 API 함수 인자 (서버 수신 증거 아님)" :
        "ChatGPT 제출 인자 및 네이티브 IPC/네트워크 본문 미관측",
      outbound?.truncated, "data-route-outbound-message");
    const visibleUserTurns = Array.from(main.querySelectorAll(
      '[class~="group/user-message"]'));
    const latestUserTurn = visibleUserTurns.at(-1);
    const latestUserContent = latestUserTurn?.querySelector(
      '[class~="whitespace-pre-wrap"]') || null;
    const rawUserText = latestUserContent?.textContent ?? null;
    const latestUserText = rawUserText == null ? null :
      (window.__sparkCiiDisplayMask?.projectText?.(rawUserText) ?? rawUserText);
    messageBlock("ChatGPT 사용자 말풍선", latestUserText?.slice(0, 100_000),
      "현재 대화의 마지막 렌더링 · 송신 패킷/서버 지침 확인 아님",
      latestUserText?.length > 100_000, "data-route-rendered-message");
    // Per-stage payload evidence. It is intentionally read-only and kept
    // renderer-local. A React text getter is NOT a native packet and a CDP
    // request body is NOT proof of the final main-process TLS boundary.
    const flow = snapshot.flow || {};
    const wireEvents = Array.isArray(flow.entries) ? flow.entries : [];
    const wireMatch = wireEvents.find((entry) => {
      const text = entry?.message?.text;
      const at = Date.parse(entry?.at || "");
      if (typeof text !== "string" || !Number.isFinite(at)) return false;
      if (draftAt && Math.abs(at - draftAt) > 120_000) return false;
      if (outbound?.text && !outbound.truncated &&
          !entry.message?.truncated && text === outbound.text) return true;
      if (draft?.text && !draft.truncated && !entry.message?.truncated &&
          (text === draft.text || text.endsWith("\n\n" + draft.text))) return true;
      return !!latestUserText && !entry.message?.truncated &&
        text === latestUserText && !draftAt;
    }) || null;
    const fullCompare = wireMatch && outbound &&
      !wireMatch.message?.truncated && !outbound.truncated ?
      wireMatch.message.text === outbound.text ? "MATCH · React 반환값과 CDP 본문 일치" :
        "DIFFERENT · React 반환값과 CDP 본문 불일치" :
      "NOT VERIFIED · 두 평문 확보 필요";
    const flowPanel = document.createElement("section");
    flowPanel.setAttribute("data-route-message-flow", "");
    flowPanel.style.cssText = "border:1px solid #68778d;border-radius:7px;" +
      "background:#19212f;padding:9px;margin:10px 0 0";
    const flowHeading = document.createElement("strong");
    flowHeading.style.cssText = "display:block;color:#e6edff;margin-bottom:6px";
    flowHeading.textContent = "메시지 경로 / 단계별 실제 관측";
    flowPanel.appendChild(flowHeading);
    const flowHelp = document.createElement("p");
    flowHelp.style.cssText = "font:11px/1.45 Consolas,monospace;" +
      "color:#a6b9d2;margin:0 0 6px";
    flowHelp.textContent = "분기 경로는 확정되지 않음 · NOT OBSERVED는 실패 확정이 아님";
    flowPanel.appendChild(flowHelp);
    const flowRows = [
      ["1 UI 입력", draft ? "OBSERVED · 사용자 입력 DOM" : "NOT OBSERVED"],
      ["2 React 제출", outbound?.source === "LOCAL_COMPOSER_SUBMIT_ARGUMENT" ?
        "OBSERVED · 제출 함수 반환 인자 (최종 패킷 아님)" : "NOT OBSERVED"],
      ["2B CII Egress", egressOutbound?.prefixVerified === true ?
        "OBSERVED · startCompletionStream 요청 객체 (서버 수신 미확인)" :
        egressGate ? "NOT OBSERVED · 요청 객체 결합 아직 미관측" :
        "NOT INSTALLED"],
      ["3A Chromium HTTP/WS", wireMatch ?
        "OBSERVED · " + wireMatch.channel + " / " + wireMatch.message.shape :
        "NOT OBSERVED · 이 메시지에 연결된 CDP 본문 없음"],
      ["3B Electron IPC", "NOT OBSERVED · 렌더러에서 메인으로 전달된 실제 본문 미확인"],
      ["4 네이티브 요청", "NOT OBSERVED · Electron 메인/프로세스 전송 인자 미확인"],
      ["5 TLS 직전", "NOT OBSERVED · 최종 암호화 전 경계의 평문 미확인"],
      ["6 TLS 연결", wireMatch?.tls ?
        wireMatch.tls + " · Chromium 요청 관측 한정" :
        "NOT OBSERVED · HTTPS 요청 경로와 현재 메시지 미연결"],
      ["7 서버 수신", "NOT OBSERVED · 원격 서버 실제 수신 본문 미확인"],
      ["8 응답 렌더링", response.messageStatus ?
        response.messageStatus + " · 화면 상태, 송신 확인 아님" :
        "NOT OBSERVED"],
    ];
    for (const [label, status] of flowRows) {
      const row = document.createElement("div");
      row.setAttribute("data-route-flow-stage", label);
      row.style.cssText = "display:grid;grid-template-columns:125px minmax(0,1fr);" +
        "border-top:1px solid #ffffff20;padding:5px 0;gap:7px;" +
        "font:11px/1.5 Consolas,monospace";
      const key = document.createElement("strong");
      key.textContent = label;
      key.style.cssText = "color:#bad4f6";
      const value = document.createElement("span");
      value.textContent = status;
      value.style.cssText = "overflow-wrap:anywhere;color:" +
        (status.startsWith("OBSERVED") ? "#b5e6ca" : "#f1d7a3");
      row.append(key, value);
      flowPanel.appendChild(row);
    }
    const comparison = document.createElement("div");
    comparison.setAttribute("data-route-flow-comparison", "");
    comparison.style.cssText = "border-top:1px solid #ffffff25;margin-top:3px;" +
      "padding-top:6px;color:#f2d9ad;overflow-wrap:anywhere;font:11px/1.5 Consolas,monospace";
    comparison.textContent = "React ↔ CDP: " + fullCompare +
      " · CDP HTTP " + (flow.httpObserved || 0) +
      "건 / WS " + (flow.wsObserved || 0) + "건 (수집 시작 이후)";
    flowPanel.appendChild(comparison);
    auditBox.appendChild(flowPanel);
    messageBlock("CDP HTTP/WS 사용자 본문", wireMatch?.message?.text,
      wireMatch ? "Chromium 요청 데이터 · 네이티브/TLS 최종 본문 아님" :
        "현재 채팅과 일치하는 요청 본문 미관측",
      wireMatch?.message?.truncated, "data-route-wire-message");
    const privacy = document.createElement("small");
    privacy.textContent = "UI·React·CDP 사용자 본문은 현재 창/감시기 메모리에만 표시 · Record/파일 로그에 미저장 · heartbeat/Git 미저장";
    privacy.style.cssText = "display:block;margin-top:7px;color:#a8bad4";
    auditBox.appendChild(privacy);
    details.appendChild(auditBox);
    for (const [name, scroll] of Object.entries(outgoingScrolls)) {
      const preview = auditBox.querySelector("[" + name + "]");
      if (preview) preview.scrollTop = scroll;
    }
    const advanced = document.createElement("details");
    advanced.setAttribute("data-route-advanced", "");
    advanced.style.cssText = "border:1px solid #465568;border-radius:6px;" +
      "background:#171d28;padding:6px;margin:0 0 6px";
    advanced.open = window.__sparkRouteShowAdvanced === true;
    const advancedTitle = document.createElement("summary");
    advancedTitle.textContent = "근거 · Last Good · 사용량 · 전체 메타데이터 (" +
      (response.extraMetadata?.observedFields ?? 0) + " 필드)";
    advancedTitle.style.cssText = "cursor:pointer;color:#c9dcf5;" +
      "font-weight:600;padding:4px;font-size:11px";
    advanced.appendChild(advancedTitle);
    advanced.addEventListener("toggle", () => {
      if (advanced.isConnected) window.__sparkRouteShowAdvanced = advanced.open;
    });
    details.appendChild(advanced);
    if (advanced.open) {
    const summary = document.createElement("div");
    summary.setAttribute("data-route-capture-summary", "");
    summary.style.cssText =
      "display:flex;flex-direction:column;gap:8px;margin:0 0 9px;" +
      "font:12px/1.5 Consolas,monospace";
    const makeLane = (direction, name, rows) => {
      const palettes = {
        received: { border: "#338a68", bg: "#13291f", title: "#a8edc6" },
        resolved: { border: "#8274cc", bg: "#25213b", title: "#dfd5ff" },
        good: { border: "#44aaa5", bg: "#142e32", title: "#b4eee8" },
        sent: { border: "#4b8aca", bg: "#172941", title: "#c0e0ff" },
        diagnostic: { border: "#526174", bg: "#222b39", title: "#d8e2f1" },
        usage: { border: "#b98e40", bg: "#29261b", title: "#f1dba5" },
      };
      const colors = palettes[direction];
      const lane = document.createElement("section");
      lane.setAttribute("data-route-direction", direction);
      lane.style.cssText =
        "background:" + colors.bg + ";border:1px solid " + colors.border +
        ";border-left:4px solid " + colors.border +
        ";border-radius:5px;padding:8px 9px;box-sizing:border-box;";
      const heading = document.createElement("div");
      heading.style.cssText = "color:" + colors.title +
        ";font-weight:700;font-size:12px;letter-spacing:.15px;" +
        "margin:0 0 6px;border-bottom:1px solid #ffffff20;padding-bottom:5px";
      heading.textContent = name;
      lane.appendChild(heading);
      for (const [key, value] of rows) {
        const row = document.createElement("div");
        row.setAttribute("data-route-field", key);
        row.style.cssText =
          "display:grid;grid-template-columns:126px minmax(0,1fr);gap:7px;" +
          "padding:2px 0;align-items:start;box-sizing:border-box";
        const label = document.createElement("span");
        label.style.cssText = "color:" + colors.title +
          ";overflow-wrap:anywhere;font-weight:500";
        label.textContent = key;
        const val = document.createElement("span");
        val.style.cssText = "color:#f6f7fb;overflow-wrap:anywhere;" +
          "word-break:break-word;white-space:pre-wrap;font-weight:500";
        val.textContent = String(value);
        if (/^NOT (?:OBSERVED|REPORTED)|^UNAVAILABLE|^IN PROGRESS/.test(val.textContent)) {
          val.style.color = "#ffce84";
        }
        row.append(label, val);
        lane.appendChild(row);
      }
      summary.appendChild(lane);
      return lane;
    };
    const phase = response.messageStatus === "finished_successfully" ?
      "FINAL / finished_successfully (completion only)" :
      response.messageStatus === "in_progress" ?
        "IN PROGRESS (metadata provisional)" :
        response.messageStatus || response.status;
    makeLane("received", "수신 / SERVER → CLIENT · assistant response", [
      ["RESPONSE MODEL", present(response.model)],
      ["RESPONSE EFFORT", present(response.effort) +
        " (thinking_effort; request-echo possible, NOT applied proof)"],
      ["MESSAGE STATE", phase],
      ["CREATED AT", response.createdAt || "NOT OBSERVED"],
      ["CAPTURE", response.sourceKind === "live-render" ?
        "LIVE current rendered turn" : response.sourceKind === "query-cache" ?
          "CACHED server conversation" : response.status],
      ["MODEL SOURCE", response.source?.model || "NOT OBSERVED"],
      ...(staleResponse ? [["WARNING", "CACHED RESPONSE predates latest UI send"]] : []),
    ]);
    const finalMessage = response.messageStatus === "finished_successfully";
    const distinctResolvedEffort = response.resolvedEffort ?
      response.resolvedEffort + " (explicit response field; application unverified)" :
      response.resolvedEffortStatus === "conflicting-fields" ?
        "UNAVAILABLE (conflicting explicit fields)" : !finalMessage ?
          "NOT OBSERVED (awaiting final response)" :
          "NOT REPORTED (no explicit resolved_* field in final response)";
    makeLane("resolved", "응답 내부 보고 / RESOLVED · 별도 전송 아님", [
      ["RESOLVED MODEL", present(response.resolvedModel) +
        (response.resolvedModel && !finalMessage ? " (provisional)" : "")],
      ["RESOLVED EFFORT", distinctResolvedEffort],
      ["FIELD STATUS", finalMessage ?
        "MESSAGE COMPLETE; applied Effort NOT proven" :
        "IN PROGRESS / metadata provisional"],
      ["MODEL SOURCE", response.source?.resolvedModel || "NOT OBSERVED"],
      ["EFFORT SOURCE", response.source?.resolvedEffort || "NOT REPORTED"],
    ]);
    // Historical evidence never substitutes CURRENT. Its timestamp and
    // origin remain visible, especially when the current cached turn is stale.
    const good = snapshot.lastGoodStatus || {};
    const lastFinal = good.lastFinal || null;
    const lastEffort = good.lastResolvedEffort || null;
    makeLane("good", "LAST GOOD / 최근 완료 응답 · 적용 Effort 증거는 별도", [
      ["GOOD STATUS", !lastFinal ? "NO COMPLETED RESPONSE OBSERVED" :
        lastEffort ? "EXPLICIT RESOLVED EFFORT REPORTED (execution NOT proven)" :
        lastFinal.responseEffort ? "RESPONSE EFFORT OBSERVED / resolved Effort NOT REPORTED" :
          "COMPLETED RESPONSE OBSERVED / Effort NOT REPORTED"],
      ["LAST EFFORT", lastFinal?.responseEffort ?
        lastFinal.responseEffort + " (response-reported; NOT applied proof)" :
        "NOT OBSERVED in last completed response"],
      ["LAST EFFORT SOURCE", lastFinal?.responseEffortSource ||
        (lastFinal?.responseEffort ? "legacy heartbeat: provenance not persisted" : "NOT REPORTED")],
      ["INDEPENDENT EFFORT", lastEffort?.value ||
        "NOT REPORTED (no explicit resolved_* response field)"],
      ["INDEPENDENT SOURCE", lastEffort?.source || "NOT REPORTED"],
      ["INDEPENDENT AT", lastEffort?.createdAt || "NEVER OBSERVED"],
      ["INDEPENDENT ORIGIN", lastEffort?.sourceKind || "NEVER OBSERVED"],
      ["ACTUAL EXECUTION", "NOT VERIFIED (thinking_effort echo excluded from resolved gate)"],
      ["— HISTORY —", "Message completion is not applied-effort proof"],
      ["LAST FINAL", lastFinal ?
        "finished_successfully (message completed only)" : "NEVER OBSERVED"],
      ["REPORTED MODEL", present(lastFinal?.model)],
      ["RESOLVED MODEL", present(lastFinal?.resolvedModel)],
      ["FINAL CREATED", lastFinal?.createdAt || "NEVER OBSERVED"],
      ["CAPTURED AT", lastFinal?.observedAt || "NEVER OBSERVED"],
      ["FINALS SEEN", String(good.qualifiedFinals || 0) +
        " distinct final timestamps; NOT Effort verifications"],
      ["HISTORY SOURCE", lastFinal ?
        (lastFinal.sourceKind === "live-render" ?
          "verified live-turn metadata" : "verified active conversation cache") +
        (lastFinal.wasCachedBeforeSend ? " (older than latest send)" : "") :
        "NEVER OBSERVED"],
    ]);
    makeLane("sent", "송신 의도 / CLIENT → SERVER · UI 선택 ≠ 전송 패킷", [
      ["UI MODEL", present(ui.model) +
        (ui.displayModel ? " (UI: " + ui.displayModel + ")" : "")],
      ["UI EFFORT", present(ui.effort) +
        (ui.displayEffort ? " (UI: " + ui.displayEffort + ")" : "")],
      ["isMaximum", present(ui.isMaximumSelection) +
        " (separate from reasoning effort)"],
      ["LAST UI SEND", lastSend ?
        lastSend.at + " | " + lastSend.model + " / " + lastSend.effort :
        "NOT OBSERVED (future gestures only)"],
      ["WIRE REQ MODEL", present(wire.requestedModel) +
        " (CDP evidence only; not tied to current turn)"],
      ["WIRE REQ EFFORT", present(wire.requestedEffort) +
        " (CDP evidence only; not tied to current turn)"],
    ]);
    // Source-of-truth is the existing authenticated Codex Desktop /wham/usage
    // poller. Do not treat these 5h/weekly limits as ChatGPT chat-message quota.
    const usageState = window.__sparkProgressState?.usage || {};
    const quota = usageState.data || {};
    const validPct = (x) => typeof x === "number" &&
      Number.isFinite(x) && x >= 0 && x <= 100 ? x : null;
    const pct = (x) => {
      const v = validPct(x);
      return v === null ? "NOT REPORTED" : (Math.round(v * 10) / 10) + "%";
    };
    const stamp = (epochSeconds) => {
      const n = Number(epochSeconds);
      if (!Number.isFinite(n) || n <= 0) return "NOT REPORTED";
      const date = new Date(n * 1000);
      return Number.isNaN(date.getTime()) ? "NOT REPORTED" :
        date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) +
        " (local)";
    };
    const labelWindow = (windowObj, otherwise) => {
      const mins = windowObj?.windowMinutes;
      return mins != null && Math.abs(mins - 300) < 1 ? "5H" :
        mins != null && Math.abs(mins - 10080) < 1 ? "7D" : otherwise;
    };
    const first = quota.primary, second = quota.secondary;
    const lastSuccess = Number(usageState.lastSuccessAt ||
      (quota.primary || quota.secondary ? usageState.fetchedAt : 0));
    const usageAgeMs = lastSuccess > 0 ? Math.max(0, Date.now() - lastSuccess) : null;
    const usageStatus = usageState.error ? "ERROR / last cached values may be stale: " +
      String(usageState.error).slice(0, 120) :
      usageAgeMs !== null && usageAgeMs > 90_000 ?
        "STALE (last successful update >90s ago)" :
        usageState.inFlight ? "REFRESHING" :
        first || second ? "LIVE / last successful API response" : "UNAVAILABLE";
    const quotaRows = [
      ["SOURCE", "Codex Desktop /wham/usage; NOT ChatGPT chat quota"],
      ["PLAN", quota.planType || "NOT REPORTED"],
      [labelWindow(first, "PRIMARY") + " USED", pct(first?.usedPercent)],
      [labelWindow(first, "PRIMARY") + " LEFT", pct(first?.remainingPercent)],
      [labelWindow(first, "PRIMARY") + " RESET", stamp(first?.resetAt)],
      [labelWindow(second, "SECONDARY") + " USED", pct(second?.usedPercent)],
      [labelWindow(second, "SECONDARY") + " LEFT", pct(second?.remainingPercent)],
      [labelWindow(second, "SECONDARY") + " RESET", stamp(second?.resetAt)],
      ["LIMIT REACHED", quota.limitReached == null ?
        "NOT REPORTED" : String(quota.limitReached)],
      ["LAST SUCCESS", lastSuccess > 0 ?
        new Date(lastSuccess).toLocaleString(undefined,
          { dateStyle: "short", timeStyle: "medium" }) + " (local)" :
        "NOT OBSERVED"],
      ["REFRESH", usageStatus],
    ];
    for (const [i, item] of (Array.isArray(quota.additional) ?
      quota.additional.slice(0, 8) : []).entries()) {
      quotaRows.push(["EXTRA #" + (i + 1), String(item?.name || "additional").slice(0, 60)]);
      quotaRows.push(["EXTRA 5H", pct(item?.primary?.usedPercent) + " used"]);
      quotaRows.push(["EXTRA 7D", pct(item?.secondary?.usedPercent) + " used"]);
    }
    const quotaLane = makeLane("usage", "USAGE / CODEX QUOTA · live /wham/usage", quotaRows);
    for (const [label, windowValue] of [
      [labelWindow(first, "PRIMARY"), first],
      [labelWindow(second, "SECONDARY"), second],
    ]) {
      const used = validPct(windowValue?.usedPercent);
      if (used === null) continue;
      const wrap = document.createElement("div");
      wrap.setAttribute("data-route-quota-bar", label);
      wrap.style.cssText = "margin:6px 0";
      const caption = document.createElement("div");
      caption.textContent = label + " " + pct(used) + " used / " +
        pct(windowValue?.remainingPercent) + " left";
      caption.style.cssText = "font-size:11px;color:#e6d9b1;margin-bottom:3px";
      const rail = document.createElement("div");
      rail.setAttribute("role", "progressbar");
      rail.setAttribute("aria-label", "Codex " + label + " used");
      rail.setAttribute("aria-valuenow", String(used));
      rail.setAttribute("aria-valuemin", "0");
      rail.setAttribute("aria-valuemax", "100");
      rail.style.cssText = "height:7px;background:#514a38;" +
        "border-radius:4px;overflow:hidden";
      const fill = document.createElement("div");
      fill.style.cssText = "height:100%;border-radius:4px;background:#deb05f;" +
        "width:" + used + "%";
      rail.appendChild(fill);
      wrap.append(caption, rail);
      quotaLane.appendChild(wrap);
    }
    makeLane("diagnostic", "진단 / CAPTURE · connection", [
      ["CDP TARGETS", (capture.state || "unknown") + " / " +
        (capture.attachedTargets ?? 0) + "/" + (capture.targetCount ?? 0)],
      ["BACKGROUND", (metrics.requests ?? 0) + " HTTP | " +
        (metrics.frames ?? 0) + " WS frames | " + (metrics.failures ?? 0) + " failures"],
      ["STREAM SERVER", present(wire.serverModel) + " / " +
        present(wire.serverEffort) + " (unlinked CDP evidence)"],
      ...(capture.lastError ? [["CAPTURE ERROR", capture.lastError]] : []),
    ]);
    advanced.appendChild(summary);

    const showDiagnostics = window.__sparkRouteShowNetworkDiagnostics === true;
    const diagnosticToggle = document.createElement("button");
    diagnosticToggle.type = "button";
    diagnosticToggle.setAttribute("data-route-toggle-network", "");
    diagnosticToggle.style.cssText =
      "width:100%;text-align:left;background:#2a3445;color:#dce8ff;" +
      "border:1px solid #556174;border-radius:4px;padding:6px;margin-bottom:8px;cursor:pointer";
    diagnosticToggle.textContent = showDiagnostics ?
      "Hide background HTTP / WebSocket diagnostics" :
      "Show network diagnostics (" + (metrics.requests ?? 0) + " requests)";
    diagnosticToggle.onclick = () => {
      window.__sparkRouteShowNetworkDiagnostics = !showDiagnostics;
    };
    advanced.appendChild(diagnosticToggle);

    const candidates = [...snapshot.active, ...snapshot.recent]
      .filter((item) => {
        const route = item.route || {};
        const relevant = Boolean(item.chatGeneration || route.requestedModel ||
          route.requestedEffort || route.resolvedModel || route.resolvedEffort ||
          route.serverModel || route.serverEffort);
        return relevant || (showDiagnostics &&
          (item.startedAt || item.method || item.failure));
      })
      .sort((a, b) => Number(Boolean(
        b.chatGeneration || b.route?.requestedModel || b.route?.resolvedModel ||
          b.route?.serverModel,
      )) - Number(Boolean(
        a.chatGeneration || a.route?.requestedModel || a.route?.resolvedModel ||
          a.route?.serverModel,
      )))
      .slice(0, showDiagnostics ? 24 : 8);

    if (!candidates.length) {
      const help = document.createElement("p");
      help.setAttribute("data-route-no-evidence", "");
      help.style.cssText = "color:#c8d3e5;margin:5px 0";
      help.textContent = (capture.attachedTargets ?? 0) > 0
        ? "Response metadata uses the current rendered assistant turn (or verified " +
          "conversation cache). The desktop app's native generation HTTP packets " +
          "are not visible in renderer CDP; wire-request metadata remains unverified."
        : "Waiting for a ChatGPT CDP network target.";
      advanced.appendChild(help);
    }

    for (const item of candidates) {
      const record = document.createElement("pre");
      record.style.cssText =
        "white-space:pre-wrap;word-break:break-word;margin:0;padding:8px 0;" +
        "border-top:1px solid #424b5d;font:11px/1.5 Consolas,monospace";
      const route = item.route || {};
      const hasModelData = Boolean(
        route.requestedModel || route.requestedEffort || route.resolvedModel ||
          route.resolvedEffort || route.serverModel || route.serverEffort,
      );
      const relevant = item.chatGeneration || hasModelData;
      const lines = [
        [item.method || "NETWORK", item.responseStatus ?? "", item.url || ""]
          .filter(Boolean).join(" | "),
        "Start: " + (item.startedAt || "before capture") +
          " | End: " + (item.finishedAt || "pending"),
        "Duration: " + (item.wallTimeMs ?? "unavailable") + "ms" +
          " | Encoded: " + (item.responseBytes ?? item.encodedDataLength ?? 0) + " B" +
          " | Decoded: " + (item.decodedDataLength ?? 0) + " B",
      ];
      if (item.websocket?.framesReceived || item.websocket?.framesSent) {
        lines.push("WebSocket: received " + item.websocket.framesReceived +
          " frames / sent " + item.websocket.framesSent + " frames");
      }
      if (relevant) {
        const available = (v) => v == null ? "NOT OBSERVED" : String(v);
        lines.push("Requested: " + available(route.requestedModel) +
          " / " + available(route.requestedEffort));
        lines.push("Resolved:  " + available(route.resolvedModel) +
          " / " + available(route.resolvedEffort));
        lines.push("Server:    " + available(route.serverModel) +
          " / " + available(route.serverEffort));
        if (!hasModelData) lines.push("No model metadata emitted or captured for this request.");
        lines.push("Source: " + JSON.stringify(route.fieldSources || {}));
        if (Object.keys(route.metadata || {}).length) {
          lines.push("Metadata: " + JSON.stringify(route.metadata));
        }
      }
      if (item.failure) lines.push("Failure: " + item.failure);
      record.textContent = lines.join("\n");
      advanced.appendChild(record);
    }
    // Full bounded, privacy-screened metadata inventory for the active
    // response turn. Never put prompt text, IDs, auth values or raw SSE here.
    const extra = response.extraMetadata || { rows: [], observedFields: 0 };
    const inventory = document.createElement("section");
    inventory.setAttribute("data-route-metadata-inventory", "");
    inventory.style.cssText =
      "border:1px solid #59677d;border-radius:6px;padding:9px;" +
      "margin:12px 0 0;background:#1b2231;box-sizing:border-box";
    const inventoryTitle = document.createElement("div");
    inventoryTitle.style.cssText =
      "font-weight:700;color:#edf2ff;border-bottom:1px solid #49566b;" +
      "margin-bottom:7px;padding-bottom:6px";
    inventoryTitle.textContent = "추가 메타데이터 / ALL CAPTURED SAFE FIELDS";
    inventory.appendChild(inventoryTitle);
    const explain = document.createElement("p");
    explain.style.cssText = "color:#a6b4cf;font-size:11px;margin:0 0 7px";
    explain.textContent = "현재 턴의 assistant / user 메타데이터를 출처별로 표시합니다. " +
      "비공개 ID·대화 본문·인증 값은 마스킹하며 배열은 개수만 표시합니다. " +
      "이 목록은 보안 필터와 수집 상한을 적용한 관측 정보이며, " +
      "네트워크 증거는 현재 턴과 연결되지 않았으면 별도 표시합니다.";
    inventory.appendChild(explain);

    const buildInventory = (list) => {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;table-layout:fixed;" +
        "font:11px/1.5 Consolas,monospace;color:#e7eefa";
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const [name, width] of [["Metadata field / provenance","58%"],["Value / type","42%"]]) {
        const th = document.createElement("th");
        th.textContent = name;
        th.style.cssText = "border:1px solid #4b5b76;padding:5px;text-align:left;" +
          "background:#263248;color:#c6dcfb;width:" + width;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const field of list) {
        const line = document.createElement("tr");
        line.setAttribute("data-route-extra-field", field.field);
        const left = document.createElement("td");
        left.style.cssText = "border:1px solid #4b5b76;padding:5px;" +
          "vertical-align:top;overflow-wrap:anywhere";
        const name = document.createElement("div");
        name.textContent = field.field;
        name.style.cssText = "color:#c9dfff;font-weight:600";
        const provenance = document.createElement("small");
        provenance.textContent = field.source || "source unknown";
        provenance.style.cssText = "display:block;color:#899bb7;overflow-wrap:anywhere";
        left.append(name, provenance);
        const value = document.createElement("td");
        value.style.cssText = "border:1px solid #4b5b76;padding:5px;" +
          "vertical-align:top;overflow-wrap:anywhere";
        const raw = document.createElement("div");
        raw.textContent = String(field.value);
        raw.style.cssText = "color:" +
          (String(field.value).startsWith("[REDACTED") ? "#ffbd94" : "#f1f4fa");
        const type = document.createElement("small");
        type.textContent = String(field.type || "unknown");
        type.style.cssText = "display:block;color:#98a9c6";
        value.append(raw, type);
        line.append(left, value);
        tbody.appendChild(line);
      }
      table.appendChild(tbody);
      return table;
    };
    const rows = Array.isArray(extra.rows) ? extra.rows.slice(0, 512) : [];
    const totals = document.createElement("div");
    totals.setAttribute("data-route-metadata-count", "");
    totals.style.cssText = "color:#a2b8d6;font-size:11px;margin-bottom:6px";
    totals.textContent = rows.length + " displayed / " +
      (extra.observedFields ?? 0) + " inspected" +
      (extra.truncated ? " (bounded, truncated)" : "") +
      "; sensitive values withheld";
    inventory.appendChild(totals);
    if (rows.length) inventory.appendChild(buildInventory(rows));
    else {
      const empty = document.createElement("p");
      empty.textContent = "No captured metadata in the current turn.";
      inventory.appendChild(empty);
    }

    // CURRENT can be generating while an earlier FINAL has independent metadata.
    const historical = response.historicalFinal;
    const differentCompleted = historical?.status === "observed" &&
      historical.messageStatus === "finished_successfully" &&
      historical.createdAt &&
      (response.messageStatus !== "finished_successfully" ||
        historical.createdAt !== response.createdAt);
    const historicalExtra = differentCompleted ? historical.extraMetadata : null;
    const historicalRows = Array.isArray(historicalExtra?.rows) ?
      historicalExtra.rows.slice(0, 512) : [];
    if (differentCompleted) {
      const historyTitle = document.createElement("p");
      historyTitle.style.cssText = "color:#b4eee8;margin:12px 0 5px;font-weight:700";
      historyTitle.textContent = "LATEST COMPLETED FINAL metadata (" +
        historical.createdAt + "; " + historical.sourceKind + "): " +
        historicalRows.length + " displayed / " +
        (historicalExtra?.observedFields ?? 0) + " inspected" +
        (historicalExtra?.truncated ? " (bounded)" : "");
      inventory.appendChild(historyTitle);
      if (historicalRows.length) inventory.appendChild(buildInventory(historicalRows));
    }

    const captureRows = [];
    const networkTypes = wire.metadataKeyTypes || {};
    for (const [key, type] of Object.entries(networkTypes).slice(0, 512)) {
      const redactedKey = /(?:^|_)(?:id|token|session|user|request|trace|auth|content|message)(?:_|$)/i.test(key);
      const exists = Object.prototype.hasOwnProperty.call(wire.metadata || {}, key);
      const value = exists ? wire.metadata[key] : undefined;
      const safeScalar = value === null ||
        typeof value === "number" || typeof value === "boolean" ||
        (typeof value === "string" && /^[a-z0-9._:+-]{1,80}$/i.test(value));
      captureRows.push({
        field: key,
        source: wire.metadataSources?.[key] ||
          "unlinked:server_ste_metadata.metadata." + key,
        type: type || "unknown",
        value: redactedKey ? "[REDACTED identifier/content]" :
          !exists ? "[WITHHELD: metadata key/type observed, value not allowlisted]" :
          safeScalar ? String(value) :
          Array.isArray(value) ? "[array: " + value.length + " items; values withheld]" :
            "[not shown]",
      });
    }
    const networkTitle = document.createElement("p");
    networkTitle.style.cssText = "margin:10px 0 5px;color:#b4cce9";
    networkTitle.textContent = "CDP stream metadata (NOT linked to current turn): " +
      captureRows.length + " fields";
    inventory.appendChild(networkTitle);
    if (captureRows.length) inventory.appendChild(buildInventory(captureRows));

    // Exhaustive (within capture bounds) Effort-related field audit. It never
    // upgrades a request or response thinking_effort echo to applied Effort.
    const completedRows = response.status === "observed" &&
      response.messageStatus === "finished_successfully" ? rows : historicalRows;
    const completedAt = response.status === "observed" &&
      response.messageStatus === "finished_successfully" ?
        response.createdAt : differentCompleted ? historical.createdAt : null;
    const finalEffortFields = completedRows.filter((field) =>
      /^assistant\.final\.metadata\.(?:thinking_effort|reasoning_effort|resolved_effort|resolved_thinking_effort|resolved_reasoning_effort)$/.test(field.source));
    const independentFields = finalEffortFields.filter((field) =>
      /^assistant\.final\.metadata\.resolved_/.test(field.source) &&
      !String(field.value).startsWith("[REDACTED") &&
      field.value !== "null");
    const effortTitle = document.createElement("div");
    effortTitle.setAttribute("data-route-effort-audit", "");
    effortTitle.style.cssText = "color:#b4eee8;margin:12px 0 6px;font-weight:700";
    effortTitle.textContent = "EFFORT FIELD AUDIT / 수집된 Effort 관련 필드";
    inventory.appendChild(effortTitle);
    const auditStatus = document.createElement("p");
    auditStatus.style.cssText =
      "color:#dce8ff;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px";
    auditStatus.textContent = "Last completed final: " +
      (completedAt || "NOT OBSERVED") + "\n" +
      "Final thinking/reasoning effort fields: " + finalEffortFields.length + "\n" +
      "Explicit resolved_* effort fields: " + independentFields.length + "\n" +
      "Applied computation: NOT VERIFIED by response metadata alone" +
      (independentFields.length ? "" :
        "\nNo explicit resolved_* Effort field found in the captured completed final.");
    inventory.appendChild(auditStatus);
    const effortRows = [
      ...rows.map((row) => ({ ...row, field: "CURRENT: " + row.field })),
      ...historicalRows.map((row) => ({ ...row, field: "LAST FINAL: " + row.field })),
      ...captureRows.map((row) => ({ ...row, field: "UNLINKED NETWORK: " + row.field })),
    ].filter((row) => /(?:effort|reasoning|thinking)/i.test(row.field)).slice(0, 256);
    if (effortRows.length) inventory.appendChild(buildInventory(effortRows));


    const candidateFields = [
      "resolved_effort", "resolved_thinking_effort", "resolved_reasoning_effort",
      "server_ste_metadata.metadata.model_slug",
      "server_ste_metadata.metadata.thinking_effort",
      "requested_model_experience", "did_auto_switch_to_reasoning",
      "is_autoswitcher_enabled", "auto_switcher_race_winner",
      "server_ttfvt_ms", "cluster_region", "turn_mode", "turn_use_case",
      "reasoning_start_time", "reasoning_end_time", "finished_duration_sec",
      "fast_convo", "warmup_state", "tool_invoked", "tool_name",
      "is_search", "is_multimodal",
    ];
    const capturedKeys = new Set([...rows, ...historicalRows].map((r) => r.field));
    const unobserved = candidateFields.filter((name) =>
      !capturedKeys.has(name) && !(name in (wire.metadata || {})));
    const candidatesTitle = document.createElement("p");
    candidatesTitle.style.cssText = "color:#b4cce9;margin:10px 0 5px;font-weight:600";
    candidatesTitle.textContent = "Potential transport fields · NOT OBSERVED (" +
      unobserved.length + ")";
    inventory.appendChild(candidatesTitle);
    const potential = document.createElement("div");
    potential.setAttribute("data-route-potential-fields", "");
    potential.style.cssText = "color:#ffcf8e;font-size:11px;overflow-wrap:anywhere;" +
      "white-space:pre-wrap";
    potential.textContent = unobserved.join(" · ") ||
      "All listed candidates already represented in captured keys";
    inventory.appendChild(potential);
    advanced.appendChild(inventory);
    }
    details.scrollTop = oldScroll;
  }

  return {
    installed: true, mode: layout.mode, expanded: !details.hidden,
    chatWidth: Math.round(mainRect.width), reservedCssPixels: Number.parseInt(main.style.marginRight, 10),
    panelWidth: layout.width, panelTop,
    mainRight: Math.round(mainRect.right), panelLeft: Math.round(root.getBoundingClientRect().left),
    completed: snapshot.recent.length,
    uiSelection: ui, responseEvidence: response, staleResponse, lastComposerSend: lastSend,
    recordingCommand: window.__sparkRouteRecordingCommand || null,
    recordingObservation,
  };
}

export function buildRouteOverlayExpression(snapshot) {
  // Explicit opt-in diagnostic: bounded user-message TEXT is sent only to
  // the local renderer for immediate display. Never return or persist this
  // content through recordingObservation, heartbeat, JSONL or audit.
  const flow = snapshot.flow || {};
  const safe = JSON.stringify({
    metrics: snapshot.metrics,
    capture: snapshot.capture,
    recent: snapshot.completed.slice(0, 20),
    active: snapshot.active.slice(-8),
    updatedAt: snapshot.generatedAt,
    lastGoodStatus: normalizeLastGood(snapshot.lastGoodStatus),
    recording: snapshot.recording || {active:false,lastCommandSequence:0},
    flow: {
      source: "CHROMIUM_RENDERER_CDP_ONLY",
      httpObserved: Number(flow.httpObserved) || 0,
      wsObserved: Number(flow.wsObserved) || 0,
      lastEventAt: flow.lastEventAt || null,
      entries: (Array.isArray(flow.entries) ? flow.entries : []).slice(0,6).map(e => ({
        at:e.at,channel:e.channel,tls:e.tls,protocol:e.protocol,
        message: { text:String(e.message?.text || "").slice(0,20_000),
          truncated:e.message?.truncated === true,
          shape:e.message?.shape,fullChars:e.message?.fullChars }
      }))
    },
  }).replace(/</g, "\\u003c");
  return "(" + renderRouteOverlay.toString() + ")(" + safe + ",(" +
    chooseRouteDockLayout.toString() + "),(" +
    readUiSelectionFromDom.toString() + "),(" +
    extractSelectedModelFromFiber.toString() + "),(" +
    ensureUiSubmissionObserver.toString() + "),(" +
    readActiveResponseFromDom.toString() + "),(" +
    readActiveResponseFromReactRoot.toString() + "),(" +
    extractLatestFinalResponse.toString() + "),(" +
    responsePredatesObservedSend.toString() + "))";
}
