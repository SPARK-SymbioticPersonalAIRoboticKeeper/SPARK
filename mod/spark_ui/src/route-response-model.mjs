// Read the FINAL assistant message's server-returned metadata from the ACTIVE
// conversation in the ChatGPT Windows React Query cache.
// Never read message.content, prompt text, auth credentials or conversation IDs
// into a returned record. This does not prove the underlying model weights used.

export function extractLatestFinalResponse(conversation) {
  // Standalone: injected into the desktop renderer via CDP Function.toString().
  const pickModel = (v) => typeof v === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(v) ? v : null;
  const pickEffort = (v) => typeof v === "string" &&
    /^(?:none|instant|minimal|min|low|standard|medium|extended|high|xhigh|max|ultra|pro)$/i.test(v) ?
      v.toLowerCase() : null;
  const rows = [], seenFields = new Set(), maxRows = 512, maxFields = 1500;
  let totalFields = 0, redactedFields = 0;
  const isSensitive = (key) => {
    const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    return /(?:^|[_-])(?:id|ids|uuid|token|auth|cookie|password|credential|session|secret|private|email|user|account|phone|address|content|text|prompt|body|input|output|url|file|attachment|trace|search_result|safe_url|story_event|conversation|message|ssn|dob|birth|payment|credit|card|location|ip)(?:$|[_-])/i.test(normalized) ||
      /(?:reference|citation|merged|parent|streaming|working_turn|turn_exchange|request_id)/i.test(normalized);
  };
  const safeString = (key, value) => {
    if (isSensitive(key)) return "[REDACTED identifier/content]";
    // Short strings can still be secrets or copied prompt text; enum-like
    // characters alone do not make an arbitrary metadata value safe.
    if (/fallbackMarkdown|(?:^|[._-])(?:code|markdown|title|summary|snippet|classifier_response)(?:$|[._-])/i.test(key))
      return "[REDACTED free text]";
    const safeEnum = /^(?:model_slug|resolved_model_slug|default_model_slug|thinking_effort|resolved_effort|resolved_thinking_effort|resolved_reasoning_effort|cot_version|chime_version|message_type|reasoning_status|summary_type|tool_summary_type|view_state|plan_type|plan_type_bucket|product_experience|requested_model_experience|turn_use_case|turn_mode|model_provider|archetype|region|cluster_region|warmup_state|delta_encoding|auto_switcher_race_winner|finish_details\.type|logical_answer_prefix_activity\.visibility|model_dil_v2\.fallbackMarkdownVersion)$/i.test(key);
    if (!safeEnum) return "[REDACTED unclassified string]";
    if (typeof value !== "string" || !value) return value === "" ? "(empty)" : "[unavailable]";
    if (value.length > 96 || !/^[\p{L}\p{N}_.:+-]+$/u.test(value)) return "[REDACTED free text]";
    return value;
  };
  const addValue = (key, value, channel, depth = 0) => {
    if (rows.length >= maxRows || totalFields >= maxFields) return;
    if (typeof key !== "string" || !/^[a-zA-Z][\w.-]{0,90}$/.test(key)) return;
    const label = channel === "user" ? "user.metadata." + key :
      "assistant." + channel + ".metadata." + key;
    // Count distinct fields only; repeated metadata on streamed fragments
    // must not exhaust the inventory before all keys have been examined.
    if (seenFields.has(label)) return;
    seenFields.add(label);
    totalFields++;
    let kind = "unknown", visible = "[unsupported]";
    if (isSensitive(key)) { kind = Array.isArray(value) ? "array" :
      value === null ? "null" : typeof value;
      visible = "[REDACTED identifier/content]";
    } else if (value === null) { kind = "null"; visible = "null"; }
    else if (typeof value === "boolean") { kind = "boolean"; visible = String(value); }
    else if (typeof value === "number") {
      kind = "number"; visible = Number.isFinite(value) ? String(value) : "[nonfinite]";
    } else if (typeof value === "string") { kind = "string"; visible = safeString(key, value); }
    else if (Array.isArray(value)) {
      kind = "array"; visible = "[array: " + value.length + " items; values withheld]";
    } else if (value && typeof value === "object") {
      kind = "object";
      const count = Object.keys(value).length;
      visible = "[object: " + count + " keys; see safe fields below]";
    }
    if (visible.startsWith("[REDACTED")) redactedFields++;
    rows.push({ field: key, source: label, type: kind, value: visible });
    // Only safely typed scalar children of one-level objects are exposed;
    // arbitrary nested arrays, citations, prompts and IDs are never traversed.
    if (kind === "object" && depth < 2 && !isSensitive(key)) {
      for (const child of Object.keys(value).slice(0, 48)) {
        const v = Object.getOwnPropertyDescriptor(value, child)?.value;
        if (v == null || ["string", "number", "boolean"].includes(typeof v) ||
            Array.isArray(v)) {
          addValue(key + "." + child, v, channel, 1);
        }
      }
    }
  };
  const extra = () => ({
    rows, observedFields: totalFields, redactedFields,
    truncated: rows.length >= maxRows || totalFields >= maxFields,
    policy: "Identifiers and content are redacted; arrays show count only",
  });
  const blank = (status) => ({
    status, model: null, resolvedModel: null, effort: null,
    resolvedEffort: null, resolvedEffortStatus: "not-reported",
    extraMetadata: extra(),
  });
  if (!conversation || typeof conversation !== "object" ||
      !conversation.mapping || typeof conversation.mapping !== "object" ||
      typeof conversation.current_node !== "string") {
    return blank("unavailable");
  }

  const mapping = conversation.mapping, seen = new Set();
  let id = conversation.current_node, assistantInterim = false, chosen = null;
  // The active current-node ancestry is the only authorized message range.
  // Each earlier assistant message in THIS turn can contribute safe metadata.
  // Stop before crossing the next user message to avoid another turn's fields.
  for (let depth = 0; typeof id === "string" && id.length &&
      depth < 300 && !seen.has(id); depth++) {
    seen.add(id);
    const node = Object.getOwnPropertyDescriptor(mapping, id)?.value;
    const message = node?.message;
    if (node?.id !== id || message?.id !== id) {
      return blank("invalid-path");
    }
    if (message.author?.role === "user") {
      // Inspect the current turn's request-side metadata, but never its content.
      // Provenance stays user.metadata.* and cannot establish applied Effort.
      const userMeta = message.metadata;
      if (userMeta && typeof userMeta === "object" && !Array.isArray(userMeta)) {
        for (const key of Object.keys(userMeta).slice(0, 512)) {
          addValue(key, Object.getOwnPropertyDescriptor(userMeta, key)?.value, "user");
        }
      }
      return chosen ? { ...chosen, extraMetadata: extra() } :
        blank(assistantInterim ? "generating" : "awaiting-response");
    }
    if (message.author?.role === "assistant") {
      const meta = message.metadata;
      const channel = typeof message.channel === "string" &&
        /^[a-z0-9_-]{1,24}$/i.test(message.channel) ? message.channel : "assistant";
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        for (const key of Object.keys(meta).slice(0, 512)) {
          addValue(key, Object.getOwnPropertyDescriptor(meta, key)?.value, channel);
        }
      }
      if (!chosen && (message.channel === "final" || meta?.end_turn === true)) {
        const ts = Number(message.create_time);
        const createdAt = Number.isFinite(ts) && ts > 0 ?
          new Date(ts < 10_000_000_000 ? ts * 1000 : ts).toISOString() : null;
        const model = pickModel(meta?.model_slug);
        const resolvedModel = pickModel(meta?.resolved_model_slug);
        const effort = pickEffort(meta?.thinking_effort);
        const candidates = ["resolved_thinking_effort", "resolved_reasoning_effort",
          "resolved_effort"].map((key) => ({ key, value: pickEffort(meta?.[key]) }))
          .filter((entry) => entry.value !== null);
        const consistent = candidates.every((entry) =>
          entry.value === candidates[0]?.value);
        const resolvedEffort = consistent ? (candidates[0]?.value || null) : null;
        const resolvedEffortKey = consistent ? (candidates[0]?.key || null) : null;
        chosen = {
          status: model || resolvedModel || effort || resolvedEffort ?
            "observed" : "metadata-unavailable",
          model, resolvedModel, effort, resolvedEffort,
          resolvedEffortStatus: !consistent ? "conflicting-fields" :
            resolvedEffort ? "observed" : "not-reported",
          defaultModel: pickModel(meta?.default_model_slug),
          createdAt,
          messageStatus: typeof message.status === "string" ?
            message.status.slice(0, 60) : null,
          source: {
            model: model ? "assistant.final.metadata.model_slug" : null,
            resolvedModel: resolvedModel ? "assistant.final.metadata.resolved_model_slug" : null,
            effort: effort ? "assistant.final.metadata.thinking_effort" : null,
            resolvedEffort: resolvedEffortKey ?
              "assistant.final.metadata." + resolvedEffortKey : null,
          },
        };
      }
      if (message.channel !== "analysis" && message.recipient !== "api_tool.call_tool") {
        assistantInterim = true;
      }
    }
    id = node.parent;
  }
  return chosen ? { ...chosen, extraMetadata: extra() } : blank("path-limit");
}

export function readActiveResponseFromReactRoot(root, extract) {
  const unavailable = (status) =>
    ({ status, model: null, resolvedModel: null, effort: null });
  if (!root || typeof root !== "object" || typeof extract !== "function") {
    return unavailable("no-react-root");
  }

  const stack = [root], activeIDs = new Set(), clients = new Set();
  const recentEntries = new Set(), renderedSnapshots = new Set();
  let count = 0;
  let inspectedMemoItems = 0;
  let cappedLive = false;
  // Only named navigation props, current turn object references and bounded
  // React compiler memo slots. Never copy raw message/response content.
  while (stack.length && count < 40_000) {
    const f = stack.pop();
    count++;
    if (f !== root && f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
    const props = f.memoizedProps;
    if (props && typeof props === "object") {
      const active = props.activeServerConversationId;
      if (typeof active === "string" && active.length >= 16 && active.length <= 150) {
        activeIDs.add(active);
      }
      if (props.entry?.isMostRecentTurn === true &&
          Array.isArray(props.entry.turn?.items)) recentEntries.add(props.entry);
      for (const value of [props.client, props.queryClient, props.value]) {
        if (value && typeof value.getQueryCache === "function") clients.add(value);
      }
    }
    // Current conversation model may be held in the React compiler memo cache,
    // not the older React Query server-history cache. The live model is accepted
    // only if it owns the current turn AND its user message ID.
    const memo = f.updateQueue?.memoCache?.data;
    if (!Array.isArray(memo) || cappedLive) continue;
    if (memo.length > 160) { cappedLive = true; continue; }
    for (const row of memo) {
      if (!Array.isArray(row) || row.length > 2_000) {
        cappedLive = true;
        break;
      }
      for (const item of row) {
        if (++inspectedMemoItems > 450_000) {
          cappedLive = true;
          break;
        }
        if (item && typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, "renderedConversation") &&
            Array.isArray(item.renderedTurns) && item.renderedTurns.length <= 2_000) {
          renderedSnapshots.add(item);
        }
      }
      if (cappedLive) break;
    }
  }
  if (stack.length) return unavailable("fiber-limit");
  if (activeIDs.size !== 1) return unavailable(
    activeIDs.size ? "ambiguous-active-conversation" : "active-conversation-unavailable");
  const activeId = [...activeIDs][0];
  // The visible chat title is permitted solely for opt-in local diagnostic logs.
  // It is read only from the verified active conversation, never another tab.
  const safeTitle = (obj) => typeof obj?.title === "string" &&
    obj.title.length > 0 && obj.title.length <= 180 ? obj.title : null;
  let matching = null;
  for (const client of clients) {
    let queries;
    try { queries = client.getQueryCache().getAll(); }
    catch { continue; }
    if (!Array.isArray(queries)) continue;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 ||
          key[0] !== "chatgpt-conversation" || key[1] !== activeId) continue;
      const data = query.state?.data;
      if (!data || data.conversation_id !== activeId) continue;
      if (matching && matching !== data) return unavailable("ambiguous-response-cache");
      matching = data;
    }
  }


  // CURRENT may be generating while an earlier turn already completed.
  // Walk only the verified active conversation's current-node ancestry and
  // return a minimal historical final. NEVER replace the current response.
  const recentCompleted = (conversation, sourceKind, verification) => {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object" ||
        typeof conversation.current_node !== "string") return null;
    const seen = new Set();
    let cursor = conversation.current_node;
    for (let depth = 0; depth < 2_000 &&
        typeof cursor === "string" && cursor.length &&
        !seen.has(cursor); depth++) {
      seen.add(cursor);
      const node = Object.getOwnPropertyDescriptor(mapping, cursor)?.value;
      const message = node?.message;
      if (node?.id !== cursor || message?.id !== cursor) return null;
      if (message.author?.role === "assistant" &&
          message.channel === "final" &&
          message.status === "finished_successfully") {
        // Extract through the already-tested safe collector. Only the
        // chosen node/path is projected; never expose another turn's text/IDs.
        const evidence = extract({
          current_node: cursor, mapping,
        });
        if (evidence?.status === "observed" &&
            evidence.messageStatus === "finished_successfully" &&
            typeof evidence.createdAt === "string") {
          return {
            status: "observed",
            messageStatus: "finished_successfully",
            model: evidence.model,
            resolvedModel: evidence.resolvedModel,
            effort: evidence.effort,
            resolvedEffort: evidence.resolvedEffort,
            resolvedEffortStatus: evidence.resolvedEffortStatus,
            createdAt: evidence.createdAt,
            source: evidence.source,
            extraMetadata: evidence.extraMetadata,
            sourceKind, verification,
            historical: true,
          };
        }
      }
      cursor = node.parent;
    }
    return null;
  };

  if (!cappedLive) {
    const trusted = [];
    for (const snapshot of renderedSnapshots) {
      const live = snapshot.renderedConversation;
      const turns = snapshot.renderedTurns;
      const mapping = live?.mapping;
      if (!live || typeof live.current_node !== "string" ||
          !mapping || typeof mapping !== "object" || !turns.length) continue;
      const lastTurn = turns[turns.length - 1]?.turn;
      if (!lastTurn || !Array.isArray(lastTurn.messageIds)) continue;
      const owners = [...recentEntries].filter((entry) => entry.turn === lastTurn);
      if (owners.length !== 1) continue;
      const user = owners[0].turn.items.filter((item) => item?.type === "user-message");
      if (user.length !== 1) continue;
      const userID = user[0].messageId || user[0].serverMessageId;
      const userNode = typeof userID === "string" ?
        Object.getOwnPropertyDescriptor(mapping, userID)?.value : null;
      if (!userNode || userNode.id !== userID ||
          userNode.message?.id !== userID ||
          userNode.message.author?.role !== "user" ||
          !lastTurn.messageIds.includes(userID)) continue;

      // New final message IDs may rotate or arrive before the React turn's
      // messageIds update. Verify the actual current-node parent chain reaches
      // this exact turn's user, instead of requiring the final ID to be listed.
      let cursor = live.current_node;
      const seenNodes = new Set();
      let belongsToTurn = false;
      for (let depth = 0; typeof cursor === "string" && cursor.length &&
          depth < 300 && !seenNodes.has(cursor); depth++) {
        seenNodes.add(cursor);
        const node = Object.getOwnPropertyDescriptor(mapping, cursor)?.value;
        const message = node?.message;
        if (node?.id !== cursor || message?.id !== cursor) break;
        if (message.author?.role === "user") {
          belongsToTurn = cursor === userID;
          break;
        }
        cursor = node.parent;
      }
      if (!belongsToTurn) continue;

      // Current server conversation cache (possibly stale) independently
      // identifies the selected chat. Require shared message IDs if it exists.
      // Matching the entire React turn object prevents borrowing a neighbour tab.
      if (matching?.mapping && typeof matching.mapping === "object") {
        let shared = 0, checked = 0;
        for (const id of Object.keys(matching.mapping).slice(0, 2_000)) {
          checked++;
          const node = Object.getOwnPropertyDescriptor(mapping, id)?.value;
          if (node?.id === id && node.message?.id === id) shared++;
          if (shared >= 3) break;
        }
        if (shared < Math.min(3, checked)) continue;
      }
      trusted.push(live);
    }
    if (trusted.length > 1 && trusted.some((item) =>
      item.mapping !== trusted[0].mapping ||
      item.current_node !== trusted[0].current_node)) {
      return unavailable("ambiguous-live-response");
    }
    if (trusted.length) {
      const verification =
        "current-turn-reference+verified-current-path-to-user+active-conversation";
      const chatTitle = safeTitle(trusted[0]) || safeTitle(matching);
      return { ...extract(trusted[0]), sourceKind: "live-render",
        verification, chatTitle, chatTitleSource: chatTitle ? "verified-active-chat" : "unavailable",
        historicalFinal: recentCompleted(trusted[0], "live-render", verification) ||
          recentCompleted(matching, "query-cache",
            "unique-active-server-conversation") };
    }
  }

  if (!matching) return unavailable("response-cache-unavailable");
  // The server conversation ID and user content never leave this function.
  const verification = "unique-active-server-conversation";
  const chatTitle = safeTitle(matching);
  return { ...extract(matching), sourceKind: "query-cache",
    verification, chatTitle, chatTitleSource: chatTitle ? "verified-active-chat" : "unavailable",
    historicalFinal: recentCompleted(matching, "query-cache", verification) };
}

export function readActiveResponseFromDom(extract, readRoot) {
  const root = window.__codexRoot?._internalRoot?.current;
  return readRoot(root, extract);
}


export function responsePredatesObservedSend(response, lastSend) {
  if (!response || response.status !== "observed" ||
      typeof response.createdAt !== "string" ||
      !lastSend || typeof lastSend.at !== "string") return false;
  const answerTime = Date.parse(response.createdAt);
  const sendTime = Date.parse(lastSend.at);
  return Number.isFinite(answerTime) && Number.isFinite(sendTime) &&
    sendTime > answerTime + 2_000;
}
