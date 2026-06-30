// web/board.js — /backlog Kanban board (Tasks 5, 6, 7)
// XSS discipline: textContent/createElement only; innerHTML only to clear.
import {
  getBacklog, addBacklogItem, updateBacklogItem, setBacklogPaused,
  reorderBacklog, getProjects, getRunner, setRunnerConfig, approveBacklogItem,
} from './api.js';
import {
  orderedColumns, filterItems, groupByLane, groupByColumn, joinRunner,
} from './board-model.js';
import { enableColumnDnd } from './board-dnd.js';
import { openCardDrawer } from './board-drawer.js';
import { fillProjectNav } from './agents.js';

// ── Column labels ────────────────────────────────────────────────────────────
const COLUMN_LABELS = {
  held:        'Backlog',
  queued:      'Queued',
  in_progress: 'In Progress',
  in_review:   'In Review',
  done:        'Done',
  cancelled:   'Archived',
};

// ── WIP limits (localStorage) ────────────────────────────────────────────────
const WIP_KEY = 'glmps.board.wip';
function wipLimits() { try { return JSON.parse(localStorage.getItem(WIP_KEY)) || {}; } catch { return {}; } }
function setWip(col, n) {
  const w = wipLimits();
  if (n) w[col] = n; else delete w[col];
  localStorage.setItem(WIP_KEY, JSON.stringify(w));
}

// ── Board-level state ─────────────────────────────────────────────────────────
const state = { project: 'all', query: '', groupBy: null, showArchived: false, minPriority: null };

// ── Module refs ───────────────────────────────────────────────────────────────
let host = null;
let lastDragEndTs = 0;  // timestamp of last drag-drop settle; used to suppress the post-drag click
let kanbanRail = null;      // the <aside class="kanban-rail"> in the two-column layout
let projectSelect = null;   // the toolbar <select> for project, kept in sync with nav

// ── Priority pill ─────────────────────────────────────────────────────────────
const PRIORITY_LABELS = { 0: 'low', 1: 'normal', 2: 'high', 3: 'urgent' };
const PRIORITY_CLASSES = { 0: 'pill-low', 1: 'pill-normal', 2: 'pill-high', 3: 'pill-urgent' };

function priorityPill(priority) {
  if (priority == null) return null;
  const n = Number(priority);
  const pill = document.createElement('span');
  pill.className = `board-priority-pill ${PRIORITY_CLASSES[n] ?? ''}`;
  pill.textContent = PRIORITY_LABELS[n] ?? String(priority);
  return pill;
}

// ── Card builder ──────────────────────────────────────────────────────────────
function card(it) {
  const el = document.createElement('div');
  el.className = 'backlog-card' + (it.live ? ' live' : '') + (it.quarantined ? ' quarantined' : '');
  el.dataset.id = it.id;

  // Title row (with optional priority pill)
  const titleRow = document.createElement('div');
  titleRow.className = 'backlog-card-title-row';

  const title = document.createElement('div');
  title.className = 'backlog-card-title';
  title.textContent = it.title;
  titleRow.appendChild(title);

  const pill = priorityPill(it.priority);
  if (pill) titleRow.appendChild(pill);

  // Poison-quarantine flag: the ticket was held by the intake poison-scanner.
  if (it.quarantined) {
    const flag = document.createElement('span');
    flag.className = 'backlog-card-flag';
    flag.textContent = 'quarantined';
    const flags = it.provenance && Array.isArray(it.provenance.flags) ? it.provenance.flags : [];
    const reason = flags.length ? `Poison-scanner flagged: ${flags.join(', ')}. Review before approving.`
                               : 'Held by the poison-scanner. Review before approving.';
    flag.title = reason;
    flag.setAttribute('aria-label', reason);
    titleRow.appendChild(flag);
  }
  el.appendChild(titleRow);

  // Meta
  const meta = document.createElement('div');
  meta.className = 'backlog-card-meta';
  const bits = [it.project];
  if (it.agent) bits.push(it.agent);
  if (it.sessionState) bits.push(it.sessionState);
  meta.textContent = bits.join(' · ');
  el.appendChild(meta);

  // Quick-action triage buttons (state-dependent)
  if (it.state === 'queued' || it.state === 'held') {
    const actions = document.createElement('div');
    actions.className = 'backlog-card-actions';

    if (it.state === 'queued') {
      const hold = document.createElement('button');
      hold.className = 'backlog-card-action hold';
      hold.textContent = 'Hold';
      hold.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await updateBacklogItem(it.id, { state: 'held' }); }
        catch { emit('Failed to hold item'); }
        await refreshBacklog();
      });
      actions.appendChild(hold);
    }

    if (it.state === 'held') {
      const queue = document.createElement('button');
      queue.className = 'backlog-card-action queue';
      queue.textContent = 'Queue';
      queue.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await updateBacklogItem(it.id, { state: 'queued' }); }
        catch { emit('Failed to queue item'); }
        await refreshBacklog();
      });
      actions.appendChild(queue);
    }

    // Approve releases a poison-quarantined ticket (operator-only gate).
    if (it.quarantined) {
      const approve = document.createElement('button');
      approve.className = 'backlog-card-action approve';
      approve.textContent = 'Approve';
      approve.title = 'Release this quarantined ticket so the runner can launch it';
      approve.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await approveBacklogItem(it.id); }
        catch { emit('Failed to approve item'); }
        await refreshBacklog();
      });
      actions.appendChild(approve);
    }

    el.appendChild(actions);
  }

  // Click-to-open drawer (guard: skip if a drag settled within the last 250ms)
  el.addEventListener('click', () => {
    if (Date.now() - lastDragEndTs < 250) return;
    openCardDrawer(it, { onChange: refreshBacklog });
  });

  return el;
}

// ── Column renderer (shared by grouped and ungrouped) ─────────────────────────
function renderColumns(board, filtered, dndGroup) {
  const cols = orderedColumns(state.showArchived);
  const byCol = groupByColumn(filtered);
  const wip = wipLimits();

  for (const col of cols) {
    const colItems = byCol[col] ?? [];

    const colEl = document.createElement('div');
    colEl.className = 'backlog-col';
    colEl.dataset.col = col;

    // Column header
    const h = document.createElement('div');
    h.className = 'backlog-col-head';

    const headLabel = document.createElement('span');
    headLabel.className = 'col-head-label';
    headLabel.textContent = COLUMN_LABELS[col] ?? col;
    h.appendChild(headLabel);

    // WIP badge
    const limit = wip[col] ? Number(wip[col]) : null;
    const wipBadge = document.createElement('button');
    wipBadge.className = 'col-wip-badge' + (limit && colItems.length > limit ? ' over' : '');
    wipBadge.title = limit ? `WIP limit: ${limit}. Click to change.` : 'Click to set WIP limit';

    if (limit) {
      wipBadge.textContent = `${colItems.length}/${limit}`;
    } else {
      wipBadge.textContent = String(colItems.length);
    }

    wipBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = limit ? String(limit) : '';
      const raw = window.prompt(`WIP limit for "${COLUMN_LABELS[col] ?? col}" (blank to clear):`, current);
      if (raw === null) return; // cancelled
      const n = raw.trim() === '' ? 0 : parseInt(raw, 10);
      setWip(col, Number.isFinite(n) && n > 0 ? n : 0);
      refreshBacklog();
    });

    h.appendChild(wipBadge);
    colEl.appendChild(h);

    // Cards container
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'backlog-col-cards';

    if (colItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'backlog-col-empty';
      empty.textContent = 'empty';
      cardsWrap.appendChild(empty);
    } else {
      for (const it of colItems) cardsWrap.appendChild(card(it));
    }

    colEl.appendChild(cardsWrap);
    board.appendChild(colEl);

    // Wire drag-and-drop
    enableColumnDnd(cardsWrap, dndGroup, async (colEl2) => {
      const ids = [...colEl2.querySelectorAll('.backlog-card')].map(c => c.dataset.id);
      const status = colEl2.closest('.backlog-col').dataset.col;
      lastDragEndTs = Date.now();
      try { await reorderBacklog({ status, ids }); }
      catch { emit('Reorder failed'); }
      await refreshBacklog();
    });
  }
}

// ── refreshBacklog — rebuilds only columns/lanes, NOT the toolbar ─────────────
export async function refreshBacklog() {
  if (!host) return;
  const board = host.querySelector('#backlog-columns');
  if (!board) return;

  let items = [];
  try { items = (await getBacklog()).items ?? []; } catch {}

  // Enrich from the runner ledger: cards with a launched session show as live,
  // with their editor target as the agent label. Fail soft if the runner is down.
  let runner = null;
  try { runner = await getRunner(); } catch {}
  items = joinRunner(items, runner);

  const filtered = filterItems(items, {
    project: state.project,
    query: state.query,
    minPriority: state.minPriority,
    showCancelled: state.showArchived,
  });

  board.innerHTML = '';

  if (state.groupBy) {
    // Swimlane mode: one band per lane
    const lanes = groupByLane(filtered, state.groupBy);
    for (const { lane, label, items: laneItems } of lanes) {
      const band = document.createElement('div');
      band.className = 'backlog-swimlane';

      const laneHeader = document.createElement('div');
      laneHeader.className = 'swimlane-header';

      const laneLabel = document.createElement('span');
      laneLabel.className = 'swimlane-label';
      laneLabel.textContent = label || lane;

      const laneCount = document.createElement('span');
      laneCount.className = 'swimlane-count';
      laneCount.textContent = String(laneItems.length);

      laneHeader.appendChild(laneLabel);
      laneHeader.appendChild(laneCount);
      band.appendChild(laneHeader);

      const laneColumns = document.createElement('div');
      laneColumns.className = 'backlog-columns';
      renderColumns(laneColumns, laneItems, `backlog-${lane}`);
      band.appendChild(laneColumns);

      board.appendChild(band);
    }
  } else {
    // Flat mode: single set of columns
    const colsRow = document.createElement('div');
    colsRow.className = 'backlog-columns';
    renderColumns(colsRow, filtered, 'backlog');
    board.appendChild(colsRow);
  }
}

// ── Project nav helpers ───────────────────────────────────────────────────────
function mountNav() {
  if (!kanbanRail) return;
  fillProjectNav(kanbanRail, {
    onSelectProject: (key) => setBoardProject(key),
    selectedProject: state.project,
  }).catch(() => {});
}

// Swap the active highlight on the existing nav rows in place. Re-rendering the
// whole rail on every click (the old behavior) flickered on rapid clicks.
function highlightNavRow(key) {
  if (!kanbanRail) return;
  const want = key == null ? 'all' : key;
  for (const row of kanbanRail.querySelectorAll('.dash-nav-selectable')) {
    row.classList.toggle('is-focused', row.dataset.projKey === want);
  }
}

function setBoardProject(key) {
  state.project = key; // 'all' or a project key
  if (projectSelect) projectSelect.value = key;
  refreshBacklog();
  highlightNavRow(key); // move the highlight in place instead of re-rendering the rail
}

// ── renderBacklog — builds toolbar + columns container once ───────────────────
export async function renderBacklog(container, _handlers) {
  host = container;
  container.innerHTML = '';

  // ── Two-column shell: rail (left) + main (right) ───────
  const rail = document.createElement('aside');
  rail.className = 'dash-roster-rail kanban-rail';
  rail.setAttribute('aria-label', 'Projects');
  kanbanRail = rail;
  container.appendChild(rail);

  const main = document.createElement('div');
  main.className = 'kanban-main';
  container.appendChild(main);

  // ── Rapidfire bar ──────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'backlog-bar';

  const input = document.createElement('input');
  input.className = 'backlog-input';
  input.placeholder = 'Rapidfire an idea — Enter to queue (paste multiple lines for many)';
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const lines = input.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    input.value = '';
    const proj = state.project === 'all' ? 'default' : state.project;
    for (const title of lines) {
      try { await addBacklogItem({ project: proj, title }); }
      catch { emit('Failed to add item'); }
    }
    await refreshBacklog();
  });

  const pause = document.createElement('button');
  pause.className = 'backlog-pause';
  pause.textContent = 'Pause queue';
  pause.addEventListener('click', async () => {
    const paused = pause.classList.toggle('on');
    pause.textContent = paused ? 'Resume queue' : 'Pause queue';
    try { await setBacklogPaused(paused); }
    catch { emit('Failed to set pause state'); }
  });

  // ── Queue runner: arm auto-launch + pick where sessions open ──
  // The board only tracks cards; the runner is what actually launches the top
  // queued card as a live editor session. Off by default so nothing starts
  // unexpectedly.
  const RUNNER_LABELS = {
    'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
    'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'Native terminal',
  };
  const runner = document.createElement('button');
  runner.className = 'backlog-runner';
  runner.title = 'When on, the top queued card launches automatically as a live session in your chosen editor.';
  const runnerDot = document.createElement('span');
  runnerDot.className = 'backlog-runner-dot';
  const runnerText = document.createElement('span');
  runnerText.textContent = 'Auto-run off';
  runner.append(runnerDot, runnerText);

  const target = document.createElement('select');
  target.className = 'board-toolbar-select';
  target.setAttribute('aria-label', 'Launch sessions in');
  target.title = 'Where the runner opens each session';

  function paintRunner(on) {
    runner.classList.toggle('on', on);
    runnerText.textContent = on ? 'Auto-run on' : 'Auto-run off';
  }
  runner.addEventListener('click', async () => {
    const on = !runner.classList.contains('on');
    paintRunner(on);
    try { await setRunnerConfig({ enabled: on }); }
    catch { paintRunner(!on); emit('Failed to change the runner'); }
  });
  target.addEventListener('change', async () => {
    try { await setRunnerConfig({ lastTarget: target.value }); }
    catch { emit('Failed to set the launch target'); }
  });
  // Hydrate from the server (targets + current config); fail soft if unavailable.
  getRunner().then((r) => {
    const ids = Array.isArray(r?.targets) ? r.targets : [];
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = RUNNER_LABELS[id] ?? id;
      target.appendChild(opt);
    }
    if (r?.config?.lastTarget && ids.includes(r.config.lastTarget)) target.value = r.config.lastTarget;
    paintRunner(!!r?.config?.enabled);
  }).catch(() => {});

  bar.append(input, runner, target, pause);
  main.appendChild(bar);

  // ── Toolbar ────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'board-toolbar';

  // Project picker
  const projectSel = document.createElement('select');
  projectSel.className = 'board-toolbar-select';
  projectSel.setAttribute('aria-label', 'Project');

  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All projects';
  projectSel.appendChild(allOpt);

  // Populate projects asynchronously; start with what we know
  async function populateProjects() {
    let projKeys = [];
    try {
      const resp = await getProjects();
      projKeys = (resp?.projects ?? []).map(p => p.key).filter(Boolean);
    } catch {}
    // Also pick up any project seen in items
    try {
      const items2 = (await getBacklog()).items ?? [];
      for (const it of items2) {
        if (it.project && !projKeys.includes(it.project)) projKeys.push(it.project);
      }
    } catch {}
    // Remove old dynamic options (keep 'all')
    while (projectSel.options.length > 1) projectSel.remove(1);
    for (const k of projKeys.sort()) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      if (k === state.project) opt.selected = true;
      projectSel.appendChild(opt);
    }
  }
  populateProjects();

  projectSelect = projectSel;
  projectSel.addEventListener('change', () => {
    setBoardProject(projectSel.value);
  });

  // Search
  const searchInput = document.createElement('input');
  searchInput.className = 'board-toolbar-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search cards…';
  searchInput.setAttribute('aria-label', 'Search backlog');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    refreshBacklog();
  });

  // Group by
  const groupSel = document.createElement('select');
  groupSel.className = 'board-toolbar-select';
  groupSel.setAttribute('aria-label', 'Group by');
  for (const [val, lbl] of [['', 'No grouping'], ['project', 'By project'], ['priority', 'By priority']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    groupSel.appendChild(opt);
  }
  groupSel.addEventListener('change', () => {
    state.groupBy = groupSel.value || null;
    refreshBacklog();
  });

  // Show archived checkbox
  const archivedLabel = document.createElement('label');
  archivedLabel.className = 'board-toolbar-checkbox-label';
  const archivedCb = document.createElement('input');
  archivedCb.type = 'checkbox';
  archivedCb.className = 'board-toolbar-checkbox';
  archivedCb.checked = state.showArchived;
  archivedCb.addEventListener('change', () => {
    state.showArchived = archivedCb.checked;
    refreshBacklog();
  });
  const archivedText = document.createTextNode('Show archived');
  archivedLabel.appendChild(archivedCb);
  archivedLabel.appendChild(archivedText);

  toolbar.appendChild(projectSel);
  toolbar.appendChild(searchInput);
  toolbar.appendChild(groupSel);
  toolbar.appendChild(archivedLabel);
  main.appendChild(toolbar);

  // ── Columns/lanes container ────────────────────────────
  const boardWrap = document.createElement('div');
  boardWrap.className = 'backlog-board-wrap';
  boardWrap.id = 'backlog-columns';
  main.appendChild(boardWrap);

  // ── Mount project navigator in rail ───────────────────
  mountNav();

  await refreshBacklog();
  input.focus();

  return function cleanup() {
    host = null;
    kanbanRail = null;
    projectSelect = null;
  };
}

function emit(msg) { window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg })); }
