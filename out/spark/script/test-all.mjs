import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const THIS_FILE = fileURLToPath(import.meta.url);
const OUT_DIR = fileURLToPath(new URL('../../', import.meta.url));

export function isolatedTestEnvironment(input = process.env) {
  const environment = { ...input };
  // SPARK itself can run as a Node test worker. Those flags must not leak
  // into a new, independent Node --test process: it would silently run 0 tests.
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_TEST_WORKER_ID;
  return environment;
}

export function parseTapSummary(output) {
  function count(name) {
    const expression = new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm');
    let match;
    let last = null;
    while ((match = expression.exec(output)) !== null) last = Number(match[1]);
    return last;
  }
  return {
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    todo: count('todo'),
  };
}

export function isPassingResult(exitCode, result) {
  return exitCode === 0
    && Number.isSafeInteger(result.tests) && result.tests > 0
    && Number.isSafeInteger(result.pass) && result.pass > 0
    && result.fail === 0
    && result.cancelled === 0
    && Number.isSafeInteger(result.skipped)
    && result.todo === 0
    && result.pass + result.skipped === result.tests;
}

export function prepareDisposableTestState(sourceRoot = path.resolve(OUT_DIR, '..')) {
  // A regular Git clone has no ignored test-state directory yet.
  // This directory is disposable; never initialize credentials or app sessions here.
  const stateDir = path.resolve(sourceRoot, 'log', 'system');
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

export function runVerifiedTests(testPaths) {
  if (!testPaths.length) {
    console.error('[SPARK TEST] No test paths supplied; refusing an empty success.');
    return 1;
  }
  // Fresh Git checkouts intentionally omit disposable runtime directories.
  // Only prepare this empty, ignored test-state directory; never touch secrets.
  prepareDisposableTestState();
  const run = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    '--test-reporter=tap',
    ...testPaths,
  ], {
    cwd: OUT_DIR,
    env: isolatedTestEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = parseTapSummary(run.stdout || '');
  const passed = !run.error && !run.signal && isPassingResult(run.status, result);
  console.log('[SPARK TEST] ' + (passed ? 'PASS' : 'FAIL')
    + ' total=' + (result.tests ?? 'unknown')
    + ' pass=' + (result.pass ?? 'unknown')
    + ' fail=' + (result.fail ?? 'unknown')
    + ' skipped=' + (result.skipped ?? 'unknown')
    + ' cancelled=' + (result.cancelled ?? 'unknown')
    + ' exit=' + (run.status ?? 'unknown'));
  if (!passed) {
    if (run.error) console.error(run.error);
    if (run.stdout) console.error(run.stdout.slice(-48000));
    if (run.stderr) console.error(run.stderr.slice(-8000));
  } else if (run.stderr && run.stderr.trim()) {
    console.warn(run.stderr.slice(-2000));
  }
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  process.exitCode = runVerifiedTests(process.argv.slice(2));
}
