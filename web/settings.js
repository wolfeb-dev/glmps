// web/settings.js
// Topbar settings gear: Restart server (one-click + auto-reload), Open config.json,
// and a version/port info line. Mirrors the .term-menu popup pattern.
// All data via textContent/createElement; no innerHTML with data.
import { getConfig, restartServer, health, openInEditor } from './api.js';

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

    wrap.appendChild(menuEl);
    btn.classList.add('open');

    onDoc = (ev) => { if (!wrap.contains(ev.target)) closeMenu(); };
    onKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);

    try {
      cfg = await getConfig();
      const v = cfg.version ? `v${cfg.version}` : '';
      const p = cfg.port ? `:${cfg.port}` : '';
      info.textContent = [v, p].filter(Boolean).join(' · ') || '—';
    } catch { info.textContent = '—'; }
  }

  btn.addEventListener('click', openMenu);
  topbar.appendChild(wrap);
}
