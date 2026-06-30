// web/app.js
import { getState, onEvents, getLearning, addIdea, learningAction, setLearningConfig, fetchBudget, fetchEngagement } from './api.js';
import { toolColorClass, mostRecentSessionId } from './grid.js';
import { fillRoster } from './agents.js';
import { mountLauncher } from './launcher.js';
import { mountSettings } from './settings.js';

let currentView = 'dashboard';
let openSessionId = null;
let detailMod = null;
let editorMod = null;
let historyMod = null;
let analyticsMod = null;
let learningMod = null;
let dashboardMod = null;
let mapMod = null;
let boardMod = null;
let boardCleanup = null;
let engagementMod = null;
let experimentsMod = null;
let refreshTimer = null;
let lastState = null;
let serverBuildId = null;      // first SSE 'hello' wins; a different one on reconnect => server restarted
let detailCleanup = null;
let historyCleanup = null;
let renderSeq = 0;

// ── AgentOps pillar classification ───────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for which view belongs to which pillar.
// To reassign a view: change its entry here AND move its <button> in index.html.
// To suppress the view-level banner chip for a view: set label to null.
//   • grid: master-detail layout that fills the whole view; still shows chip in banner.
const PILLARS = {
  dashboard:   { label: 'Overview',      suffix: 'overview'      },
  map:         { label: 'Observability', suffix: 'observability' },
  grid:        { label: 'Observability', suffix: 'observability' },
  history:     { label: 'Observability', suffix: 'observability' },
  detail:      { label: 'Observability', suffix: 'observability' }, // full-page session detail
  learning:    { label: 'Evaluation',    suffix: 'evaluation'    },
  experiments: { label: 'Evaluation',    suffix: 'evaluation'    },
  analytics:   { label: 'Observability', suffix: 'observability' }, // usage/budget metrics
  kanban:      { label: 'Orchestration', suffix: 'orchestration' },
  engagement:  { label: 'Governance',    suffix: 'governance'    },
};

// Updates the #pillar-banner chip below the topbar when the active view changes.
// Called from showView(). All content via textContent — never innerHTML with data.
function updatePillarBanner(viewName) {
  const banner = document.getElementById('pillar-banner');
  if (!banner) return;
  banner.textContent = ''; // clear — safe: no data, just resets static chip
  const p = PILLARS[viewName];
  if (!p?.label) return; // analytics + unknown views: no banner chip
  const chip = document.createElement('span');
  chip.className = `pillar-chip pillar-chip-${p.suffix}`;
  chip.textContent = p.label;
  banner.appendChild(chip);
}

// ── Dropdown nav helpers (function declarations hoist — called by showView) ──
function closeAllDropdowns() {
  for (const p of document.querySelectorAll('.nav-pillar.is-open')) {
    p.classList.remove('is-open');
    const t = p.querySelector('.nav-pillar-trigger');
    if (t) t.setAttribute('aria-expanded', 'false');
  }
}

function updateNavActivePillar(viewName) {
  for (const t of document.querySelectorAll('.nav-pillar-trigger')) {
    t.classList.remove('active-pillar');
  }
  const p = PILLARS[viewName];
  if (!p?.suffix) return;
  const pillarEl = document.querySelector(`.nav-pillar-${p.suffix}`);
  pillarEl?.querySelector('.nav-pillar-trigger')?.classList.add('active-pillar');
}

// ── Toast ────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}

// mc-toast CustomEvent from editor.js / detail.js
window.addEventListener('mc-toast', e => toast(e.detail));

// ── View switching ───────────────────────────────
function showView(name) {
  currentView = name;
  closeAllDropdowns();
  for (const sec of document.querySelectorAll('.view')) sec.classList.add('hidden');
  const target = document.getElementById(`view-${name}`);
  if (target) target.classList.remove('hidden');
  for (const btn of document.querySelectorAll('#topbar nav button[data-view]')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  updateNavActivePillar(name);
  updatePillarBanner(name);
}

// ── Embedded detail (inside master-detail) ────────
async function renderEmbeddedDetail(id) {
  detailMod ??= await import('./detail.js').catch(() => null);
  if (!detailMod) { toast('Detail view not built yet'); return; }

  if (detailCleanup) { detailCleanup(); detailCleanup = null; }

  openSessionId = id;

  const container = document.getElementById('detail-main');
  const summary = (lastState?.sessions ?? []).find(s => s.id === id) ?? null;

  const seq = ++renderSeq;
  const cleanup = await detailMod.renderDetail(id, container, {
    onOpenFile,
    onCopy,
    onOpenMap,
    onBack: () => {},   // no-op: back not shown in embedded mode
  }, summary, { embedded: true });

  // If a newer render started while awaiting, clean up immediately and bail
  if (seq !== renderSeq) { cleanup?.(); return; }

  detailCleanup = cleanup;

  // Update rail selection highlight
  fillGridRail(lastState);
}

// ── Full-page detail (from History view) ─────────
// Thin wrapper: routing pushes /session/<id>; enterView() does the render.
async function onOpenSession(id) { await navigate('detail', id); }

// Render the full-page detail view for a session (called by enterView).
async function renderFullDetail(id) {
  if (historyCleanup) { historyCleanup(); historyCleanup = null; }
  if (detailCleanup) { detailCleanup(); detailCleanup = null; }

  openSessionId = id;
  const container = document.getElementById('view-detail');
  const summary = (lastState?.sessions ?? []).find(s => s.id === id) ?? null;

  detailCleanup = await detailMod.renderDetail(id, container, {
    onOpenFile,
    onCopy,
    onOpenMap,
    onBack: () => history.back(),   // browser history drives "back"
  }, summary);
}

async function onOpenFile(path, diff) {
  editorMod ??= await import('./editor.js').catch(() => null);
  if (!editorMod) { toast('Editor not built yet'); return; }
  editorMod.openEditor(path, { onClose: () => {}, diff });
}

function onCopy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copied — paste into the session terminal'),
    () => toast('Clipboard write failed'),
  );
}

// onSelectSession is called from rail entries (updates the URL to /detail/<id>)
async function onSelectSession(id) {
  const path = pathFor('grid', id);
  if (location.pathname !== path) history.pushState({ view: 'grid', sessionId: id }, '', path);
  await renderEmbeddedDetail(id);
}

const handlers = { onOpenSession, onOpenFile, onCopy, onSelectSession };

// Detail (grid) left rail: the dashboard's Live-sessions roster. Clicking a row
// selects that session into the embedded detail; the "Recent" section keeps
// ended sessions reachable.
function fillGridRail(state) {
  const railEl = document.getElementById('rail');
  if (!railEl) return;
  const rosterHandlers = { ...handlers, onOpenJob: id => onSelectSession(id) };
  fillRoster(railEl, state ?? { sessions: [] }, rosterHandlers, {
    onSelect: s => onSelectSession(s.id),
    focusedId: openSessionId,
    includeEnded: true,
  });
}

function onOpenJob(id) { navigate('grid', id); }

// Shared: navigate to the Map view, optionally pre-selecting a session.
function onOpenMap(id) { navigate('map', id); }

// Dashboard handler: clicking a live job opens it in the Detail (grid) view
const dashboardHandlers = {
  onOpenJob,
  onOpenMap,
  onOpenFile,
};

// Map handler: same onOpenJob wired through
const mapHandlers = { onOpenJob, onOpenFile };

// ── Tools strip ──────────────────────────────────
function renderToolsStrip(tools) {
  const strip = document.getElementById('tools-strip');
  if (!strip) return;
  strip.innerHTML = '';
  if (!Array.isArray(tools) || tools.length === 0) { strip.classList.add('hidden'); return; }

  // Only show installed tools (omit not-installed detect-only)
  const visible = tools.filter(t => t.installed);
  if (visible.length === 0) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');

  for (const t of visible) {
    const chip = document.createElement('div');
    // Apply tool signature color class (safe className, not innerHTML)
    const colorCls = toolColorClass(t.id);
    chip.className = 'tool-chip' + (colorCls !== 'muted' ? ` tool-chip-${colorCls}` : '');
    if (t.depth === 'detect-only') {
      chip.className = 'tool-chip noadapter';
    } else if ((t.sessionsFound ?? 0) > 0) {
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', async () => {
        historyMod ??= await import('./history.js').catch(() => null);
        if (!historyMod) return;
        if (historyCleanup) { historyCleanup(); historyCleanup = null; }
        if (location.pathname !== '/history') history.pushState({ view: 'history' }, '', '/history');
        showView('history');
        const container = document.getElementById('view-history');
        historyCleanup = await historyMod.renderHistory(container, handlers, { tool: t.id });
      });
    }

    // Icon — onerror hides the img element
    const img = document.createElement('img');
    img.src = '/api/icon/' + t.id;
    img.alt = '';
    img.width = 14;
    img.height = 14;
    img.className = 'tool-chip-icon';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    chip.appendChild(img);

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'tool-chip-name';
    nameEl.textContent = t.displayName;
    chip.appendChild(nameEl);

    // Badge
    const badgeEl = document.createElement('span');
    badgeEl.className = 'tool-chip-badge';
    if (t.depth === 'detect-only') {
      badgeEl.textContent = 'no adapter yet';
    } else {
      const count = t.sessionsFound ?? 0;
      badgeEl.textContent = count === 1 ? '1 session' : count + ' sessions';
    }
    chip.appendChild(badgeEl);

    // Tooltip with dataDirs
    if (Array.isArray(t.dataDirs) && t.dataDirs.length > 0) {
      chip.title = t.dataDirs.join('\n');
    }

    strip.appendChild(chip);
  }
}

// ── Render ───────────────────────────────────────
function render(state) {
  lastState = state;
  if (currentView === 'grid') {
    // Re-render the rail; do NOT re-render the open detail (it self-updates via mc-events)
    fillGridRail(state);
  }
  if (currentView === 'dashboard' && dashboardMod) {
    dashboardMod.updateDashboard(state, dashboardHandlers);
  }
  if (currentView === 'map' && mapMod) {
    mapMod.updateMap(state);
  }
  renderToolsStrip(state.tools ?? []);
  const stats = document.getElementById('topstats');
  const live = (state.sessions ?? []).filter(s => s.live).length;

  const liveSessions = (state.sessions ?? []).filter(s => s.live);
  let totalCost = 0;
  let maxRateLimit = 0;
  for (const s of liveSessions) {
    totalCost += s.status?.cost?.totalUsd ?? 0;
    const used = s.status?.rateLimits?.five_hour?.used_percentage ?? 0;
    maxRateLimit = Math.max(maxRateLimit, used);
  }

  // Build topstats with colored spans (safe — textContent only on spans)
  stats.textContent = '';
  const liveSpan = document.createElement('span');
  liveSpan.className = 'stat-live';
  liveSpan.textContent = `${live} live`;
  stats.appendChild(liveSpan);
  if (totalCost > 0) {
    const sep1 = document.createElement('span');
    sep1.textContent = ' · ';
    stats.appendChild(sep1);
    const costSpan = document.createElement('span');
    costSpan.className = 'stat-cost';
    costSpan.textContent = `$${totalCost.toFixed(2)}`;
    stats.appendChild(costSpan);
  }
  if (maxRateLimit > 0) {
    const sep2 = document.createElement('span');
    sep2.textContent = ' · ';
    stats.appendChild(sep2);
    const rateSpan = document.createElement('span');
    rateSpan.className = 'stat-rate';
    rateSpan.textContent = `5h ${Math.round(maxRateLimit)}%`;
    stats.appendChild(rateSpan);
  }
}

// ── SSE coalesced refresh ────────────────────────
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try { render(await getState()); } catch {}
    getLearning().then(updateLearningBadge).catch(() => {});
  }, 2000);
}

// ── Learning view ────────────────────────────────
async function renderLearningView() {
  learningMod ??= await import('./learning.js').catch(() => null);
  if (!learningMod) { toast('Learning view not built yet'); return; }
  const container = document.getElementById('view-learning');
  let data;
  try { data = await getLearning(); } catch { toast('Failed to load learning queue'); return; }
  updateLearningBadge(data);
  learningMod.renderLearning(container, data, {
    onIdea:   async (text) => { try { await addIdea(text); } finally { renderLearningView(); } },
    onAction: async (id, action, rule) => { try { await learningAction(id, action, rule); } finally { renderLearningView(); } },
    onToggle: async (v) => { try { await setLearningConfig(v); } finally { renderLearningView(); } },
  });
}

// ── Analytics nav badge — max limiter % from /api/budget ──
function updateAnalyticsBadge(data) {
  const btn = document.querySelector('#topbar nav button[data-view="analytics"]');
  if (!btn) return;

  let badge = btn.querySelector('.usage-nav-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'usage-nav-badge';
    btn.appendChild(badge);
  }

  const usage = data?.usage ?? {};
  const pcts = [
    usage.fiveHour?.usedPercent,
    usage.sevenDay?.usedPercent,
    usage.sevenDaySonnet?.usedPercent,
  ].filter(v => v != null);

  if (pcts.length === 0) {
    badge.style.display = 'none';
    return;
  }

  const max = Math.floor(Math.max(...pcts));
  badge.style.display = '';
  badge.textContent = max + '%';
  const colorClass = max >= 80 ? 'usage-nav-badge-warn' : 'usage-nav-badge-normal';
  badge.className = 'usage-nav-badge ' + colorClass;
}

// ── Learning nav dot — pending items awaiting review ──
function updateLearningBadge(data) {
  const btn = document.querySelector('#topbar nav button[data-view="learning"]');
  if (!btn) return;
  let dot = btn.querySelector('.nav-item-dot');
  const items = Array.isArray(data?.items) ? data.items : [];
  const pending = items.filter(i => i.status === 'pending').length;
  if (pending === 0) {
    if (dot) dot.style.display = 'none';
    updatePillarDots();
    return;
  }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'nav-item-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  }
  dot.style.display = '';
  dot.title = `${pending} learning item${pending === 1 ? '' : 's'} awaiting review`;
  updatePillarDots();
}

// ── Kanban nav dot — backlog items needing attention ──────────────────────
// Counts state='queued' (unstarted) and state='held' (parked/deferred).
async function updateKanbanDot() {
  const btn = document.querySelector('#topbar nav button[data-view="kanban"]');
  if (!btn) return;
  let count = 0;
  try {
    const res = await fetch('/api/backlog');
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      count = items.filter(i => i.state === 'queued' || i.state === 'held').length;
    }
  } catch { /* server unreachable */ }

  let dot = btn.querySelector('.nav-item-dot');
  if (count === 0) {
    if (dot) dot.style.display = 'none';
    updatePillarDots();
    return;
  }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'nav-item-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  }
  dot.style.display = '';
  dot.title = `${count} backlog item${count === 1 ? '' : 's'} queued`;
  updatePillarDots();
}

// ── Pillar-level dot — bubbles up from child view dots ────────────────────
function updatePillarDots() {
  for (const pillarEl of document.querySelectorAll('.nav-pillar')) {
    const trigger = pillarEl.querySelector('.nav-pillar-trigger');
    if (!trigger) continue;
    const activeDots = [...pillarEl.querySelectorAll('.nav-item-dot')]
      .filter(d => d.style.display !== 'none');
    let pillarDot = trigger.querySelector('.nav-pillar-dot');
    if (activeDots.length > 0) {
      if (!pillarDot) {
        pillarDot = document.createElement('span');
        pillarDot.className = 'nav-pillar-dot';
        pillarDot.setAttribute('aria-hidden', 'true');
        trigger.appendChild(pillarDot);
      }
      pillarDot.style.display = '';
      trigger.title = activeDots.map(d => d.title).filter(Boolean).join('; ');
    } else {
      if (pillarDot) pillarDot.style.display = 'none';
      trigger.title = '';
    }
  }
}

// ── Routing (History API, clean URLs) ────────────
const NAV_VIEWS = ['dashboard', 'history', 'analytics', 'learning', 'experiments', 'map', 'grid', 'kanban', 'engagement'];

function pathFor(view, sessionId) {
  switch (view) {
    case 'grid':      return sessionId ? `/detail/${encodeURIComponent(sessionId)}` : '/detail';
    case 'detail':    return sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/detail';
    case 'history':   return '/history';
    case 'analytics': return '/analytics';
    case 'learning':     return '/learning';
    case 'experiments':  return '/experiments';
    case 'map':          return '/map';
    case 'kanban':      return sessionId ? `/kanban/${encodeURIComponent(sessionId)}` : '/kanban';
    case 'engagement':  return '/engagement';
    default:            return '/dashboard';
  }
}

function parseRoute(pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  const head = parts[0] || 'dashboard';
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (head === 'detail')  return { view: 'grid',   sessionId: id };
  if (head === 'session') return { view: 'detail', sessionId: id };
  if (head === 'backlog') return { view: 'kanban', sessionId: id };  // back-compat: /backlog → Kanban
  if (NAV_VIEWS.includes(head)) return { view: head, sessionId: id };
  return { view: 'dashboard', sessionId: null };
}

// Render a view WITHOUT touching history. Shared by nav clicks, popstate, boot.
async function enterView(view, sessionId = null) {
  if (view === 'dashboard') { dashboardMod ??= await import('./agents.js').catch(() => null);    if (!dashboardMod) { toast('Dashboard not built yet'); return; } }
  if (view === 'history')   { historyMod   ??= await import('./history.js').catch(() => null);   if (!historyMod)   { toast('History not built yet'); return; } }
  if (view === 'analytics') { analyticsMod ??= await import('./analytics.js').catch(() => null); if (!analyticsMod) { toast('Analytics not built yet'); return; } }
  if (view === 'learning')  { learningMod  ??= await import('./learning.js').catch(() => null);  if (!learningMod)  { toast('Learning not built yet'); return; } }
  if (view === 'map')       { mapMod       ??= await import('./map.js').catch(() => null);       if (!mapMod)       { toast('Map not built yet'); return; } }
  if (view === 'detail')    { detailMod    ??= await import('./detail.js').catch(() => null);    if (!detailMod)    { toast('Detail view not built yet'); return; } }
  if (view === 'kanban')      { boardMod      ??= await import('./board.js').catch(() => null);      if (!boardMod)      { toast('Kanban not built yet'); return; } }
  if (view === 'engagement')  { engagementMod  ??= await import('./engagement.js').catch(() => null);  if (!engagementMod)  { toast('Engagement not built yet');   return; } }
  if (view === 'experiments') { experimentsMod ??= await import('./experiments.js').catch(() => null); if (!experimentsMod) { toast('Experiments not built yet'); return; } }

  // Clean up listeners when leaving a view
  if (view !== 'detail') { detailCleanup?.(); detailCleanup = null; }
  if (currentView === 'history' && view !== 'history') { historyCleanup?.(); historyCleanup = null; }
  if (currentView === 'kanban' && view !== 'kanban') { boardCleanup?.(); boardCleanup = null; }

  showView(view);

  if (view === 'dashboard' && dashboardMod) {
    const container = document.getElementById('view-dashboard');
    await dashboardMod.renderDashboard(container, dashboardHandlers);
    if (lastState) dashboardMod.updateDashboard(lastState, dashboardHandlers);
  } else if (view === 'history' && historyMod) {
    historyCleanup = await historyMod.renderHistory(document.getElementById('view-history'), handlers);
  } else if (view === 'analytics' && analyticsMod) {
    await analyticsMod.renderAnalytics(document.getElementById('view-analytics'));
  } else if (view === 'learning' && learningMod) {
    await renderLearningView();
  } else if (view === 'map' && mapMod) {
    try {
      await mapMod.renderMap(document.getElementById('view-map'), mapHandlers, sessionId ?? undefined);
      if (lastState) mapMod.updateMap(lastState);
    } catch (err) { toast('Map error: ' + (err?.message ?? err)); }
  } else if (view === 'grid') {
    const sessions = lastState?.sessions ?? [];
    let sel = (sessionId && sessions.some(s => s.id === sessionId)) ? sessionId : null;
    if (!sel) sel = (openSessionId && sessions.some(s => s.id === openSessionId))
      ? openSessionId
      : mostRecentSessionId(lastState ?? { sessions: [] });
    openSessionId = sel;
    if (lastState) fillGridRail(lastState);
    if (openSessionId) await renderEmbeddedDetail(openSessionId);
  } else if (view === 'detail' && detailMod && sessionId) {
    await renderFullDetail(sessionId);
  } else if (view === 'kanban' && boardMod) {
    boardCleanup = await boardMod.renderBacklog(document.getElementById('view-kanban'), handlers);
  } else if (view === 'engagement' && engagementMod) {
    const container = document.getElementById('view-engagement');
    try {
      const data = await fetchEngagement();
      engagementMod.renderEngagement(container, data);
    } catch { toast('Failed to load engagement data'); }
  } else if (view === 'experiments' && experimentsMod) {
    const container = document.getElementById('view-experiments');
    try {
      await experimentsMod.renderExperiments(container);
    } catch { toast('Failed to load experiments data'); }
  }
}

// User-initiated navigation: push history, then render.
async function navigate(view, sessionId = null) {
  const path = pathFor(view, sessionId);
  if (location.pathname !== path) history.pushState({ view, sessionId }, '', path);
  await enterView(view, sessionId);
}

// Back / forward buttons restore the view from history state (or the URL).
window.addEventListener('popstate', (e) => {
  const r = (e.state && e.state.view) ? e.state : parseRoute(location.pathname);
  enterView(r.view, r.sessionId);
});

// ── Nav view buttons — navigate on click ──────────────────────────────────
for (const btn of document.querySelectorAll('#topbar nav button[data-view]')) {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
}

// ── Dropdown pillar interactions (hover, click, keyboard, outside-click) ──
{
  let navHoverTimer = null;

  function openDropdown(pillarEl) {
    if (navHoverTimer) { clearTimeout(navHoverTimer); navHoverTimer = null; }
    closeAllDropdowns();
    pillarEl.classList.add('is-open');
    pillarEl.querySelector('.nav-pillar-trigger')?.setAttribute('aria-expanded', 'true');
  }

  for (const pillarEl of document.querySelectorAll('.nav-pillar')) {
    const trigger = pillarEl.querySelector('.nav-pillar-trigger');
    const getItems = () => [...pillarEl.querySelectorAll('.nav-view-btn')];

    // Hover: open immediately, close after a short pause to bridge the gap
    pillarEl.addEventListener('mouseenter', () => openDropdown(pillarEl));
    pillarEl.addEventListener('mouseleave', () => {
      if (navHoverTimer) clearTimeout(navHoverTimer);
      navHoverTimer = setTimeout(() => closeAllDropdowns(), 150);
    });

    // Click on trigger: toggle open/closed
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent document click from immediately re-closing
      const isOpen = pillarEl.classList.contains('is-open');
      closeAllDropdowns();
      if (!isOpen) openDropdown(pillarEl);
    });

    // Keyboard on pillar trigger
    trigger?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openDropdown(pillarEl);
        getItems()[0]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        openDropdown(pillarEl);
        const all = getItems();
        all[all.length - 1]?.focus();
      } else if (e.key === 'Escape') {
        closeAllDropdowns();
      } else if (e.key === 'ArrowRight') {
        const pillars = [...document.querySelectorAll('.nav-pillar')];
        const next = pillars[pillars.indexOf(pillarEl) + 1];
        if (next) { closeAllDropdowns(); next.querySelector('.nav-pillar-trigger')?.focus(); }
      } else if (e.key === 'ArrowLeft') {
        const pillars = [...document.querySelectorAll('.nav-pillar')];
        const prev = pillars[pillars.indexOf(pillarEl) - 1];
        if (prev) { closeAllDropdowns(); prev.querySelector('.nav-pillar-trigger')?.focus(); }
      }
    });

    // Keyboard on menu items
    for (const item of getItems()) {
      item.addEventListener('keydown', (e) => {
        const all = getItems();
        const idx = all.indexOf(item);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          all[idx + 1]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (idx === 0) trigger?.focus(); else all[idx - 1]?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeAllDropdowns();
          trigger?.focus();
        } else if (e.key === 'Tab') {
          closeAllDropdowns(); // natural tab focus out; let browser handle movement
        }
      });
    }
  }

  // Outside click closes all dropdowns
  document.addEventListener('click', () => closeAllDropdowns());
}

// ── Boot ─────────────────────────────────────────
(async () => {
  const topbar = document.getElementById('topbar');
  // Await the launcher (it fetches config) before mounting settings so the
  // settings gear lands to the RIGHT of the New-terminal dropdown.
  if (topbar) { await mountLauncher(topbar); mountSettings(topbar); }

  // Seed the analytics badge on load without navigating to the view
  fetchBudget().then(data => updateAnalyticsBadge(data)).catch(() => {});
  getLearning().then(updateLearningBadge).catch(() => {});
  updateKanbanDot().catch(() => {});

  try {
    const state = await getState();
    render(state);

    // Boot into the view named by the current URL (so refresh / deep links /
    // back+forward all land on the right view).
    const r = parseRoute(location.pathname);
    history.replaceState({ view: r.view, sessionId: r.sessionId }, '', pathFor(r.view, r.sessionId));
    await enterView(r.view, r.sessionId);
  } catch (e) {
    const dashContainer = document.getElementById('view-dashboard');
    if (dashContainer) dashContainer.textContent = 'Failed to load dashboard: ' + e.message;
  }

  onEvents(payload => {
    if (payload.type === 'hello') {
      onServerHello(payload.buildId);
      return;
    }
    if (payload.type === 'backlog') {
      if (currentView === 'kanban' && boardMod) boardMod.refreshBacklog();
      updateKanbanDot().catch(() => {});
      return;
    }
    if (payload.type === 'events') {
      scheduleRefresh();
      if (openSessionId && payload.sessionId === openSessionId) {
        window.dispatchEvent(new CustomEvent('mc-events', { detail: payload }));
      }
    }
  });
})();

// ── Server-restart guard ─────────────────────────
// EventSource auto-reconnects after a server restart and re-receives 'hello'.
// First id seen wins; a different id means the server restarted with new code,
// so reload to pick it up — unless the editor is open (don't clobber unsaved edits).
function onServerHello(buildId) {
  if (!buildId) return;
  if (serverBuildId == null) { serverBuildId = buildId; return; }
  if (buildId === serverBuildId) return;
  const editorOpen = !document.getElementById('editor-pane')?.classList.contains('hidden');
  if (editorOpen) {
    toast('Server restarted with new code — reload when ready');
    return;
  }
  location.reload();
}
