(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChatDilRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ChatGPT's archived DIL is declarative UI markup, not the JSON protocol
  // used by ChatKit widgets. Render only documented static components.
  // Never evaluate JSX-like bindings, execute event handlers, import modules,
  // or use content-supplied URL/script attributes.
  const supported = new Set([
    'box', 'col', 'row', 'grid', 'grid-item', 'flow', 'flow-item',
    'card', 'badge', 'text', 'title', 'caption', 'label', 'icon',
    'divider', 'spacer', 'bold', 'italic', 'underline', 'strikethrough',
    'table', 'table-row', 'table-cell', 'list', 'list-item',
    'button', 'pressable', 'checkbox', 'input', 'select', 'slider',
    'carousel', 'carousel-item', 'radio', 'radio-group', 'math',
  ]);
  const inlineTags = new Set([
    'badge', 'text', 'caption', 'label', 'icon', 'bold', 'italic',
    'underline', 'strikethrough', 'button', 'checkbox', 'input',
    'select', 'slider', 'radio', 'math', 'spacer',
  ]);
  const colors = new Set([
    'default', 'secondary', 'tertiary', 'muted', 'success', 'warning',
    'danger', 'error', 'info', 'discovery',
  ]);
  const allowedBackgrounds = new Set([
    'surface', 'surface-secondary', 'surface-tertiary',
    'success-solid', 'warning-solid', 'danger-solid',
  ]);
  const iconPaths = Object.freeze({
    'check-circle': ['circle|12 12 9', 'path|m8 12 2.5 2.5L16 9'],
    'alert-circle': ['circle|12 12 9', 'path|M12 8v4', 'path|M12 16h.01'],
    circle: ['circle|12 12 9'],
    'file-code': ['path|M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'path|M14 2v6h6', 'path|m10 13-2 2 2 2', 'path|m14 13 2 2-2 2'],
    'file-text': ['path|M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z','path|M14 2v6h6','path|M8 13h8','path|M8 17h8'],
    folder: ['path|M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12H3Z'],
    copy: ['rect|8 8 13 13 2', 'path|M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3'],
    'chevron-right': ['path|m9 18 6-6-6-6'],
  });

  function codeRanges(source) {
    const ranges = [];
    let i = 0;
    const tick = String.fromCharCode(96);
    while (i < source.length) {
      if (source[i] !== tick) { i++; continue; }
      const begin = i;
      while (source[i] === tick) i++;
      const close = source.indexOf(tick.repeat(i - begin), i);
      if (close >= 0) {
        ranges.push([begin, close + (i - begin)]);
        i = close + (i - begin);
      }
    }
    return ranges;
  }

  function readTag(source, offset) {
    const prefix = source.slice(offset).match(/^<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/);
    if (!prefix) return null;
    const tag = prefix[2].toLowerCase();
    if (!supported.has(tag)) return null;
    let index = offset + prefix[0].length;
    let quote = null, braces = 0;
    while (index < source.length && index - offset < 3000) {
      const c = source[index];
      if (quote) {
        if (c === quote && source[index - 1] !== '\\') quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '{') {
        braces++;
      } else if (c === '}') {
        braces--;
        if (braces < 0) return null;
      } else if (c === '>' && braces === 0) {
        const inside = source.slice(offset + prefix[0].length, index);
        const selfClosing = /\/\s*$/.test(inside);
        return {
          tag,
          closing: !!prefix[1],
          selfClosing,
          attrs: selfClosing ? inside.replace(/\/\s*$/, '') : inside,
          start: offset,
          end: index + 1,
        };
      }
      index++;
    }
    return null;
  }

  function parse(source) {
    const text = String(source || '');
    const ranges = codeRanges(text);
    let protectedIndex = 0;
    const root = { tag: null, children: [] };
    const stack = [root];
    let cursor = 0, search = 0, count = 0;
    while (search < text.length) {
      const at = text.indexOf('<', search);
      if (at < 0) break;
      while (protectedIndex < ranges.length && ranges[protectedIndex][1] <= at) protectedIndex++;
      if (protectedIndex < ranges.length && at >= ranges[protectedIndex][0] && at < ranges[protectedIndex][1]) {
        search = ranges[protectedIndex][1];
        continue;
      }
      const part = readTag(text, at);
      if (!part) { search = at + 1; continue; }
      if (at > cursor) stack[stack.length - 1].children.push({ text: text.slice(cursor, at) });
      if (part.closing) {
        if (stack.length < 2 || stack[stack.length - 1].tag !== part.tag) {
          // An unmatched DIL tag is not a valid tree. Do not reinterpret it
          // as executable HTML; leave the original message to Markdown.
          return null;
        }
        stack.pop();
      } else {
        const element = { tag: part.tag, attrs: attributes(part.attrs), children: [] };
        stack[stack.length - 1].children.push(element);
        count++;
        if (!part.selfClosing) stack.push(element);
      }
      cursor = part.end;
      search = part.end;
    }
    if (stack.length > 1) return null;
    if (cursor < text.length) root.children.push({ text: text.slice(cursor) });
    return count ? { ...root, count } : null;
  }

  function attributes(raw) {
    const obj = {};
    const source = String(raw || '');
    let at = 0;
    while (at < source.length) {
      while (/\s/.test(source[at] || '')) at++;
      const match = source.slice(at).match(/^([a-zA-Z][a-zA-Z0-9_-]*)/);
      if (!match) { at++; continue; }
      const key = match[1];
      at += key.length;
      while (/\s/.test(source[at] || '')) at++;
      if (source[at] !== '=') { obj[key] = true; continue; }
      at++;
      while (/\s/.test(source[at] || '')) at++;
      if (at >= source.length) break;
      let value = '';
      const c = source[at];
      if (c === '"' || c === "'") {
        at++;
        while (at < source.length && source[at] !== c) {
          value += source[at++];
        }
        at++;
      } else if (c === '{') {
        const start = at;
        let depth = 0, quote = null;
        while (at < source.length) {
          const ch = source[at++];
          if (quote) {
            if (ch === quote && source[at - 2] !== '\\') quote = null;
          } else if (ch === '"' || ch === "'") quote = ch;
          else if (ch === '{') depth++;
          else if (ch === '}' && --depth === 0) break;
        }
        value = source.slice(start, at);
      } else {
        const start = at;
        while (at < source.length && !/\s/.test(source[at])) at++;
        value = source.slice(start, at);
      }
      // Preserve original event bindings as inert data. The host adapter
      // can replay known action types on an explicit click, and every
      // unknown action remains discoverable instead of being discarded.
      // Never inject these expressions into HTML event attributes.
      if (key === 'style' || key === 'dangerouslySetInnerHTML') continue;
      obj[key] = value;
    }
    return obj;
  }

  function propNumber(value, fallback, max = 48) {
    const raw = String(value ?? '').trim();
    const normalized = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1).trim() : raw;
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  }

  function propCssLength(value) {
    const raw = String(value ?? '').trim();
    if (/^\d{1,3}%$/.test(raw)) return raw;
    if (/^\d{1,4}(?:\.\d{1,2})?(?:px|pt|rem|vh|vw)$/.test(raw)) return raw;
    if (/^\{\d+(?:\.\d+)?\}$/.test(raw)) return (Number(raw.slice(1, -1)) * 5) + 'px';
    return '';
  }

  function spacing(value) {
    const raw = String(value ?? '').trim();
    const sized = propCssLength(raw);
    return sized || (propNumber(raw, 0, 100) * 5) + 'px';
  }

  function padding(value) {
    if (value === undefined) return '';
    const raw = String(value).trim();
    if (/^\{\{/.test(raw) && /\}\}$/.test(raw)) {
      const pairs = Object.fromEntries(
        [...raw.matchAll(/\b(top|bottom|left|right|x|y)\s*:\s*(\d+(?:\.\d+)?)/g)]
          .map(m => [m[1], Math.min(40, Number(m[2])) * 5])
      );
      if (!Object.keys(pairs).length) return '';
      const top = pairs.top ?? pairs.y ?? 0;
      const right = pairs.right ?? pairs.x ?? 0;
      const bottom = pairs.bottom ?? pairs.y ?? 0;
      const left = pairs.left ?? pairs.x ?? 0;
      return [top, right, bottom, left].map(v => v + 'px').join(' ');
    }
    return spacing(raw);
  }

  function makeIcon(name, document) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-label', name || 'icon');
    svg.classList.add('dil-icon');
    const shapes = iconPaths[name];
    if (!shapes) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', '12');
      text.setAttribute('y', '17');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'currentColor');
      text.setAttribute('stroke', 'none');
      text.setAttribute('font-size', '16');
      text.textContent = '•';
      svg.appendChild(text);
      return svg;
    }
    for (const value of shapes) {
      const [type, raw] = value.split('|');
      const item = document.createElementNS(ns, type);
      if (type === 'circle') {
        const [cx, cy, r] = raw.split(' ');
        item.setAttribute('cx', cx);
        item.setAttribute('cy', cy);
        item.setAttribute('r', r);
      } else if (type === 'rect') {
        const [x,y,width,height,rx] = raw.split(' ');
        for (const [key,v] of Object.entries({x,y,width,height,rx})) item.setAttribute(key,v);
      } else item.setAttribute('d', raw);
      svg.appendChild(item);
    }
    return svg;
  }

  function localAction(source) {
    // Only a narrowly recognized, self-contained host action is portable.
    // The original raw expression is kept separately for all other cases.
    const match = String(source || '').trim().match(
      /^\{\s*\(\s*\)\s*=>\s*GenUI\.(copy)\(\s*("(?:\\.|[^"\\])*")\s*\)\s*\}$/s
    );
    if (!match) return null;
    try {
      const argument = JSON.parse(match[2]);
      return typeof argument === 'string'
        ? { name: match[1], argument } : null;
    } catch (_) { return null; }
  }

  async function copyLocal(value) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {
      // file:// origins can deny the Clipboard API; use the user-triggered
      // document selection fallback without evaluating the saved callback.
    }
    try {
      const field = document.createElement('textarea');
      field.value = value;
      field.readOnly = true;
      field.style.position = 'fixed';
      field.style.left = '-9999px';
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      return !!copied;
    } catch (_) { return false; }
  }

  function renderElement(node, context) {
    const { document, markdown } = context;
    const tag = node.tag, attrs = node.attrs || {};
    if (tag === 'icon') {
      const icon = makeIcon(String(attrs.name || ''), document);
      if (attrs.inline) icon.classList.add('dil-inline');
      if (colors.has(attrs.color)) icon.classList.add('dil-color-' + attrs.color);
      return icon;
    }
    if (tag === 'divider') {
      const hr = document.createElement('hr');
      hr.className = 'dil-divider';
      if (attrs.spacing !== undefined) hr.style.marginBlock = spacing(attrs.spacing);
      return hr;
    }
    if (tag === 'spacer') {
      const spacer = document.createElement('span');
      spacer.className = 'dil-spacer';
      if (attrs.minSize !== undefined) spacer.style.minWidth = spacing(attrs.minSize);
      return spacer;
    }

    const htmlName = tag === 'table' ? 'table'
      : tag === 'table-row' ? 'tr'
      : tag === 'table-cell' ? 'td'
      : tag === 'list' ? 'ul'
      : tag === 'list-item' ? 'li'
      : tag === 'bold' ? 'strong'
      : tag === 'italic' ? 'em'
      : tag === 'underline' ? 'u'
      : tag === 'strikethrough' ? 's'
      : tag === 'button' ? 'button'
      : tag === 'input' ? 'input'
      : inlineTags.has(tag) ? 'span' : 'div';
    const element = document.createElement(htmlName);
    element.classList.add('dil-' + tag);

    if (tag === 'button' || tag === 'pressable') {
      const sourceAction = String(attrs.onClick || '');
      if (sourceAction) {
        element.dataset.originalAction = sourceAction;
        element.title = 'Original ChatGPT action preserved; click to replay supported local action or inspect the original callback';
        element.addEventListener('click', () => {
          const eventDetail = { sourceAction, component: tag };
          element.dispatchEvent(new CustomEvent('spark-dil-action', {
            bubbles: true, detail: eventDetail,
          }));
          const parsedAction = localAction(sourceAction);
          if (parsedAction?.name === 'copy') {
            copyLocal(parsedAction.argument).then(copied => {
              element.title = copied ? 'Copied original action value' : 'Original copy action: clipboard unavailable';
            });
          } else {
            element.title = 'Original action retained, but this offline Viewer has no authorized live ChatGPT host';
          }
        });
      } else {
        element.setAttribute('aria-disabled', 'true');
        element.title = 'No action was recorded in the archived source';
        if (tag === 'button') element.disabled = true;
      }
    } else if (['input', 'checkbox', 'select', 'slider'].includes(tag)) {
      element.setAttribute('aria-disabled', 'true');
      if ('disabled' in element) element.disabled = true;
    }
    if (colors.has(attrs.color)) element.classList.add('dil-color-' + attrs.color);
    if (attrs.strong === true || attrs.weight === 'bold' || attrs.weight === 'semibold') element.classList.add('dil-strong');
    if (attrs.tabularNums === true) element.classList.add('dil-tabular');
    if (attrs.inline === true) element.classList.add('dil-inline');
    if (attrs.border === true) element.classList.add('dil-border');
    if (attrs.clip === true) element.classList.add('dil-clip');
    if (typeof attrs.radius === 'string' && /^(?:xs|sm|md|lg|xl|full)$/.test(attrs.radius)) element.classList.add('dil-radius-' + attrs.radius);
    if (typeof attrs.background === 'string' && allowedBackgrounds.has(attrs.background)) element.classList.add('dil-bg-' + attrs.background);
    if (typeof attrs.size === 'string' && /^(?:xs|sm|md|lg|xl|2xl)$/.test(attrs.size)) element.classList.add('dil-size-' + attrs.size);
    if (attrs.align && /^(?:center|start|end|stretch|baseline)$/.test(attrs.align)) element.classList.add('dil-align-' + attrs.align);
    if (attrs.justify && /^(?:between|around|evenly|center|start|end)$/.test(attrs.justify)) element.classList.add('dil-justify-' + attrs.justify);
    if (attrs.direction && /^(?:row|column)$/.test(attrs.direction)) element.style.flexDirection = attrs.direction;
    if (attrs.gap !== undefined) element.style.gap = spacing(attrs.gap);
    if (attrs.padding !== undefined) element.style.padding = padding(attrs.padding);
    for (const key of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight']) {
      if (attrs[key] === undefined) continue;
      const valid = propCssLength(attrs[key]);
      if (valid) element.style[key] = valid;
    }
    if (tag === 'grid') {
      const cols = Math.max(1, Math.min(6, Math.floor(propNumber(attrs.columns, 2, 6))));
      element.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    }
    if (tag === 'badge' && attrs.pill === true) element.classList.add('dil-pill');
    if (tag === 'title' && attrs.textAlign === 'center') element.style.textAlign = 'center';
    if (tag === 'text' && attrs.textAlign === 'center') element.style.textAlign = 'center';

    renderChildren(element, node.children || [], context, inlineTags.has(tag), true);
    return element;
  }

  function renderChildren(container, nodes, context, inline, insideDIL = false) {
    const items = [];
    let composite = '';
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(node, 'text')) {
        composite += node.text;
        continue;
      }
      const index = items.push(node) - 1;
      const placeholder = '<span data-dil-placeholder="' + index + '"></span>';
      composite += inlineTags.has(node.tag) ? placeholder : '\n\n' + placeholder + '\n\n';
    }

    // The archived model pretty-prints nested DIL tags with four-plus
    // spaces. Markdown would otherwise turn their placeholders into fenced
    // code and lose the entire subtree (including action-bearing buttons).
    // Normalize indentation in nested DIL layout only; top-level Markdown
    // and the original server JSONL are left byte-for-byte unchanged.
    if (insideDIL) composite = composite.replace(/(^|\n)[ \t]+(?=\S)/g, '$1');
    const html = context.markdown(composite, !!inline);
    const staging = context.document.createElement('div');
    staging.innerHTML = html;
    for (const placeholder of [...staging.querySelectorAll('[data-dil-placeholder]')]) {
      const index = Number(placeholder.getAttribute('data-dil-placeholder'));
      const node = items[index];
      if (!node) { placeholder.remove(); continue; }
      const element = renderElement(node, context);
      // Remove a redundant paragraph created around a block placeholder.
      const parent = placeholder.parentElement;
      if (parent?.tagName === 'P' && parent.children.length === 1 &&
          !parent.textContent.trim() && !inlineTags.has(node.tag)) parent.replaceWith(element);
      else placeholder.replaceWith(element);
    }
    while (staging.firstChild) container.appendChild(staging.firstChild);
  }

  function renderContent(container, source, markdown) {
    const tree = parse(source);
    if (!tree) return false;
    const context = {
      document: container.ownerDocument || document,
      markdown,
    };
    const staging = context.document.createElement('div');
    renderChildren(staging, tree.children, context, false);
    container.replaceChildren(...[...staging.childNodes]);
    container.dataset.dilStaticCount = String(tree.count);
    return true;
  }

  return { parse, attributes, renderContent };
});
