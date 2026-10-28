import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_ROOT,
  THEME_COLOR_GROUPS,
  THEME_COLOR_KEYS,
  compileThemeCss,
  loadTheme,
} from "../src/theme.mjs";

function colorPaths(theme) {
  return Object.entries(theme.colors).flatMap(([group, colors]) =>
    Object.keys(colors).map((key) => `${group}.${key}`),
  );
}

test("default and dark-red themes expose the same complete color map", async () => {
  const defaultTheme = await loadTheme();
  const darkRedTheme = await loadTheme(
    path.join(PROJECT_ROOT, "config", "dark-red-theme.json"),
  );

  assert.equal(defaultTheme.schemaVersion, 4);
  assert.equal(defaultTheme.id, "chatgpt-ui-rainbow-map");
  assert.equal(darkRedTheme.id, "chatgpt-ui-dark-red");
  assert.deepEqual(Object.keys(defaultTheme.colors), Object.keys(THEME_COLOR_GROUPS));
  assert.deepEqual(colorPaths(defaultTheme), THEME_COLOR_KEYS);
  assert.deepEqual(colorPaths(darkRedTheme), THEME_COLOR_KEYS);
  assert.equal(darkRedTheme.colors.surfaces.userPromptBackground, "#6e0002");
  assert.ok(new Set(Object.values(defaultTheme.colors).flatMap(Object.values)).size >= 50);

  const css = compileThemeCss(defaultTheme);
  assert.match(css, /data-user-message-bubble/);
  assert.match(css, /ApplicationMenuTopBar/);
});

test("JSON schema lists every runtime color group and key", async () => {
  const schema = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "config", "theme.schema.json"), "utf8"),
  );
  const schemaGroups = schema.properties.colors.properties;
  assert.deepEqual(schema.properties.colors.required, Object.keys(THEME_COLOR_GROUPS));
  for (const [group, keys] of Object.entries(THEME_COLOR_GROUPS)) {
    assert.deepEqual(schemaGroups[group].required, keys);
    assert.deepEqual(Object.keys(schemaGroups[group].properties), keys);
  }
});
