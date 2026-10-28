#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluate, listTargets, waitForTargets } from "./cdp.mjs";
import { buildProgressRestoreExpression } from "./progress.mjs";
import { buildProjectCollapseRestoreExpression } from "./project-collapse.mjs";
import {
  DEFAULT_THEME_PATH,
  PROJECT_ROOT,
  buildApplyExpression,
  buildInspectExpression,
  buildRestoreExpression,
  buildScanExpression,
  buildStatusExpression,
  compileThemeCss,
  describeTheme,
  loadTheme,
} from "./theme.mjs";

const DEFAULT_STATE_PATH = path.resolve(PROJECT_ROOT, "..", "..", "log", "system", "session.json");

function usage() {
  return `SPARK ChatGPT UI

Usage:
  node src/cli.mjs <validate|probe|scan|inspect|apply|status|restore> [options]

Options:
  --host <host>        CDP host (default: 127.0.0.1)
  --port <port>        CDP port, or the port from log/system/active.json
  --theme <path>       Theme JSON path (default: config/default-theme.json)
  --state <path>       Runtime session state path
  --timeout <ms>       Wait/evaluation timeout (default: 45000)
  --json               Emit compact JSON
`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    host: "127.0.0.1",
    port: null,
    themePath: DEFAULT_THEME_PATH,
    statePath: DEFAULT_STATE_PATH,
    timeoutMs: 45_000,
    compact: false,
  };

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--json") {
      options.compact = true;
      continue;
    }

    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--host":
        options.host = value;
        break;
      case "--port":
        options.port = Number(value);
        break;
      case "--theme":
        options.themePath = path.resolve(value);
        break;
      case "--state":
        options.statePath = path.resolve(value);
        break;
      case "--timeout":
        options.timeoutMs = Number(value);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("--timeout must be a positive number.");
  }

  return { command, options };
}

async function readJsonIfPresent(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function resolvePort(options) {
  if (Number.isInteger(options.port) && options.port > 0 && options.port <= 65535) {
    return options.port;
  }

  const active = await readJsonIfPresent(
    path.resolve(PROJECT_ROOT, "..", "..", "log", "system", "active.json"),
  );
  const port = Number(active?.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;

  throw new Error("No CDP port supplied and log/system/active.json has no valid port.");
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function printableTarget(target) {
  return {
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

async function evaluateTargets(targets, expression, options) {
  const results = [];
  for (const target of targets) {
    results.push({
      target: printableTarget(target),
      result: await evaluate(target, expression, {
        timeoutMs: options.timeoutMs,
      }),
    });
  }
  return results;
}

async function run(command, options) {
  const theme = await loadTheme(options.themePath);

  if (command === "validate") {
    const summary = describeTheme(theme);
    return {
      command,
      configPath: path.resolve(options.themePath),
      theme: summary,
      compiledCssLength: compileThemeCss(theme).length,
    };
  }

  const port = await resolvePort(options);
  const connection = { host: options.host, port, timeoutMs: options.timeoutMs };
  const targets =
    command === "probe"
      ? await listTargets(connection)
      : await waitForTargets(connection);

  if (command === "probe") {
    return {
      command,
      endpoint: `${options.host}:${port}`,
      targetCount: targets.length,
      targets: targets.map(printableTarget),
    };
  }

  const builders = {
    scan: buildScanExpression,
    inspect: buildInspectExpression,
    apply: buildApplyExpression,
    status: buildStatusExpression,
    restore: buildRestoreExpression,
  };
  const builder = builders[command];
  if (!builder) {
    throw new Error(`Unknown command: ${command ?? "<missing>"}\n\n${usage()}`);
  }

  const results = await evaluateTargets(targets, builder(theme), options);

  if (command === "apply") {
    const summary = describeTheme(theme);
    const state = {
      schemaVersion: 2,
      appliedAt: new Date().toISOString(),
      endpoint: { host: options.host, port },
      configPath: path.resolve(options.themePath),
      theme: {
        ...summary,
      },
      persistence: "Current document. The launcher starts watch.mjs for reloads.",
    };
    await writeJsonAtomic(options.statePath, state);
    return { command, state, applied: results };
  }

  if (command === "restore") {
    const projectCollapseRestored = await evaluateTargets(targets, buildProjectCollapseRestoreExpression(), options);
    const progressRestored = await evaluateTargets(targets, buildProgressRestoreExpression(), options);
    await rm(options.statePath, { force: true });
    return { command, restored: results, projectCollapseRestored, progressRestored };
  }

  return {
    command,
    endpoint: `${options.host}:${port}`,
    configPath: path.resolve(options.themePath),
    results,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  const result = await run(command, options);
  process.stdout.write(
    `${JSON.stringify(result, null, options.compact ? 0 : 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`chatgpt-ui: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
