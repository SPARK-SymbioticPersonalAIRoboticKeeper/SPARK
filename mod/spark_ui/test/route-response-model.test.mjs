import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLatestFinalResponse, readActiveResponseFromReactRoot,
  responsePredatesObservedSend,
} from "../src/route-response-model.mjs";
import { buildRouteOverlayExpression } from "../src/route-overlay.mjs";
import { RouteCollector } from "../src/route-collector.mjs";

function mkMessage(id, role, extra = {}) {
  return {
    id, author: { role }, create_time: 1792199622,
    ...extra,
  };
}
function mkConversation(conversationId = "opaque-private-conversation-id") {
  const mapping = {
    "u1": { id: "u1", parent: null, message: mkMessage("u1", "user", {
      content: { parts: ["PRIVATE USER TEXT"] },
    }) },
    "a1": { id: "a1", parent: "u1", message: mkMessage("a1", "assistant", {
      channel: "final", status: "finished_successfully",
      content: { parts: ["PRIVATE ASSISTANT ANSWER"] },
      metadata: {
        model_slug: "gpt-6-thinking",
        resolved_model_slug: "gpt-6-thinking",
        thinking_effort: "max",
        default_model_slug: "gpt-6",
      },
    }) },
  };
  return {
    conversation_id: conversationId,
    current_node: "a1",
    mapping,
  };
}

test("current final response reports message metadata; nothing comes from composer", () => {
  const result = extractLatestFinalResponse(mkConversation());
  assert.equal(result.status, "observed");
  assert.equal(result.model, "gpt-6-thinking");
  assert.equal(result.resolvedModel, "gpt-6-thinking");
  assert.equal(result.effort, "max");
  // Response thinking_effort is NOT an explicitly resolved effort.
  assert.equal(result.resolvedEffort, null);
  assert.equal(result.resolvedEffortStatus, "not-reported");
  assert.equal(result.source.resolvedEffort, null);
  assert.equal(result.defaultModel, "gpt-6");
  assert.equal(result.messageStatus, "finished_successfully");
  assert.equal(result.source.model, "assistant.final.metadata.model_slug");
  assert.equal(result.source.effort, "assistant.final.metadata.thinking_effort");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal("conversation_id" in result, false);
});

test("distinct explicitly resolved effort is accepted with its own metadata source", () => {
  const data = mkConversation();
  data.mapping.a1.message.metadata.resolved_thinking_effort = "high";
  const output = extractLatestFinalResponse(data);
  assert.equal(output.effort, "max");
  assert.equal(output.resolvedEffort, "high");
  assert.equal(output.resolvedEffortStatus, "observed");
  assert.equal(output.source.resolvedEffort, "assistant.final.metadata.resolved_thinking_effort");
  data.mapping.a1.message.metadata.resolved_reasoning_effort = "low";
  const conflict = extractLatestFinalResponse(data);
  assert.equal(conflict.resolvedEffort, null);
  assert.equal(conflict.resolvedEffortStatus, "conflicting-fields");
});

test("in-progress final-channel metadata remains provisional, not completed", () => {
  const data = mkConversation();
  data.mapping.a1.message.status = "in_progress";
  const result = extractLatestFinalResponse(data);
  assert.equal(result.status, "observed");
  assert.equal(result.messageStatus, "in_progress");
  assert.equal(result.resolvedModel, "gpt-6-thinking");
  assert.equal(result.resolvedEffort, null);
});

test("complete assistant metadata inventory keeps safe scalars and redacts identities/content", () => {
  const data = mkConversation();
  const md = data.mapping.a1.message.metadata;
  md.request_id = "server-private-request-12345";
  md.turn_exchange_id = "private-turn-abc-xyz";
  md.is_complete = true;
  md.can_save = false;
  md.cot_version = "v2";
  md.finish_details = { type: "stop", stop_tokens: ["PRIVATE_COMPLETION_TOKEN"] };
  md.content_references = [{ title: "PRIVATE TITLE", url: "https://secret.local" }];
  md.reasoning_title = "PRIVATE PROMPT AND CONTENT";
  md.model_dil_v2 = { code: "SECRET", fallbackMarkdown: "CONFIDENTIAL" };
  data.mapping.a1.parent = "analysis-1";
  data.mapping["analysis-1"] = {
    id: "analysis-1", parent: "u1",
    message: mkMessage("analysis-1", "assistant", {
      channel: "analysis", metadata: {
        reasoning_start_time: 1792201000.125,
        tool_invoked: true,
        reasoning_title: "PRIVATE REASONING TITLE",
      },
    }),
  };
  const result = extractLatestFinalResponse(data);
  const rows = result.extraMetadata.rows;
  const find = (source) => rows.find((r) => r.source === source);
  assert.equal(find("assistant.final.metadata.model_slug").value, "gpt-6-thinking");
  assert.equal(find("assistant.final.metadata.request_id").value,
    "[REDACTED identifier/content]");
  assert.equal(find("assistant.final.metadata.is_complete").value, "true");
  assert.equal(find("assistant.final.metadata.can_save").value, "false");
  assert.equal(find("assistant.final.metadata.finish_details.type").value, "stop");
  assert.match(find("assistant.final.metadata.finish_details.stop_tokens").value,
    /array: 1 items; values withheld/);
  assert.equal(find("assistant.analysis.metadata.reasoning_start_time").value,
    "1792201000.125");
  assert.equal(find("assistant.analysis.metadata.tool_invoked").value, "true");
  assert.equal(find("assistant.analysis.metadata.reasoning_title").value,
    "[REDACTED free text]");
  assert.equal(find("assistant.final.metadata.model_dil_v2.code").value,
    "[REDACTED free text]");
  assert.equal(find("assistant.final.metadata.model_dil_v2.fallbackMarkdown").value,
    "[REDACTED free text]");
  assert.equal(result.extraMetadata.observedFields, rows.length);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.ok(result.extraMetadata.observedFields >= rows.length);
  assert.ok(result.extraMetadata.redactedFields >= 3);
});

test("metadata from the previous user turn is not imported into a new response", () => {
  const data = mkConversation();
  data.mapping.a1.message.metadata.is_complete = true;
  data.mapping.u2 = { id: "u2", parent: "a1",
    message: mkMessage("u2", "user", { content: { parts: ["PRIVATE"] } }) };
  data.current_node = "u2";
  const result = extractLatestFinalResponse(data);
  assert.equal(result.status, "awaiting-response");
  assert.equal(result.extraMetadata.rows.length, 0);
});

test("new user message cannot inherit the previous assistant response model", () => {
  const data = mkConversation();
  data.mapping.u2 = {
    id: "u2", parent: "a1",
    message: mkMessage("u2", "user", { content: { parts: ["PRIVATE"] } }),
  };
  data.current_node = "u2";
  assert.equal(extractLatestFinalResponse(data).status, "awaiting-response");
  data.mapping.c1 = {
    id: "c1", parent: "u2",
    message: mkMessage("c1", "assistant", {
      channel: "commentary",
      metadata: { model_slug: "gpt-5-6" },
    }),
  };
  data.current_node = "c1";
  const stillPending = extractLatestFinalResponse(data);
  assert.equal(stillPending.status, "generating");
  assert.equal(stillPending.model, null);
});

test("exact active server conversation binds to only that conversation cache", () => {
  const id = "ACTIVE_CONVERSATION_UUID_ABCDEFGHIJKLMNOP";
  const data = mkConversation(id);
  data.title = "SWE4.2 verified active chat";
  const stale = mkConversation("OTHER_CONVERSATION_UUID_QRSTUVWXYZABCD");
  stale.title = "Unrelated chat title";
  stale.mapping.a1.message.metadata.model_slug = "gpt-5-6";
  const queries = [
    { queryKey: ["chatgpt-conversation", stale.conversation_id], state: { data: stale } },
    { queryKey: ["chatgpt-conversation", id], state: { data } },
  ];
  const client = { getQueryCache: () => ({ getAll: () => queries }) };
  const root = { memoizedProps: { activeServerConversationId: id },
    child: { memoizedProps: { client }, sibling: null, child: null, return: null },
    sibling: null };
  const result = readActiveResponseFromReactRoot(root, extractLatestFinalResponse);
  assert.equal(result.status, "observed");
  assert.equal(result.model, "gpt-6-thinking");
  assert.equal(result.chatTitle, "SWE4.2 verified active chat");
  assert.equal(result.chatTitleSource, "verified-active-chat");
  assert.equal(JSON.stringify(result).includes("Unrelated chat title"), false);
});

test("ambiguity and wrong cache IDs fail closed", () => {
  const id = "ACTIVE_CONVERSATION_UUID_ABCDEFGHIJKLMNOP";
  const other = "OTHER_CONVERSATION_UUID_QRSTUVWXYZABCD";
  const data = mkConversation(other);
  const client = { getQueryCache: () => ({ getAll: () => [
    { queryKey: ["chatgpt-conversation", id], state: { data } },
  ] }) };
  const root = { memoizedProps: { activeServerConversationId: id, client } };
  assert.equal(readActiveResponseFromReactRoot(root, extractLatestFinalResponse).status,
    "response-cache-unavailable");
  root.child = { memoizedProps: { activeServerConversationId: other }, child: null };
  assert.equal(readActiveResponseFromReactRoot(root, extractLatestFinalResponse).status,
    "ambiguous-active-conversation");
});

test("invalid answer metadata is not displayed or promoted to a requested model", () => {
  const data = mkConversation();
  data.mapping.a1.message.metadata.model_slug = "PRIVATE LONG USER PROMPT";
  data.mapping.a1.message.metadata.resolved_model_slug = "<script>alert(1)</script>";
  data.mapping.a1.message.metadata.thinking_effort = "SuperMax";
  const result = extractLatestFinalResponse(data);
  assert.equal(result.status, "metadata-unavailable");
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("live current-turn render metadata overrides the older server conversation query cache", () => {
  const id = "ACTIVE_CONVERSATION_UUID_ABCDEFGHIJKLMNOP";
  const cached = mkConversation(id);
  cached.mapping.a1.message.metadata.model_slug = "gpt-5-6";
  cached.mapping.a1.message.metadata.resolved_model_slug = "gpt-5-6";
  cached.mapping.a1.message.metadata.thinking_effort = "high";

  const live = mkConversation(id);
  live.mapping.u2 = { id: "u2", parent: "a1",
    message: mkMessage("u2", "user", { content: { parts: ["PRIVATE NEW PROMPT"] } }) };
  live.mapping.a2 = { id: "a2", parent: "u2",
    message: mkMessage("a2", "assistant", {
      channel: "final", status: "finished_successfully",
      create_time: 1792201339.432,
      metadata: {
        model_slug: "gpt-6-thinking",
        resolved_model_slug: "gpt-6-thinking",
        thinking_effort: "max",
      },
      content: { parts: ["PRIVATE NEW RESPONSE"] },
    }) };
  live.current_node = "a2";

  const client = { getQueryCache: () => ({ getAll: () => [{
    queryKey: ["chatgpt-conversation", id], state: { data: cached },
  }] }) };
  const turn = {
    messageIds: ["u2"], items: [  // Live final ID may not be listed in turn.messageIds.
      { type: "user-message", messageId: "u2" },
      { type: "assistant-message", messageId: "a2" },
    ],
  };
  const entry = { isMostRecentTurn: true, turn };
  const snapshot = { renderedConversation: live,
    renderedTurns: [{ id: "opaque-local-turn", turn }] };
  const memoSlots = Array(95).fill(null);
  memoSlots[94] = snapshot; // Beyond the old first-55-slot scan.
  const root = {
    memoizedProps: { activeServerConversationId: id, client },
    child: {
      memoizedProps: { entry },
      updateQueue: { memoCache: { data: [memoSlots] } },
    },
  };

  const current = readActiveResponseFromReactRoot(root, extractLatestFinalResponse);
  assert.equal(current.status, "observed");
  assert.equal(current.sourceKind, "live-render");
  assert.equal(current.model, "gpt-6-thinking");
  assert.equal(current.resolvedModel, "gpt-6-thinking");
  assert.equal(current.effort, "max");
  assert.equal(current.messageStatus, "finished_successfully");
  assert.equal(current.verification, "current-turn-reference+verified-current-path-to-user+active-conversation");
  assert.equal(responsePredatesObservedSend(current,
    { at: "2026-10-17T01:41:41.469Z" }), false);
  assert.equal(JSON.stringify(current).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(current).includes(id), false);

  // The exact user/turn ownership is mandatory. Without it, the old cache is
  // an honest fallback, not an unrelated live response.
  turn.items[0].messageId = "wrong-user";
  const fallback = readActiveResponseFromReactRoot(root, extractLatestFinalResponse);
  assert.equal(fallback.sourceKind, "query-cache");
  assert.equal(fallback.model, "gpt-5-6");
});

test("CURRENT in-progress stays provisional but verified historical completed final is recovered", () => {
  const id = "ACTIVE_CONVERSATION_UUID_ABCDEFGHIJKLMNOP";
  const data = mkConversation(id);
  data.mapping.u2 = { id: "u2", parent: "a1",
    message: mkMessage("u2", "user", { content: { parts: ["PRIVATE NEW PROMPT"] } }) };
  data.mapping.a2 = { id: "a2", parent: "u2",
    message: mkMessage("a2", "assistant", {
      channel: "final", status: "in_progress",
      create_time: 1792201339.432,
      metadata: {
        model_slug: "gpt-5-6", resolved_model_slug: "gpt-5-6",
        thinking_effort: "high",
      },
      content: { parts: ["PRIVATE CURRENT RESPONSE"] },
    }) };
  data.current_node = "a2";
  data.mapping.foreignFinal = { id: "foreignFinal", parent: "u1",
    message: mkMessage("foreignFinal", "assistant", {
      channel: "final", status: "finished_successfully",
      metadata: { model_slug: "UNTRUSTED MODEL FROM SIBLING" },
    }) };
  const client = { getQueryCache: () => ({ getAll: () => [
    { queryKey: ["chatgpt-conversation", id], state: { data } },
  ] }) };
  const root = { memoizedProps: {
    activeServerConversationId: id, client,
  } };
  const current = readActiveResponseFromReactRoot(root, extractLatestFinalResponse);
  assert.equal(current.messageStatus, "in_progress");
  assert.equal(current.model, "gpt-5-6");
  assert.equal(current.sourceKind, "query-cache");
  const historical = current.historicalFinal;
  assert.equal(historical.historical, true);
  assert.equal(historical.messageStatus, "finished_successfully");
  assert.equal(historical.model, "gpt-6-thinking");
  assert.equal(historical.resolvedModel, "gpt-6-thinking");
  assert.equal(historical.effort, "max");
  assert.equal(historical.resolvedEffort, null);
  assert.equal(historical.sourceKind, "query-cache");
  assert.equal(historical.verification, "unique-active-server-conversation");
  assert.ok(historical.extraMetadata?.rows.some((r) =>
    r.source === "assistant.final.metadata.thinking_effort" && r.value === "max"));
  assert.equal(JSON.stringify(historical).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(historical).includes(id), false);
});

test("active conversation without historical completed finals does not fabricate LAST GOOD", () => {
  const id = "ACTIVE_CONVERSATION_UUID_ABCDEFGHIJKLMNOP";
  const data = mkConversation(id);
  data.mapping.a1.message.status = "in_progress";
  const root = { memoizedProps: {
    activeServerConversationId: id,
    client: { getQueryCache: () => ({ getAll: () =>
      [{ queryKey: ["chatgpt-conversation", id], state: { data } }] }) },
  } };
  const response = readActiveResponseFromReactRoot(root, extractLatestFinalResponse);
  assert.equal(response.messageStatus, "in_progress");
  assert.equal(response.historicalFinal, null);
});

test("cached older response is not attributed to an observed newer UI send", () => {
  const cached = { status: "observed", createdAt: "2026-10-17T01:13:42.399Z" };
  const nextSend = { at: "2026-10-17T01:36:38.917Z" };
  assert.equal(responsePredatesObservedSend(cached, nextSend), true);
  assert.equal(responsePredatesObservedSend(cached, { at: "2026-10-17T01:13:40.000Z" }), false);
  assert.equal(responsePredatesObservedSend({ status: "unavailable" }, nextSend), false);
});

test("overlay prioritizes final response over current selection", () => {
  const source = buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /readActiveResponseFromReactRoot/);
  assert.match(source, /RESPONSE MODEL/);
  assert.match(source, /RESPONSE EFFORT/);
  assert.match(source, /RESOLVED MODEL/);
  assert.match(source, /UI MODEL/);
  assert.match(source, /WIRE REQ MODEL/);
  assert.match(source, /RESOLVED EFFORT/);
  assert.match(source, /data-route-direction/);
  assert.match(source, /#338a68/);
  assert.match(source, /#4b8aca/);
  assert.match(source, /CACHED RESPONSE predates latest UI send/);
  assert.match(source, /LIVE current rendered turn/);
});

test("current user metadata is inventoried separately and cannot forge applied effort", () => {
  const data = mkConversation();
  data.mapping.u1.message.metadata = {
    thinking_effort: "high",
    resolved_effort: "low",
    accountId: 12345678,
    privateText: "SENSITIVE TEXT",
    nestedTelemetry: {
      reasoning_effort: "medium", duration_ms: 19, secretToken: 9281,
    },
  };
  const result = extractLatestFinalResponse(data);
  const fields = result.extraMetadata.rows;
  const value = (source) => fields.find((row) => row.source === source)?.value;
  assert.equal(result.effort, "max");
  assert.equal(result.resolvedEffort, null);
  assert.equal(value("user.metadata.thinking_effort"), "high");
  assert.equal(value("user.metadata.resolved_effort"), "low");
  assert.equal(value("user.metadata.accountId"), "[REDACTED identifier/content]");
  assert.equal(value("user.metadata.privateText"), "[REDACTED identifier/content]");
  assert.equal(value("user.metadata.nestedTelemetry.duration_ms"), "19");
  assert.equal(value("user.metadata.nestedTelemetry.secretToken"), "[REDACTED identifier/content]");
  assert.equal(JSON.stringify(result).includes("SENSITIVE TEXT"), false);
  assert.equal(JSON.stringify(result).includes("12345678"), false);
});

test("metadata after 120 fields is not silently dropped; inventory remains bounded", () => {
  const data = mkConversation();
  const meta = data.mapping.a1.message.metadata;
  for (let i = 0; i < 190; i++) meta["safe_metric_" + i] = i;
  const final = extractLatestFinalResponse(data);
  assert.ok(final.extraMetadata.observedFields >= 193);
  assert.ok(final.extraMetadata.rows.some((row) =>
    row.source === "assistant.final.metadata.safe_metric_189" &&
    row.value === "189"));
  assert.equal(final.extraMetadata.truncated, false);
});
