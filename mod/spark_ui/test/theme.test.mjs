import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApplyExpression,
  buildInspectExpression,
  buildRestoreExpression,
  buildScanExpression,
  buildStatusExpression,
  compileThemeCss,
  describeTheme,
  loadTheme,
  validateTheme,
} from "../src/theme.mjs";

const theme = await loadTheme();

test("schema v4 compiles grouped color roles into deterministic internal rules", () => {
  assert.equal(validateTheme(theme), theme);
  assert.deepEqual(describeTheme(theme), {
    schemaVersion: 4,
    id: "chatgpt-ui-rainbow-map",
    name: "Rainbow Element Map",
    colorCount: 108,
    colorGroupCount: 11,
    cssVariableCount: 217,
    elementCount: 2,
    scanPropertyCount: 11,
  });
  const css = compileThemeCss(theme);

  assert.match(css, /:root/);
  assert.match(css, /--codex-titlebar-tint: #d00000 !important/);
  assert.match(css, /--color-surface: #240046 !important/);
  assert.match(css, /--vscode-terminal-ansiBrightMagenta: #ff00ff !important/);
  assert.match(css, /\[data-user-message-bubble\]/);
  assert.match(css, /\[data-user-message-bubble\]:hover/);
  assert.match(css, /thread-scroll-container/);
  assert.match(css, /--thread-content-max-width: 100% !important/);
  assert.match(css, /--thread-body-max-width: 100% !important/);
  assert.match(css, /max-width: 100% !important/);
  assert.match(css, /border: 1px solid #ffff00 !important/);
  assert.match(css, /box-shadow: 0 6px 18px rgba\(255, 255, 0, 0\.65\) !important/);
});

test("runtime expressions expose generic element inspection and color scans", () => {
  const apply = buildApplyExpression(theme);
  const inspect = buildInspectExpression(theme);
  const status = buildStatusExpression(theme);
  const restore = buildRestoreExpression(theme);
  const scan = buildScanExpression(theme);

  assert.match(apply, /chatgptThemeChanger/);
  assert.match(apply, /DOMContentLoaded/);
  assert.match(inspect, /rootVariables/);
  assert.match(status, /samples/);
  assert.match(restore, /\.remove\(\)/);
  assert.match(scan, /scannedElementCount/);
  assert.match(scan, /maxSamplesPerValue/);
  assert.doesNotMatch(inspect, /textContent/);
  assert.doesNotMatch(scan, /textContent/);
});

test("validation reports missing, misspelled, and unsafe color values", () => {
  assert.throws(() => validateTheme({}), /schemaVersion 4/);
  assert.throws(
    () => validateTheme({ ...theme, id: "contains spaces" }),
    /letters, numbers, and dashes/,
  );

  const missing = structuredClone(theme);
  delete missing.colors.text.userPrompt;
  assert.throws(
    () => validateTheme(missing),
    /Theme colors are missing: text\.userPrompt/,
  );

  const misspelled = structuredClone(theme);
  misspelled.colors.text.promptText = "white";
  assert.throws(
    () => validateTheme(misspelled),
    /Unknown theme colors: text\.promptText/,
  );

  const unsafe = structuredClone(theme);
  unsafe.colors.text.userPrompt = "red; display: none";
  assert.throws(
    () => validateTheme(unsafe),
    /must be a CSS color/,
  );
});
