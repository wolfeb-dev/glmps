// web/app.js
import { getState, onEvents, getLearning, addIdea, learningAction, setLearningConfig, fetchBudget } from './api.js';
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
let refreshTimer = null;
let lastState = null;
let serverBuildId = null;      // first SSE 'hello' wins; a different one on reconnect => server restarted
let detailCleanup = null;
let historyCleanup = null;
let renderSeq = 0;

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
  for (const sec of document.querySelectorAll('.view')) sec.classList.add('hidden');
  const target = document.getElementById(`view-${name}`);
  if (target) target.classList.remove('hidden');
  for (const btn of document.querySelectorAll('#topbar nav button')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
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
  let dot = btn.querySelector('.learning-nav-dot');
  const items = Array.isArray(data?.items) ? data.items : [];
  const pending = items.filter(i => i.status === 'pending').length;
  if (pending === 0) {
    if (dot) dot.style.display = 'none';
    return;
  }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'learning-nav-dot';
    btn.appendChild(dot);
  }
  dot.style.display = '';
  dot.title = `${pending} learning item${pending === 1 ? '' : 's'} awaiting review`;
}

// ── Routing (History API, clean URLs) ────────────
const NAV_VIEWS = ['dashboard', 'history', 'analytics', 'learning', 'map', 'grid', 'kanban'];

function pathFor(view, sessionId) {
  switch (view) {
    case 'grid':      return sessionId ? `/detail/${encodeURIComponent(sessionId)}` : '/detail';
    case 'detail':    return sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/detail';
    case 'history':   return '/history';
    case 'analytics': return '/analytics';
    case 'learning':  return '/learning';
    case 'map':       return '/map';
    case 'kanban':    return sessionId ? `/kanban/${encodeURIComponent(sessionId)}` : '/kanban';
    default:          return '/dashboard';
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
  if (view === 'kanban')    { boardMod     ??= await import('./board.js').catch(() => null);     if (!boardMod)     { toast('Kanban not built yet'); return; } }

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

// ── Nav buttons ──────────────────────────────────
for (const btn of document.querySelectorAll('#topbar nav button')) {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
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
