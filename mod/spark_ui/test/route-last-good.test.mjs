import test from "node:test";
import assert from "node:assert/strict";
import {
  LAST_GOOD_SCHEMA, normalizeLastGood, lastGoodFromHeartbeat, updateLastGood,
} from "../src/route-last-good.mjs";
import { buildRouteOverlayExpression } from "../src/route-overlay.mjs";
import { RouteCollector } from "../src/route-collector.mjs";

const live = (createdAt = "2026-10-17T12:40:00.000Z", extra = {}) => ({
  status: "observed",
  messageStatus: "finished_successfully",
  sourceKind: "live-render",
  verification: "current-turn-reference+verified-current-path-to-user+active-conversation",
  model: "gpt-6-thinking",
  resolvedModel: "gpt-6-thinking",
  effort: "max",
  resolvedEffort: null,
  resolvedEffortStatus: "not-reported",
  createdAt,
  source: {
    model: "assistant.final.metadata.model_slug",
    effort: "assistant.final.metadata.thinking_effort",
    resolvedModel: "assistant.final.metadata.resolved_model_slug",
    resolvedEffort: null,
  },
  ...extra,
});
const at = (time) => ({ observedAt: time });

test("last good records an actual completed response but never infers resolved effort", () => {
  const result = updateLastGood(null, live(),
    at("2026-10-17T12:40:03.000Z"));
  assert.equal(result.schemaVersion, LAST_GOOD_SCHEMA);
  assert.equal(result.qualifiedFinals, 1);
  assert.equal(result.lastFinal.model, "gpt-6-thinking");
  assert.equal(result.lastFinal.responseEffort, "max");
  assert.equal(result.lastFinal.responseEffortSource,
    "assistant.final.metadata.thinking_effort");
  assert.equal(result.lastFinal.resolvedModel, "gpt-6-thinking");
  assert.equal(result.lastFinal.messageStatus, "finished_successfully");
  assert.equal(result.lastFinal.resolvedEffort, null);
  assert.equal(result.lastResolvedEffort, null);
  assert.equal(JSON.stringify(result).includes("conversation_id"), false);
});

test("in-progress and incomplete current snapshots never overwrite last good", () => {
  const good = updateLastGood(null, live(),
    at("2026-10-17T12:40:03.000Z"));
  const newer = live("2026-10-17T12:50:00.000Z", {
    model: "gpt-6-pro", resolvedEffort: "high",
    resolvedEffortStatus: "observed",
    source: { resolvedEffort: "assistant.final.metadata.resolved_effort" },
    messageStatus: "in_progress",
  });
  assert.deepEqual(updateLastGood(good, newer,
    at("2026-10-17T12:50:03.000Z")), good);
  assert.deepEqual(updateLastGood(good, { status: "generating" },
    at("2026-10-17T12:50:03.000Z")), good);
  assert.deepEqual(updateLastGood(good, null,
    at("2026-10-17T12:50:03.000Z")), good);
});

test("newer completed final replaces old final but not older explicit resolved effort", () => {
  const first = live("2026-10-17T12:40:00.000Z", {
    resolvedEffort: "high",
    resolvedEffortStatus: "observed",
    source: {
      model: "assistant.final.metadata.model_slug",
      resolvedModel: "assistant.final.metadata.resolved_model_slug",
      effort: "assistant.final.metadata.thinking_effort",
      resolvedEffort: "assistant.final.metadata.resolved_thinking_effort",
    },
  });
  const prior = updateLastGood(null, first,
    at("2026-10-17T12:40:03.000Z"));
  assert.equal(prior.lastResolvedEffort.value, "high");
  assert.equal(prior.lastFinal.resolvedEffort, "high");
  const later = updateLastGood(prior,
    live("2026-10-17T13:00:00.000Z", {
      model: "gpt-6-pro", resolvedModel: "gpt-6-pro",
      effort: "medium",
    }), at("2026-10-17T13:00:03.000Z"));
  assert.equal(later.lastFinal.model, "gpt-6-pro");
  assert.equal(later.lastFinal.responseEffort, "medium");
  assert.equal(later.lastFinal.resolvedEffort, null);
  assert.equal(later.lastResolvedEffort.value, "high");
  assert.equal(later.lastResolvedEffort.createdAt, "2026-10-17T12:40:00.000Z");
  assert.equal(later.qualifiedFinals, 2);
});

test("cache historical final is labeled as historical, never misrepresented as live", () => {
  const result = updateLastGood(null, {
    ...live("2026-10-16T19:33:28.600Z"),
    sourceKind: "query-cache",
    verification: "unique-active-server-conversation",
  }, { ...at("2026-10-17T13:30:36.000Z"), staleResponse: true });
  assert.equal(result.lastFinal.sourceKind, "query-cache");
  assert.equal(result.lastFinal.wasCachedBeforeSend, true);
  assert.equal(result.lastFinal.createdAt, "2026-10-16T19:33:28.600Z");
});

test("explicit resolved effort requires finished final and exact authoritative key", () => {
  const attempted = live("2026-10-17T12:40:00.000Z", {
    resolvedEffort: "high", resolvedEffortStatus: "observed",
    source: { resolvedEffort: "assistant.final.metadata.thinking_effort" },
  });
  assert.equal(updateLastGood(null, attempted,
    at("2026-10-17T12:40:03.000Z")).lastResolvedEffort, null);
  const forged = live("2026-10-17T12:40:00.000Z", {
    resolvedEffort: "high", resolvedEffortStatus: "observed",
    source: { resolvedEffort: "assistant.final.metadata.resolved_effort" },
    verification: "unverified-network-packet",
  });
  assert.equal(updateLastGood(null, forged,
    at("2026-10-17T12:40:03.000Z")).lastFinal, null);
});

test("completed message with echoed thinking_effort does not pass LAST GOOD applied-Effort gate", () => {
  const echoed = updateLastGood(null, live(),
    at("2026-10-17T12:40:03.000Z"));
  assert.equal(echoed.lastFinal.messageStatus, "finished_successfully");
  assert.equal(echoed.lastFinal.responseEffort, "max");
  assert.equal(echoed.lastResolvedEffort, null);
  // Even an explicitly named resolution without the corresponding reported
  // resolved model from this same response is not accepted.
  const missingModel = live("2026-10-17T12:42:00.000Z", {
    resolvedModel: null,
    resolvedEffort: "high",
    resolvedEffortStatus: "observed",
    source: {
      model: "assistant.final.metadata.model_slug",
      resolvedModel: null,
      effort: "assistant.final.metadata.thinking_effort",
      resolvedEffort: "assistant.final.metadata.resolved_effort",
    },
  });
  const next = updateLastGood(echoed, missingModel,
    at("2026-10-17T12:42:03.000Z"));
  assert.equal(next.lastResolvedEffort, null);
  assert.equal(next.lastFinal.model, "gpt-6-thinking");
});

test("older response cannot replace newer last-good despite later polling", () => {
  const newer = updateLastGood(null,
    live("2026-10-17T13:00:00.000Z"),
    at("2026-10-17T13:00:05.000Z"));
  const older = updateLastGood(newer,
    live("2026-10-17T12:30:00.000Z", { model: "gpt-5-6" }),
    at("2026-10-17T13:30:00.000Z"));
  assert.deepEqual(older, newer);
  const repeated = updateLastGood(newer,
    live("2026-10-17T13:00:00.000Z"),
    at("2026-10-17T13:15:00.000Z"));
  assert.deepEqual(repeated, newer);
  assert.equal(repeated.qualifiedFinals, 1);
});

test("existing watcher heartbeat persists exactly validated evidence and strips private extras", () => {
  const original = updateLastGood(null,
    live(), at("2026-10-17T12:40:03.000Z"));
  const json = JSON.stringify({
    schemaVersion: 3,
    pid: 1000, healthy: true,
    lastGoodStatus: {
      ...original,
      SECRET_USER_TEXT: "PRIVATE PROMPT",
      lastFinal: {
        ...original.lastFinal,
        accountId: "PRIVATE ACCOUNT",
        prompt: "PRIVATE TEXT",
      },
    },
  });
  const restored = lastGoodFromHeartbeat(JSON.parse(json));
  assert.deepEqual(restored, original);
  assert.equal(JSON.stringify(restored).includes("PRIVATE"), false);
  assert.deepEqual(lastGoodFromHeartbeat({ schemaVersion: 1 }), normalizeLastGood(null));
});

test("injected overlay always receives only bounded sanitized last-good metadata", () => {
  const snapshot = new RouteCollector().snapshot();
  snapshot.lastGoodStatus = {
    ...updateLastGood(null, live(), at("2026-10-17T12:40:03.000Z")),
    unauthorized: "PRIVATE CHAT",
  };
  const js = buildRouteOverlayExpression(snapshot);
  assert.doesNotThrow(() => new Function("return " + js));
  assert.match(js, /LAST GOOD/);
  assert.match(js, /GOOD STATUS/);
  assert.match(js, /NOT VERIFIED/);
  assert.match(js, /thinking_effort echo excluded/);
  assert.match(js, /message completed only/);
  assert.doesNotMatch(js, /VERIFIED finished_successfully/);
  assert.match(js, /LAST EFFORT/);
  assert.doesNotMatch(js, /PRIVATE CHAT/);
  assert.match(js, /lastGoodStatus/);
});

test("historical last reported Effort remains visible without implying applied Effort", () => {
  const first = updateLastGood(null, live(), at("2026-10-17T12:40:03.000Z"));
  assert.equal(first.lastFinal.responseEffort, "max");
  assert.equal(first.lastFinal.responseEffortSource,
    "assistant.final.metadata.thinking_effort");
  assert.equal(first.lastResolvedEffort, null);
  const forged = live("2026-10-17T12:55:00.000Z", {
    effort: "max",
    source: {
      model: "assistant.final.metadata.model_slug",
      resolvedModel: "assistant.final.metadata.resolved_model_slug",
      effort: "user.metadata.thinking_effort",
    },
  });
  const next = updateLastGood(first, forged, at("2026-10-17T12:55:03.000Z"));
  assert.equal(next.lastFinal.responseEffort, null);
  assert.equal(next.lastFinal.responseEffortSource, null);
  assert.equal(next.lastResolvedEffort, null);
});

test("schema-1 last response is upgraded with exact reported Effort provenance", () => {
  const latest = updateLastGood(null, live(), at("2026-10-17T12:40:03.000Z"));
  const migrated = structuredClone(latest);
  delete migrated.lastFinal.responseEffortSource;
  const next = updateLastGood(migrated, live(), at("2026-10-17T12:41:03.000Z"));
  assert.equal(next.qualifiedFinals, 1);
  assert.equal(next.lastFinal.responseEffortSource,
    "assistant.final.metadata.thinking_effort");
});
