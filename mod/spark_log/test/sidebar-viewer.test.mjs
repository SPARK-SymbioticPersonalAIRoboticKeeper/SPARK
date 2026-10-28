import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BACKUP = path.join(ROOT, 'mod', 'spark_log', 'backup', 'ChatBackup.Core.psm1');
const VIEWER = path.join(ROOT, 'mod', 'spark_log', 'viewer', 'viewer_cli.ps1');

async function readSidebarResolutionExpression() {
  const code = await fs.readFile(BACKUP, 'utf8');
  const funcStart = code.indexOf('function Resolve-ChatGPTSidebarItem(');
  const heredocStart = code.indexOf('$expr = @"', funcStart);
  const heredocEnd = code.indexOf('\n"@', heredocStart);
  assert.ok(funcStart >= 0 && heredocStart > funcStart && heredocEnd > heredocStart);
  const javascript = code.slice(heredocStart + '$expr = @"'.length, heredocEnd).trim();
  assert.match(javascript, /stableRows/);
  assert.match(javascript, /candidates\.length !== 1/);
  return javascript.replace('$titleJson', JSON.stringify('same-name'));
}

function sidebarRow(id, kind = 'server') {
  const row = {
    getAttribute(name) {
      if (name === 'aria-label') return 'same-name';
      if (name === 'data-app-action-sidebar-thread-id') return null;
      if (name === 'data-app-action-sidebar-thread-kind') return null;
      return null;
    },
  };
  row['__reactFiber$fixture'] = {
    memoizedProps: { conversationId: id, item: { kind } },
    return: null,
  };
  return row;
}

function resolve(javascript, rows) {
  const document = { querySelectorAll: () => rows };
  return JSON.parse(vm.runInNewContext(javascript, { document }, { timeout: 1000 }));
}

test('ChatLog backup resolves duplicate optimistic sidebar render by real server identity', async () => {
  const javascript = await readSidebarResolutionExpression();
  const id = '11111111-2222-4333-8444-555555555555';
  const found = resolve(javascript, [
    sidebarRow(id, 'server'),
    sidebarRow(id, 'optimistic'),
  ]);
  assert.equal(found.ok, true);
  assert.equal(found.id, id);
  assert.equal(found.kind, 'server');
  assert.equal(found.title, 'same-name');
});

test('ChatLog backup never selects an ambiguous real conversation with matching title', async () => {
  const javascript = await readSidebarResolutionExpression();
  const found = resolve(javascript, [
    sidebarRow('server-id-one', 'server'),
    sidebarRow('server-id-two', 'server'),
  ]);
  assert.equal(found.ok, false);
  assert.equal(found.count, 2);
  assert.match(found.error, /multiple/i);
  const missing = resolve(javascript, []);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/i);
});

test('Viewer uses a fresh live element objectId rather than a stale DOM nodeId', async () => {
  const source = await fs.readFile(VIEWER, 'utf8');
  assert.match(source, /document\.querySelector\('#fileInput'\)/);
  assert.match(source, /DOM\.setFileInputFiles/);
  assert.match(source, /objectId = \$objectId/);
  assert.doesNotMatch(source, /DOM\.querySelector' @\{ nodeId/);
  assert.match(source, /Viewer file input did not become ready/);
  assert.match(source, /AddSeconds\(60\)/);
  assert.match(source, /VIEWER_OPENED/);
});
