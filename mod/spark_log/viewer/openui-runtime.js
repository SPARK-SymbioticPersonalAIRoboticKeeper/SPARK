/* SPARK bridge for MIT OpenUI browser-bundle 0.2.1.
 * The archived raw server conversation is immutable; this translates only
 * supported saved widgets into an OpenUI Lang program for the vendor runtime.
 * It never evaluates model-authored JS, forwards remote calls, or discards
 * source action metadata from the JSONL.
 */
(function (root) {
  'use strict';

  const runtime = () => root.__OpenUI;
  const actionHistory = [];

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function quoted(value) {
    return JSON.stringify(String(value ?? ''));
  }

  function programFor(reference) {
    const data = reference?.data || {};
    const kind = String(data.widget_type || reference?.category || '').toLowerCase();
    if (kind === 'code_block') {
      const language = text(data.language).trim() || 'text';
      const content = text(data.content || data.code || data.text);
      return {
        kind,
        code: 'root = Card([CodeBlock(' + quoted(language) + ', ' + quoted(content) + ')])',
        content,
        language,
      };
    }
    if (kind === 'writing_block') {
      const content = text(data.content || data.text);
      return {
        kind,
        code: 'root = Card([MarkDownRenderer(' + quoted(content) + ', "clear")])',
        content,
        variant: text(data.variant).trim() || 'document',
      };
    }
    return null;
  }

  function render(reference, options = {}) {
    const vendor = runtime();
    const program = programFor(reference);
    if (!vendor?.React || !vendor.createRoot || !vendor.Renderer ||
        !vendor.openuiChatLibrary || !program) return null;

    const panel = document.createElement('section');
    panel.className = 'chat-widget openui-widget openui-widget-' + program.kind;
    panel.dataset.widgetKind = program.kind;
    panel.dataset.widgetRenderer = 'OpenUI 0.2.1';
    panel.dataset.sourcePreserved = 'jsonl';

    if (program.kind === 'writing_block') {
      const header = document.createElement('div');
      header.className = 'widget-code-head';
      const label = document.createElement('span');
      label.className = 'widget-code-language';
      label.textContent = 'Writing · ' + program.variant;
      header.appendChild(label);
      if (typeof options.copyButton === 'function') {
        header.appendChild(options.copyButton(program.content, 'Copy original writing block'));
      }
      panel.appendChild(header);
    }

    const mount = document.createElement('div');
    mount.className = 'openui-react-mount';
    panel.appendChild(mount);

    // The hosted OpenUI runtime owns its React component state. Action events
    // from the offline replay are retained locally and made observable, not
    // sent blindly to any connected ChatGPT service.
    const status = document.createElement('div');
    status.className = 'openui-action-status';
    status.setAttribute('role', 'status');
    panel.appendChild(status);

    const onAction = event => {
      const record = {
        event,
        widgetKind: program.kind,
        timestamp: new Date().toISOString(),
      };
      actionHistory.push(record);
      if (actionHistory.length > 1000) actionHistory.shift();
      status.textContent = 'Action captured locally. No live ChatGPT backend is connected.';
      panel.dispatchEvent(new CustomEvent('spark-openui-action', {
        bubbles: true,
        detail: record,
      }));
    };

    const reactRoot = vendor.createRoot(mount);
    reactRoot.render(vendor.React.createElement(vendor.Renderer, {
      response: program.code,
      library: vendor.openuiChatLibrary,
      isStreaming: false,
      onAction,
    }));

    return panel;
  }

  root.SPARKOpenUI = Object.freeze({
    render,
    programFor,
    actionHistory,
    available: () => !!runtime()?.Renderer,
  });
})(typeof window !== 'undefined' ? window : globalThis);
