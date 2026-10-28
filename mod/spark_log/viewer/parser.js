(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChatHistoryParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function activeBranch(conversation) {
    const mapping = conversation.mapping || {};
    const current = conversation.current_node;
    if (!current || !mapping[current]) {
      return Object.entries(mapping).sort((a, b) => {
        const at = a[1]?.message?.create_time ?? Number.MAX_SAFE_INTEGER;
        const bt = b[1]?.message?.create_time ?? Number.MAX_SAFE_INTEGER;
        return at - bt;
      });
    }

    const result = [];
    const seen = new Set();
    let nodeId = current;
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      result.push([nodeId, mapping[nodeId]]);
      nodeId = mapping[nodeId].parent;
    }
    result.reverse();
    return result;
  }

  function assetId(pointer) {
    if (typeof pointer !== 'string') return '';
    const m = pointer.match(/file[-_:]([A-Za-z0-9_-]+)/i);
    return m ? m[1] : pointer;
  }

  function partToText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.content_type === 'image_asset_pointer') return `\n\n[Image asset: ${assetId(part.asset_pointer)}]\n\n`;
    if (part.content_type === 'audio_asset_pointer') return `\n\n[Audio asset: ${assetId(part.asset_pointer)}]\n\n`;
    if (part.content_type === 'audio_transcription') return part.text || '';
    if (typeof part.text === 'string') return part.text;
    return '';
  }

  function contentToText(message) {
    const content = message.content || {};
    const type = content.content_type || 'text';
    if (type === 'text' || type === 'multimodal_text') return (content.parts || []).map(partToText).join('');
    if (type === 'code') return `\`\`\`${content.language || ''}\n${content.text || ''}\n\`\`\``;
    if (type === 'reasoning_recap') return typeof content.content === 'string' ? content.content : (content.parts || []).map(partToText).join('');
    if (type === 'tether_quote') {
      const head = content.url ? `[${content.title || content.url}](${content.url})` : (content.title || '');
      return [head, content.text || ''].filter(Boolean).join('\n\n');
    }
    if (type === 'tether_browsing_display') return content.result || content.summary || '';
    if (type === 'execution_output') return content.text ? `\`\`\`text\n${content.text}\n\`\`\`` : '';
    if (typeof content.text === 'string') return content.text;
    return (content.parts || []).map(partToText).join('');
  }

  function visibleMessage(message) {
    if (!message) return false;
    const role = message.author?.role;
    if (role !== 'user' && role !== 'assistant') return false;
    if (message.metadata?.is_visually_hidden_from_conversation) return false;

    if (role === 'assistant') {
      // Tool-call payloads and reasoning are part of the raw backup but are
      // not user-facing chat messages. Never display them as ChatGPT replies.
      if (message.recipient && message.recipient !== 'all') return false;
      if (['thoughts', 'reasoning_recap'].includes(message.content?.content_type)) return false;
      // Preserve partial responses in the raw JSONL, but do not render an
      // in-progress fragment as if it were a completed answer.
      if (message.status === 'in_progress') return false;
    }
    return true;
  }

  function normalizeReferences(message) {
    const refs = message?.metadata?.content_references;
    if (!Array.isArray(refs)) return [];
    return refs
      .filter(ref => ref && typeof ref === 'object')
      .map((ref, index) => ({
        ...ref,
        _index: index,
        start_idx: Number.isInteger(ref.start_idx) ? ref.start_idx : null,
        end_idx: Number.isInteger(ref.end_idx) ? ref.end_idx : null,
        matched_text: typeof ref.matched_text === 'string' ? ref.matched_text : ''
      }));
  }

  function parseConversation(conversation) {
    const messages = [];
    const branch = activeBranch(conversation);
    // A valid JSONL file and a fully rendered Viewer are not evidence that
    // the newest ChatGPT turn was finished when the raw snapshot was taken.
    const newestUserIndex = branch.findLastIndex(([, node]) =>
      node?.message?.author?.role === 'user'
    );
    const newestCompletedFinalIndex = branch.findLastIndex(([, node]) => {
      const message = node?.message;
      return message?.author?.role === 'assistant'
        && (!message.recipient || message.recipient === 'all')
        && message.channel === 'final'
        && message.status === 'finished_successfully';
    });
    const newestCompletedFinal = newestCompletedFinalIndex >= 0
      ? branch[newestCompletedFinalIndex][1].message : null;
    const snapshot = {
      lastCompletedFinalTime: newestCompletedFinal?.create_time || null,
      lastUserTurnCompleted: newestUserIndex < 0
        ? newestCompletedFinalIndex >= 0
        : newestCompletedFinalIndex > newestUserIndex,
      newestTurnPending: newestUserIndex >= 0
        && newestCompletedFinalIndex <= newestUserIndex,
    };
    for (const [index, [nodeId, node]] of branch.entries()) {
      const message = node?.message;
      // A current in-flight turn can contain individually finished commentary
      // before its final answer exists. Hide that interim content from the
      // offline transcript until the final is actually completed.
      if (snapshot.newestTurnPending && index > newestUserIndex
          && message?.author?.role === 'assistant') continue;
      if (!visibleMessage(message)) continue;

      const text = contentToText(message);
      const references = normalizeReferences(message);
      if (!text.trim() && references.length === 0) continue;

      messages.push({
        id: message.id || nodeId,
        role: message.author?.role || 'unknown',
        text,
        references,
        // Preserve the server's compiled DIL v2 payload for future official
        // renderer adapters. It is untrusted data and is never executed here.
        modelDilV2: message.metadata?.model_dil_v2 ?? null,
        contentType: message.content?.content_type || 'text',
        createTime: message.create_time || null,
        model: message.metadata?.model_slug || '',
        channel: message.channel || null
      });
    }

    return {
      id: conversation.conversation_id || conversation.id || '',
      title: conversation.title || '(untitled)',
      createTime: conversation.create_time || null,
      updateTime: conversation.update_time || null,
      snapshot,
      messages
    };
  }

  function parseText(text) {
    const clean = String(text || '').trim();
    if (!clean) return [];

    let records = [];
    try {
      const data = JSON.parse(clean);
      if (Array.isArray(data)) records = data;
      else if (Array.isArray(data?.conversations)) records = data.conversations;
      else if (data?.mapping) records = [data];
    } catch (wholeError) {
      const lines = clean.split(/\r?\n/).filter(x => x.trim());
      records = lines.map((line, index) => {
        try { return JSON.parse(line); }
        catch (err) { throw new Error(`Invalid JSONL at line ${index + 1}: ${err.message}`); }
      }).filter(x => x?.mapping);
    }

    return records
      .filter(x => x?.mapping)
      .map(parseConversation)
      .filter(x => x.messages.length > 0);
  }

  return { parseText, parseConversation, activeBranch };
});