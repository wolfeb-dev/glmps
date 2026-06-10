// web/app.js
import { getState, onEvents, getLearning, addIdea, learningAction, setLearningConfig } from './api.js';
import { renderRail, toolColorClass } from './grid.js';
import { mountLauncher } from './launcher.js';
import { mountSettings } from './settings.js';

let currentView = 'grid';
let openSessionId = null;
let detailMod = null;
let editorMod = null;
let historyMod = null;
let analyticsMod = null;
let analyticsCleanup = null;   // analytics has no listeners; kept for symmetry, may stay null
let learningMod = null;
let refreshTimer = null;
let lastState = null;
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
    onBack: () => {},   // no-op: back not shown in embedded mode
  }, summary, { embedded: true });

  // If a newer render started while awaiting, clean up immediately and bail
  if (seq !== renderSeq) { cleanup?.(); return; }

  detailCleanup = cleanup;

  // Update rail selection highlight
  renderRail(lastState ?? { sessions: [] }, handlers, openSessionId);
}

// ── Full-page detail (from History view) ─────────
async function onOpenSession(id) {
  detailMod ??= await import('./detail.js').catch(() => null);
  if (!detailMod) { toast('Detail view not built yet'); return; }

  if (historyCleanup) { historyCleanup(); historyCleanup = null; }
  if (detailCleanup) { detailCleanup(); detailCleanup = null; }

  openSessionId = id;
  showView('detail');

  const container = document.getElementById('view-detail');
  const summary = (lastState?.sessions ?? []).find(s => s.id === id) ?? null;

  detailCleanup = await detailMod.renderDetail(id, container, {
    onOpenFile,
    onCopy,
    onBack: () => {
      if (detailCleanup) { detailCleanup(); detailCleanup = null; }
      openSessionId = null;
      showView('grid');
      if (lastState) renderRail(lastState, handlers, openSessionId);
    },
  }, summary);
}

async function onOpenFile(path) {
  editorMod ??= await import('./editor.js').catch(() => null);
  if (!editorMod) { toast('Editor not built yet'); return; }
  editorMod.openEditor(path, { onClose: () => {} });
}

function onCopy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copied — paste into the session terminal'),
    () => toast('Clipboard write failed'),
  );
}

// onSelectSession is called from rail entries
async function onSelectSession(id) {
  await renderEmbeddedDetail(id);
}

const handlers = { onOpenSession, onOpenFile, onCopy, onSelectSession };

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
    renderRail(state, handlers, openSessionId);
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
  }, 2000);
}

// ── Learning view ────────────────────────────────
async function renderLearningView() {
  learningMod ??= await import('./learning.js').catch(() => null);
  if (!learningMod) { toast('Learning view not built yet'); return; }
  const container = document.getElementById('view-learning');
  let data;
  try { data = await getLearning(); } catch { toast('Failed to load learning queue'); return; }
  learningMod.renderLearning(container, data, {
    onIdea:   async (text) => { try { await addIdea(text); } finally { renderLearningView(); } },
    onAction: async (id, action, rule) => { try { await learningAction(id, action, rule); } finally { renderLearningView(); } },
    onToggle: async (v) => { try { await setLearningConfig(v); } finally { renderLearningView(); } },
  });
}

// ── Nav buttons ──────────────────────────────────
for (const btn of document.querySelectorAll('#topbar nav button')) {
  btn.addEventListener('click', async () => {
    const view = btn.dataset.view;
    if (view === 'history') {
      historyMod ??= await import('./history.js').catch(() => null);
      if (!historyMod) { toast('History not built yet'); return; }
    }
    if (view === 'analytics') {
      analyticsMod ??= await import('./analytics.js').catch(() => null);
      if (!analyticsMod) { toast('Analytics not built yet'); return; }
    }
    if (view === 'learning') {
      learningMod ??= await import('./learning.js').catch(() => null);
      if (!learningMod) { toast('Learning not built yet'); return; }
    }
    // Clean up detail listener whenever we navigate away from detail
    if (view !== 'detail') {
      detailCleanup?.();
      detailCleanup = null;
    }
    // Clean up history listeners whenever we navigate away from history
    if (currentView === 'history') {
      if (historyCleanup) { historyCleanup(); historyCleanup = null; }
    }
    showView(view);
    if (view === 'history' && historyMod) {
      const container = document.getElementById('view-history');
      historyCleanup = await historyMod.renderHistory(container, handlers);
    }
    if (view === 'analytics' && analyticsMod) {
      await analyticsMod.renderAnalytics(document.getElementById('view-analytics'));
    }
    if (view === 'learning' && learningMod) {
      await renderLearningView();
    }
    if (view === 'grid') {
      if (lastState) renderRail(lastState, handlers, openSessionId);
      // Re-render embedded detail for current selection
      if (openSessionId) {
        await renderEmbeddedDetail(openSessionId);
      }
    }
  });
}

// ── Boot ─────────────────────────────────────────
(async () => {
  const topbar = document.getElementById('topbar');
  // Await the launcher (it fetches config) before mounting settings so the
  // settings gear lands to the RIGHT of the New-terminal dropdown.
  if (topbar) { await mountLauncher(topbar); mountSettings(topbar); }
  try {
    const state = await getState();
    render(state);

    // Auto-select: most recently active live session, or first session
    const sessions = [...(state.sessions ?? [])].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.lastTs ?? 0) - (a.lastTs ?? 0);
    });
    if (sessions.length > 0) {
      await renderEmbeddedDetail(sessions[0].id);
    }
  } catch (e) {
    const detailMain = document.getElementById('detail-main');
    if (detailMain) detailMain.textContent = 'Failed to load state: ' + e.message;
  }

  onEvents(payload => {
    if (payload.type === 'events') {
      scheduleRefresh();
      if (openSessionId && payload.sessionId === openSessionId) {
        window.dispatchEvent(new CustomEvent('mc-events', { detail: payload }));
      }
    }
  });
})();
