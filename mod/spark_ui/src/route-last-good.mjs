// Track last COMPLETED message separately from last explicitly REPORTED
// resolved Effort. Neither finished_successfully nor response.thinking_effort
// verifies applied inference settings (request-echo possible).
// Never write prompts, message/conversation IDs or raw metadata to persistent state.

export const LAST_GOOD_SCHEMA = 1;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EFFORT = /^(?:none|instant|minimal|min|low|standard|medium|extended|high|xhigh|max|ultra|pro)$/i;
const RESOLVED_SOURCE = /^assistant\.final\.metadata\.(?:resolved_thinking_effort|resolved_reasoning_effort|resolved_effort)$/;
const REPORTED_SOURCE = /^assistant\.final\.metadata\.(?:thinking_effort|reasoning_effort)$/;
const VERIFIED_ORIGIN = {
  "live-render": "current-turn-reference+verified-current-path-to-user+active-conversation",
  "query-cache": "unique-active-server-conversation",
};
const stringMatch = (value, pattern) =>
  typeof value === "string" && pattern.test(value) ? value : null;
const effort = (value) => stringMatch(value, EFFORT)?.toLowerCase() ?? null;
const iso = (value) => {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2020, 0, 1) ?
    new Date(time).toISOString() : null;
};
const cleanSource = (value) => typeof value === "string" &&
  (value === "live-render" || value === "query-cache") ? value : null;
const lastFinal = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const createdAt = iso(raw.createdAt), observedAt = iso(raw.observedAt);
  const sourceKind = cleanSource(raw.sourceKind);
  if (!createdAt || !observedAt || !sourceKind ||
      raw.messageStatus !== "finished_successfully") return null;
  const model = stringMatch(raw.model, MODEL);
  const resolvedModel = stringMatch(raw.resolvedModel, MODEL);
  const responseEffort = effort(raw.responseEffort);
  const reportedEffortSource = stringMatch(raw.responseEffortSource, REPORTED_SOURCE);
  const directResolvedEffort = effort(raw.resolvedEffort);
  const sourceResolvedEffort = stringMatch(raw.resolvedEffortSource, RESOLVED_SOURCE);
  if (!model && !resolvedModel && !responseEffort) return null;
  return {
    createdAt, observedAt, sourceKind,
    messageStatus: "finished_successfully",
    model, resolvedModel, responseEffort,
    responseEffortSource: responseEffort ? reportedEffortSource : null,
    resolvedEffort: directResolvedEffort && sourceResolvedEffort ?
      directResolvedEffort : null,
    resolvedEffortSource: directResolvedEffort && sourceResolvedEffort ?
      sourceResolvedEffort : null,
    wasCachedBeforeSend: raw.wasCachedBeforeSend === true,
  };
};
const lastEffort = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const createdAt = iso(raw.createdAt), observedAt = iso(raw.observedAt);
  const sourceKind = cleanSource(raw.sourceKind);
  const source = stringMatch(raw.source, RESOLVED_SOURCE);
  const value = effort(raw.value);
  return createdAt && observedAt && sourceKind && source && value ?
    { createdAt, observedAt, sourceKind, value, source } : null;
};

export function normalizeLastGood(raw) {
  const result = {
    schemaVersion: LAST_GOOD_SCHEMA,
    qualifiedFinals: 0,
    lastFinal: null,
    lastResolvedEffort: null,
  };
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== LAST_GOOD_SCHEMA) {
    return result;
  }
  const previousFinal = lastFinal(raw.lastFinal);
  const previousEffort = lastEffort(raw.lastResolvedEffort);
  result.lastFinal = previousFinal;
  result.lastResolvedEffort = previousEffort;
  const n = raw.qualifiedFinals;
  if (Number.isInteger(n) && n >= 0 && n <= 1_000_000) {
    result.qualifiedFinals = n;
  } else if (previousFinal) {
    result.qualifiedFinals = 1;
  }
  if (previousFinal && result.qualifiedFinals === 0) result.qualifiedFinals = 1;
  return result;
}

export function updateLastGood(previous, response, options = {}) {
  const current = normalizeLastGood(previous);
  if (!response || response.status !== "observed" ||
      response.messageStatus !== "finished_successfully") return current;
  const sourceKind = cleanSource(response.sourceKind);
  if (!sourceKind || response.verification !== VERIFIED_ORIGIN[sourceKind]) {
    return current;
  }
  const createdAt = iso(response.createdAt);
  const observedAt = iso(options.observedAt || new Date().toISOString());
  if (!createdAt || !observedAt ||
      Date.parse(createdAt) > Date.parse(observedAt) + 5 * 60 * 1000) return current;
  const model = stringMatch(response.model, MODEL);
  const resolvedModel = stringMatch(response.resolvedModel, MODEL);
  const reportedEffortSource = stringMatch(response.source?.effort, REPORTED_SOURCE);
  const responseEffort = reportedEffortSource ? effort(response.effort) : null;

  const explicitSource = stringMatch(response.source?.resolvedEffort, RESOLVED_SOURCE);
  // A completed message alone has NO quality-gate significance.
  // Accept only an explicitly named resolved-effort report paired with a
  // resolved-model field in the SAME completed response. This remains a
  // server-reported value, NOT physical inference proof.
  const resolvedEffort = response.resolvedEffortStatus === "observed" &&
    explicitSource && resolvedModel &&
    response.source?.resolvedModel ===
      "assistant.final.metadata.resolved_model_slug" ?
      effort(response.resolvedEffort) : null;
  const newFinal = lastFinal({
    createdAt, observedAt, sourceKind, messageStatus: "finished_successfully",
    model, resolvedModel, responseEffort, responseEffortSource: reportedEffortSource,
    resolvedEffort, resolvedEffortSource: resolvedEffort ? explicitSource : null,
    wasCachedBeforeSend: options.staleResponse === true,
  });
  if (!newFinal) return current;

  const old = current.lastFinal;
  const comparison = old ? Date.parse(newFinal.createdAt) - Date.parse(old.createdAt) : 1;
  if (comparison > 0 || (comparison === 0 &&
      newFinal.sourceKind === "live-render" && old.sourceKind === "query-cache")) {
    current.qualifiedFinals = Math.min(1_000_000, current.qualifiedFinals +
      (comparison === 0 ? 0 : 1));
    current.lastFinal = newFinal;
  } else if (comparison === 0 && old &&
      old.sourceKind === newFinal.sourceKind &&
      old.model === newFinal.model &&
      old.resolvedModel === newFinal.resolvedModel &&
      old.responseEffort === newFinal.responseEffort &&
      !old.responseEffortSource && newFinal.responseEffortSource) {
    // Add proven field provenance to older schema-1 heartbeat snapshots.
    current.lastFinal = { ...old, responseEffortSource: newFinal.responseEffortSource };
  }

  if (resolvedEffort) {
    const candidate = lastEffort({
      createdAt, observedAt, sourceKind, value: resolvedEffort, source: explicitSource,
    });
    const older = current.lastResolvedEffort;
    if (candidate && (!older ||
        Date.parse(candidate.createdAt) > Date.parse(older.createdAt) ||
        (candidate.createdAt === older.createdAt && candidate.sourceKind === "live-render" &&
          older.sourceKind === "query-cache"))) {
      current.lastResolvedEffort = candidate;
    }
  }
  return current;
}

export function lastGoodFromHeartbeat(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object" ||
      heartbeat.schemaVersion !== 3) return normalizeLastGood(null);
  return normalizeLastGood(heartbeat.lastGoodStatus);
}
