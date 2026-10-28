import test from "node:test";
import assert from "node:assert/strict";
import { rankTarget, targetIsUsable } from "../src/cdp.mjs";

test("ChatGPT and Codex application pages rank above unrelated pages", () => {
  const app = {
    type: "page",
    url: "app://-/index.html",
    title: "Codex",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/app",
  };
  const other = {
    type: "page",
    url: "https://example.com",
    title: "Example",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/other",
  };
  assert.ok(rankTarget(app) > rankTarget(other));
});

test("DevTools and non-page targets are excluded", () => {
  assert.equal(
    targetIsUsable({
      type: "page",
      url: "devtools://devtools/bundled/inspector.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
    }),
    false,
  );
  assert.equal(
    targetIsUsable({
      type: "service_worker",
      url: "app://-/worker.js",
      webSocketDebuggerUrl: "ws://127.0.0.1:1/worker",
    }),
    false,
  );
});
