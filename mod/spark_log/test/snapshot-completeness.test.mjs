import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const parser = require(path.join(root, 'mod', 'spark_log', 'viewer', 'parser.js'));
const viewerCli = path.join(root, 'mod', 'spark_log', 'viewer', 'viewer_cli.ps1');
const viewerJs = path.join(root, 'mod', 'spark_log', 'viewer', 'viewer.js');

function message(role, content, options = {}) {
  return {
    author: { role },
    content: { content_type: 'text', parts: [content] },
    status: 'finished_successfully',
    recipient: 'all',
    channel: role === 'assistant' ? 'final' : null,
    ...options,
  };
}

function exampleSnapshot() {
  const events = [
    ['u1', message('user', 'Initial user request')],
    ['call1', message('assistant', '{"tool":"run_command"}', {
      recipient: 'api_tool.call_tool', channel: null,
      content: { content_type: 'code', language: 'json', text: '{"tool":"run_command"}' },
    })],
    ['tool1', message('tool', '{"stdout":"private result"}')],
    ['final1', message('assistant', 'Last fully completed assistant answer')],
    ['u2', message('user', 'Please capture the latest answer')],
    ['progress', message('assistant', 'Interim status without a final', { channel: 'commentary' })],
    ['draft', message('assistant', 'Draft output never completed', {
      status: 'in_progress',
    })],
  ];
  const mapping = {};
  let parent = null;
  for (const [id, m] of events) {
    mapping[id] = { parent, message: { id, ...m, create_time: events.findIndex(x => x[0] === id) + 1 } };
    parent = id;
  }
  return { conversation_id: 'synthetic-chat', title: 'Fixture', mapping, current_node: 'draft' };
}

test('backup Viewer suppresses tool-call payloads and incomplete assistant fragments', () => {
  const fixture = exampleSnapshot();
  const conversation = parser.parseConversation(fixture);
  const contents = conversation.messages.map(m => m.text);
  assert.deepEqual(contents, [
    'Initial user request',
    'Last fully completed assistant answer',
    'Please capture the latest answer',
  ]);
  assert.equal(conversation.snapshot.newestTurnPending, true);
  assert.equal(conversation.snapshot.lastUserTurnCompleted, false);
  assert.equal(conversation.snapshot.lastCompletedFinalTime, 4);
  assert.equal(conversation.messages.at(-1).role, 'user');
  assert.ok(!contents.includes('Interim status without a final'));
});

test('a finished final after latest user explicitly clears the incomplete-snapshot warning', () => {
  const fixture = exampleSnapshot();
  fixture.mapping.complete = {
    parent: 'draft',
    message: {
      id: 'complete',
      ...message('assistant', 'Final verified reply'),
      create_time: 7,
    },
  };
  fixture.current_node = 'complete';
  const conversation = parser.parseConversation(fixture);
  assert.equal(conversation.snapshot.newestTurnPending, false);
  assert.equal(conversation.snapshot.lastUserTurnCompleted, true);
  assert.equal(conversation.messages.at(-1).text, 'Final verified reply');
  assert.ok(conversation.messages.some(m => m.text === 'Interim status without a final'));
});

test('Viewer clearly identifies a snapshot captured during a still-running response', async () => {
  const source = await fs.readFile(viewerJs, 'utf8');
  assert.match(source, /INCOMPLETE SNAPSHOT: latest user turn has no finished assistant final/);
  assert.match(source, /Last completed final:/);
  assert.match(source, /main\.scrollTop = main\.scrollHeight/);
});

test('auto-open Viewer selects the configured Windows default browser instead of fixed Edge', async () => {
  const source = await fs.readFile(viewerCli, 'utf8');
  assert.match(source, /Get-DefaultBrowserPath/);
  assert.match(source, /UrlAssociations\\https\\UserChoice/);
  assert.match(source, /Registry\]::ClassesRoot/);
  assert.match(source, /VIEWER_DEFAULT_BROWSER=/);
  assert.match(source, /Start-Process -FilePath \$browser\.Path/);
  assert.doesNotMatch(source, /function Get-EdgePath/);
  assert.doesNotMatch(source, /\$edge = Get-EdgePath/);
});

test('backup CLI exposes semantic snapshot completeness and GUI never calls an in-progress capture complete', async () => {
  const core = await fs.readFile(path.join(root, 'mod', 'spark_log', 'backup', 'ChatBackup.Core.psm1'), 'utf8');
  const gui = await fs.readFile(path.join(root, 'mod', 'spark_log', 'backup', 'backup_chat_gui.ps1'), 'utf8');
  assert.match(core, /function Get-ChatGPTSnapshotState/);
  assert.match(core, /latest-user-turn-not-finished/);
  assert.match(core, /complete-through-latest-user/);
  assert.match(core, /SnapshotStatus = \[string\]\$snapshot\.Status/);
  assert.match(core, /LatestUserTurnCompleted = \[bool\]\$snapshot\.LatestUserTurnCompleted/);
  assert.match(gui, /Snapshot: \$\(\$result\.SnapshotStatus\)/);
  assert.match(gui, /WARNING: The latest user turn has no finished assistant final/);
  assert.doesNotMatch(gui, /Backup complete\.`r`nType:/);
});

test('model_dil_v2 source, constants, widgets, callbacks and resolved asset metadata survive parsing as inert data', () => {
  const dil = {
    code: '{@body const [count,setCount] = DIL.useState(0)}\n<button onClick={() => GenUI.copy("safe")}>Copy</button>',
    constants: { fixture: { nested: ['one', 'two'] } },
    fallbackMarkdown: 'Synthetic fallback only',
    requiredComponents: ['AsyncImage', 'Chart', 'MapWidgetV2'],
    clientDefinedWidgets: { fixture: { status: 'resolved', refIndex: 0 } },
    appData: {
      opGenui: {
        interactionSurface: 'offline',
        componentResults: {
          image: {
            componentName: 'AsyncImage',
            status: 'resolved',
            safe_urls: ['https://example.invalid/synthetic-only.png'],
            state: { images: [{ width: 100, height: 80 }] },
          },
        },
      },
    },
  };
  const chart = {
    type: 'client_defined_widget',
    matched_text: '<Chart content={{synthetic:true}}/>',
    start_idx: 0,
    end_idx: 0,
    data: {
      widget_type: 'charts_widget_v2',
      content: {
        chartType: 'bar', xKey: 'label',
        series: [{ dataKey: 'count' }],
        data: [{ label: 'A', count: 2 }],
      },
    },
  };
  const fixture = {
    title: 'Synthetic DIL v2 test',
    conversation_id: 'synthetic-dil-v2',
    current_node: 'assistant',
    mapping: {
      user: { parent: null, message: { id: 'user', ...message('user', 'Show synthetic DIL') } },
      assistant: {
        parent: 'user',
        message: {
          id: 'assistant', ...message('assistant', 'Synthetic DIL preview'),
          metadata: { model_dil_v2: dil, content_references: [chart] },
        },
      },
    },
  };
  const source = JSON.stringify(fixture);
  const parsed = parser.parseText(source)[0];
  assert.equal(parsed.snapshot.lastUserTurnCompleted, true);
  assert.equal(parsed.messages.length, 2);
  const restored = parsed.messages[1];
  assert.deepEqual(restored.modelDilV2, dil);
  assert.deepEqual(restored.modelDilV2.appData.opGenui.componentResults.image.safe_urls,
    ['https://example.invalid/synthetic-only.png']);
  assert.match(restored.modelDilV2.code, /GenUI\.copy/);
  assert.equal(restored.references.length, 1);
  assert.deepEqual(restored.references[0].data, chart.data);
  assert.equal(restored.references[0].matched_text, chart.matched_text);
  assert.equal(JSON.stringify(fixture), source, 'parsing must not rewrite the server JSONL');
});
