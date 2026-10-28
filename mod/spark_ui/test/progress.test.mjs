import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProgressExpression, buildProgressRestoreExpression, PROGRESS_ROOT_ID } from '../src/progress.mjs';
import { loadTheme } from '../src/theme.mjs';

const theme=await loadTheme();

test('progress overlay expression carries only bounded activity metadata and usage integration',()=>{
  const expression=buildProgressExpression(theme,{
    checkedAt:'2026-09-15T00:00:00.000Z',
    activity:{
      active:{operationId:'op-test',operation:'run_command',startedAtMs:1000,watchdogMs:30000,mutating:true},
      pendingUncertainMutation:null,
      last:null,
    },
  });
  assert.match(expression,new RegExp(PROGRESS_ROOT_ID));
  assert.match(expression,/run_command/);
  assert.match(expression,/brainWorking/);
  assert.match(expression,/app-shared-/);
  assert.match(expression,/safeGet/);
  assert.match(expression,/\/wham\/usage/);
  assert.match(expression,/remainingPercent/);
  assert.match(expression,/retiredLeftWidget: true/);
  assert.match(expression,/document.getElementById\(payload.rootId\)\?\.remove\(\)/);
  assert.match(expression,/browserState.transport = payload.snapshot/);
  assert.match(expression,/limitReached/);
  assert.match(expression,/lastSuccessAt/);
  assert.match(expression,/additional_rate_limits/);
  assert.match(expression,/rawUsed == null \|\| rawUsed === ""/);
  assert.doesNotMatch(expression,/compact-panel|numbers-v1|usage-primary-percent/);
  assert.doesNotMatch(expression,/Switch mode|_ModelPickerTriggerModelText_/);
  assert.doesNotMatch(expression,/spark-progress-top|spark-progress-bottom/);
  assert.doesNotMatch(expression,/Open profile menu|aria-label="Update"/);
  assert.doesNotMatch(expression,/\.Uqt\b/);
  assert.doesNotMatch(expression,/targetPath|commandArgs|Authorization: Bearer/);
  assert.doesNotThrow(()=>new Function(`return ${expression}`));
});

test('progress restore removes overlay and browser state',()=>{
  const expression=buildProgressRestoreExpression();
  assert.match(expression,new RegExp(PROGRESS_ROOT_ID));
  assert.match(expression,/\.remove\(\)/);
  assert.match(expression,/__sparkProgressState/);
});
