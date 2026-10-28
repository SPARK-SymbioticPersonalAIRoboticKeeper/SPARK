// ChatGPT routing/network metadata only. Never persist prompts, response text, or credentials.
export const ROUTE_FIELDS = Object.freeze([
  "requestedModel", "requestedEffort", "resolvedModel",
  "resolvedEffort", "serverModel", "serverEffort",
]);

const SENSITIVE_KEY = /(?:^|[_-])(?:auth(?:orization)?|cookie|token|secret|password|passwd|credential|session|bearer|csrf|prompt|content|contents|messages?|user|email|phone|address|file|image|audio|video|attachment|payload|body|input|output|text)(?:$|[_-])/i;
const BLOCKED_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/i;
const PRIVATE_META_KEY = /(?:^|[_-])(?:id|ids|uuid|account|user|request|conversation|message|turn_exchange|turn_trace|working_turn|parent|streaming_parent)(?:$|[_-])/i;
const META_SAFE_KEY = /^(?:model_slug|denoised_model_slug|archetype|model_provider|region|cluster_region|server_ttfvt_ms|fast_convo|warmup_state|conduit_prewarmed|is_first_turn|resume_with_websockets|plan_type|plan_type_bucket|is_autoswitcher_enabled|auto_switcher_race_winner|did_auto_switch_to_reasoning|model_switcher_deny|product_experience|turn_use_case|turn_mode|tool_name|tool_invoked|is_search|search_tool_call_count|search_tool_query_types|is_multimodal|did_prompt_contain_image|request_id|turn_exchange_id|turn_trace_id|reasoning_start_time|reasoning_end_time|finished_duration_sec|conversation_id|message_id|delta_encoding|thinking_effort|reasoning_effort|resolved_thinking_effort|resolved_reasoning_effort|resolved_effort|default_model_slug|resolved_model_slug|requested_model_experience|requested_model|server_model)$/i;

export function safeUrl(raw) {
  try {
    const url = new URL(raw);
    // Keep endpoint class while avoiding conversation/account identifiers in paths.
    const path = url.pathname
      .replace(/(\/ws\/user\/)[^/]+/gi, "$1:id")
      .replace(/(\/user\/)[^/]{20,}/gi, "$1:id")
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, ":id")
      .replace(/\b[0-9a-f]{24,}\b/gi, ":id");
    return (url.origin === "null" ? url.protocol + "//" + url.host : url.origin) + path;
  } catch {
    return "";
  }
}

export function safeHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    // The explicit allowlist below controls metadata capture; the generic
    // payload-key denylist must not suppress valid HTTP content-* headers.
    if (BLOCKED_HEADER.test(key)) continue;
    if (key === "content-type" || key === "accept" || key === "server" ||
        key === "server-timing" || key === "cf-ray" || key === "traceparent" ||
        key === "x-request-id" || key === "x-trace-id" ||
        key === "x-openai-request-id" || key === "x-ratelimit-remaining-requests" ||
        key === "x-ratelimit-remaining-tokens" || key === "retry-after" ||
        key === "date" || key === "cache-control" || key === "content-length" ||
        key === "content-encoding" || key === "access-control-expose-headers") {
      result[key] = String(value).slice(0, 280);
    }
  }
  return result;
}

export function cleanMetadataValue(value, depth = 0, field = "") {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return META_SAFE_KEY.test(field) &&
    value.length > 0 && value.length <= 96 &&
    /^[a-z0-9_.:+-]+$/i.test(value) ?
      value : "[REDACTED unclassified string]";
  if (depth >= 3) return "[NESTED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => cleanMetadataValue(v, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value).slice(0, 80)) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (PRIVATE_META_KEY.test(key) ||
          (!META_SAFE_KEY.test(key) &&
          !(/^(?:is_|did_|has_)/i.test(key) && typeof val === "boolean") &&
          !(/(?:_ms|_sec|_count|_duration)$/i.test(key) && typeof val === "number"))) continue;
      result[key] = cleanMetadataValue(val, depth + 1, key);
    }
    return result;
  }
  return null;
}

export function newRoute() {
  return {
    requestedModel: null,
    requestedEffort: null,
    resolvedModel: null,
    resolvedEffort: null,
    serverModel: null,
    serverEffort: null,
    requestedExperience: null,
    defaultModel: null,
    messageModel: null,
    fieldSources: {},
    metadata: {},
    metadataKeyTypes: {},
    metadataSources: {},
    generationEvents: 0,
  };
}

export function mark(route, key, value, source) {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  route[key] = value;
  route.fieldSources[key] = source;
}

export function extractRequest(body, route, sourcePrefix = "request.body") {
  let value;
  try { value = JSON.parse(body); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  function walk(obj, location, depth) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 4) return;
    mark(route, "requestedModel", obj.model, location + ".model");
    const effort = obj.thinking_effort ?? obj.reasoning_effort ??
      obj["reasoning.effort"] ??
      (obj.reasoning && typeof obj.reasoning === "object" ? obj.reasoning.effort : null);
    if (effort != null) {
      const key = obj.thinking_effort != null ? "thinking_effort" :
        obj.reasoning_effort != null ? "reasoning_effort" :
          obj["reasoning.effort"] != null ? "reasoning.effort" : "reasoning.effort";
      mark(route, "requestedEffort", effort, location + "." + key);
    }
    mark(route, "requestedExperience", obj.requested_model_experience,
      location + ".requested_model_experience");
    // Only known control-envelope keys. Never descend into chat messages/text.
    for (const key of ["parameters", "payload", "request", "options", "settings", "data"]) {
      if (obj[key] && typeof obj[key] === "object") walk(obj[key], location + "." + key, depth + 1);
    }
  }
  walk(value, sourcePrefix, 0);
  return Boolean(route.requestedModel || route.requestedEffort);
}

function visit(obj, route, prefix, transport, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 10) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 80); i += 1) visit(obj[i], route, prefix + "[" + i + "]", transport, depth + 1);
    return;
  }
  if (obj.type === "server_ste_metadata" && obj.metadata && typeof obj.metadata === "object") {
    const metadata = obj.metadata;
    const p = prefix ? prefix + ".metadata" : "metadata";
    for (const [key, value] of Object.entries(metadata)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const fieldPath = transport + ":" + p + "." + key;
      // Retain type and provenance for every non-sensitive server metadata key,
      // even when its value is intentionally withheld by the display allowlist.
      if (key.length > 100 || !/^[a-zA-Z][\w.-]*$/.test(key)) continue;
      route.metadataKeyTypes[key] = value === null ? "null" :
        Array.isArray(value) ? "array" : typeof value;
      route.metadataSources[key] = fieldPath;
      if (!PRIVATE_META_KEY.test(key) &&
          (META_SAFE_KEY.test(key) ||
          (/^(?:is_|did_|has_)/i.test(key) && typeof value === "boolean") ||
          (/(?:_ms|_sec|_count|_duration)$/i.test(key) && typeof value === "number"))) {
        route.metadata[key] = cleanMetadataValue(value, 0, key);
        route.metadataSources[key] = fieldPath;
      }
      if (key === "model_slug") mark(route, "serverModel", value, fieldPath);
      if (key === "thinking_effort" || key === "reasoning_effort") mark(route, "serverEffort", value, fieldPath);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const location = prefix ? prefix + "." + key : key;
    const source = transport + ":" + location;
    if (key === "resolved_model_slug") mark(route, "resolvedModel", value, source);
    else if (key === "resolved_thinking_effort" || key === "resolved_reasoning_effort" || key === "resolved_effort") mark(route, "resolvedEffort", value, source);
    else if (key === "default_model_slug") mark(route, "defaultModel", value, source);
    else if (key === "requested_model_experience") mark(route, "requestedExperience", value, source);
    if (key === "message" && value && typeof value === "object") {
      mark(route, "messageModel", value.model, source + ".model");
    }
    if (value && typeof value === "object") visit(value, route, location, transport, depth + 1);
  }
}

export function extractResponseEvent(event, route, transport = "sse") {
  if (!event || typeof event !== "object") return false;
  route.generationEvents += 1;
  visit(event, route, "", transport);
  return Boolean(route.resolvedModel || route.serverModel || route.messageModel ||
    Object.keys(route.metadataKeyTypes).length);
}

export function parseEventText(text, route, transport = "sse") {
  if (typeof text !== "string" || text.length > 5_000_000) return 0;
  let parsedCount = 0;
  const parseJson = (entry) => {
    try {
      const value = JSON.parse(entry);
      extractResponseEvent(value, route, transport);
      parsedCount += 1;
    } catch { /* Never persist malformed/raw response text. */ }
  };
  if (text.includes("\ndata:") || text.startsWith("data:") || text.includes("\r\ndata:")) {
    const normal = text.replace(/\r\n/g, "\n");
    let pieces = [];
    for (const line of normal.split("\n")) {
      if (line.startsWith("data:")) {
        pieces.push(line.slice(5).replace(/^ /, ""));
      } else if (line === "" && pieces.length) {
        parseJson(pieces.join("\n"));
        pieces = [];
      }
    }
    if (pieces.length) parseJson(pieces.join("\n"));
  } else {
    parseJson(text);
  }
  return parsedCount;
}

export function routeVerdict(route) {
  const { requestedModel: requested, resolvedModel: resolved, serverModel: server } = route;
  if (resolved && server && resolved !== server) return "SERVER_CONFLICT";
  if (!requested || !(server || resolved)) return "UNKNOWN";
  if (requested === "auto" || requested.endsWith("-auto")) return "AUTO_ROUTED";
  return requested === (server || resolved) ? "MATCH" : "ROUTING_DIFFERENT";
}
