import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isolatedTestEnvironment,
  parseTapSummary,
  isPassingResult,
  prepareDisposableTestState,
} from '../../../out/spark/script/test-all.mjs';

test('verified test runner removes inherited Node worker context', () => {
  const original = { NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '1', SAFE: 'ok' };
  const child = isolatedTestEnvironment(original);
  assert.deepEqual(child, { SAFE: 'ok' });
  assert.equal(original.NODE_TEST_CONTEXT, 'child-v8');
});

test('verified test runner rejects zero tests or incomplete summary even on exit zero', () => {
  assert.equal(isPassingResult(0, parseTapSummary('')), false);
  assert.equal(isPassingResult(0, parseTapSummary('# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n')), false);
  assert.equal(isPassingResult(0, parseTapSummary('# tests 5\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n')), false);
});

test('verified test runner distinguishes complete pass, failed tests and OS skips', () => {
  const success = parseTapSummary('# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  assert.deepEqual(success, { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(isPassingResult(0, success), true);
  assert.equal(isPassingResult(1, success), false);
  const fail = parseTapSummary('# tests 5\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n');
  assert.equal(isPassingResult(0, fail), false);
  const skip = parseTapSummary('# tests 5\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n');
  assert.equal(isPassingResult(0, skip), true);
});

test('fresh Git checkout prepares only disposable test state and preserves existing contents', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'spark-test-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = prepareDisposableTestState(root);
  assert.equal(statSync(target).isDirectory(), true);
  const stateFile = path.join(target, 'existing.json');
  writeFileSync(stateFile, '{"keep":true}\n', 'utf8');
  assert.equal(prepareDisposableTestState(root), target);
  assert.equal(readFileSync(stateFile, 'utf8'), '{"keep":true}\n');
});
