import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const renderer = require(path.join(root, 'mod', 'spark_log', 'viewer', 'dil-renderer.js'));
const viewer = path.join(root, 'mod', 'spark_log', 'viewer', 'viewer.js');
const html = path.join(root, 'mod', 'spark_log', 'viewer', 'index.html');
const css = path.join(root, 'mod', 'spark_log', 'viewer', 'viewer.css');

function collect(nodes, result = []) {
  for (const node of nodes) {
    if (node.tag) {
      result.push(node);
      collect(node.children || [], result);
    }
  }
  return result;
}

test('archived ChatGPT DIL progress card preserves nested layout, badge, grid and bar', () => {
  const fixture = [
    '### Saved UI card',
    '<row align="center" gap={2}>',
    '  <badge color="success">Viewer opened</badge>',
    '  **Local browser**',
    '</row>',
    '<box border radius="lg" padding={3} gap={2}>',
    '  <row align="center" justify="between">',
    '    <text color="secondary">Visible messages</text>',
    '    <title size="lg" tabularNums>128 / 128</title>',
    '  </row>',
    '  <box background="surface-tertiary" height="8px" radius="full" clip>',
    '    <box background="success-solid" width="100%" height="100%" radius="full"/>',
    '  </box>',
    '  <grid columns={3} gap={2}>',
    '    <grid-item><text color="secondary">Tables</text><title size="lg">19</title></grid-item>',
    '    <grid-item><text color="secondary">Code</text><title size="lg">8</title></grid-item>',
    '    <grid-item><text color="secondary">Assets</text><title size="lg">4</title></grid-item>',
    '  </grid>',
    '</box>',
  ].join('\n');
  const parsed = renderer.parse(fixture);
  assert.ok(parsed);
  const found = collect(parsed.children);
  assert.equal(found.length, parsed.count);
  assert.equal(found.filter(x => x.tag === 'badge').length, 1);
  assert.equal(found.filter(x => x.tag === 'grid-item').length, 3);
  assert.ok(found.some(x => x.tag === 'box' && x.attrs.background === 'success-solid' && x.attrs.width === '100%'));
  assert.ok(found.some(x => x.tag === 'grid' && x.attrs.columns === '{3}'));
  assert.ok(found.some(x => x.tag === 'title' && x.attrs.tabularNums === true));
  assert.ok(found.some(x => x.tag === 'row' && x.attrs.justify === 'between'));
  assert.ok(found.some(x => x.tag === 'box' && x.attrs.clip === true));
});

test('DIL parser preserves original callback source and nested object props without eval', () => {
  const source = '<box padding={{x:3,y:1}}><button onClick={()=>GenUI.copy("danger")}>Copy</button></box>';
  const tree = renderer.parse(source);
  assert.ok(tree);
  assert.equal(tree.count, 2);
  const [outer, inner] = collect(tree.children);
  assert.equal(outer.attrs.padding, '{{x:3,y:1}}');
  assert.equal(inner.tag, 'button');
  assert.equal(inner.attrs.onClick, '{()=>GenUI.copy("danger")}');
  assert.equal(renderer.attributes('onClick={()=>GenUI.issueNewTurn("persisted") }').onClick, '{()=>GenUI.issueNewTurn("persisted") }');
});

test('Markdown inline and fenced code depicting UI tags remain inert literal source', () => {
  const tick = String.fromCharCode(96);
  const fenced = tick.repeat(3) + 'jsx\n<box><row>not UI</row></box>\n' + tick.repeat(3);
  const inline = tick + '<badge>literal</badge>' + tick;
  const parsed = renderer.parse(
    fenced + '\n\n' + inline + '\n\n<badge color="success">Only this is UI</badge>'
  );
  assert.ok(parsed);
  assert.equal(parsed.count, 1);
  assert.equal(collect(parsed.children)[0].tag, 'badge');
});

test('unbalanced supported tags fail closed rather than corrupting the transcript tree', () => {
  assert.equal(renderer.parse('<box><row>missing closing row</box>'), null);
  assert.equal(renderer.parse('<row>missing end'), null);
  assert.equal(renderer.parse('plain Markdown with no widget markup'), null);
  assert.equal(renderer.parse('<script>alert(1)</script>'), null);
});

test('Viewer links offline static DIL renderer after markup sanitizer and before message body hydration', async () => {
  const page = await fs.readFile(html, 'utf8');
  const source = await fs.readFile(viewer, 'utf8');
  const style = await fs.readFile(css, 'utf8');
  assert.ok(page.indexOf('dil-renderer.js') > page.indexOf('parser.js'));
  assert.ok(page.indexOf('dil-renderer.js') < page.indexOf('viewer.js'));
  assert.match(source, /ChatDilRenderer\.renderContent\(body, source, markdown\)/);
  assert.match(source, /DOMPurify\.sanitize/);
  assert.match(source, /marked\.parseInline/);
  for (const cssClass of ['dil-grid', 'dil-row', 'dil-badge', 'dil-bg-success-solid', 'dil-title']) {
    assert.ok(style.includes('.' + cssClass), 'Missing static DIL layout rule ' + cssClass);
  }
});

test('DIL static renderer has no dynamic code evaluation or arbitrary script injection mechanism', async () => {
  const code = await fs.readFile(path.join(root, 'mod', 'spark_log', 'viewer', 'dil-renderer.js'), 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(/);
  assert.doesNotMatch(code, /\bnew Function\s*\(/);
  assert.doesNotMatch(code, /script\.src\s*=/);
  assert.match(code, /aria-disabled/);
  assert.match(code, /Never evaluate JSX-like bindings/);
});
