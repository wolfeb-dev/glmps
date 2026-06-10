// web/history.js
import { getState, search, resume } from './api.js';
import { toolColorClass, badgeText } from './grid.js';

function setText(el, s) { el.textContent = String(s ?? ''); }

function relTime(ts) {
  if (ts == null) return '';
  if (!Number.isFinite(ts)) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  let diff = Date.now() - ms;
  diff = Math.max(0, diff);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function cwdLastSeg(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? cwd;
}

function applyFilters(history, sessions, filters) {
  const { project, tool, dateRange, skillQ } = filters;
  const now = Date.now();

  return history.filter(h => {
    // project filter
    if (project !== 'all') {
      if (cwdLastSeg(h.cwd) !== project) return false;
    }
    // tool filter
    if (tool !== 'all') {
      if (h.tool !== tool) return false;
    }
    // date filter — live sessions skip date filter (they're pinned)
    const isLive = sessions.some(s => s.id === h.id && s.live);
    if (!isLive && dateRange !== 'all') {
      const days = dateRange === '7' ? 7 : 30;
      const cutoff = now - days * 86400 * 1000;
      const ts = h.lastTs < 1e12 ? h.lastTs * 1000 : h.lastTs;
      if (ts < cutoff) return false;
    }
    // skill text filter
    if (skillQ) {
      const q = skillQ.toLowerCase();
      const match = (h.skillsUsed ?? []).some(sk => sk.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });
}

function buildFilters(history, filtersState, toolDisplayNames = {}) {
  const bar = document.createElement('div');
  bar.className = 'hist-filters';

  // Project select
  const projectSel = document.createElement('select');
  projectSel.className = 'hist-select';
  const allProj = document.createElement('option');
  allProj.value = 'all';
  setText(allProj, 'All projects');
  projectSel.appendChild(allProj);
  const projects = [...new Set(history.map(h => cwdLastSeg(h.cwd)).filter(Boolean))].sort();
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p;
    setText(opt, p);
    projectSel.appendChild(opt);
  }
  projectSel.value = filtersState.project;

  // Tool select
  const toolSel = document.createElement('select');
  toolSel.className = 'hist-select';
  const allToolsOpt = document.createElement('option');
  allToolsOpt.value = 'all';
  setText(allToolsOpt, 'All tools');
  toolSel.appendChild(allToolsOpt);
  // Dynamically build from distinct tools in history
  const distinctTools = [...new Set(history.map(h => h.tool).filter(Boolean))].sort();
  for (const toolId of distinctTools) {
    const opt = document.createElement('option');
    opt.value = toolId;
    setText(opt, toolDisplayNames[toolId] ?? toolId);
    toolSel.appendChild(opt);
  }
  toolSel.value = filtersState.tool;

  // Date select
  const dateSel = document.createElement('select');
  dateSel.className = 'hist-select';
  for (const [val, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']]) {
    const opt = document.createElement('option');
    opt.value = val;
    setText(opt, label);
    dateSel.appendChild(opt);
  }
  dateSel.value = filtersState.dateRange;

  // Skill input
  const skillInput = document.createElement('input');
  skillInput.type = 'text';
  skillInput.className = 'hist-input';
  skillInput.placeholder = 'Filter by skill…';
  skillInput.value = filtersState.skillQ;

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'hist-input hist-search';
  searchInput.placeholder = 'Full-text search…';

  bar.appendChild(projectSel);
  bar.appendChild(toolSel);
  bar.appendChild(dateSel);
  bar.appendChild(skillInput);
  bar.appendChild(searchInput);

  return { bar, projectSel, toolSel, dateSel, skillInput, searchInput };
}

function buildSkillChips(skillsUsed) {
  const wrap = document.createElement('div');
  wrap.className = 'skill-chips';
  const skills = skillsUsed ?? [];
  const shown = skills.slice(0, 3);
  for (const sk of shown) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-skill';
    setText(chip, sk.split(':').pop() ?? sk);
    wrap.appendChild(chip);
  }
  if (skills.length > 3) {
    const more = document.createElement('span');
    more.className = 'chip chip-more';
    setText(more, `+${skills.length - 3}`);
    more.title = skills.slice(3).join(', ');
    wrap.appendChild(more);
  }
  if (skills.length > 0) {
    wrap.title = skills.join(', ');
  }
  return wrap;
}

function buildResumeMenu(entry, handlers, menuCleanups) {
  // Container for button + popup
  const wrap = document.createElement('div');
  wrap.className = 'resume-wrap';
  wrap.style.position = 'relative';

  const btn = document.createElement('button');
  btn.className = 'hist-action-btn';
  setText(btn, 'Resume ▾');

  let menuEl = null;

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }

    menuEl = document.createElement('div');
    menuEl.className = 'resume-menu';

    const items = [
      ['In Antigravity terminal', () => doResume('panel')],
      ['As editor tab', () => doResume('editor')],
      ['Copy command', () => {
        handlers.onCopy(`claude --resume ${entry.id}`);
        closeMenu();
      }],
    ];

    for (const [label, action] of items) {
      const row = document.createElement('div');
      row.className = 'resume-menu-row';
      setText(row, label);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        action();
      });
      menuEl.appendChild(row);
    }

    wrap.appendChild(menuEl);
  }

  async function doResume(location) {
    closeMenu();
    try {
      await resume(entry.id, entry.cwd, location);
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Resume queued — Antigravity will open it' }));
    } catch {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Resume failed' }));
    }
  }

  btn.addEventListener('click', openMenu);
  wrap.appendChild(btn);

  // Track for cleanup
  menuCleanups.push(closeMenu);

  return { wrap, closeMenu };
}

function buildTableRow(entry, sessions, handlers, menuCleanups) {
  const row = document.createElement('div');
  row.className = 'hist-row';

  const isLive = sessions.some(s => s.id === entry.id && s.live);
  if (isLive) row.classList.add('hist-row-live');

  // Title
  const titleEl = document.createElement('div');
  titleEl.className = 'hist-col hist-col-title';
  setText(titleEl, entry.title ?? entry.id.slice(0, 8));

  // Project
  const projectEl = document.createElement('div');
  projectEl.className = 'hist-col';
  const seg = cwdLastSeg(entry.cwd);
  setText(projectEl, seg);
  if (entry.cwd) projectEl.title = entry.cwd;

  // Tool badge
  const toolEl = document.createElement('div');
  toolEl.className = 'hist-col';
  const badge = document.createElement('span');
  const badgeColor = toolColorClass(entry.tool);
  badge.className = 'tool-badge' + (badgeColor !== 'muted' ? ' tool-badge-' + badgeColor : '');
  setText(badge, badgeText(entry.tool));
  toolEl.appendChild(badge);

  // Last activity
  const timeEl = document.createElement('div');
  timeEl.className = 'hist-col hist-col-time';
  if (isLive) {
    const dot = document.createElement('span');
    dot.className = 'status-dot working';
    dot.title = 'live';
    timeEl.appendChild(dot);
    const liveLabel = document.createElement('span');
    setText(liveLabel, ' live');
    timeEl.appendChild(liveLabel);
  } else {
    setText(timeEl, relTime(entry.lastTs));
  }

  // Skills
  const skillsEl = document.createElement('div');
  skillsEl.className = 'hist-col hist-col-skills';
  skillsEl.appendChild(buildSkillChips(entry.skillsUsed));

  // Actions
  const actionsEl = document.createElement('div');
  actionsEl.className = 'hist-col hist-col-actions';

  const openBtn = document.createElement('button');
  openBtn.className = 'hist-action-btn';
  setText(openBtn, 'Open');
  openBtn.addEventListener('click', () => handlers.onOpenSession(entry.id));
  actionsEl.appendChild(openBtn);

  if (entry.tool === 'claude-code') {
    const { wrap } = buildResumeMenu(entry, handlers, menuCleanups);
    actionsEl.appendChild(wrap);
  } else if (entry.tool === 'antigravity') {
    const wsBtn = document.createElement('button');
    wsBtn.className = 'hist-action-btn';
    setText(wsBtn, 'Open workspace');
    wsBtn.addEventListener('click', async () => {
      try {
        await resume(entry.id, entry.cwd, 'workspace');
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Opening workspace in Antigravity (conversation resume not supported)' }));
      } catch {
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Resume failed' }));
      }
    });
    actionsEl.appendChild(wsBtn);
  }

  row.appendChild(titleEl);
  row.appendChild(projectEl);
  row.appendChild(toolEl);
  row.appendChild(timeEl);
  row.appendChild(skillsEl);
  row.appendChild(actionsEl);

  return row;
}

function buildTableHeader() {
  const row = document.createElement('div');
  row.className = 'hist-row hist-header';
  for (const label of ['Title', 'Project', 'Tool', 'Last activity', 'Skills', 'Actions']) {
    const cell = document.createElement('div');
    cell.className = 'hist-col hist-col-hd';
    setText(cell, label);
    row.appendChild(cell);
  }
  return row;
}

function buildTable(filtered, sessions, handlers, menuCleanups) {
  const wrap = document.createElement('div');
  wrap.className = 'hist-table';

  wrap.appendChild(buildTableHeader());

  const live = filtered.filter(h => sessions.some(s => s.id === h.id && s.live));
  const ended = filtered.filter(h => !sessions.some(s => s.id === h.id && s.live));

  if (live.length > 0) {
    const liveLabel = document.createElement('div');
    liveLabel.className = 'hist-group-label hist-group-live';
    setText(liveLabel, 'Live');
    wrap.appendChild(liveLabel);
    for (const entry of live) {
      wrap.appendChild(buildTableRow(entry, sessions, handlers, menuCleanups));
    }
  }

  if (ended.length > 0) {
    if (live.length > 0) {
      const endedLabel = document.createElement('div');
      endedLabel.className = 'hist-group-label';
      setText(endedLabel, 'Ended');
      wrap.appendChild(endedLabel);
    }
    for (const entry of ended) {
      wrap.appendChild(buildTableRow(entry, sessions, handlers, menuCleanups));
    }
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    setText(empty, 'No sessions match the current filters.');
    wrap.appendChild(empty);
  }

  return wrap;
}

function buildSearchResults(searchRes, history, filters, handlers) {
  const section = document.createElement('div');
  section.className = 'search-results';

  if (!searchRes) return section;

  const { results, capped } = searchRes;

  if (capped) {
    const banner = document.createElement('div');
    banner.className = 'capped-banner';
    setText(banner, 'Results capped — narrow your filters');
    section.appendChild(banner);
  }

  // Group by sessionId
  const bySession = new Map();
  for (const r of results) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }

  // Client-side filter by project/tool
  let shown = 0;
  for (const [sessionId, snippets] of bySession) {
    const entry = history.find(h => h.id === sessionId);

    // Apply project/tool filters only when entry exists
    if (entry) {
      if (filters.project !== 'all' && cwdLastSeg(entry.cwd) !== filters.project) continue;
      if (filters.tool !== 'all' && entry.tool !== filters.tool) continue;
    }

    shown++;

    const group = document.createElement('div');
    group.className = 'search-result-group';

    const header = document.createElement('div');
    header.className = 'search-result-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'search-result-title';
    const title = entry ? (entry.title ?? entry.id.slice(0, 8)) : `${sessionId.slice(0, 8)} (no metadata)`;
    setText(titleEl, title);

    const projEl = document.createElement('span');
    projEl.className = 'search-result-proj';
    setText(projEl, entry ? (cwdLastSeg(entry.cwd) || '') : '');

    const openBtn = document.createElement('button');
    openBtn.className = 'hist-action-btn';
    setText(openBtn, 'Open');
    openBtn.addEventListener('click', () => handlers.onOpenSession(sessionId));

    header.appendChild(titleEl);
    header.appendChild(projEl);
    header.appendChild(openBtn);
    group.appendChild(header);

    for (const r of snippets) {
      const snip = document.createElement('div');
      snip.className = 'search-snippet';
      setText(snip, `L${r.lineNo}: ${r.snippet}`);
      group.appendChild(snip);
    }

    section.appendChild(group);
  }

  if (results.length > 0 && shown === 0) {
    const noMatch = document.createElement('div');
    noMatch.className = 'search-no-match';
    setText(noMatch, 'No search results match current project/tool filters.');
    section.appendChild(noMatch);
  }

  return section;
}

export async function renderHistory(container, handlers, initialFilters = {}) {
  container.innerHTML = '';

  const windowCleanups = [];

  // State
  let state = null;
  let searchRes = null;
  let filtersState = {
    project: initialFilters.project ?? 'all',
    tool: initialFilters.tool ?? 'all',
    dateRange: initialFilters.dateRange ?? '7',
    skillQ: initialFilters.skillQ ?? '',
  };

  // Try to load initial state
  try { state = await getState(); } catch { state = { sessions: [], history: [] }; }

  const history = state.history ?? [];
  const sessions = state.sessions ?? [];

  // Build a displayName map from state.tools (populated if server provides tools array)
  const toolDisplayNames = {};
  for (const t of (state.tools ?? [])) {
    if (t.id) toolDisplayNames[t.id] = t.displayName ?? t.id;
  }

  // ── Filter bar ─────────────────────────────────
  const { bar, projectSel, toolSel, dateSel, skillInput, searchInput } =
    buildFilters(history, filtersState, toolDisplayNames);

  if (initialFilters.tool) toolSel.value = initialFilters.tool;
  container.appendChild(bar);

  // ── Search results placeholder ─────────────────
  let searchSection = document.createElement('div');
  searchSection.className = 'search-results';
  container.appendChild(searchSection);

  // ── Table container ────────────────────────────
  const tableWrap = document.createElement('div');
  tableWrap.className = 'hist-table-wrap';
  container.appendChild(tableWrap);

  // Menu cleanup refs (resume popups)
  const menuCleanups = [];

  function renderTable() {
    // Close any open resume menus before replacing DOM
    for (const fn of menuCleanups) fn();
    menuCleanups.length = 0;

    const filtered = applyFilters(history, sessions, filtersState);
    tableWrap.innerHTML = '';
    tableWrap.appendChild(buildTable(filtered, sessions, handlers, menuCleanups));
  }

  function renderSearchResults() {
    const newSection = buildSearchResults(searchRes, history, filtersState, handlers);
    container.replaceChild(newSection, searchSection);
    searchSection = newSection;
  }

  renderTable();

  // ── Filter change handlers ─────────────────────
  projectSel.addEventListener('change', () => {
    filtersState.project = projectSel.value;
    renderTable();
    renderSearchResults();
  });

  toolSel.addEventListener('change', () => {
    filtersState.tool = toolSel.value;
    renderTable();
    renderSearchResults();
  });

  dateSel.addEventListener('change', () => {
    filtersState.dateRange = dateSel.value;
    renderTable();
  });

  skillInput.addEventListener('input', () => {
    filtersState.skillQ = skillInput.value;
    renderTable();
  });

  // ── Full-text search ────────────────────────────
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = searchInput.value.trim();
    if (!q) {
      searchRes = null;
      renderSearchResults();
      return;
    }
    try {
      searchRes = await search(q);
    } catch {
      searchRes = null;
    }
    renderSearchResults();
  });

  // ── Outside-click / Esc to close resume menus ──
  function onDocClick() {
    for (const fn of menuCleanups) fn();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      for (const fn of menuCleanups) fn();
    }
  }

  window.addEventListener('click', onDocClick);
  window.addEventListener('keydown', onDocKeydown);
  windowCleanups.push(
    () => window.removeEventListener('click', onDocClick),
    () => window.removeEventListener('keydown', onDocKeydown),
  );

  // Return cleanup
  return function cleanup() {
    for (const fn of windowCleanups) fn();
    for (const fn of menuCleanups) fn();
    menuCleanups.length = 0;
  };
}

