// Read-only chat-request payload observer. All message strings stay in process memory
// and in the existing CDP-rendered panel; never put them in route logs/heartbeats.
const MAX_BODY = 1_000_000;
const MAX_TEXT = 20_000;
const MAX_ENTRIES = 12;
const CHAT_HOST = /(^|\.)(?:chatgpt\.com|openai\.com|chatgpt-staging\.com)$/i;
const CHAT_PATH = /\/(?:backend-api\/(?:f\/)?(?:conversation|responses|chat|message)(?:\/|$)|conversation(?:\/|$)|responses(?:\/|$)|chat\/completions(?:\/|$))/i;
const RPC_METHOD = new Set([
  "turn/start", "turn/steer", "turn/addUserMessage",
  "thread/queue/add", "thread/queue/update"
]);

export function isChatRequestDestination(url, method) {
  if (typeof url !== "string") return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!["https:", "wss:"].includes(parsed.protocol)) return false;
  if (!CHAT_HOST.test(parsed.hostname)) return false;
  if (!CHAT_PATH.test(parsed.pathname)) return false;
  return ["POST", "WS"].includes(String(method).toUpperCase());
}

function stringParts(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const values = content.map(part => typeof part === "string" ? part :
      part?.type === "text" && typeof part.text === "string" ? part.text : null);
    return values.every(value => typeof value === "string") ? values.join("\n") : null;
  }
  if (content && typeof content === "object") {
    if (Array.isArray(content.parts)) return stringParts(content.parts);
    if (Array.isArray(content.content)) return stringParts(content.content);
    if (typeof content.text === "string" &&
        (!content.type || content.type === "text" || content.type === "input_text")) {
      return content.text;
    }
  }
  return null;
}

// Require a recognized user role or explicit user-text RPC field. Never print
// arbitrary JSON, credentials, headers, account context, tool data or hidden prompts.
export function extractChatUserText(body, channel = "HTTP") {
  if (typeof body !== "string" || body.length > MAX_BODY) return null;
  let input;
  try { input = JSON.parse(body); } catch { return null; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const method = input.method === "mcp-request" ? input.request?.method :
    input.request?.method || input.method;
  const params = input.method === "mcp-request" ? input.request?.params :
    input.request?.params || input.params;
  let text = null;
  let shape = null;
  if (RPC_METHOD.has(method) && params && typeof params === "object") {
    if (Array.isArray(params.input)) {
      text = stringParts(params.input);
      shape = "RPC_INPUT";
    } else if (typeof params.text === "string") {
      text = params.text;
      shape = "RPC_TEXT";
    }
  }
  if (text === null && channel === "HTTP" && Array.isArray(input.messages)) {
    const users = input.messages.filter(x =>
      x?.role === "user" || x?.author?.role === "user");
    // Ambiguous history or a batch cannot be identified as the current send.
    if (users.length === 1) {
      text = stringParts(users[0].content);
      shape = "SINGLE_USER_MESSAGE";
    }
  }
  if (text === null && channel === "HTTP" && typeof input.prompt === "string") {
    text = input.prompt;
    shape = "PROMPT_FIELD";
  }
  if (typeof text !== "string" || !text.trim()) return null;
  return {
    text: text.slice(0, MAX_TEXT),
    fullChars: text.length,
    truncated: text.length > MAX_TEXT,
    shape
  };
}

export class RouteFlowObserver {
  constructor({ maxEntries = MAX_ENTRIES, clock = () => new Date().toISOString() } = {}) {
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.entries = [];
    this.httpSeen = 0;
    this.wsSeen = 0;
    this.responses = 0;
    this.lastEventAt = null;
    this.pending = new Map();
  }

  request({ id, url, method, body, channel = "HTTP", at = this.clock() }) {
    if (!isChatRequestDestination(url, method)) return false;
    const message = extractChatUserText(body, channel);
    if (!message) return false;
    const requestKey = String(id || "");
    if (requestKey && this.pending.has(requestKey)) {
      const prior = this.pending.get(requestKey);
      if (prior.message.text === message.text) return false;
    }
    const entry = {
      at, channel: channel === "WS" ? "CDP_WEBSOCKET_SENT" : "CDP_HTTP_REQUEST",
      source: "CHROMIUM_RENDERER_NETWORK",
      message, tls: url.startsWith("wss:") || url.startsWith("https:") ?
        "TLS_EXPECTED_NOT_VERIFIED" : "UNVERIFIED",
      protocol: null, securityState: null
    };
    // The request ID is only a private in-memory correlation key.
    if (requestKey) this.pending.set(requestKey, entry);
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    if (this.pending.size > this.maxEntries * 3) {
      const retained = new Set(this.entries);
      for (const [key, value] of this.pending) {
        if (!retained.has(value)) this.pending.delete(key);
      }
    }
    if (channel === "WS") this.wsSeen++;
    else this.httpSeen++;
    this.lastEventAt = at;
    return true;
  }

  response({ id, securityState, protocol, securityDetails } = {}) {
    const entry = this.pending.get(String(id || ""));
    if (!entry) return false;
    this.responses++;
    if (typeof securityState === "string") entry.securityState = securityState;
    if (typeof protocol === "string") entry.protocol = protocol;
    const version = securityDetails?.protocol;
    if (typeof version === "string" && /^(?:TLS|QUIC)/i.test(version)) {
      entry.tls = version;
    } else if (securityState === "secure") {
      entry.tls = "SECURE_TRANSPORT_REPORTED";
    }
    return true;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      source: "CHROMIUM_RENDERER_CDP_ONLY",
      httpObserved: this.httpSeen,
      wsObserved: this.wsSeen,
      lastEventAt: this.lastEventAt,
      // No request IDs, account IDs, URLs, cookie/auth headers or raw JSON.
      entries: this.entries.map(entry => ({
        at: entry.at, channel: entry.channel, source: entry.source,
        message: { ...entry.message }, tls: entry.tls,
        protocol: entry.protocol, securityState: entry.securityState
      }))
    };
  }
}
