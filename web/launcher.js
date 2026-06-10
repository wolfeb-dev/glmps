// web/launcher.js
// Topbar "New terminal" launcher: pick an AI CLI + folder, open it as an
// editor-tab terminal in Antigravity via the companion. Mirrors the resume-menu
// pattern; all data goes through textContent / element APIs (no innerHTML).
import { getConfig, launchTerminal } from './api.js';

const LS_CLI = 'mc.term.cli';
const LS_FOLDER = 'mc.term.folder';

function cwdLastSeg(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? cwd;
}

function cliIcon(icon) {
  const span = document.createElement('span');
  span.className = 'term-cli-ic';
  const safe = String(icon ?? 'terminal').replace(/[^a-z0-9_-]/gi, '');
  const url = `url("icons/${safe || 'terminal'}.svg")`;
  span.style.webkitMaskImage = url;
  span.style.maskImage = url;
  return span;
}

export async function mountLauncher(topbar) {
  let config = { terminals: [], projectRoots: [] };
  try { config = await getConfig(); } catch { return; }
  const terminals = Array.isArray(config.terminals) ? config.terminals : [];
  if (terminals.length === 0) return;
  const roots = Array.isArray(config.projectRoots) ? config.projectRoots : [];

  // Selection state (restored from localStorage when still valid)
  let selectedCli = localStorage.getItem(LS_CLI);
  if (!terminals.some(t => t.label === selectedCli)) selectedCli = terminals[0].label;
  let selectedFolder = localStorage.getItem(LS_FOLDER) ?? '';
  if (selectedFolder && !roots.includes(selectedFolder)) selectedFolder = '';

  const wrap = document.createElement('div');
  wrap.className = 'term-launcher';

  const btn = document.createElement('button');
  btn.className = 'term-launch-btn';
  btn.type = 'button';
  btn.appendChild(cliIcon('terminal'));
  const btnLabel = document.createElement('span');
  btnLabel.textContent = 'New terminal';
  btn.appendChild(btnLabel);
  const caret = document.createElement('span');
  caret.className = 'term-caret';
  caret.textContent = '▾';
  btn.appendChild(caret);
  wrap.appendChild(btn);

  let menuEl = null;
  let onDocClick = null;
  let onKey = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    if (onDocClick) { document.removeEventListener('click', onDocClick, true); onDocClick = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    btn.classList.remove('open');
  }

  function buildMenu() {
    menuEl = document.createElement('div');
    menuEl.className = 'term-menu';

    const cap = document.createElement('div');
    cap.className = 'term-menu-cap';
    cap.textContent = 'Launch in editor tab';
    menuEl.appendChild(cap);

    const list = document.createElement('div');
    list.className = 'term-cli-list';
    for (const t of terminals) {
      const row = document.createElement('div');
      row.className = 'term-cli-row' + (t.label === selectedCli ? ' sel' : '');
      row.appendChild(cliIcon(t.icon));
      const lab = document.createElement('span');
      lab.className = 'term-cli-label';
      lab.textContent = t.label;
      row.appendChild(lab);
      const check = document.createElement('span');
      check.className = 'term-cli-check';
      check.textContent = '✓';
      row.appendChild(check);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedCli = t.label;
        for (const r of list.children) r.classList.toggle('sel', r === row);
      });
      list.appendChild(row);
    }
    menuEl.appendChild(list);

    if (roots.length > 0) {
      const fLabel = document.createElement('label');
      fLabel.className = 'term-folder-label';
      fLabel.textContent = 'Folder';
      menuEl.appendChild(fLabel);

      const sel = document.createElement('select');
      sel.className = 'term-folder';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(no folder)';
      sel.appendChild(none);
      for (const root of roots) {
        const opt = document.createElement('option');
        opt.value = root;
        opt.textContent = cwdLastSeg(root);
        opt.title = root;
        sel.appendChild(opt);
      }
      sel.value = selectedFolder;
      sel.addEventListener('change', () => { selectedFolder = sel.value; });
      sel.addEventListener('click', (ev) => ev.stopPropagation());
      menuEl.appendChild(sel);
    }

    const launch = document.createElement('button');
    launch.className = 'term-launch';
    launch.type = 'button';
    launch.appendChild(cliIcon('terminal'));
    const lt = document.createElement('span');
    lt.textContent = 'Launch';
    launch.appendChild(lt);
    launch.addEventListener('click', (ev) => { ev.stopPropagation(); doLaunch(); });
    menuEl.appendChild(launch);

    wrap.appendChild(menuEl);
  }

  function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    buildMenu();
    btn.classList.add('open');
    onDocClick = (ev) => { if (!wrap.contains(ev.target)) closeMenu(); };
    onKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }

  async function doLaunch() {
    const cli = selectedCli;
    const folder = selectedFolder || null;
    localStorage.setItem(LS_CLI, cli);
    localStorage.setItem(LS_FOLDER, selectedFolder || '');
    closeMenu();
    try {
      const { status } = await launchTerminal(cli, folder);
      window.dispatchEvent(new CustomEvent('mc-toast', {
        detail: status === 200
          ? 'Terminal queued — Antigravity will open it'
          : 'Launch failed — check the folder',
      }));
    } catch {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Launch failed' }));
    }
  }

  btn.addEventListener('click', openMenu);
  topbar.appendChild(wrap);
}
