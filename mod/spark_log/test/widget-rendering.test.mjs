import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VIEWER = path.join(ROOT, 'mod', 'spark_log', 'viewer', 'viewer.js');
const STYLE = path.join(ROOT, 'mod', 'spark_log', 'viewer', 'viewer.css');

class TestNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this._text = null;
    this._html = '';
    this.style = {};
  }
  appendChild(node) { this._text = null; this.children.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() {
    return this._text === null
      ? this.children.map(node => node.textContent).join('')
      : this._text;
  }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

function descendants(node, tag) {
  return node.children.flatMap(child =>
    (child.tagName === tag ? [child] : []).concat(descendants(child, tag))
  );
}

async function widgetRenderer() {
  const source = await fs.readFile(VIEWER, 'utf8');
  const start = source.indexOf('  function widgetText(');
  const end = source.indexOf('  function primarySource(', start);
  assert.ok(start > 0 && end > start, 'widget renderer source block exists');

  const clipboard = [];
  const sandbox = {
    document: {
      createElement: tag => new TestNode(tag),
      createTextNode: text => Object.assign(new TestNode('#text'), { textContent: text }),
    },
    navigator: { clipboard: { writeText: async value => { clipboard.push(value); } } },
    markdown: sourceText => '<p>' + String(sourceText).replaceAll('<', '&lt;') + '</p>',
    chartContent: reference => reference?.data?.content || reference?.data || null,
    renderChartWidget: () => new TestNode('svg'),
  };
  vm.runInNewContext(
    source.slice(start, end) + '\nglobalThis.runRenderer = renderWidget;',
    sandbox,
    { timeout: 2500 }
  );
  return { render: sandbox.runRenderer, clipboard, source };
}

test('code_block widget restores original PowerShell code exactly, with language and functional Copy', async () => {
  const { render, clipboard } = await widgetRenderer();
  const command = '& "E:\\SRC\\SPARK\\out\\SPARK.ps1" chatlog -b -Title "SPARK" -OutputDirectory "E:\\SRC\\SPARK\\log\\chatlog"';
  const widget = render({
    type: 'client_defined_widget',
    category: 'code_block',
    data: { widget_type: 'code_block', language: 'powershell', content: command },
  });
  assert.equal(widget.dataset.widgetKind, 'code_block');
  const pre = descendants(widget, 'pre');
  assert.equal(pre.length, 1);
  const code = descendants(pre[0], 'code');
  assert.equal(code.length, 1);
  assert.equal(code[0].textContent, command);
  assert.equal(code[0].className, 'language-powershell');
  const button = descendants(widget, 'button');
  assert.equal(button.length, 1);
  assert.equal(button[0].textContent, 'Copy');
  await button[0].listeners.click();
  assert.deepEqual(clipboard, [command]);
  assert.equal(button[0].textContent, 'Copied');
  assert.equal(descendants(widget, 'summary').length, 0);
});

test('code widget treats HTML-looking command text as text and does not execute it', async () => {
  const { render } = await widgetRenderer();
  const code = '<script>window.pwned=1</script>\n& "C:\\Tool\\script.ps1" -Help';
  const widget = render({
    type: 'client_defined_widget',
    category: 'code_block',
    data: { widget_type: 'code_block', language: 'powershell', content: code },
  });
  assert.equal(descendants(widget, 'code')[0].textContent, code);
  assert.equal(descendants(widget, 'code')[0].innerHTML, '');
  assert.equal(descendants(widget, 'script').length, 0);
});

test('writing_block restores saved Markdown body and copies its original bytes', async () => {
  const { render, clipboard } = await widgetRenderer();
  const raw = '**제목**\n\n- 첫 항목\n- 둘째 항목';
  const widget = render({
    type: 'client_defined_widget',
    category: 'writing_block',
    data: { widget_type: 'writing_block', variant: 'chat_message', content: raw },
  });
  assert.equal(widget.dataset.widgetKind, 'writing_block');
  const body = descendants(widget, 'div').find(x => x.className === 'widget-writing-body');
  assert.ok(body);
  assert.ok(body.innerHTML.includes('첫 항목'));
  const button = descendants(widget, 'button')[0];
  await button.listeners.click();
  assert.equal(clipboard[0], raw);
  assert.equal(descendants(widget, 'pre').length, 0);
});

test('unknown widget preserves readable saved data, rather than an empty placeholder', async () => {
  const { render } = await widgetRenderer();
  const widget = render({
    type: 'client_defined_widget',
    category: 'unimplemented',
    data: { widget_type: 'unimplemented', content: { alpha: 3, label: 'restorable value' } },
  });
  assert.equal(descendants(widget, 'details').length, 1);
  const pre = descendants(widget, 'pre');
  assert.equal(pre.length, 1);
  assert.match(pre[0].textContent, /restorable value/);
  assert.match(pre[0].textContent, /"alpha": 3/);
});

test('legacy writing-block reference metadata resolves the actual saved WritingBlock tag by ID and exact body', async () => {
  const source = await fs.readFile(VIEWER, 'utf8');
  const start = source.indexOf('  function referencePlaceholder(');
  const end = source.indexOf('  function hydrateReferences(', start);
  assert.ok(start > 0 && end > start);
  const sandbox = {
    widgetText: value => typeof value === 'string' ? value : '',
  };
  vm.runInNewContext(
    source.slice(start, end) + '\nglobalThis.replaceReferences = withReferencePlaceholders;',
    sandbox,
    { timeout: 2500 }
  );
  const body = '**Document title**\n\n- Important detail';
  const message = {
    text: 'Before <WritingBlock id="58317" variant="chat_message">' + body + '</WritingBlock> After',
    references: [{
      type: 'client_defined_widget', category: 'writing_block',
      data: { widget_type: 'writing_block', id: '58317', content: body },
      matched_text: ':::writing{variant="chat_message"}\n' + body + '\n:::',
      start_idx: 7, end_idx: 130,
    }],
  };
  const replaced = sandbox.replaceReferences(message);
  assert.equal(replaced.includes('<WritingBlock'), false);
  assert.match(replaced, /chat-ref-placeholder/);
  assert.match(replaced, /data-ref-index="0"/);
  assert.ok(replaced.startsWith('Before '));
  assert.ok(replaced.endsWith(' After'));

  const wrongId = structuredClone(message);
  wrongId.references[0].data.id = 'not-the-same-widget';
  assert.equal(sandbox.replaceReferences(wrongId), message.text);
});

test('Viewer styles define distinct native code/writing blocks rather than generic fallback-only UI', async () => {
  const styles = await fs.readFile(STYLE, 'utf8');
  assert.match(styles, /\.code-widget > \.widget-code-pre/);
  assert.match(styles, /\.widget-code-head/);
  assert.match(styles, /\.widget-copy-button/);
  assert.match(styles, /\.widget-writing-body/);
});
