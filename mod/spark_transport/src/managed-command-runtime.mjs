import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from './command-runner.mjs';

const EXIT_DRAIN_GRACE_MS = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createBoundedCapture(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let observedBytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += buffer.length;
      const remaining = Math.max(0, maxBytes - bytes);
      if (buffer.length <= remaining) {
        chunks.push(buffer);
        bytes += buffer.length;
      } else {
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
      }
    },
    stats() {
      return { capturedBytes: bytes, observedBytes, truncated };
    },
    result() {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
        capturedBytes: bytes,
        observedBytes,
      };
    },
  };
}

function validateStart({ command, args, timeoutMs, maxOutputBytes, heartbeatIntervalMs, initialWaitMs, requestSegmentMs }) {
  if (typeof command !== 'string' || !command.trim()) return 'command must be a non-empty string';
  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) return 'args must be an array of strings';
  if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) return 'timeoutMs must be a positive integer when provided';
  for (const [name, value] of [['maxOutputBytes', maxOutputBytes], ['heartbeatIntervalMs', heartbeatIntervalMs], ['initialWaitMs', initialWaitMs], ['requestSegmentMs', requestSegmentMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) return `${name} must be a positive integer`;
  }
  return null;
}

export function createManagedCommandRuntime({
  maxOutputBytes = 64 * 1024,
  heartbeatIntervalMs = 10_000,
  initialWaitMs = 2_000,
  requestSegmentMs = 45_000,
} = {}) {
  const tasks = new Map();

  function snapshot(task, kind = 'heartbeat') {
    const now = Date.now();
    const stdout = task.stdoutCapture.stats();
    const stderr = task.stderrCapture.stats();
    const outputAdvanced =
      stdout.observedBytes > task.lastReportedStdoutBytes ||
      stderr.observedBytes > task.lastReportedStderrBytes;
    task.lastReportedStdoutBytes = stdout.observedBytes;
    task.lastReportedStderrBytes = stderr.observedBytes;
    const elapsedMs = now - task.startedAt;
    const deadlineMs = task.timeoutMs ?? null;
    const remainingMs = deadlineMs === null ? null : Math.max(0, deadlineMs - elapsedMs);
    const warnings = [];
    if (deadlineMs !== null) warnings.push('EXPLICIT_DEADLINE_ACTIVE');
    if (kind !== 'started' && !outputAdvanced) warnings.push('NO_OBSERVABLE_OUTPUT_CHANGE');
    return {
      kind,
      resumeId: task.resumeId,
      pid: task.child?.pid ?? null,
      processAlive: task.finalResult === null,
      elapsedMs,
      stdoutBytes: stdout.observedBytes,
      stderrBytes: stderr.observedBytes,
      outputAdvanced,
      noOutputForMs: Math.max(0, now - task.lastOutputAt),
      deadlineMs,
      deadlineAt: deadlineMs === null ? null : new Date(task.startedAt + deadlineMs).toISOString(),
      remainingMs,
      warnings,
    };
  }

  function workingResult(task, { requestDetached = false } = {}) {
    const snap = snapshot(task, requestDetached ? 'detached' : 'segment');
    const stdout = task.stdoutCapture.result();
    const stderr = task.stderrCapture.result();
    const warnings = [...snap.warnings];
    if (requestDetached && !warnings.includes('REQUEST_SEGMENT_DETACHED')) warnings.push('REQUEST_SEGMENT_DETACHED');
    return {
      ok: true,
      inProgress: true,
      status: 'working',
      resumeId: task.resumeId,
      pid: snap.pid,
      processAlive: true,
      elapsedMs: snap.elapsedMs,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutBytes: stdout.observedBytes,
      stderrBytes: stderr.observedBytes,
      outputAdvanced: snap.outputAdvanced,
      noOutputForMs: snap.noOutputForMs,
      deadlineMs: snap.deadlineMs,
      deadlineAt: snap.deadlineAt,
      remainingMs: snap.remainingMs,
      requestSegmentMs,
      requestDetached,
      warnings,
    };
  }

  function finalize(task, payload) {
    if (task.finalResult) return task.finalResult;
    clearTimeout(task.deadlineTimer);
    clearTimeout(task.exitDrainTimer);
    const stdout = task.stdoutCapture.result();
    const stderr = task.stderrCapture.result();
    const durationMs = Date.now() - task.startedAt;
    task.finalResult = {
      ...payload,
      inProgress: false,
      resumeId: task.resumeId,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      processDurationMs: durationMs,
    };
    task.resolveCompletion(task.finalResult);
    return task.finalResult;
  }

  function finishFromExit(task, code, signal) {
    if (task.finalResult) return task.finalResult;
    if (task.timedOut) {
      return finalize(task, {
        ok: false,
        status: 'failed',
        exitCode: code,
        signal,
        stateUncertain: true,
        error: {
          code: 'COMMAND_TIMEOUT',
          message: `command exceeded the explicit ${task.timeoutMs} ms terminal deadline`,
        },
      });
    }
    if (task.cancelReason) {
      return finalize(task, {
        ok: false,
        status: 'cancelled',
        exitCode: code,
        signal,
        stateUncertain: true,
        error: {
          code: task.cancelReason === 'user' ? 'COMMAND_CANCELLED_BY_USER' : 'COMMAND_CANCELLED',
          message: task.cancelReason === 'user' ? 'command was cancelled by explicit user request' : 'command was cancelled',
        },
      });
    }
    return finalize(task, {
      ok: code === 0,
      status: code === 0 ? 'completed' : 'failed',
      exitCode: code,
      signal,
      ...(code === 0 ? {} : {
        stateUncertain: true,
        error: {
          code: 'COMMAND_FAILED',
          message: 'command exited with non-zero status; elevated execution is not attempted automatically',
        },
      }),
    });
  }

  async function terminateTask(task, reason) {
    if (!task || task.finalResult) return task?.finalResult ?? null;
    task.cancelReason = reason;
    await terminateProcessTree(task.child?.pid, task.child);
    await delay(EXIT_DRAIN_GRACE_MS);
    if (!task.finalResult) {
      try { task.child?.stdout?.destroy(); } catch {}
      try { task.child?.stderr?.destroy(); } catch {}
      finishFromExit(task, task.child?.exitCode ?? null, task.child?.signalCode ?? null);
    }
    return task.finalResult;
  }

  function startTask({ command, args = [], cwd, timeoutMs = null, env = {} }) {
    const validationError = validateStart({
      command,
      args,
      timeoutMs,
      maxOutputBytes,
      heartbeatIntervalMs,
      initialWaitMs,
      requestSegmentMs,
    });
    if (validationError) {
      return {
        error: {
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', message: validationError },
        },
      };
    }

    const resumeId = `cmd_${randomUUID()}`;
    const startedAt = Date.now();
    const task = {
      resumeId,
      command,
      args,
      cwd,
      timeoutMs,
      startedAt,
      lastOutputAt: startedAt,
      lastReportedStdoutBytes: 0,
      lastReportedStderrBytes: 0,
      stdoutCapture: createBoundedCapture(maxOutputBytes),
      stderrCapture: createBoundedCapture(maxOutputBytes),
      child: null,
      finalResult: null,
      completion: null,
      resolveCompletion: null,
      deadlineTimer: null,
      exitDrainTimer: null,
      timedOut: false,
      cancelReason: null,
    };
    task.completion = new Promise((resolve) => { task.resolveCompletion = resolve; });

    try {
      task.child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      const permission = error?.code === 'EACCES' || error?.code === 'EPERM';
      return {
        error: {
          ok: false,
          error: {
            code: permission ? 'ELEVATION_REQUIRED_OR_PERMISSION_DENIED' : 'COMMAND_START_FAILED',
            message: permission ? 'command could not start with current non-elevated permissions' : 'command could not be started',
          },
        },
      };
    }

    tasks.set(resumeId, task);

    task.child.stdout?.on('data', (chunk) => {
      task.stdoutCapture.push(chunk);
      task.lastOutputAt = Date.now();
    });
    task.child.stderr?.on('data', (chunk) => {
      task.stderrCapture.push(chunk);
      task.lastOutputAt = Date.now();
    });

    task.child.once('error', (error) => {
      if (task.finalResult) return;
      const permission = error?.code === 'EACCES' || error?.code === 'EPERM';
      finalize(task, {
        ok: false,
        status: 'failed',
        exitCode: null,
        signal: null,
        error: {
          code: permission ? 'ELEVATION_REQUIRED_OR_PERMISSION_DENIED' : 'COMMAND_START_FAILED',
          message: permission ? 'command could not start with current non-elevated permissions' : 'command could not be started',
        },
      });
    });

    task.child.once('exit', (code, signal) => {
      if (task.finalResult || task.timedOut || task.cancelReason) return;
      task.exitDrainTimer = setTimeout(() => {
        try { task.child?.stdout?.destroy(); } catch {}
        try { task.child?.stderr?.destroy(); } catch {}
        finishFromExit(task, code, signal);
      }, EXIT_DRAIN_GRACE_MS);
    });

    task.child.once('close', (code, signal) => {
      if (task.finalResult) return;
      finishFromExit(task, code, signal);
    });

    if (timeoutMs !== null) {
      task.deadlineTimer = setTimeout(() => {
        if (task.finalResult || task.timedOut) return;
        task.timedOut = true;
        void terminateProcessTree(task.child?.pid, task.child).then(async () => {
          await delay(EXIT_DRAIN_GRACE_MS);
          if (!task.finalResult) finishFromExit(task, task.child?.exitCode ?? null, task.child?.signalCode ?? null);
        });
      }, timeoutMs);
      task.deadlineTimer.unref?.();
    }

    return { task };
  }

  async function waitSegment(task, { waitMs, onHeartbeat, signal, first = false } = {}) {
    if (task.finalResult) return task.finalResult;
    if (signal?.aborted) return workingResult(task, { requestDetached: true });

    return await new Promise((resolve) => {
      let settled = false;
      let segmentTimer;
      let heartbeatTimer;
      let abortHandler;

      const cleanup = () => {
        clearTimeout(segmentTimer);
        clearInterval(heartbeatTimer);
        if (abortHandler && signal?.removeEventListener) {
          try { signal.removeEventListener('abort', abortHandler); } catch {}
        }
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const emit = (kind) => {
        if (typeof onHeartbeat !== 'function' || task.finalResult) return;
        try { onHeartbeat(snapshot(task, kind)); } catch {}
      };

      emit(first ? 'started' : 'resumed');
      heartbeatTimer = setInterval(() => emit('heartbeat'), heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      segmentTimer = setTimeout(() => finish(workingResult(task)), waitMs);
      task.completion.then(finish).catch(() => {});

      abortHandler = () => finish(workingResult(task, { requestDetached: true }));
      if (signal?.addEventListener) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
    });
  }

  async function startAndWait(options, context = {}) {
    const started = startTask(options);
    if (started.error) return started.error;
    return await waitSegment(started.task, {
      waitMs: initialWaitMs,
      onHeartbeat: context.onProgress,
      signal: context.signal,
      first: true,
    });
  }

  async function resume(resumeId, { cancel = false } = {}, context = {}) {
    const task = tasks.get(resumeId);
    if (!task) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_RESUME_ID',
          message: 'managed command resumeId is unknown to this SPARK runtime; reconcile process/state before starting a replacement command',
        },
      };
    }
    if (cancel) return await terminateTask(task, 'user');
    return await waitSegment(task, {
      waitMs: requestSegmentMs,
      onHeartbeat: context.onProgress,
      signal: context.signal,
      first: false,
    });
  }

  function activity() {
    const active = [];
    for (const task of tasks.values()) {
      if (task.finalResult) continue;
      active.push({
        resumeId: task.resumeId,
        pid: task.child?.pid ?? null,
        startedAt: new Date(task.startedAt).toISOString(),
        elapsedMs: Date.now() - task.startedAt,
      });
    }
    return { activeCount: active.length, active };
  }

  async function closeAll() {
    const active = [...tasks.values()].filter((task) => !task.finalResult);
    await Promise.all(active.map((task) => terminateTask(task, 'server')));
  }

  return {
    startAndWait,
    resume,
    activity,
    closeAll,
    requestSegmentMs,
    initialWaitMs,
  };
}
