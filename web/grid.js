// web/grid.js
// All DOM references are inside exported functions — safe to import in Node for syntax checks.

function setText(el, s) { el.textContent = String(s ?? ''); }

function projectName(session) {
  if (session.cwd) {
    const seg = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (seg) return seg;
  }
  if (session.title) return session.title;
  return session.id.slice(0, 8);
}

function modelShort(status) {
  if (!status) return null;
  const name = status.model?.displayName;
  if (!name) return null;
  // Shorten common model names
  return name.replace('claude-', '').replace(/^(sonnet|haiku|opus)/, s => s[0].toUpperCase() + s.slice(1));
}

const TOOL_BADGES = {
  'claude-code': 'CC', 'antigravity': 'AG', 'agy-cli': 'AG',
  'gemini-cli': 'GC', 'copilot-chat': 'CP', 'hermes': 'HE',
  'codex-cli': 'CX', 'openclaw': 'OC',
};

// Signature color per tool — maps to CSS class suffix for tool-chip-<color>
// and hex for inline border-left on rail entries.
const TOOL_COLOR = {
  'claude-code':   { cls: 'gold',   hex: '#d4a437' },
  'antigravity':   { cls: 'blue',   hex: '#4a8cd8' },
  'agy-cli':       { cls: 'blue',   hex: '#4a8cd8' },
  'gemini-cli':    { cls: 'green',  hex: '#3fb87f' },
  'copilot-chat':  { cls: 'purple', hex: '#a878d8' },
  'hermes':        { cls: 'amber',  hex: '#e0a23a' },
  'codex-cli':     { cls: 'red',    hex: '#e05656' },
  'openclaw':      { cls: 'muted',  hex: '#252a32' },
};

function toolAccentHex(tool) {
  return TOOL_COLOR[tool]?.hex ?? '#252a32';
}

function toolColorClass(tool) {
  return TOOL_COLOR[tool]?.cls ?? 'muted';
}

function badgeText(tool) {
  if (TOOL_BADGES[tool]) return TOOL_BADGES[tool];
  return (tool || '').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function makeBadgeFallback(tool) {
  const span = document.createElement('span');
  span.className = 'tool-badge';
  setText(span, badgeText(tool));
  return span;
}

function makeToolIcon(tool) {
  const img = document.createElement('img');
  img.src = `/api/icon/${tool}`;
  img.className = 'tool-icon';
  img.alt = badgeText(tool);
  img.width = 18;
  img.height = 18;
  img.addEventListener('error', () => {
    // Replace img with text badge fallback
    const badge = makeBadgeFallback(tool);
    img.replaceWith(badge);
  });
  return img;
}

function renderRailEntry(session, handlers, selectedId) {
  const entry = document.createElement('div');
  entry.className = 'rail-entry' + (session.live ? '' : ' rail-ended') + (session.id === selectedId ? ' selected' : '');
  entry.setAttribute('data-session-id', session.id);

  // Tool accent left bar (safe — sets style property, not innerHTML)
  entry.style.borderLeftColor = toolAccentHex(session.tool);

  // Icon
  const icon = makeToolIcon(session.tool);
  entry.appendChild(icon);

  // Name + dot row
  const nameRow = document.createElement('div');
  nameRow.className = 'rail-name-row';

  const dot = document.createElement('span');
  dot.className = `status-dot ${session.state}`;
  dot.title = session.state;
  nameRow.appendChild(dot);

  const nameEl = document.createElement('span');
  nameEl.className = 'rail-name';
  setText(nameEl, session.title || projectName(session));
  nameRow.appendChild(nameEl);

  // Capability-gap warning badge
  if (session.gapCount > 0) {
    const gap = document.createElement('span');
    gap.className = 'rail-gap-badge';
    gap.title = `${session.gapCount} capability gap${session.gapCount > 1 ? 's' : ''}`;
    setText(gap, '⚠');
    nameRow.appendChild(gap);
  }

  // Model + ctx% after name — ctx% rendered gold
  if (session.status) {
    const short = modelShort(session.status);
    const ctxPct = session.status.context?.usedPercent;
    if (short || ctxPct != null) {
      const metaEl = document.createElement('span');
      metaEl.className = 'rail-meta';

      if (short) {
        const modelSpan = document.createElement('span');
        setText(modelSpan, short);
        metaEl.appendChild(modelSpan);
      }

      if (ctxPct != null) {
        if (short) {
          // separator
          const sep = document.createElement('span');
          setText(sep, ' ');
          metaEl.appendChild(sep);
        }
        const ctxSpan = document.createElement('span');
        ctxSpan.className = 'rail-ctx-pct';
        setText(ctxSpan, `${Math.round(ctxPct)}%`);
        metaEl.appendChild(ctxSpan);
      }

      nameRow.appendChild(metaEl);
    }
  }

  entry.appendChild(nameRow);

  // Counts line: each segment in its kind color using individual <span> elements
  const counts = session.counts;
  if (counts) {
    const segments = [];
    if (counts.skills)       segments.push({ text: `${counts.skills}sk`,   cls: 'cnt-skill' });
    if (counts.memory)       segments.push({ text: `${counts.memory}mem`,  cls: 'cnt-mem'   });
    if (counts.agents)       segments.push({ text: `${counts.agents}ag`,   cls: 'cnt-ag'    });
    if (counts.contextFiles) segments.push({ text: `${counts.contextFiles}ctx`, cls: 'cnt-ctx' });
    if (counts.mcp)          segments.push({ text: `${counts.mcp}mcp`,     cls: 'cnt-mcp'   });
    if (counts.git)          segments.push({ text: `${counts.git}git`,     cls: 'cnt-git'   });

    if (segments.length > 0) {
      const countsEl = document.createElement('div');
      countsEl.className = 'rail-counts';

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const span = document.createElement('span');
        span.className = seg.cls;
        setText(span, seg.text);
        countsEl.appendChild(span);

        if (i < segments.length - 1) {
          const dot = document.createElement('span');
          setText(dot, '·');
          countsEl.appendChild(dot);
        }
      }

      entry.appendChild(countsEl);
    }
  }

  entry.addEventListener('click', () => handlers.onSelectSession(session.id));

  return entry;
}

export function renderRail(state, handlers, selectedId) {
  const railEl = document.getElementById('rail');
  if (!railEl) return;

  // Sort: live first, then by lastTs desc
  const all = [...(state.sessions ?? [])].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.lastTs ?? 0) - (a.lastTs ?? 0);
  });

  // Show live sessions + the 10 most recent ended ones; exclude cloud-only remote sessions
  const live = all.filter(s => s.live);
  const ended = all.filter(s => !s.live && s.format !== 'remote').slice(0, 10);
  const visible = [...live, ...ended];

  railEl.innerHTML = '';
  for (const session of visible) {
    railEl.appendChild(renderRailEntry(session, handlers, selectedId));
  }
}

export { TOOL_COLOR, toolAccentHex, toolColorClass, makeToolIcon, badgeText };
