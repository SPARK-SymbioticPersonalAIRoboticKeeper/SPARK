#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sparkDataRoot } from '../../../out/spark/data-path.mjs';
import { evaluate, listTargets } from "./cdp.mjs";
import { buildProgressExpression } from "./progress.mjs";
import { RouteCollector, monitorTargets } from "./route-collector.mjs";
import { RouteFlowObserver } from "./route-flow.mjs";
import { buildRouteOverlayExpression } from "./route-overlay.mjs";
import { buildProjectCollapseExpression } from "./project-collapse.mjs";
import { RouteRecorder } from "./route-recorder.mjs";
import { lastGoodFromHeartbeat, updateLastGood } from "./route-last-good.mjs";
import { PROJECT_ROOT, buildApplyExpression, loadTheme } from "./theme.mjs";
import { isCiiTarget } from "../../spark_cii/src/cli.mjs";
import { buildStatusExpression } from "../../spark_cii/src/guard.mjs";
import { CiiAudit } from "../../spark_cii/src/audit.mjs";

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: null,
    themePath: undefined,
    intervalMs: 1_500,
    unavailableExitMs: 30_000,
    transportHealthUrl: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--host") options.host = value;
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--theme") options.themePath = path.resolve(value);
    else if (flag === "--interval") options.intervalMs = Number(value);
    else if (flag === "--unavailable-exit") options.unavailableExitMs = Number(value);
    else if (flag === "--transport-health") options.transportHealthUrl = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 250) {
    throw new Error("--interval must be an integer of at least 250ms.");
  }
  if (options.transportHealthUrl) {
    const parsed = new URL(options.transportHealthUrl);
    const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error("--transport-health must be a loopback http URL.");
    }
  }
  return options;
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeHeartbeat(value) {
  const filePath = path.resolve(PROJECT_ROOT, "..", "..", "log", "system", "watcher.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function recoverLastGood() {
  // The existing atomically replaced heartbeat is also the recovery journal:
  // do not introduce another state folder, sidecar or credential log.
  try {
    const heartbeat = JSON.parse(await readFile(
      path.resolve(PROJECT_ROOT, "..", "..", "log", "system", "watcher.json"), "utf8",
    ));
    return lastGoodFromHeartbeat(heartbeat);
  } catch {
    return lastGoodFromHeartbeat(null);
  }
}

async function readTransportProgress(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(800),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return {
      checkedAt: new Date().toISOString(),
      activity: body?.activity ?? null,
      transportError: null,
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      activity: null,
      transportError: error?.message ?? String(error),
    };
  }
}

function primaryProgressTarget(targets) {
  return targets.find((target) => target.url === "app://-/index.html")
    ?? targets.find((target) => target.url?.startsWith("app://-/index.html") && !target.url.includes("initialRoute="))
    ?? targets[0]
    ?? null;
}

// Independent observer: records CII absence even when the CII process never started.
// It reads only installation/status metadata, not user messages or instructions.
export async function observeCiiReadiness(targets, state, {
  inspect = (target) => evaluate(target,
    "(()=>{const gate=window.__sparkCiiGate?.getState?.()??null;" +
    "const bp=globalThis.__sparkCiiBreakpointState??null;" +
    "return gate?{enabled:gate.enabled,stage:gate.stage,gate," +
    "displayMask:window.__sparkCiiDisplayMask?.getState?.()??null," +
    "dispatchBreakpoint:bp,refreshedAt:bp?.heartbeatAt??0}:" +
    "window.__sparkCiiGuard?.getState?.()??null})()",
    { timeoutMs: 2_000 }),
  audit = new CiiAudit({ source: "ui" }),
  now = () => Date.now()
} = {}) {
  const eligible = targets.filter(isCiiTarget);
  let status = eligible.length ? "ACTIVE" : "NO_TARGET";
  for (const target of eligible) {
    try {
      const current = await inspect(target);
      if (current?.enabled !== true) { status = "MISSING"; break; }
      if (current.stage === "EGRESS_SEND_GATE" &&
          (current.displayMask?.enabled !== true ||
            current.displayMask?.version !== "CII_DISPLAY_MASK_V1" ||
            current.gate?.armed !== true ||
            current.dispatchBreakpoint?.status === "ERROR")) {
        status = "DEGRADED";
        break;
      }
      if (current.stage === "ORIGINAL_EDITOR_INSERT" &&
          (current.safeBypass === true || Number(current.blocked) > 0)) {
        status = "DEGRADED";
        break;
      }
      if (!Number.isFinite(current.refreshedAt) || now() - current.refreshedAt > 10_000) {
        status = "STALE"; break;
      }
      if (current.stage === "EGRESS_SEND_GATE" &&
          Number(current.dispatchBreakpoint?.forwarded) === 0 &&
          status === "ACTIVE") status = "ARMED_UNVERIFIED";
    } catch {
      status = "CDP_UNAVAILABLE";
      break;
    }
  }
  if (status !== state.last || now() - state.lastAt > 60_000) {
    try { await audit.write("UI_CII_STATE", { status, targetCount: eligible.length }); }
    catch { process.stderr.write("[CII] Audit unavailable; CII readiness unverified\n"); }
    state.last = status;
    state.lastAt = now();
  }
  return status;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const theme = await loadTheme(options.themePath);
  const expression = buildApplyExpression(theme);
  const projectCollapseExpression = buildProjectCollapseExpression();
  let unavailableSince = null;
  let cycle = 0;
  const ciiObserver = { last: null, lastAt: 0 };
  const ciiAudit = new CiiAudit({ source: "ui" });
  const routeCollector = new RouteCollector();
  const routeFlow = new RouteFlowObserver();
  const recorder = new RouteRecorder({
    logDir: path.join(sparkDataRoot({ projectRoot: path.resolve(PROJECT_ROOT, '..', '..') }), 'route-recordings'),
  });
  let lastGoodStatus = await recoverLastGood();
  // Independent CDP read-only Network observer; no application request interception.
  void monitorTargets({
    host: options.host, port: options.port, collector: routeCollector,
    flowObserver: routeFlow,
    isClosed: () => false,
  }).catch((error) => process.stderr.write(`route monitor: ${error.message}\n`));

  for (;;) {
    cycle += 1;
    try {
      const targets = await listTargets({
        host: options.host,
        port: options.port,
        timeoutMs: Math.min(options.intervalMs, 1_200),
      });
      if (cycle === 1 || cycle % 3 === 0) {
        await observeCiiReadiness(targets, ciiObserver, { audit: ciiAudit });
      }
      const progressTarget = primaryProgressTarget(targets);
      const progressSnapshot = await readTransportProgress(options.transportHealthUrl);
      const progressExpression = options.transportHealthUrl
        ? buildProgressExpression(theme, progressSnapshot)
        : null;
      const results = [];
      for (const target of targets) {
        const result = await evaluate(target, expression, { timeoutMs: 5_000 });
        let projectCollapse = null;
        if (target.url === "app://-/index.html") {
          try {
            projectCollapse = await evaluate(target, projectCollapseExpression, { timeoutMs: 5_000 });
          } catch (error) {
            projectCollapse = { status: "error", message: String(error?.message ?? error).slice(0, 180) };
          }
        }
        let progress = null;
        if (progressExpression && progressTarget?.id === target.id) {
          progress = await evaluate(target, progressExpression, { timeoutMs: 5_000 });
        }
        let routeOverlay = null;
        if (progressTarget?.id === target.id) {
          const monitorSnapshot = routeCollector.snapshot();
          // Private in-process only: never include flow payloads in routeOverlay
          // return value, heartbeat, RouteRecorder, JSONL or audit records.
          monitorSnapshot.flow = routeFlow.snapshot();
          monitorSnapshot.lastGoodStatus = lastGoodStatus;
          monitorSnapshot.recording = recorder.status();
          routeOverlay = await evaluate(target,
            buildRouteOverlayExpression(monitorSnapshot), { timeoutMs: 5_000 });
          // The active conversation may have completed earlier turns even if
          // CURRENT is generating or temporarily behind its server cache.
          // Backfill only finished assistant/final ancestors from the exact
          // active conversation, with a distinct historical provenance.
          await recorder.command(routeOverlay?.recordingCommand,
            routeOverlay?.recordingObservation);
          await recorder.observe(routeOverlay?.recordingObservation);
          const active = routeOverlay?.responseEvidence;
          const olderFinal = active?.historicalFinal;
          const observationTime = new Date().toISOString();
          if (olderFinal) {
            lastGoodStatus = updateLastGood(lastGoodStatus, olderFinal, {
              observedAt: observationTime,
              staleResponse: routeOverlay?.staleResponse === true ||
                active?.messageStatus !== "finished_successfully" ||
                active?.createdAt !== olderFinal.createdAt,
            });
          }
          // Only completed, source-fenced messages can advance LAST FINAL.
          // A separately named resolved-effort field can advance LAST REPORTED
          // EFFORT; neither proves physical applied compute. CURRENT is separate.
          lastGoodStatus = updateLastGood(lastGoodStatus, active, {
            staleResponse: routeOverlay?.staleResponse === true,
            observedAt: observationTime,
          });
        }
        results.push({
          ...(routeOverlay ? { routeOverlay } : {}),
          ...(projectCollapse ? { projectCollapse } : {}),
          targetId: target.id,
          url: target.url,
          result,
          ...(progress ? { progress } : {}),
        });
      }
      unavailableSince = null;
      await writeHeartbeat({
        schemaVersion: 3,
        pid: process.pid,
        cycle,
        lastGoodStatus,
        recording: recorder.status(),
        healthy: true,
        checkedAt: new Date().toISOString(),
        endpoint: `${options.host}:${options.port}`,
        configPath: options.themePath ?? null,
        theme: { id: theme.id, name: theme.name },
        progress: options.transportHealthUrl ? {
          enabled: true,
          transportHealthUrl: options.transportHealthUrl,
          transport: progressSnapshot,
        } : { enabled: false },
        results,
      });
    } catch (error) {
      await recorder.failure();
      unavailableSince ??= Date.now();
      await writeHeartbeat({
        schemaVersion: 3,
        pid: process.pid,
        cycle,
        lastGoodStatus,
        recording: recorder.status(),
        healthy: false,
        checkedAt: new Date().toISOString(),
        endpoint: `${options.host}:${options.port}`,
        configPath: options.themePath ?? null,
        theme: { id: theme.id, name: theme.name },
        progress: { enabled: Boolean(options.transportHealthUrl) },
        error: error.message,
      });
      if (Date.now() - unavailableSince >= options.unavailableExitMs) {
        throw new Error(
          `CDP endpoint unavailable for ${options.unavailableExitMs}ms: ${error.message}`,
        );
      }
    }
    await delay(options.intervalMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `chatgpt-ui watcher: ${error.stack ?? error.message}\n`,
    );
    process.exitCode = 1;
  });
}
