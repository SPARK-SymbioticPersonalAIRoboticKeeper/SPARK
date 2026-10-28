const MUTATING_OPERATIONS = new Set([
  'create_file',
  'write_file',
  'modify_file',
  'create_directory',
  'copy_path',
  'move_path',
  'delete_path',
  'run_command',
]);

const SAFE_PRECONDITION_ERRORS = new Set([
  'INVALID_ARGUMENTS',
  'PATH_TRAVERSAL',
  'ABSOLUTE_PATH_NOT_ALLOWED',
  'OUTSIDE_ALLOWED_ROOT',
  'ROOT_PERMISSION_DENIED',
  'ROOT_DELETE_FORBIDDEN',
  'ALREADY_EXISTS',
  'NOT_FOUND',
  'AMBIGUOUS_ROOT_PATH',
  'SYMLINK_ESCAPE',
  'SYMLINK_MUTATION_NOT_ALLOWED',
  'ELEVATION_REQUIRED_OR_PERMISSION_DENIED',
  'COMMAND_START_FAILED',
  'COMMAND_CANCELLED_BEFORE_START',
]);

const COMMAND_WATCHDOG_GRACE_MS = 5_000;
const DEFAULT_LEDGER_WATCHDOG_MS = 5_000;

function operationTarget(name, args = {}) {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.source === 'string' && typeof args.destination === 'string') return `${args.source} -> ${args.destination}`;
  if (name === 'run_command' && (args.command === '__SPARK_CONTINUE__' || args.command === '__SPARK_CANCEL__')) return args.command;
  if (name === 'run_command') return [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ');
  return null;
}

function summaryFor(name, legacy) {
  if (legacy.ok === true) {
    if (name === 'list_directory') return `Listed ${legacy.entries?.length ?? 0} entries.`;
    if (name === 'read_file') return `Read ${legacy.path ?? 'file'}.`;
    if (name === 'run_command' && legacy.inProgress && legacy.continuation) return `Command is still running; immediately continue with run_command command=${legacy.continuation.command} and the returned args.`;
    if (name === 'run_command') return `Command completed with exit code ${legacy.exitCode ?? 0}.`;
    return `${name} completed.`;
  }
  return legacy.error?.message ?? `${name} failed.`;
}

function dataOnly(legacy) {
  const data = { ...legacy };
  delete data.ok;
  delete data.error;
  delete data.durationMs;
  return data;
}

function watchdogMsFor(name, args, operationTimeoutMs, commandTimeoutMs) {
  if (name !== 'run_command') return operationTimeoutMs;
  const explicit = Number.isSafeInteger(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : null;
  const configured = Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0 ? commandTimeoutMs : null;
  const deadline = explicit ?? configured;
  return deadline === null ? null : deadline + COMMAND_WATCHDOG_GRACE_MS;
}

function withWatchdog(promise, timeoutMs, timeoutValue) {
  if (timeoutMs === null || timeoutMs === undefined) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(typeof timeoutValue === 'function' ? timeoutValue() : timeoutValue);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stateMayHaveChanged(name, legacy) {
  if (!MUTATING_OPERATIONS.has(name) || legacy.ok === true) return false;
  const code = legacy.error?.code;
  if (code === 'OPERATION_TIMEOUT' || code === 'COMMAND_TIMEOUT' || code === 'RECYCLE_BIN_TIMEOUT') return true;
  if (name === 'run_command') return !SAFE_PRECONDITION_ERRORS.has(code);
  return false;
}

export function createOperationRuntime({ toolRuntime, ledger, operationTimeoutMs = 30_000, commandTimeoutMs = 30_000, ledgerTimeoutMs = DEFAULT_LEDGER_WATCHDOG_MS }) {
  let pendingUncertainMutation = null;
  let activeOperation = null;
  let lastOperation = null;

  function activity() {
    return {
      active: activeOperation ? { ...activeOperation } : null,
      pendingUncertainMutation: pendingUncertainMutation ? {
        operationId: pendingUncertainMutation.operationId,
        operation: pendingUncertainMutation.name,
      } : null,
      last: lastOperation ? { ...lastOperation } : null,
    };
  }

  async function call(name, args = {}, context = {}) {
    const operationId = ledger.nextOperationId();
    const startedAt = Date.now();
    const watchdogMs = watchdogMsFor(name, args, operationTimeoutMs, commandTimeoutMs);
    activeOperation = {
      operationId,
      operation: name,
      startedAt: new Date(startedAt).toISOString(),
      startedAtMs: startedAt,
      watchdogMs,
      mutating: MUTATING_OPERATIONS.has(name),
    };
    let legacy;
    if (MUTATING_OPERATIONS.has(name) && pendingUncertainMutation) {
      legacy = {
        ok: false,
        stateUncertain: true,
        pendingOperationId: pendingUncertainMutation.operationId,
        error: {
          code: 'UNCERTAIN_MUTATION_IN_FLIGHT',
          message: `prior timed-out mutation ${pendingUncertainMutation.operationId} has not settled; reconcile state before another mutation`,
        },
      };
    } else {
      const toolPromise = Promise.resolve().then(() => toolRuntime.call(name, args, context));
      let toolSettled = false;
      void toolPromise.finally(() => {
        toolSettled = true;
        if (pendingUncertainMutation?.promise === toolPromise) pendingUncertainMutation = null;
      }).catch(() => {});
      try {
        legacy = await withWatchdog(
          toolPromise,
          watchdogMs,
          () => ({
            ok: false,
            stateUncertain: MUTATING_OPERATIONS.has(name),
            error: {
              code: 'OPERATION_TIMEOUT',
              message: `operation exceeded ${watchdogMs} ms watchdog`,
            },
          }),
        );
        if (legacy.error?.code === 'OPERATION_TIMEOUT' && MUTATING_OPERATIONS.has(name) && !toolSettled) {
          pendingUncertainMutation = { operationId, name, promise: toolPromise };
          legacy.pendingOperationId = operationId;
        }
      } catch {
        legacy = { ok: false, error: { code: 'INTERNAL_ERROR', message: 'the operation failed' } };
      }
    }

    const durationMs = Number.isFinite(legacy.durationMs) ? legacy.durationMs : Date.now() - startedAt;
    const inProgress = legacy.ok === true && legacy.inProgress === true;
    const changed = legacy.ok === true && MUTATING_OPERATIONS.has(name) && !inProgress;
    const stateUncertain = Boolean(legacy.stateUncertain || stateMayHaveChanged(name, legacy));
    if (stateUncertain) legacy.stateUncertain = true;
    const error = legacy.ok === true ? undefined : {
      code: legacy.error?.code ?? 'INTERNAL_ERROR',
      message: legacy.error?.message ?? 'the operation failed',
      ...(legacy.error?.platformCode ? { platformCode: legacy.error.platformCode } : {}),
    };
    const requiresElevation = Boolean(error && ['EACCES', 'EPERM', 'PERMISSION_DENIED', 'ELEVATION_REQUIRED', 'ELEVATION_REQUIRED_OR_PERMISSION_DENIED'].includes(error.code));
    const summary = summaryFor(name, legacy);
    const result = {
      ok: legacy.ok === true,
      operationId,
      operation: name,
      summary,
      changed,
      data: dataOnly(legacy),
      durationMs,
      requiresElevation,
      retryable: !inProgress && !stateUncertain && (error?.code === 'COMMAND_TIMEOUT' || error?.code === 'OPERATION_TIMEOUT'),
      ...(error ? { error } : {}),
    };

    const ledgerEntry = {
      operationId,
      operation: name,
      target: operationTarget(name, args),
      status: inProgress ? 'working' : (result.ok ? 'success' : 'failed'),
      changed,
      durationMs,
      errorCode: error?.code ?? null,
      summary,
    };
    try {
      const ledgerOutcome = await withWatchdog(ledger.record(ledgerEntry), ledgerTimeoutMs, Symbol.for('SPARK_LEDGER_TIMEOUT'));
      if (ledgerOutcome === Symbol.for('SPARK_LEDGER_TIMEOUT')) result.data.ledgerWarning = 'operation ledger write exceeded watchdog';
    } catch {
      result.data.ledgerWarning = 'operation ledger write failed';
    }
    lastOperation = {
      operationId,
      operation: name,
      status: inProgress ? 'working' : (result.ok ? 'success' : 'failed'),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs,
      stateUncertain,
      errorCode: error?.code ?? null,
    };
    if (activeOperation?.operationId === operationId) activeOperation = null;
    return result;
  }

  return { call, activity };
}
