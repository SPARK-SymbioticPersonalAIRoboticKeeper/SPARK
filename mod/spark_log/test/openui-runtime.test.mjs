import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = path.join(ROOT, 'mod', 'spark_log', 'viewer');
const BRIDGE = path.join(DIR, 'openui-runtime.js');

function bridge() {
  class FakeNode {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.received = []; }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    dispatchEvent(event) { this.received.push(event); return true; }
  }
  let element;
  const window = {
    __OpenUI: {
      React: { createElement: (component, props) => ({ component, props }) },
      Renderer() {},
      openuiChatLibrary: { root: 'Card' },
      createRoot() { return { render(obj) { element = obj; } }; },
    },
  };
  const sandbox = {
    window,
    document: { createElement: tag => new FakeNode(tag) },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Date,
  };
  return { sandbox, getRendered: () => element };
}

test('MIT OpenUI 0.2.1 is actually vendored and original license shipped', async () => {
  const candidates = [
    ['openui-bundle-0.2.1.min.js', 'BBA936FF93F31A2955460F40D80BCD329B6A5848D6A05DF54427E5DD137181DF'],
    ['openui-styles-0.2.1.css', '93B69B218203BD054A88B7C8821D6C0DC6944AF38119ADA37E8082E59C0A18F3'],
  ];
  for (const [name, expected] of candidates) {
    const bytes = await fs.readFile(path.join(DIR, 'vendor', name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(), expected);
  }
  const license = await fs.readFile(path.join(DIR, 'vendor', 'licenses', 'openui-MIT.txt'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Permission is hereby granted/);
});

test('OpenUI bridge uses library for actual saved CodeBlock and WritingBlock rather than bespoke implementation', async () => {
  const { sandbox, getRendered } = bridge();
  vm.runInNewContext(await fs.readFile(BRIDGE, 'utf8'), sandbox);
  const api = sandbox.window.SPARKOpenUI;
  const command = '& "E:\\SRC\\SPARK\\out\\SPARK.ps1" -Title "세부"';
  const ref = { category: 'code_block', data: { widget_type: 'code_block', language: 'powershell', content: command } };
  const program = api.programFor(ref);
  assert.equal(program.kind, 'code_block');
  assert.equal(program.code, 'root = Card([CodeBlock("powershell", ' + JSON.stringify(command) + ')])');
  const panel = api.render(ref);
  assert.equal(panel.dataset.widgetRenderer, 'OpenUI 0.2.1');
  assert.equal(panel.dataset.sourcePreserved, 'jsonl');
  assert.equal(getRendered().props.response, program.code);
  assert.equal(getRendered().props.library, sandbox.window.__OpenUI.openuiChatLibrary);

  const writing = api.programFor({ category: 'writing_block', data: { widget_type: 'writing_block', content: '**Note**\n- Item', variant: 'document' } });
  assert.match(writing.code, /MarkDownRenderer/);
  assert.match(writing.code, /\\n- Item/);
  assert.equal(api.programFor({ category: 'unrecognized', data: {} }), null);
});

test('real OpenUI action events are captured locally, retained, and surfaced without automatic network submission', async () => {
  const { sandbox, getRendered } = bridge();
  vm.runInNewContext(await fs.readFile(BRIDGE, 'utf8'), sandbox);
  const api = sandbox.window.SPARKOpenUI;
  const panel = api.render({ category: 'code_block', data: { widget_type: 'code_block', content: 'hello' } });
  const event = { type: 'continue_conversation', humanFriendlyMessage: 'Command from saved widget' };
  getRendered().props.onAction(event);
  assert.equal(api.actionHistory.length, 1);
  assert.equal(api.actionHistory[0].event, event);
  assert.equal(panel.received[0].type, 'spark-openui-action');
  assert.equal(panel.received[0].detail.event.humanFriendlyMessage, event.humanFriendlyMessage);
  assert.match(panel.children.at(-1).textContent, /locally/);
});

test('pinned OpenUI vendor script and styles are loaded before viewer renderer without a CDN', async () => {
  const html = await fs.readFile(path.join(DIR, 'index.html'), 'utf8');
  const viewer = await fs.readFile(path.join(DIR, 'viewer.js'), 'utf8');
  assert.match(html, /vendor\/openui-bundle-0\.2\.1\.min\.js/);
  assert.match(html, /vendor\/openui-styles-0\.2\.1\.css/);
  assert.ok(html.indexOf('openui-runtime.js') < html.indexOf('viewer.js'));
  assert.ok(html.indexOf('openui-styles-0.2.1.css') < html.indexOf('viewer.css'));
  assert.match(viewer, /SPARKOpenUI\.render/);
});

test('offline OpenUI adapter never evaluates archived JS or submits a generated host action', async () => {
  const code = await fs.readFile(BRIDGE, 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(/);
  assert.doesNotMatch(code, /\bnew\s+Function\s*\(/);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /\bXMLHttpRequest\b/);
  assert.match(code, /onAction/);
});

test('saved original DIL callback and UI source are explicitly inspectable instead of silently dropped', async () => {
  const viewer = await fs.readFile(path.join(DIR, 'viewer.js'), 'utf8');
  const source = await fs.readFile(path.join(DIR, 'dil-renderer.js'), 'utf8');
  assert.match(source, /dataset\.originalAction = sourceAction/);
  assert.match(source, /spark-dil-action/);
  assert.match(source, /GenUI\\\.\(copy\)/);
  assert.match(viewer, /className = 'message-original-source'/);
  assert.match(viewer, /sourcePanel\.textContent = msg\.text/);
  assert.match(viewer, /className = 'message-source-toggle'/);
});
