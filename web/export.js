// web/export.js
// Session export: pure normalizers (extractSessionContent / toMarkdown / toJson)
// plus a browser-only triggerDownload helper. No build step, no deps.
//
// Reference for the content-extraction shape:
// D:/_scratch_cch_viewer/src/services/export/contentExtractor.ts (extractBlocks).
// We normalize GLMPS's shared event shape
// { kind, lane, label, path, tool, ts, sessionId } (+ optional op/change/model)
// rather than raw Anthropic content blocks.

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// Render a write event's change payload into a short unified-style text block.
function changeText(change) {
  if (!change || typeof change !== 'object') return '';
  const lines = [];
  if (change.old?.text) {
    for (const l of String(change.old.text).split('\n')) lines.push('- ' + l);
    if (change.old.truncated) lines.push('- ... truncated');
  }
  if (change.new?.text) {
    for (const l of String(change.new.text).split('\n')) lines.push('+ ' + l);
    if (change.new.truncated) lines.push('+ ... truncated');
  }
  return lines.join('\n');
}

// extractSessionContent(items) -> [{ kind, text }]
// Pure normalizer over GLMPS events (and, defensively, raw message
// objects with a .message/.content shape). Skips empties; never throws.
export function extractSessionContent(items) {
  if (!Array.isArray(items)) return [];
  const parts = [];
  const add = (kind, text) => {
    const t = (text == null ? '' : String(text)).trim();
    if (t === '') return;
    parts.push({ kind, text: t });
  };

  for (const it of items) {
    if (it == null || typeof it !== 'object') continue;

    // Raw message object (role + string/array content) — flatten to text.
    if (it.message && typeof it.message === 'object') {
      const role = it.message.role ?? it.type ?? 'message';
      const c = it.message.content;
      if (typeof c === 'string') { add(role, c); continue; }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string') add(role, b.text);
          else if (b.type === 'thinking' && typeof b.thinking === 'string') add('thinking', b.thinking);
          else if (b.type === 'tool_use' && typeof b.name === 'string') add('tool', b.name);
          else if (b.type === 'tool_result') {
            const rc = typeof b.content === 'string' ? b.content : '[tool result]';
            add(b.is_error === true ? 'error' : 'result', clip(rc, 500));
          }
        }
        continue;
      }
    }

    // GLMPS event shape.
    const kind = it.kind ?? 'event';
    switch (kind) {
      case 'git': {
        const label = it.label ?? 'commit';
        add('git', label);
        break;
      }
      case 'tool': {
        const op = it.op ? it.op + ' ' : '';
        const label = it.label ?? it.path ?? it.tool ?? 'tool';
        add('tool', op + label);
        if (it.change) add('change', changeText(it.change));
        break;
      }
      case 'skill':
        add('skill', it.label ?? it.path ?? 'skill');
        break;
      case 'agent':
        add('agent', (it.model ? it.model + ': ' : '') + (it.label ?? 'agent'));
        break;
      default: {
        const label = it.label ?? it.path ?? it.tool ?? '';
        add(kind, label);
        if (it.op === 'write' && it.change) add('change', changeText(it.change));
        break;
      }
    }
  }
  return parts;
}

const FENCE_KINDS = new Set(['change', 'result', 'error', 'tool', 'git']);

// toMarkdown(meta, parts) -> string
// meta: { title?, sessionId?, tool?, model?, exportedAt? }
// parts: [{ kind, text }] (output of extractSessionContent)
export function toMarkdown(meta = {}, parts = []) {
  const out = [];
  const title = meta.title || meta.sessionId || 'Session';
  out.push('# ' + title);
  out.push('');
  const metaLines = [];
  if (meta.sessionId) metaLines.push('- Session: `' + meta.sessionId + '`');
  if (meta.tool) metaLines.push('- Tool: ' + meta.tool);
  if (meta.model) metaLines.push('- Model: ' + meta.model);
  if (meta.exportedAt) metaLines.push('- Exported: ' + meta.exportedAt);
  if (metaLines.length) { out.push(...metaLines); out.push(''); }

  for (const p of parts) {
    out.push('## ' + p.kind);
    if (FENCE_KINDS.has(p.kind)) {
      out.push('```');
      out.push(p.text);
      out.push('```');
    } else {
      out.push(p.text);
    }
    out.push('');
  }
  return out.join('\n');
}

// toJson(meta, parts) -> string (pretty-printed JSON document)
export function toJson(meta = {}, parts = []) {
  return JSON.stringify({
    title: meta.title ?? null,
    sessionId: meta.sessionId ?? null,
    tool: meta.tool ?? null,
    model: meta.model ?? null,
    exportedAt: meta.exportedAt ?? null,
    parts: Array.isArray(parts) ? parts : [],
  }, null, 2);
}

// triggerDownload(filename, text, mime) — browser-only side effect.
// Creates a Blob + temporary anchor, clicks it, then revokes the URL.
export function triggerDownload(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
