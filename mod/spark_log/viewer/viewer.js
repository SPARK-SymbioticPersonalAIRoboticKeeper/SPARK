(() => {
  'use strict';

  const state = { conversations: [], selectedId: null };
  const $ = id => document.getElementById(id);
  const fileInput = $('fileInput');
  const loader = $('loader');
  const app = $('app');
  const status = $('loadStatus');
  const list = $('conversationList');
  const messages = $('messages');
  const search = $('searchBox');
  const dropZone = $('dropZone');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  marked.setOptions({ gfm: true, breaks: true });
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });

  function formatTime(seconds) {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function markdown(text, inline = false) {
    const raw = inline ? marked.parseInline(text || '') : marked.parse(text || '');
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['data-ref-index', 'data-dil-placeholder', 'target', 'rel']
    });
  }

  function makeSvg(tag, attrs = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) element.setAttribute(key, String(value));
    }
    return element;
  }

  function formatChartValue(value, series) {
    if (!Number.isFinite(Number(value))) return String(value ?? '');
    const number = Number(value);
    let formatted;
    if (series?.valueFormat === 'integer') formatted = Math.round(number).toLocaleString();
    else formatted = number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${series?.valuePrefix || ''}${formatted}${series?.valueSuffix || ''}`;
  }

  function chartContent(reference) {
    return reference?.data?.content || reference?.data || null;
  }

  function renderChartWidget(reference) {
    const content = chartContent(reference);
    if (!content || !Array.isArray(content.data) || !content.data.length) return renderGenericWidget(reference);

    const card = document.createElement('section');
    card.className = 'chat-widget chart-widget';

    const meta = content.meta || {};
    const title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = meta.title || 'Chart';
    card.appendChild(title);

    if (meta.description) {
      const description = document.createElement('div');
      description.className = 'widget-description';
      description.textContent = meta.description;
      card.appendChild(description);
    }

    const xKey = content.xKey || Object.keys(content.data[0] || {})[0];
    const series = Array.isArray(content.series) && content.series.length
      ? content.series
      : Object.keys(content.data[0] || {})
          .filter(key => key !== xKey && content.data.some(row => Number.isFinite(Number(row[key]))))
          .map(key => ({ dataKey: key, label: key }));

    const numericSeries = series.filter(s => s?.dataKey && content.data.some(row => Number.isFinite(Number(row[s.dataKey]))));
    if (!numericSeries.length) return renderGenericWidget(reference);

    const allValues = [];
    for (const row of content.data) {
      for (const s of numericSeries) {
        const value = Number(row[s.dataKey]);
        if (Number.isFinite(value)) allValues.push(value);
      }
    }

    let yMin = Number.isFinite(Number(content.yAxisMin)) ? Number(content.yAxisMin) : Math.min(...allValues);
    let yMax = Number.isFinite(Number(content.yAxisMax)) ? Number(content.yAxisMax) : Math.max(...allValues);
    if (yMin === yMax) {
      const pad = Math.abs(yMin || 1) * 0.05;
      yMin -= pad;
      yMax += pad;
    } else if (!Number.isFinite(Number(content.yAxisMin)) || !Number.isFinite(Number(content.yAxisMax))) {
      const pad = (yMax - yMin) * 0.08;
      if (!Number.isFinite(Number(content.yAxisMin))) yMin -= pad;
      if (!Number.isFinite(Number(content.yAxisMax))) yMax += pad;
    }

    const width = 820;
    const height = 390;
    const margin = { left: 78, right: 26, top: 24, bottom: 62 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const rows = content.data;
    const xAt = index => margin.left + (rows.length === 1 ? plotW / 2 : (index / (rows.length - 1)) * plotW);
    const yAt = value => margin.top + (1 - ((value - yMin) / (yMax - yMin))) * plotH;

    const shell = document.createElement('div');
    shell.className = 'chart-shell';
    const svg = makeSvg('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': meta.title || 'Chart'
    });

    const gridCount = 5;
    for (let i = 0; i <= gridCount; i++) {
      const ratio = i / gridCount;
      const y = margin.top + ratio * plotH;
      const value = yMax - ratio * (yMax - yMin);
      svg.appendChild(makeSvg('line', {
        x1: margin.left,
        y1: y,
        x2: width - margin.right,
        y2: y,
        class: 'chart-grid'
      }));
      const label = makeSvg('text', {
        x: margin.left - 12,
        y: y + 4,
        'text-anchor': 'end',
        class: 'chart-axis-label'
      });
      label.textContent = formatChartValue(value, numericSeries[0]);
      svg.appendChild(label);
    }

    const maxXLabels = 9;
    const step = Math.max(1, Math.ceil(rows.length / maxXLabels));
    const labelIndexes = new Set();
    for (let i = 0; i < rows.length; i += step) labelIndexes.add(i);
    labelIndexes.add(rows.length - 1);

    for (const i of [...labelIndexes].sort((a, b) => a - b)) {
      const label = makeSvg('text', {
        x: xAt(i),
        y: height - margin.bottom + 28,
        'text-anchor': 'middle',
        class: 'chart-axis-label chart-x-label'
      });
      label.textContent = String(rows[i]?.[xKey] ?? '');
      svg.appendChild(label);
    }

    const colors = ['#4aa3ff', '#34d399', '#f59e0b', '#a78bfa', '#fb7185', '#22d3ee'];
    const chartType = String(content.chartType || 'line').toLowerCase();

    numericSeries.forEach((s, seriesIndex) => {
      const color = colors[seriesIndex % colors.length];
      const points = rows
        .map((row, index) => ({ index, value: Number(row[s.dataKey]), row }))
        .filter(point => Number.isFinite(point.value));

      if (chartType === 'bar' || chartType === 'column') {
        const groupWidth = Math.max(8, plotW / Math.max(rows.length, 1) * 0.72);
        const barWidth = groupWidth / numericSeries.length;
        const baseY = yAt(Math.max(yMin, 0));
        for (const point of points) {
          const y = yAt(point.value);
          const rect = makeSvg('rect', {
            x: xAt(point.index) - groupWidth / 2 + seriesIndex * barWidth,
            y: Math.min(y, baseY),
            width: Math.max(2, barWidth - 2),
            height: Math.max(1, Math.abs(baseY - y)),
            rx: 2,
            fill: color,
            class: 'chart-bar'
          });
          const tooltip = makeSvg('title');
          tooltip.textContent = `${point.row?.[xKey] ?? ''} - ${s.label || s.dataKey}: ${formatChartValue(point.value, s)}`;
          rect.appendChild(tooltip);
          svg.appendChild(rect);
        }
      } else {
        const pointString = points.map(point => `${xAt(point.index)},${yAt(point.value)}`).join(' ');
        if (chartType === 'area' && points.length > 1) {
          const firstX = xAt(points[0].index);
          const lastX = xAt(points[points.length - 1].index);
          const baseline = yAt(yMin);
          const polygon = makeSvg('polygon', {
            points: `${firstX},${baseline} ${pointString} ${lastX},${baseline}`,
            fill: color,
            'fill-opacity': 0.14,
            stroke: 'none'
          });
          svg.appendChild(polygon);
        }
        const line = makeSvg('polyline', {
          points: pointString,
          fill: 'none',
          stroke: color,
          'stroke-width': 3,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          class: 'chart-line'
        });
        svg.appendChild(line);

        for (const point of points) {
          const circle = makeSvg('circle', {
            cx: xAt(point.index),
            cy: yAt(point.value),
            r: 4,
            fill: color,
            class: 'chart-point'
          });
          const tooltip = makeSvg('title');
          tooltip.textContent = `${point.row?.[xKey] ?? ''} - ${s.label || s.dataKey}: ${formatChartValue(point.value, s)}`;
          circle.appendChild(tooltip);
          svg.appendChild(circle);
        }
      }
    });

    shell.appendChild(svg);
    card.appendChild(shell);

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    numericSeries.forEach((s, index) => {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.background = colors[index % colors.length];
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(s.label || s.dataKey));
      legend.appendChild(item);
    });
    card.appendChild(legend);

    if (meta.footer) {
      const footer = document.createElement('div');
      footer.className = 'widget-footer';
      footer.textContent = meta.footer;
      card.appendChild(footer);
    }

    return card;
  }

  function widgetText(value) {
    return typeof value === 'string' ? value : '';
  }

  function widgetCopyButton(source, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'widget-copy-button';
    button.textContent = 'Copy';
    button.title = label || 'Copy the saved widget content';
    button.setAttribute('aria-label', label || 'Copy widget content');
    button.addEventListener('click', async () => {
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(source);
          copied = true;
        }
      } catch (_) {
        // file:// Chromium can deny clipboard writes without a secure context.
      }
      if (!copied) {
        const temporary = document.createElement('textarea');
        temporary.value = source;
        temporary.readOnly = true;
        temporary.setAttribute('aria-hidden', 'true');
        temporary.className = 'widget-copy-temporary';
        document.body.appendChild(temporary);
        temporary.select();
        try { copied = document.execCommand('copy'); }
        catch (_) { copied = false; }
        temporary.remove();
      }
      button.textContent = copied ? 'Copied' : 'Copy failed';
    });
    return button;
  }

  function appendHighlightedCode(target, raw, language) {
    const content = widgetText(raw);
    const syntax = String(language || '').toLowerCase();
    // Syntax highlighting never evaluates a saved command or sets innerHTML.
    if (syntax !== 'powershell' && syntax !== 'ps1') {
      target.textContent = content;
      return;
    }
    const tokens = /#[^\n]*|"(?:\x60[\s\S]|[^"\x60])*"|'(?:''|[^'])*'|\$[A-Za-z_][\w:]*|\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|Get-[\w-]+|Set-[\w-]+|Write-[\w-]+|New-[\w-]+|Start-[\w-]+|Stop-[\w-]+)\b|-[A-Za-z][\w-]*|\b\d+(?:\.\d+)?\b/gim;
    let position = 0;
    for (const match of content.matchAll(tokens)) {
      if (match.index > position) {
        target.appendChild(document.createTextNode(content.slice(position, match.index)));
      }
      const token = match[0];
      const span = document.createElement('span');
      span.className = token.startsWith('#') ? 'syntax-comment'
        : token.startsWith('"') || token.startsWith("'") ? 'syntax-string'
        : token.startsWith('$') ? 'syntax-variable'
        : token.startsWith('-') ? 'syntax-parameter'
        : /^\d/.test(token) ? 'syntax-number' : 'syntax-command';
      span.textContent = token;
      target.appendChild(span);
      position = match.index + token.length;
    }
    if (position < content.length) {
      target.appendChild(document.createTextNode(content.slice(position)));
    }
  }

  function renderCodeBlockWidget(reference) {
    const data = reference?.data || {};
    const content = widgetText(data.content || data.code || data.text);
    const language = widgetText(data.language).trim() || 'text';
    const panel = document.createElement('section');
    panel.className = 'chat-widget code-widget';
    panel.dataset.widgetKind = 'code_block';

    const header = document.createElement('div');
    header.className = 'widget-code-head';
    const tag = document.createElement('span');
    tag.className = 'widget-code-language';
    tag.textContent = language;
    header.append(tag, widgetCopyButton(content, 'Copy code'));
    panel.appendChild(header);

    const pre = document.createElement('pre');
    pre.className = 'widget-code-pre';
    const code = document.createElement('code');
    code.className = 'language-' + language.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    appendHighlightedCode(code, content, language);
    pre.appendChild(code);
    panel.appendChild(pre);
    return panel;
  }

  function renderWritingBlockWidget(reference) {
    const data = reference?.data || {};
    const content = widgetText(data.content || data.text);
    const variant = widgetText(data.variant).trim() || 'document';

    const panel = document.createElement('section');
    panel.className = 'chat-widget writing-widget';
    panel.dataset.widgetKind = 'writing_block';
    const header = document.createElement('div');
    header.className = 'widget-code-head';
    const label = document.createElement('span');
    label.className = 'widget-code-language';
    label.textContent = 'Writing · ' + variant.replaceAll('_', ' ');
    header.append(label, widgetCopyButton(content, 'Copy original writing block'));
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'widget-writing-body';
    body.innerHTML = markdown(content);
    panel.appendChild(body);
    return panel;
  }

  function renderGenericWidget(reference) {
    const card = document.createElement('section');
    card.className = 'chat-widget generic-widget';
    const data = reference?.data || {};
    const content = data.content || {};
    const title = content?.meta?.title || data.title || reference.category || 'ChatGPT widget';
    const subtitle = content?.meta?.description || data.description || data.widget_type || reference.type || '';
    const heading = document.createElement('div');
    heading.className = 'widget-title';
    heading.textContent = title;
    card.appendChild(heading);
    if (subtitle) {
      const description = document.createElement('div');
      description.className = 'widget-description';
      description.textContent = subtitle;
      card.appendChild(description);
    }
    const note = document.createElement('div');
    note.className = 'widget-fallback-note';
    note.textContent = 'This widget cannot be replayed interactively offline; its saved data is available below.';
    card.appendChild(note);

    const details = document.createElement('details');
    details.className = 'widget-raw-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Show saved widget data';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    const saved = JSON.stringify(data, null, 2) || reference.matched_text || '';
    pre.textContent = saved.length > 200000 ? saved.slice(0, 200000) + '\n[Further data is preserved in the JSONL backup.]' : saved;
    details.appendChild(pre);
    card.appendChild(details);
    return card;
  }

  function renderWidget(reference) {
    const kind = String(reference?.data?.widget_type || reference?.category || '').toLowerCase();
    // Prefer the maintained MIT OpenUI React widget runtime over homegrown
    // code/Markdown component implementations. Keep old rendering only as
    // an offline compatibility fallback if the pinned vendor asset is absent.
    if (kind === 'code_block' || kind === 'writing_block') {
      const hosted = typeof SPARKOpenUI !== 'undefined'
        ? SPARKOpenUI.render(reference, { copyButton: widgetCopyButton }) : null;
      if (hosted) return hosted;
      return kind === 'code_block' ? renderCodeBlockWidget(reference)
        : renderWritingBlockWidget(reference);
    }
    const content = chartContent(reference);
    if (
      reference?.type === 'client_defined_widget' &&
      reference?.category === 'visualization' &&
      content &&
      Array.isArray(content.data)
    ) {
      return renderChartWidget(reference);
    }
    return renderGenericWidget(reference);
  }

  function primarySource(reference) {
    if (Array.isArray(reference?.items) && reference.items.length) return reference.items[0];
    if (Array.isArray(reference?.sources) && reference.sources.length) return reference.sources[0];
    return null;
  }

  function renderCitation(reference) {
    const item = primarySource(reference);
    if (!item?.url) {
      const span = document.createElement('span');
      span.className = 'citation citation-muted';
      span.textContent = 'source';
      return span;
    }

    const link = document.createElement('a');
    link.className = 'citation';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = item.attribution || (() => {
      try { return new URL(item.url).hostname.replace(/^www\./, ''); }
      catch { return 'source'; }
    })();

    const titles = [];
    for (const source of reference.items || []) {
      if (source?.title) titles.push(source.title);
      for (const supporting of source?.supporting_websites || []) {
        if (supporting?.title) titles.push(supporting.title);
      }
    }
    if (titles.length) link.title = titles.join('\n');
    return link;
  }

  function renderSources(reference) {
    const details = document.createElement('details');
    details.className = 'sources-footnote';
    const summary = document.createElement('summary');
    summary.textContent = 'Sources';
    details.appendChild(summary);

    const listElement = document.createElement('ul');
    for (const source of reference?.sources || []) {
      if (!source?.url) continue;
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = source.title || source.attribution || source.url;
      li.appendChild(link);
      listElement.appendChild(li);
    }
    details.appendChild(listElement);
    return details;
  }

  function referencePlaceholder(index) {
    return `<span class="chat-ref-placeholder" data-ref-index="${index}"></span>`;
  }

  function findWritingBlockRange(text, reference) {
    const data = reference?.data || {};
    const id = String(data.id || '');
    const content = widgetText(data.content);
    if (!id || !content) return null;

    let start = text.indexOf('<WritingBlock');
    while (start >= 0) {
      const openEnd = text.indexOf('>', start);
      if (openEnd < 0) return null;
      const openTag = text.slice(start, openEnd + 1);
      const attr = openTag.match(/\bid\s*=\s*(["'])(.*?)\1/i);
      if (attr?.[2] === id) {
        const closing = '</WritingBlock>';
        const closeAt = text.indexOf(closing, openEnd + 1);
        if (closeAt < 0) return null;
        // Match the actual saved body as well as the widget ID to avoid
        // swallowing unrelated user text when metadata offsets are stale.
        if (text.slice(openEnd + 1, closeAt) !== content) return null;
        return { start, end: closeAt + closing.length };
      }
      start = text.indexOf('<WritingBlock', openEnd + 1);
    }
    return null;
  }

  function withReferencePlaceholders(message) {
    let text = String(message.text || '');
    const replacements = [];

    (message.references || []).forEach((reference, index) => {
      if (reference.type === 'sources_footnote') return;

      let start = Number.isInteger(reference.start_idx) ? reference.start_idx : -1;
      let end = Number.isInteger(reference.end_idx) ? reference.end_idx : -1;
      const matched = reference.matched_text || '';

      if (start < 0 || end < start || text.slice(start, end) !== matched) {
        const kind = String(reference.data?.widget_type || reference.category || '').toLowerCase();
        const actualWritingBlock = reference.type === 'client_defined_widget'
          && kind === 'writing_block' ? findWritingBlockRange(text, reference) : null;
        if (actualWritingBlock) {
          start = actualWritingBlock.start;
          end = actualWritingBlock.end;
        } else {
          if (!matched || matched.trim() === '') return;
          start = text.indexOf(matched);
          if (start < 0) return;
          end = start + matched.length;
        }
      }

      replacements.push({ start, end, index });
    });

    replacements
      .sort((a, b) => b.start - a.start)
      .forEach(rep => {
        text = text.slice(0, rep.start) + referencePlaceholder(rep.index) + text.slice(rep.end);
      });

    return text;
  }

  function hydrateReferences(container, message) {
    const placeholders = [...container.querySelectorAll('.chat-ref-placeholder')];
    for (const placeholder of placeholders) {
      const index = Number(placeholder.dataset.refIndex);
      const reference = message.references?.[index];
      if (!reference) {
        placeholder.remove();
        continue;
      }

      let rendered = null;
      if (reference.type === 'client_defined_widget') rendered = renderWidget(reference);
      else if (reference.type === 'grouped_webpages') rendered = renderCitation(reference);
      else if (reference.type === 'sources_footnote') rendered = renderSources(reference);
      else if (reference.alt) {
        const span = document.createElement('span');
        span.className = 'reference-alt';
        span.textContent = reference.alt;
        rendered = span;
      }

      if (!rendered) {
        placeholder.remove();
        continue;
      }

      const parent = placeholder.parentElement;
      if (
        reference.type === 'client_defined_widget' &&
        parent?.tagName === 'P' &&
        parent.textContent.trim() === '' &&
        parent.children.length === 1
      ) {
        parent.replaceWith(rendered);
      } else {
        placeholder.replaceWith(rendered);
      }
    }
  }

  async function renderMermaid(container) {
    const blocks = [...container.querySelectorAll('pre code.language-mermaid')];

    for (const code of blocks) {
      const source = code.textContent || '';
      const panel = document.createElement('div');
      panel.className = 'mermaid';
      code.parentElement.replaceWith(panel);

      try {
        const renderId = 'mermaid-' + crypto.randomUUID().replaceAll('-', '');
        const result = await mermaid.render(renderId, source);
        panel.innerHTML = result.svg;
        panel.classList.add('mermaid-rendered');
        if (typeof result.bindFunctions === 'function') result.bindFunctions(panel);

        const svg = panel.querySelector('svg');
        if (!svg || !svg.getAttribute('viewBox')) {
          throw new Error('Mermaid returned no usable SVG.');
        }
      } catch (err) {
        panel.classList.add('mermaid-error');
        panel.innerHTML = '';

        const title = document.createElement('strong');
        title.textContent = 'Mermaid render error';
        const detail = document.createElement('div');
        detail.className = 'mermaid-error-detail';
        detail.textContent = err?.message || String(err);
        const pre = document.createElement('pre');
        pre.textContent = source;

        panel.append(title, detail, pre);
        console.warn('Mermaid render failed:', err);
      }
    }
  }

  function replaceAssetMarkers(container) {
    for (const p of [...container.querySelectorAll('p')]) {
      const text = p.textContent.trim();
      if (/^\[(Image|Audio) asset: /.test(text)) p.className = 'asset';
    }
  }

  async function renderMessageBody(body, message) {
    const source = withReferencePlaceholders(message);
    // Restore static ChatGPT DIL layout markup when present in the saved
    // assistant text. Marked and DOMPurify remain responsible for user text.
    // No stored JSX expression, host action or JavaScript is evaluated.
    if (!ChatDilRenderer.renderContent(body, source, markdown)) {
      body.innerHTML = markdown(source);
    }
    hydrateReferences(body, message);

    for (const reference of message.references || []) {
      if (reference.type === 'sources_footnote' && Array.isArray(reference.sources) && reference.sources.length) {
        body.appendChild(renderSources(reference));
      }
    }

    replaceAssetMarkers(body);
    await renderMermaid(body);
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const filtered = state.conversations.filter(c => c.title.toLowerCase().includes(q));
    for (const conversation of filtered) {
      const button = document.createElement('button');
      button.className = 'conversation-item' + (conversation.id === state.selectedId ? ' active' : '');
      button.textContent = conversation.title;
      button.title = conversation.title;
      button.addEventListener('click', () => selectConversation(conversation.id));
      list.appendChild(button);
    }
  }

  async function selectConversation(id) {
    state.selectedId = id;
    const conversation = state.conversations.find(c => c.id === id) || state.conversations[0];
    if (!conversation) return;

    $('conversationTitle').textContent = conversation.title;
    const snapshot = conversation.snapshot || {};
    const latestTurn = snapshot.newestTurnPending
      ? 'INCOMPLETE SNAPSHOT: latest user turn has no finished assistant final'
      : 'Latest user turn contains a completed final';
    const lastFinalTime = snapshot.lastCompletedFinalTime
      ? `Last completed final: ${formatTime(snapshot.lastCompletedFinalTime)}`
      : 'No completed assistant final found';
    const details = [
      conversation.id,
      `${conversation.messages.length} visible messages`,
      latestTurn,
      lastFinalTime,
      formatTime(conversation.updateTime)
    ].filter(Boolean);
    $('conversationMeta').textContent = details.join('  |  ');
    messages.innerHTML = '';

    for (const msg of conversation.messages) {
      const article = document.createElement('article');
      article.className = `message ${msg.role}`;

      const head = document.createElement('div');
      head.className = 'message-head';
      const role = document.createElement('strong');
      role.textContent = msg.role === 'user' ? 'You' : 'ChatGPT';
      head.appendChild(role);

      const time = formatTime(msg.createTime);
      if (time) {
        const span = document.createElement('span');
        span.textContent = time;
        head.appendChild(span);
      }

      if (msg.model && msg.role === 'assistant') {
        const model = document.createElement('span');
        model.textContent = msg.model;
        head.appendChild(model);
      }

      // Lossless source inspection is essential when ChatGPT's proprietary
      // runtime semantics cannot be replayed offline. The exact archived
      // DIL, bindings and callbacks remain available with one click.
      const hasStructuredSource = msg.role === 'assistant' && (
        /<(?:box|row|grid|button|slider|card|WritingBlock|AsyncImage|Chart)\b|\{@body\b|\bGenUI\./.test(msg.text || '') ||
        (msg.references || []).some(r => r.type === 'client_defined_widget')
      );
      let sourcePanel = null;
      if (hasStructuredSource) {
        const sourceButton = document.createElement('button');
        sourceButton.type = 'button';
        sourceButton.className = 'message-source-toggle';
        sourceButton.textContent = 'Original UI source';
        sourceButton.setAttribute('aria-expanded', 'false');
        sourcePanel = document.createElement('pre');
        sourcePanel.className = 'message-original-source';
        sourcePanel.textContent = msg.text || '';
        sourcePanel.hidden = true;
        sourceButton.addEventListener('click', () => {
          sourcePanel.hidden = !sourcePanel.hidden;
          sourceButton.setAttribute('aria-expanded', String(!sourcePanel.hidden));
        });
        head.appendChild(sourceButton);
      }

      const body = document.createElement('div');
      body.className = 'body';
      await renderMessageBody(body, msg);

      article.append(head, body);
      if (sourcePanel) article.appendChild(sourcePanel);
      messages.appendChild(article);
    }

    if (!conversation.messages.length) {
      messages.innerHTML = '<div class="empty">No visible messages were found.</div>';
    }

    renderList();
    // Open at the newest saved message so a truncated snapshot is obvious.
    const main = document.querySelector('.main');
    if (main) main.scrollTop = main.scrollHeight;
  }

  async function loadFiles(files) {
    const found = [];
    status.className = 'status';
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        status.textContent = `Reading ${i + 1} / ${files.length}: ${file.name}`;
        const parsed = ChatHistoryParser.parseText(await file.text());
        found.push(...parsed);
      }

      if (!found.length) throw new Error('No readable ChatGPT conversation was found in the selected file(s).');

      const byId = new Map(state.conversations.map(c => [c.id || c.title, c]));
      for (const conversation of found) byId.set(conversation.id || conversation.title, conversation);

      state.conversations = [...byId.values()]
        .sort((a, b) => (b.updateTime || b.createTime || 0) - (a.updateTime || a.createTime || 0));
      state.selectedId = found[0].id || found[0].title;

      loader.classList.add('hidden');
      app.classList.remove('hidden');
      await selectConversation(state.selectedId);
    } catch (err) {
      status.className = 'status error';
      status.textContent = err.message || String(err);
    }
  }

  fileInput.addEventListener('change', e => loadFiles([...e.target.files]));
  $('openMore').addEventListener('click', () => fileInput.click());
  search.addEventListener('input', renderList);

  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
    });
  }

  dropZone.addEventListener('drop', e => loadFiles([...e.dataTransfer.files]));
})();