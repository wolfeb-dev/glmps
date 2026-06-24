// web/settings.js
// Topbar settings gear: Restart server (one-click + auto-reload), Open config.json,
// a version/port info line, Knowledge graph maintenance, and Learning loop controls.
// All data via textContent/createElement; no innerHTML with data.
import { getConfig, restartServer, health, openInEditor, graphStatus, rebuildGraph, learningStatus, runSynth } from './api.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function icon(name) {
  const span = document.createElement('span');
  span.className = 'set-ic';
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '');
  const url = `url("icons/${safe || 'gear'}.svg")`;
  span.style.webkitMaskImage = url;
  span.style.maskImage = url;
  return span;
}

export function mountSettings(topbar) {
  const wrap = document.createElement('div');
  wrap.className = 'set-launcher';

  const btn = document.createElement('button');
  btn.className = 'set-btn';
  btn.type = 'button';
  btn.title = 'Settings';
  btn.setAttribute('aria-label', 'Settings');
  btn.appendChild(icon('gear'));
  wrap.appendChild(btn);

  let menuEl = null, onDoc = null, onKey = null, cfg = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove(); menuEl = null;
    if (onDoc) { document.removeEventListener('click', onDoc, true); onDoc = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    btn.classList.remove('open');
  }

  function row(iconName, label, onClick) {
    const r = document.createElement('div');
    r.className = 'set-row';
    r.appendChild(icon(iconName));
    const t = document.createElement('span');
    t.className = 'set-row-label';
    t.textContent = label;
    r.appendChild(t);
    r.addEventListener('click', (e) => { e.stopPropagation(); onClick(r); });
    return r;
  }

  function relativeTime(ms) {
    if (ms == null) return '—';
    const diff = Math.max(0, Date.now() - ms);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(diff / 60000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(diff / 3600000);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function capStyle(label) {
    const el = document.createElement('div');
    el.className = 'set-cap-style';
    el.textContent = label;
    return el;
  }

  // ── Knowledge graph section ──────────────────────────────────────────────

  function buildGraphSection(menu) {
    const wrap = document.createElement('div');
    wrap.className = 'set-section';

    const divider = document.createElement('div');
    divider.className = 'set-divider';
    wrap.appendChild(divider);

    wrap.appendChild(capStyle('Knowledge graph'));

    const list = document.createElement('div');
    list.className = 'set-graph-list';
    list.textContent = '…';
    wrap.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'set-graph-footer';

    const rebuildAllBtn = document.createElement('button');
    rebuildAllBtn.className = 'set-action-btn';
    rebuildAllBtn.type = 'button';
    rebuildAllBtn.textContent = 'Rebuild all stale';
    rebuildAllBtn.addEventListener('click', async () => {
      rebuildAllBtn.disabled = true;
      rebuildAllBtn.textContent = 'Rebuilding…';
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding stale graphs…' }));
      try {
        await rebuildGraph();
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Graphs rebuilt' }));
        refreshGraphList(list, rebuildAllBtn);
      } catch {
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuild failed' }));
        rebuildAllBtn.disabled = false;
        rebuildAllBtn.textContent = 'Rebuild all stale';
      }
    });
    footer.appendChild(rebuildAllBtn);
    wrap.appendChild(footer);

    menu.appendChild(wrap);
    return { list, rebuildAllBtn };
  }

  async function refreshGraphList(list, rebuildAllBtn) {
    list.textContent = '…';
    try {
      const { graphs } = await graphStatus();
      list.textContent = '';
      if (!graphs || graphs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'set-graph-empty';
        empty.textContent = 'No graphs yet.';
        list.appendChild(empty);
      } else {
        graphs.forEach(g => {
          const item = document.createElement('div');
          item.className = 'set-graph-row';

          const top = document.createElement('div');
          top.className = 'set-graph-top';

          const name = document.createElement('span');
          name.className = 'set-graph-name';
          name.textContent = String(g.project || g.root || '(unknown)');
          top.appendChild(name);

          if (g.needsUpdate) {
            const pill = document.createElement('span');
            pill.className = 'set-needs-update';
            pill.textContent = 'needs update';
            top.appendChild(pill);
          }

          item.appendChild(top);

          const sub = document.createElement('div');
          sub.className = 'set-graph-sub';
          const rebuilt = relativeTime(g.rebuiltMs);
          const nodes = g.nodes != null ? g.nodes.toLocaleString() : '—';
          sub.textContent = `Rebuilt ${rebuilt} · ${nodes} nodes`;
          item.appendChild(sub);

          item.addEventListener('click', async () => {
            if (item.classList.contains('busy')) return;
            item.classList.add('busy');
            const proj = String(g.project || g.root || '');
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Rebuilding ${proj}…` }));
            try {
              await rebuildGraph(g.root);
              window.dispatchEvent(new CustomEvent('mc-toast', { detail: `${proj}: rebuilt` }));
              refreshGraphList(list, rebuildAllBtn);
            } catch {
              window.dispatchEvent(new CustomEvent('mc-toast', { detail: `${proj}: rebuild failed` }));
              item.classList.remove('busy');
            }
          });

          list.appendChild(item);
        });
      }

      // Re-enable rebuild-all after list refresh
      if (rebuildAllBtn) {
        rebuildAllBtn.disabled = false;
        rebuildAllBtn.textContent = 'Rebuild all stale';
      }
    } catch {
      list.textContent = '';
      const err = document.createElement('div');
      err.className = 'set-graph-empty';
      err.textContent = 'Could not load graphs.';
      list.appendChild(err);
      if (rebuildAllBtn) {
        rebuildAllBtn.disabled = false;
        rebuildAllBtn.textContent = 'Rebuild all stale';
      }
    }
  }

  // ── Learning loop section ────────────────────────────────────────────────

  function buildLearningSection(menu) {
    const wrap = document.createElement('div');
    wrap.className = 'set-section';

    const divider = document.createElement('div');
    divider.className = 'set-divider';
    wrap.appendChild(divider);

    wrap.appendChild(capStyle('Learning loop'));

    const statusLine = document.createElement('div');
    statusLine.className = 'set-learning-status';
    statusLine.textContent = '…';
    wrap.appendChild(statusLine);

    const runBtn = document.createElement('button');
    runBtn.className = 'set-action-btn';
    runBtn.type = 'button';
    runBtn.textContent = 'Run now';
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Running synthesizer…' }));
      try {
        const result = await runSynth();
        const msg = result.ok
          ? `${result.upserted ?? 0} gaps from ${result.scanned ?? 0} sessions`
          : (result.message || 'Synthesizer failed');
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg }));
        refreshLearningStatus(statusLine, runBtn);
      } catch {
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Synthesizer failed' }));
        runBtn.disabled = false;
        runBtn.textContent = 'Run now';
      }
    });
    wrap.appendChild(runBtn);

    menu.appendChild(wrap);
    return { statusLine, runBtn };
  }

  async function refreshLearningStatus(statusLine, runBtn) {
    try {
      const data = await learningStatus();
      const when = data.lastRunMs != null ? `Last synthesized ${relativeTime(data.lastRunMs)}` : 'Never run';
      const pending = data.pending != null ? ` · ${data.pending} pending` : '';
      statusLine.textContent = when + pending;
    } catch {
      statusLine.textContent = 'Status unavailable.';
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = 'Run now';
      }
    }
  }

  async function doRestart(r) {
    r.classList.add('busy');
    const lbl = r.querySelector('.set-row-label');
    if (lbl) lbl.textContent = 'Restarting…';
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Restarting server…' }));
    try { await restartServer(); } catch {}
    closeMenu();
    await sleep(800); // let the old server release the port before polling
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await health()) { location.reload(); return; }
      await sleep(500);
    }
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: "Server didn't come back — relaunch manually" }));
  }

  async function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }

    menuEl = document.createElement('div');
    menuEl.className = 'set-menu';

    const cap = document.createElement('div');
    cap.className = 'set-cap';
    cap.textContent = 'Settings';
    menuEl.appendChild(cap);

    menuEl.appendChild(row('restart', 'Restart server', doRestart));
    menuEl.appendChild(row('file', 'Open config.json', () => {
      if (cfg?.configPath) { openInEditor(cfg.configPath); closeMenu(); }
      else window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'config path unknown' }));
    }));

    const info = document.createElement('div');
    info.className = 'set-info';
    info.textContent = '…';
    menuEl.appendChild(info);

    const { list: graphList, rebuildAllBtn } = buildGraphSection(menuEl);
    const { statusLine, runBtn } = buildLearningSection(menuEl);

    wrap.appendChild(menuEl);
    btn.classList.add('open');

    onDoc = (ev) => { if (!wrap.contains(ev.target)) closeMenu(); };
    onKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);

    // Lazy-fetch all three in parallel on open
    try {
      cfg = await getConfig();
      const v = cfg.version ? `v${cfg.version}` : '';
      const p = cfg.port ? `:${cfg.port}` : '';
      info.textContent = [v, p].filter(Boolean).join(' · ') || '—';
    } catch { info.textContent = '—'; }

    refreshGraphList(graphList, rebuildAllBtn);
    refreshLearningStatus(statusLine, runBtn);
  }

  btn.addEventListener('click', openMenu);
  topbar.appendChild(wrap);
}
