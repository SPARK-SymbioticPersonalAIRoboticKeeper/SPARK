const DEFAULT_TIMEOUT_MS = 8_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CDP endpoint returned HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

export function targetIsUsable(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) {
    return false;
  }

  const url = target.url ?? "";
  return !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
}

export function rankTarget(target) {
  const url = target.url ?? "";
  const title = target.title ?? "";
  let score = 0;
  if (url.startsWith("app://-/index.html")) score += 100;
  else if (url.startsWith("app://")) score += 80;
  if (/codex|chatgpt/i.test(title)) score += 20;
  if (target.type === "page") score += 10;
  return score;
}

export async function listTargets({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const targets = await fetchJson(
    `http://${host}:${port}/json/list`,
    timeoutMs,
  );
  return targets.filter(targetIsUsable).sort((a, b) => rankTarget(b) - rankTarget(a));
}

export async function waitForTargets({
  host,
  port,
  timeoutMs = 45_000,
  intervalMs = 250,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const targets = await listTargets({ host, port, timeoutMs: 1_500 });
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `No usable CDP page appeared on ${host}:${port} within ${timeoutMs}ms.` +
      (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

function messageToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
}

export class CdpClient {
  constructor(webSocketUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.webSocketUrl = webSocketUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (this.socket) return;
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to ${this.webSocketUrl}`));
      }, this.timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket connection failed: ${this.webSocketUrl}`));
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(messageToText(event.data));
      } catch {
        return;
      }

      if (!message.id) {
        if (typeof message.method === "string" && typeof this.onEvent === "function") {
          try { void Promise.resolve(this.onEvent(message)).catch(() => {}); } catch {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
    });

    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP WebSocket closed before the response arrived."));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP client is not connected.");
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (!this.socket) return;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    this.socket = null;
  }
}

export async function evaluate(target, expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const client = new CdpClient(target.webSocketDebuggerUrl, timeoutMs);
  try {
    await client.connect();
    await client.send("Runtime.enable");
    const response = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });

    if (response.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate threw: ${JSON.stringify(response.exceptionDetails)}`,
      );
    }

    return response.result?.value ?? null;
  } finally {
    client.close();
  }
}

export async function installForFutureDocuments(
  target,
  expression,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const client = new CdpClient(target.webSocketDebuggerUrl, timeoutMs);
  try {
    await client.connect();
    await client.send("Page.enable");
    const response = await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: expression,
      runImmediately: false,
    });
    return response.identifier;
  } finally {
    client.close();
  }
}

export async function removeFutureDocumentScript(
  target,
  identifier,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const client = new CdpClient(target.webSocketDebuggerUrl, timeoutMs);
  try {
    await client.connect();
    await client.send("Page.enable");
    await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  } finally {
    client.close();
  }
}
