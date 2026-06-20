// web/detail.js
import { getState, learningAction } from './api.js';
import { invocationFor } from './copy-strings.js';
import { toolAccentHex, makeToolIcon, badgeText } from './grid.js';
import { renderAnsi } from './ansi.js';
import { extractSessionContent, toMarkdown, toJson, triggerDownload } from './export.js';

// Convert a "#rrggbb" hex string to "rgba(r,g,b,alpha)" — computed color strings only, no user data.
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function setText(el, s) { el.textContent = String(s ?? ''); }

function kindChip(kind) {
  const span = document.createElement('span');
  span.className = `chip chip-${kind}`;
  setText(span, kind);
  return span;
}

// Detect tier keyword from a model string (id or displayName)
function tierClass(m) {
  if (!m || typeof m !== 'string') return null;
  const lower = m.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

// Return a human-readable tier label from various model string forms
function modelTier(m) {
  if (!m || typeof m !== 'string') return null;
  const lower = m.toLowerCase();
  // Short tier shortcuts
  if (lower === 'opus') return 'Opus';
  if (lower === 'sonnet') return 'Sonnet';
  if (lower === 'haiku') return 'Haiku';
  // displayName like 'Opus 4.8 (1M context)' — strip parenthetical
  if (/^(opus|sonnet|haiku)\s/i.test(m)) {
    return m.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  // id like 'claude-opus-4-8[1m]' — detect tier and return capitalized tier
  const t = tierClass(m);
  if (t) return t.charAt(0).toUpperCase() + t.slice(1);
  return null;
}

// Module-level parent model context (set at renderDetail time)
let _parentModel = null;
let _parentModelRaw = null;

function fmtTime(ts) {
  if (ts == null) return '??:??:??';
  let d;
  if (typeof ts === 'string') {
    d = new Date(ts);
  } else {
    // epoch ms or epoch s — heuristic: values < 1e12 are likely seconds
    d = new Date(ts < 1e12 ? ts * 1000 : ts);
  }
  if (isNaN(d.getTime())) return '??:??:??';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ── Shared diff popup (one instance at a time) ───────
// The popup element is lazily created and appended to document.body.
// It is shared across all event rows in the page.
let _diffPopup = null;
let _activeToggle = null;

function getDiffPopup() {
  if (!_diffPopup) {
    _diffPopup = document.createElement('div');
    _diffPopup.className = 'diff-popup';
    document.body.appendChild(_diffPopup);
  }
  return _diffPopup;
}

function hideDiffPopup() {
  if (_diffPopup) {
    _diffPopup.style.display = 'none';
    _diffPopup.innerHTML = '';
  }
  if (_activeToggle) {
    setText(_activeToggle, 'diff ▸');
    _activeToggle = null;
  }
}

function positionDiffPopup(popup, btn) {
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popW = Math.min(520, vw - 16);
  const popH = 320;

  // Prefer below the button, left-aligned to button right edge, clamped to viewport
  let top = r.bottom + 4;
  let left = r.right - popW;

  if (left < 8) left = 8;
  if (left + popW > vw - 8) left = vw - popW - 8;
  if (top + popH > vh - 8) {
    // flip above
    top = r.top - popH - 4;
  }
  if (top < 8) top = 8;

  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
  popup.style.maxWidth = popW + 'px';
  popup.style.display = 'block';
}

function fillDiffPopup(popup, change, labelBasename, handlers, filePath) {
  popup.innerHTML = '';

  // Header — flex row: basename left, edit pencil right
  if (labelBasename || filePath) {
    const hdr = document.createElement('div');
    hdr.className = 'diff-popup-header';

    const nameSpan = document.createElement('span');
    setText(nameSpan, labelBasename ?? '');
    hdr.appendChild(nameSpan);

    if (filePath && handlers?.onOpenFile) {
      const editBtn = document.createElement('button');
      editBtn.className = 'diff-edit';
      editBtn.title = 'Open in editor';
      setText(editBtn, '✎');
      editBtn.addEventListener('click', () => {
        handlers.onOpenFile(filePath);
        hideDiffPopup();
      });
      hdr.appendChild(editBtn);
    }

    popup.appendChild(hdr);
  }

  if (change.old) {
    const oldEl = document.createElement('div');
    oldEl.className = 'diff-old';
    // Prefix each line with '- ', then render any terminal escapes via renderAnsi
    // (XSS-safe: text -> textContent, styling from a fixed palette — no innerHTML with data).
    const lines = change.old.text.split('\n').map(l => '- ' + l).join('\n');
    oldEl.appendChild(renderAnsi(lines));
    popup.appendChild(oldEl);
    if (change.old.truncated) {
      const note = document.createElement('div');
      note.className = 'diff-truncated';
      setText(note, '… truncated');
      popup.appendChild(note);
    }
  }

  if (change.new) {
    const newEl = document.createElement('div');
    newEl.className = 'diff-new';
    const lines = change.new.text.split('\n').map(l => '+ ' + l).join('\n');
    newEl.appendChild(renderAnsi(lines));
    popup.appendChild(newEl);
    if (change.new.truncated) {
      const note = document.createElement('div');
      note.className = 'diff-truncated';
      setText(note, '… truncated');
      popup.appendChild(note);
    }
  }
}

function makeEventRow(ev, handlers, dimmed) {
  const row = document.createElement('div');
  const isGit = ev.kind === 'git';
  row.className = 'event-row' + (dimmed ? ' event-row-dim' : '') + (isGit ? ' evt-git' : '');

  const timeEl = document.createElement('span');
  timeEl.className = 'event-time';
  setText(timeEl, fmtTime(ev.ts));
  row.appendChild(timeEl);

  // Column 2: a meta wrapper holding the op marker (if any) + chip/icon,
  // so the row keeps a fixed child count regardless of read/write/git.
  const meta = document.createElement('span');
  meta.className = 'event-meta';
  if (isGit) {
    const img = document.createElement('img');
    img.src = '/icons/git-commit.svg';
    img.className = 'evt-icon';
    img.alt = 'git';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    meta.appendChild(img);
  } else {
    const hasOp = ev.op === 'read' || ev.op === 'write';
    if (hasOp && !dimmed) {
      // Task 1: text "rd"/"wr" tokens instead of arrows
      const opEl = document.createElement('span');
      opEl.className = ev.op === 'read' ? 'op-read' : 'op-write';
      opEl.title = ev.op === 'read' ? 'read' : 'write';
      setText(opEl, ev.op === 'read' ? 'rd' : 'wr');
      meta.appendChild(opEl);
    }
    if (ev.kind === 'agent') {
      // Show model tier chip instead of generic 'agent' chip
      const modelChip = document.createElement('span');
      const rawM = ev.model ?? _parentModelRaw;
      const tier = tierClass(rawM);
      const chipText = modelTier(ev.model) ?? _parentModel ?? 'agent';
      modelChip.className = 'chip chip-model' + (tier ? ` model-${tier}` : '');
      setText(modelChip, chipText);
      meta.appendChild(modelChip);
    } else {
      meta.appendChild(kindChip(ev.kind ?? 'tool'));
    }
  }
  row.appendChild(meta);

  const labelEl = document.createElement('span');
  labelEl.className = 'event-label';
  const labelText = ev.label ?? ev.path ?? ev.tool ?? ev.kind ?? '';
  setText(labelEl, labelText);
  if (ev.path) {
    labelEl.classList.add('clickable');
    labelEl.title = ev.path;
    labelEl.addEventListener('click', () => handlers.onOpenFile(ev.path));
  }
  row.appendChild(labelEl);

  // Column 4: +/- edit counts (file edits / writes) and/or a diff popup toggle.
  const tail = document.createElement('span');
  tail.className = 'event-tail';

  if (ev.add != null || ev.del != null) {
    const ed = document.createElement('span');
    ed.className = 'event-edits';
    const a = document.createElement('span');
    a.className = 'ev-add';
    setText(a, `+${ev.add ?? 0}`);
    const d = document.createElement('span');
    d.className = 'ev-del';
    setText(d, `−${ev.del ?? 0}`);
    ed.appendChild(a);
    ed.appendChild(d);
    tail.appendChild(ed);
  }

  if (ev.op === 'write' && ev.change) {
    row.classList.add('has-diff');
    const toggle = document.createElement('button');
    toggle.className = 'diff-toggle';
    setText(toggle, 'diff ▸');

    // Derive a basename for the popup header from the event's label/path (textContent-safe)
    const rawLabel = ev.label ?? ev.path ?? '';
    const labelBasename = rawLabel.replace(/\\/g, '/').split('/').pop() || rawLabel;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = getDiffPopup();
      if (_activeToggle === toggle) {
        hideDiffPopup();
      } else {
        hideDiffPopup();
        fillDiffPopup(popup, ev.change, labelBasename, handlers, ev.path ?? null);
        positionDiffPopup(popup, toggle);
        _activeToggle = toggle;
        setText(toggle, 'diff ▾');
      }
    });

    tail.appendChild(toggle);
  }

  row.appendChild(tail);
  return row;
}

function buildContextPanel(events, handlers) {
  const panel = document.createElement('div');
  panel.className = 'panel panel-main';

  const title = document.createElement('div');
  title.className = 'panel-title';
  setText(title, 'Context Events');
  panel.appendChild(title);

  const contextEvents = events.filter(e => e.lane === 'context');
  const newestFirst = [...contextEvents].reverse();

  const listEl = document.createElement('div');
  listEl.className = 'event-list';

  for (const ev of newestFirst) {
    listEl.appendChild(makeEventRow(ev, handlers, false));
  }
  panel.appendChild(listEl);

  // Full feed details
  const feedDetails = document.createElement('details');
  feedDetails.className = 'feed-details';

  const feedSummary = document.createElement('summary');
  setText(feedSummary, `Full feed (${events.length} events)`);
  feedDetails.appendChild(feedSummary);

  const feedList = document.createElement('div');
  feedList.className = 'event-list';
  const allNewest = [...events].reverse();
  for (const ev of allNewest) {
    feedList.appendChild(makeEventRow(ev, handlers, false));
  }
  feedDetails.appendChild(feedList);

  panel.appendChild(feedDetails);

  return { panel, listEl, feedList };
}

function buildGapCallout(gaps) {
  const box = document.createElement('div');
  box.className = 'gap-callout';

  const head = document.createElement('div');
  head.className = 'gap-head';
  const icon = document.createElement('span');
  icon.className = 'gap-icon';
  setText(icon, '⚠'); // ⚠
  head.appendChild(icon);
  const title = document.createElement('span');
  setText(title, gaps.length === 1 ? 'Capability gap' : `Capability gaps (${gaps.length})`);
  head.appendChild(title);
  box.appendChild(head);

  for (const g of gaps) {
    const line = document.createElement('div');
    line.className = 'gap-line gap-' + (g.severity === 'warn' ? 'warn' : 'info');

    const msg = document.createElement('span');
    msg.className = 'gap-msg';
    setText(msg, g.message ?? '');
    line.appendChild(msg);

    // Actionable when the server attached a learning-queue item id.
    if (g.id) {
      const actions = document.createElement('span');
      actions.className = 'gap-actions';
      const renderState = (status) => {
        actions.textContent = '';
        if (status === 'pending') {
          const approve = document.createElement('button');
          approve.className = 'gap-act gap-act-approve';
          setText(approve, 'Approve');
          const discard = document.createElement('button');
          discard.className = 'gap-act gap-act-discard';
          setText(discard, 'Discard');
          // Promote → global: lift a capability guard into global CLAUDE.md so every
          // agent sees it (the deterministic default; memory promotion lives on the
          // full Learning card). Disables siblings while in flight.
          const promote = document.createElement('button');
          promote.className = 'gap-act gap-act-promote';
          setText(promote, 'Promote');
          const setDisabled = (v) => { approve.disabled = v; discard.disabled = v; promote.disabled = v; };
          const run = async (act, target) => {
            setDisabled(true);
            try {
              const item = await learningAction(g.id, act, target);
              renderState(item && item.status ? item.status
                : (act === 'discard' ? 'discarded' : act === 'promote' && target === 'memory' ? 'dispatched' : 'applied'));
            } catch {
              setDisabled(false);
            }
          };
          approve.addEventListener('click', () => run('approve'));
          discard.addEventListener('click', () => run('discard'));
          promote.addEventListener('click', () => run('promote', 'global'));
          actions.appendChild(approve);
          actions.appendChild(discard);
          actions.appendChild(promote);
        } else {
          const tag = document.createElement('span');
          tag.className = 'gap-state gap-state-' + status;
          setText(tag, status);
          actions.appendChild(tag);
        }
      };
      renderState(g.status || 'pending');
      line.appendChild(actions);
    }

    box.appendChild(line);
  }
  return box;
}

function buildGuidingBar(guidingFiles, events, handlers, skillsUsed) {
  const bar = document.createElement('div');
  bar.className = 'banner-guiding';

  // Skills: prefer the persisted full list (skillsUsed), union with any in the
  // current event window (the window can age out early skill invocations).
  const seenSkills = new Set();
  const skills = [];
  for (const key of (skillsUsed ?? [])) {
    if (key && !seenSkills.has(key)) { seenSkills.add(key); skills.push(key); }
  }
  for (const e of (events ?? [])) {
    if (e.kind !== 'skill') continue;
    const key = e.label ?? e.path ?? '';
    if (key && !seenSkills.has(key)) { seenSkills.add(key); skills.push(key); }
  }

  const hasFiles = guidingFiles && guidingFiles.length > 0;
  const hasSkills = skills.length > 0;

  if (!hasFiles && !hasSkills) {
    const none = document.createElement('div');
    none.className = 'guiding-none';
    setText(none, 'No guiding context detected');
    bar.appendChild(none);
    return bar;
  }

  // Context files row
  if (hasFiles) {
    const filesRow = document.createElement('div');
    filesRow.className = 'guiding-files';

    for (const gf of guidingFiles) {
      const pill = document.createElement('span');
      pill.className = 'chip guiding-chip';
      pill.title = gf.path ?? '';

      // Scope tag
      const scopeTag = document.createElement('span');
      let scopeClass, scopeLabel;
      if (gf.scope === 'global') {
        scopeClass = 'scope-global'; scopeLabel = 'global';
      } else if (gf.scope === 'memory') {
        scopeClass = 'scope-memory'; scopeLabel = 'memory';
      } else if (gf.scope === 'acceptance') {
        scopeClass = 'scope-acceptance'; scopeLabel = 'done';
      } else {
        scopeClass = 'scope-project'; scopeLabel = 'project';
      }
      scopeTag.className = `scope-tag ${scopeClass}`;
      setText(scopeTag, scopeLabel);
      pill.appendChild(scopeTag);

      // Basename label — clickable
      const nameSpan = document.createElement('span');
      nameSpan.className = 'guiding-file-name clickable';
      const basename = (gf.path ?? gf.name ?? '').replace(/\\/g, '/').split('/').pop() || gf.name;
      setText(nameSpan, basename);
      if (gf.path && handlers?.onOpenFile) {
        nameSpan.addEventListener('click', () => handlers.onOpenFile(gf.path));
      }
      pill.appendChild(nameSpan);

      // Edit pencil button
      if (gf.path && handlers?.onOpenFile) {
        const editBtn = document.createElement('button');
        editBtn.className = 'guiding-edit';
        editBtn.title = gf.path;
        setText(editBtn, '✎');
        editBtn.addEventListener('click', () => handlers.onOpenFile(gf.path));
        pill.appendChild(editBtn);
      }

      filesRow.appendChild(pill);
    }

    bar.appendChild(filesRow);
  }

  // Skills row
  const skillsRow = document.createElement('div');
  skillsRow.className = 'guiding-skills';

  if (hasSkills) {
    for (const skillLabel of skills) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-skill guiding-skill-chip';
      setText(chip, skillLabel);
      skillsRow.appendChild(chip);
    }
  } else {
    const none = document.createElement('span');
    none.className = 'guiding-none-skills';
    setText(none, 'no skills invoked yet');
    skillsRow.appendChild(none);
  }

  bar.appendChild(skillsRow);

  return bar;
}

function buildUnusedPanel(usage, handlers) {
  const panel = document.createElement('div');
  panel.className = 'panel panel-side';

  const title = document.createElement('div');
  title.className = 'panel-title';
  setText(title, 'Unused assets');
  panel.appendChild(title);

  // Grouped by type — each group gets a colored, labelled header and colored pills.
  const groups = [
    { type: 'skill',        kind: 'skill',        label: 'Skills',        items: usage?.unused?.skills ?? [] },
    { type: 'agent',        kind: 'agent',        label: 'Agents',        items: usage?.unused?.agents ?? [] },
    { type: 'memory',       kind: 'memory',       label: 'Memory',        items: usage?.unused?.memory ?? [] },
    { type: 'context-file', kind: 'context-file', label: 'Context files', items: usage?.unused?.contextFiles ?? [] },
  ];

  let total = 0;
  for (const g of groups) {
    if (!g.items.length) continue;
    total += g.items.length;

    const section = document.createElement('div');
    section.className = 'unused-group';

    const head = document.createElement('div');
    head.className = `unused-group-head ug-${g.kind}`;
    const lab = document.createElement('span');
    setText(lab, g.label);
    head.appendChild(lab);
    const cnt = document.createElement('span');
    cnt.className = 'unused-group-count';
    setText(cnt, String(g.items.length));
    head.appendChild(cnt);
    section.appendChild(head);

    const pills = document.createElement('div');
    pills.className = 'unused-pills';

    // Sort applicable items before dimmed ones (for memory/contextFiles that carry applicable flag)
    const sortedItems = [...g.items].sort((a, b) => {
      const aApp = a.applicable !== false;
      const bApp = b.applicable !== false;
      if (aApp && !bApp) return -1;
      if (!aApp && bApp) return 1;
      return 0;
    });

    for (const item of sortedItems) {
      const pill = document.createElement('button');
      const dim = item.applicable === false;
      pill.className = `chip chip-${g.kind} unused-pill${dim ? ' unused-pill-dim' : ''}`;

      // Name text
      const nameSpan = document.createElement('span');
      setText(nameSpan, item.name);
      pill.appendChild(nameSpan);

      // Location sub-label for memory/contextFiles
      if (item.location != null && item.location !== '') {
        const locSpan = document.createElement('span');
        locSpan.className = 'pill-loc';
        setText(locSpan, item.location);
        pill.appendChild(locSpan);
      }

      // Title includes path/location and copy hint
      const locationHint = item.location ? ` [${item.location}]` : '';
      const pathHint = item.path ? ` — ${item.path}` : '';
      pill.title = (item.description ? item.description + ' — ' : '') + item.name + locationHint + pathHint + ' — click to copy invocation';

      pill.addEventListener('click', () => handlers.onCopy(invocationFor({ ...item, type: g.type })));
      pills.appendChild(pill);
    }
    section.appendChild(pills);
    panel.appendChild(section);
  }

  if (total === 0) {
    const none = document.createElement('div');
    none.className = 'unused-none';
    setText(none, 'All assets in use');
    panel.appendChild(none);
  }

  return { panel };
}

function projectName(session) {
  if (session?.cwd) {
    const seg = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (seg) return seg;
  }
  if (session?.title) return session.title;
  return '';
}

function buildPbNoticeRow() {
  const row = document.createElement('div');
  row.className = 'event-row event-row-dim';
  const timeEl = document.createElement('span');
  timeEl.className = 'event-time';
  setText(timeEl, '--:--:--');
  row.appendChild(timeEl);
  const chip = document.createElement('span');
  chip.className = 'chip chip-info';
  setText(chip, 'info');
  row.appendChild(chip);
  const labelEl = document.createElement('span');
  labelEl.className = 'event-label';
  setText(labelEl, 'No local agent log for this session (newer Antigravity stores conversations in its cloud backend). Title and workspace only.');
  row.appendChild(labelEl);
  return row;
}

// ── Export menu (Markdown / JSON) ────────────────────
// One shared popup, mirrors the .resume-menu pattern. All labels via textContent.
let _exportMenu = null;

function closeExportMenu() {
  if (_exportMenu) { _exportMenu.remove(); _exportMenu = null; }
}

function openExportMenu(anchorBtn, sessionId, summary, data) {
  // Toggle off if already open
  if (_exportMenu) { closeExportMenu(); return; }

  const titleText = summary
    ? (projectName(summary) || summary.title || sessionId.slice(0, 8))
    : sessionId.slice(0, 8);
  const meta = {
    title: titleText,
    sessionId,
    tool: summary?.tool ?? null,
    model: summary?.status?.model?.displayName ?? null,
    exportedAt: new Date().toISOString(),
  };
  const parts = extractSessionContent(data?.events ?? []);
  const base = sessionId.slice(0, 8);

  const menu = document.createElement('div');
  menu.className = 'resume-menu export-menu';

  const items = [
    { label: 'Markdown', run: () => triggerDownload(`${base}.md`, toMarkdown(meta, parts), 'text/markdown') },
    { label: 'JSON',     run: () => triggerDownload(`${base}.json`, toJson(meta, parts), 'application/json') },
  ];
  for (const it of items) {
    const row = document.createElement('button');
    row.className = 'resume-menu-row';
    setText(row, it.label);
    row.addEventListener('click', (e) => { e.stopPropagation(); it.run(); closeExportMenu(); });
    menu.appendChild(row);
  }

  // Anchor the menu to the button's positioned wrapper.
  anchorBtn.parentElement.appendChild(menu);
  _exportMenu = menu;

  // Outside-click closes (deferred so this click doesn't immediately dismiss).
  setTimeout(() => {
    const onAway = (e) => {
      if (_exportMenu && !_exportMenu.contains(e.target) && e.target !== anchorBtn) {
        closeExportMenu();
        document.removeEventListener('click', onAway, true);
      }
    };
    document.addEventListener('click', onAway, true);
  }, 0);
}

export async function renderDetail(sessionId, container, handlers, summary, opts) {
  // opts can be an object {embedded: bool} or undefined
  const embedded = (opts && typeof opts === 'object') ? !!opts.embedded : false;

  // Set parent model context for agent chip fallback
  const _rawModelStr = summary?.status?.model?.displayName ?? summary?.status?.model?.id ?? null;
  _parentModelRaw = _rawModelStr;
  _parentModel = modelTier(_rawModelStr);

  container.innerHTML = '';
  // Close any open diff popup from a previous session render
  hideDiffPopup();

  // ── Session banner (connects rail selection → title/model + guiding context) ──
  const banner = document.createElement('div');
  banner.className = 'session-banner';
  if (summary?.tool) {
    const accentHex = toolAccentHex(summary.tool);
    banner.style.borderLeftColor = accentHex;
    // Faint tool-color wash on the banner's leading edge — echoes the selected rail card accent.
    // Uses computed hex strings only (XSS-safe: no user data involved).
    const washColor = hexToRgba(accentHex, 0.10);
    banner.style.background = 'linear-gradient(90deg, ' + washColor + ', var(--card) 120px)';
  }

  const bannerTop = document.createElement('div');
  bannerTop.className = 'banner-top';

  if (!embedded) {
    const backBtn = document.createElement('button');
    backBtn.className = 'detail-back';
    setText(backBtn, '← grid');
    backBtn.addEventListener('click', () => handlers.onBack());
    bannerTop.appendChild(backBtn);
  }

  if (summary?.tool) {
    const icon = makeToolIcon(summary.tool);
    icon.className = 'tool-icon detail-tool-icon';
    icon.title = summary.tool;
    bannerTop.appendChild(icon);
  }

  if (summary?.state) {
    const dot = document.createElement('span');
    dot.className = `status-dot ${summary.state}`;
    dot.title = summary.state;
    bannerTop.appendChild(dot);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'detail-title';
  const titleText = summary ? (summary.title || projectName(summary) || sessionId.slice(0, 8)) : sessionId.slice(0, 8);
  setText(titleEl, titleText);
  bannerTop.appendChild(titleEl);

  if (summary?.status) {
    const statsEl = document.createElement('span');
    statsEl.className = 'detail-stats';

    const model = summary.status.model?.displayName;
    const ctxPct = summary.status.context?.usedPercent;
    const cost = summary.status.cost?.totalUsd;

    if (model) {
      const m = document.createElement('span');
      m.className = 'detail-stat-model';
      setText(m, model);
      statsEl.appendChild(m);
    }
    if (ctxPct != null) {
      const c = document.createElement('span');
      c.className = 'detail-stat-ctx';
      setText(c, `ctx ${Math.round(ctxPct)}%`);
      statsEl.appendChild(c);
    }
    if (cost != null) {
      const d = document.createElement('span');
      d.className = 'detail-stat-cost';
      setText(d, `$${Number(cost).toFixed(2)}`);
      statsEl.appendChild(d);
    }
    bannerTop.appendChild(statsEl);
  }

  banner.appendChild(bannerTop);
  container.appendChild(banner);

  // ── Fetch session data ──────────────────────────
  let data = { events: [], contextNow: [], usage: {} };
  try {
    data = await getState(sessionId);
  } catch {
    const err = document.createElement('div');
    setText(err, 'Failed to load session data.');
    container.appendChild(err);
    return () => {};
  }

  // Capability-gap callout — surfaced before guiding so a miss is the first thing seen.
  if (Array.isArray(data.gaps) && data.gaps.length) {
    banner.appendChild(buildGapCallout(data.gaps));
  }

  // Export control — added once session `data` is loaded (full-page detail only).
  // Wrapped in a positioned container so the dropdown anchors correctly.
  if (!embedded) {
    const exportWrap = document.createElement('span');
    exportWrap.className = 'detail-export-wrap';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'detail-export';
    setText(exportBtn, 'Export ▾');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openExportMenu(exportBtn, sessionId, summary, data);
    });
    exportWrap.appendChild(exportBtn);
    bannerTop.appendChild(exportWrap);
  }

  // Guiding context (files + skills) becomes the banner's second row — no label.
  const guidingRow = buildGuidingBar(data.guiding ?? [], data.events, handlers, data.skillsUsed ?? []);
  banner.appendChild(guidingRow);

  // ── Two-column layout ──────────────────────────
  const cols = document.createElement('div');
  cols.className = 'detail-cols';

  const { panel: contextPanel, listEl: contextList, feedList } = buildContextPanel(data.events, handlers);
  // pb-only / remote notice: no events, antigravity session
  if (summary?.tool === 'antigravity' &&
      (summary?.format === 'remote' || (data.events.length === 0 && (data.contextNow ?? []).length === 0))) {
    contextList.appendChild(buildPbNoticeRow());
  }
  cols.appendChild(contextPanel);

  const { panel: unusedPanel } = buildUnusedPanel(data.usage, handlers);
  cols.appendChild(unusedPanel);

  container.appendChild(cols);

  // ── Outside-click and Esc handler for diff popup ──
  function onDocClick(e) {
    if (!_diffPopup || _diffPopup.style.display === 'none') return;
    // Close if the click is outside the popup and not on a toggle button
    if (!_diffPopup.contains(e.target) && !e.target.classList.contains('diff-toggle')) {
      hideDiffPopup();
    }
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') hideDiffPopup();
  }

  function onListScroll() {
    hideDiffPopup();
  }

  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown);
  // Close popup on scroll of the context event list
  const eventListEl = contextPanel.querySelector('.event-list');
  if (eventListEl) eventListEl.addEventListener('scroll', onListScroll);

  // ── Live event listener ─────────────────────────
  function onMcEvents(e) {
    if (e.detail?.sessionId !== sessionId) return;
    const newEvents = e.detail?.events ?? [];
    if (!newEvents.length) return;

    const contextNew = newEvents.filter(ev => ev.lane === 'context');

    // Prepend to context panel (newest-first = prepend)
    for (const ev of [...contextNew].reverse()) {
      contextList.prepend(makeEventRow(ev, handlers, false));
    }

    // Prepend all to feed
    for (const ev of [...newEvents].reverse()) {
      feedList.prepend(makeEventRow(ev, handlers, false));
    }

    // Update feed summary count (use feedList's own children only)
    const feedSummaryEl = container.querySelector('.feed-details summary');
    if (feedSummaryEl) {
      const total = feedList.querySelectorAll('.event-row').length;
      setText(feedSummaryEl, `Full feed (${total} events)`);
    }
  }

  window.addEventListener('mc-events', onMcEvents);

  // Return cleanup — removes all listeners and closes popup
  return function cleanup() {
    window.removeEventListener('mc-events', onMcEvents);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKeydown);
    if (eventListEl) eventListEl.removeEventListener('scroll', onListScroll);
    hideDiffPopup();
    closeExportMenu();
  };
}
