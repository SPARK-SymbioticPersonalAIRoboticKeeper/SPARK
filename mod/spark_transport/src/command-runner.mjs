import { spawn } from 'node:child_process';

const WINDOWS_KILLER_TIMEOUT_MS = 3_000;
const EXIT_DRAIN_GRACE_MS = 250;

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
      return { text: Buffer.concat(chunks).toString('utf8'), truncated, bytes, observedBytes };
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function terminateProcessTree(pid, child) {
  if (!pid) {
    try { child?.kill('SIGKILL'); } catch {}
    return;
  }

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      let killer;
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      try {
        killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        finish();
        return;
      }
      killer.once('error', finish);
      killer.once('close', finish);
      timer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); } catch {}
        finish();
      }, WINDOWS_KILLER_TIMEOUT_MS);
    });
    try { child?.kill('SIGKILL'); } catch {}
    return;
  }

  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { child?.kill('SIGTERM'); } catch {} }
  await delay(150);
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { child?.kill('SIGKILL'); } catch {} }
}

export async function runProcess({
  command,
  args = [],
  cwd,
  timeoutMs,
  maxOutputBytes = 64 * 1024,
  env = {},
  heartbeatIntervalMs = 10_000,
  onHeartbeat,
  signal: abortSignal,
}) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'command must be a non-empty string' } };
  }
  if (!Array.isArray(args) || !args.every((v) => typeof v === 'string')) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'args must be an array of strings' } };
  }
  if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'timeoutMs must be a positive integer when provided' } };
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'heartbeatIntervalMs must be a positive integer' } };
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'maxOutputBytes must be a positive integer' } };
  }
  if (onHeartbeat !== undefined && typeof onHeartbeat !== 'function') {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'onHeartbeat must be a function when provided' } };
  }
  if (abortSignal?.aborted) {
    return {
      ok: false,
      error: { code: 'COMMAND_CANCELLED_BEFORE_START', message: 'command was cancelled before it started' },
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let child;
    let timeoutTimer;
    let heartbeatTimer;
    let exitDrainTimer;
    let abortHandler;
    let lastStdoutBytes = 0;
    let lastStderrBytes = 0;
    let lastOutputAt = startedAt;
    const stdoutCapture = createBoundedCapture(maxOutputBytes);
    const stderrCapture = createBoundedCapture(maxOutputBytes);

    const removeAbortListener = () => {
      if (abortHandler && abortSignal?.removeEventListener) {
        try { abortSignal.removeEventListener('abort', abortHandler); } catch {}
      }
    };

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(exitDrainTimer);
      clearInterval(heartbeatTimer);
      removeAbortListener();
      const stdout = stdoutCapture.result();
      const stderr = stderrCapture.result();
      resolve({
        ...payload,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const finishFromExit = (code, exitSignal) => {
      if (timedOut) {
        finish({
          ok: false,
          error: { code: 'COMMAND_TIMEOUT', message: `command exceeded the explicit ${timeoutMs} ms terminal deadline` },
          exitCode: code,
          signal: exitSignal,
        });
        return;
      }
      if (cancelled) {
        finish({
          ok: false,
          error: { code: 'COMMAND_CANCELLED', message: 'command was cancelled before completion' },
          exitCode: code,
          signal: exitSignal,
        });
        return;
      }
      finish({
        ok: code === 0,
        exitCode: code,
        signal: exitSignal,
        ...(code === 0 ? {} : {
          error: {
            code: 'COMMAND_FAILED',
            message: 'command exited with non-zero status; elevated execution is not attempted automatically',
          },
        }),
      });
    };

    const emitHeartbeat = (kind) => {
      if (settled || !child?.pid || typeof onHeartbeat !== 'function') return;
      const now = Date.now();
      const elapsedMs = now - startedAt;
      const stdout = stdoutCapture.stats();
      const stderr = stderrCapture.stats();
      const outputAdvanced = stdout.observedBytes > lastStdoutBytes || stderr.observedBytes > lastStderrBytes;
      lastStdoutBytes = stdout.observedBytes;
      lastStderrBytes = stderr.observedBytes;
      const deadlineMs = timeoutMs ?? null;
      const remainingMs = deadlineMs === null ? null : Math.max(0, deadlineMs - elapsedMs);
      const warnings = [];
      if (deadlineMs !== null) warnings.push('EXPLICIT_DEADLINE_ACTIVE');
      if (kind === 'heartbeat' && !outputAdvanced) warnings.push('NO_OBSERVABLE_OUTPUT_CHANGE');
      try {
        onHeartbeat({
          kind,
          pid: child.pid,
          processAlive: true,
          elapsedMs,
          stdoutBytes: stdout.observedBytes,
          stderrBytes: stderr.observedBytes,
          outputAdvanced,
          noOutputForMs: Math.max(0, now - lastOutputAt),
          deadlineMs,
          deadlineAt: deadlineMs === null ? null : new Date(startedAt + deadlineMs).toISOString(),
          remainingMs,
          warnings,
        });
      } catch {}
    };

    const terminate = async (reason) => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      clearInterval(heartbeatTimer);
      await terminateProcessTree(child?.pid, child);
      await delay(EXIT_DRAIN_GRACE_MS);
      if (!settled) {
        try { child?.stdout?.destroy(); } catch {}
        try { child?.stderr?.destroy(); } catch {}
        finishFromExit(child?.exitCode ?? null, child?.signalCode ?? null);
      }
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      const permission = error?.code === 'EACCES' || error?.code === 'EPERM';
      finish({
        ok: false,
        error: {
          code: permission ? 'ELEVATION_REQUIRED_OR_PERMISSION_DENIED' : 'COMMAND_START_FAILED',
          message: permission ? 'command could not start with current non-elevated permissions' : 'command could not be started',
        },
      });
      return;
    }

    child.stdout?.on('data', (d) => { stdoutCapture.push(d); lastOutputAt = Date.now(); });
    child.stderr?.on('data', (d) => { stderrCapture.push(d); lastOutputAt = Date.now(); });

    child.once('error', (error) => {
      if (settled || timedOut || cancelled) return;
      const permission = error?.code === 'EACCES' || error?.code === 'EPERM';
      finish({
        ok: false,
        error: {
          code: permission ? 'ELEVATION_REQUIRED_OR_PERMISSION_DENIED' : 'COMMAND_START_FAILED',
          message: permission ? 'command could not start with current non-elevated permissions' : 'command could not be started',
        },
      });
    });

    child.once('exit', (code, exitSignal) => {
      if (settled || timedOut || cancelled) return;
      exitDrainTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finishFromExit(code, exitSignal);
      }, EXIT_DRAIN_GRACE_MS);
    });

    child.once('close', (code, exitSignal) => {
      if (settled || timedOut || cancelled) return;
      finishFromExit(code, exitSignal);
    });

    emitHeartbeat('started');
    heartbeatTimer = setInterval(() => emitHeartbeat('heartbeat'), heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    abortHandler = () => {
      if (settled || timedOut || cancelled) return;
      void terminate('cancelled');
    };
    if (abortSignal?.addEventListener) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
      if (abortSignal.aborted) abortHandler();
    }

    if (timeoutMs !== undefined && timeoutMs !== null) {
      timeoutTimer = setTimeout(() => {
        if (settled || timedOut || cancelled) return;
        void terminate('timeout');
      }, timeoutMs);
    }
  });
}
