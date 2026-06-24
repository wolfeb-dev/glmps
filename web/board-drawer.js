// web/board-drawer.js — card detail/edit slide-over drawer
// XSS discipline: textContent/createElement only; innerHTML only to clear.
import { updateBacklogItem, deleteBacklogItem, runBacklogItem } from './api.js';

const STATES = ['queued', 'held', 'in_progress', 'in_review', 'done', 'cancelled'];
const RUNNER_LABELS = {
  'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
  'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'a terminal',
};
const STATE_LABELS = {
  queued: 'Queued', held: 'Backlog',
  in_progress: 'In Progress', in_review: 'In Review',
  done: 'Done', cancelled: 'Cancelled',
};
const PRIORITY_OPTIONS = [
  { value: '', label: 'None' },
  { value: '0', label: 'Low' },
  { value: '1', label: 'Normal' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Urgent' },
];

function fmt(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function mk(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function labeledField(labelText, control) {
  const wrap = mk('div', 'drawer-field');
  const lbl = mk('label', 'drawer-label');
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  wrap.appendChild(control);
  return wrap;
}

export function openCardDrawer(item, { onChange } = {}) {
  // Prevent duplicate drawers
  const existing = document.querySelector('.backlog-drawer-scrim');
  if (existing) existing.remove();

  // Scrim
  const scrim = mk('div', 'backlog-drawer-scrim');

  // Panel
  const panel = mk('aside', 'backlog-drawer');

  // ── Header ──────────────────────────────────────────
  const header = mk('div', 'drawer-header');
  const headerLeft = mk('div', 'drawer-header-left');

  const titleInput = mk('input', 'drawer-title-input');
  titleInput.type = 'text';
  titleInput.value = item.title ?? '';
  titleInput.setAttribute('aria-label', 'Card title');

  const idTag = mk('span', 'drawer-id-tag');
  idTag.textContent = item.id ? String(item.id).slice(0, 8) : '';

  headerLeft.appendChild(titleInput);
  headerLeft.appendChild(idTag);

  const closeBtn = mk('button', 'drawer-close-btn');
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close drawer');

  header.appendChild(headerLeft);
  header.appendChild(closeBtn);

  // ── Body ─────────────────────────────────────────────
  const body = mk('div', 'drawer-body');

  // Prompt textarea
  const promptTA = mk('textarea', 'drawer-textarea');
  promptTA.value = item.prompt ?? '';
  promptTA.rows = 4;
  promptTA.setAttribute('aria-label', 'Prompt');
  body.appendChild(labeledField('Prompt', promptTA));

  // State select
  const stateSelect = mk('select', 'drawer-select');
  for (const s of STATES) {
    const opt = mk('option');
    opt.value = s;
    opt.textContent = STATE_LABELS[s] ?? s;
    if (s === item.state) opt.selected = true;
    stateSelect.appendChild(opt);
  }
  body.appendChild(labeledField('State', stateSelect));

  // Priority select
  const prioritySelect = mk('select', 'drawer-select');
  for (const { value, label } of PRIORITY_OPTIONS) {
    const opt = mk('option');
    opt.value = value;
    opt.textContent = label;
    const itemPriority = item.priority == null ? '' : String(item.priority);
    if (value === itemPriority) opt.selected = true;
    prioritySelect.appendChild(opt);
  }
  body.appendChild(labeledField('Priority', prioritySelect));

  // Branch input
  const branchInput = mk('input', 'drawer-input');
  branchInput.type = 'text';
  branchInput.value = item.branch ?? '';
  branchInput.setAttribute('aria-label', 'Branch');
  body.appendChild(labeledField('Branch', branchInput));

  // PR URL input
  const prUrlInput = mk('input', 'drawer-input');
  prUrlInput.type = 'text';
  prUrlInput.value = item.prUrl ?? '';
  prUrlInput.setAttribute('aria-label', 'PR URL');
  body.appendChild(labeledField('PR URL', prUrlInput));

  // ── Read-only meta block ──────────────────────────────
  const meta = mk('div', 'drawer-meta-block');

  function metaRow(label, value) {
    const row = mk('div', 'drawer-meta-row');
    const k = mk('span', 'drawer-meta-key');
    k.textContent = label;
    const v = mk('span', 'drawer-meta-val');
    v.textContent = value ?? '—';
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  meta.appendChild(metaRow('Project', item.project));
  meta.appendChild(metaRow('Source', item.source));
  meta.appendChild(metaRow('Created', fmt(item.createdAt)));
  meta.appendChild(metaRow('Updated', fmt(item.updatedAt)));
  body.appendChild(meta);

  // ── Activity log ─────────────────────────────────────
  const activity = item.activity ?? [];
  if (activity.length > 0) {
    const actSection = mk('div', 'drawer-activity');
    const actTitle = mk('div', 'drawer-section-title');
    actTitle.textContent = 'Activity';
    actSection.appendChild(actTitle);

    const list = mk('ul', 'drawer-activity-list');
    // newest-first
    const sorted = [...activity].sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });
    for (const entry of sorted) {
      const li = mk('li', 'drawer-activity-item');
      const ts = mk('span', 'drawer-activity-ts');
      ts.textContent = fmt(entry.ts);
      const text = mk('span', 'drawer-activity-text');
      text.textContent = entry.text ?? '';
      li.appendChild(ts);
      li.appendChild(text);
      list.appendChild(li);
    }
    actSection.appendChild(list);
    body.appendChild(actSection);
  }

  // ── Footer ────────────────────────────────────────────
  const footer = mk('div', 'drawer-footer');

  // Run now: launch this card as a live session immediately, regardless of the
  // Auto-run toggle. Nothing to launch for finished cards, so disable those.
  const runBtn = mk('button', 'drawer-btn drawer-btn-run');
  runBtn.textContent = 'Run now';
  const finished = item.state === 'done' || item.state === 'cancelled';
  runBtn.disabled = finished;
  runBtn.title = finished
    ? `This card is ${STATE_LABELS[item.state]?.toLowerCase() ?? item.state} — nothing to run.`
    : 'Launch this card as a live session now.';

  const saveBtn = mk('button', 'drawer-btn drawer-btn-primary');
  saveBtn.textContent = 'Save';

  const cancelTicketBtn = mk('button', 'drawer-btn drawer-btn-warning');
  cancelTicketBtn.textContent = 'Cancel ticket';

  const deleteBtn = mk('button', 'drawer-btn drawer-btn-danger');
  deleteBtn.textContent = 'Delete';

  const closeFooterBtn = mk('button', 'drawer-btn drawer-btn-muted');
  closeFooterBtn.textContent = 'Close';

  footer.appendChild(runBtn);
  footer.appendChild(saveBtn);
  footer.appendChild(cancelTicketBtn);
  footer.appendChild(deleteBtn);

  const footerRight = mk('div', 'drawer-footer-right');
  footerRight.appendChild(closeFooterBtn);
  footer.appendChild(footerRight);

  // ── Assemble ─────────────────────────────────────────
  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    scrim.classList.add('open');
    panel.classList.add('open');
  });

  // ── Dismiss logic ─────────────────────────────────────
  function dismiss() {
    scrim.classList.remove('open');
    panel.classList.remove('open');
    setTimeout(() => scrim.remove(), 200);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKeyDown); }
  }
  document.addEventListener('keydown', onKeyDown);

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) { dismiss(); document.removeEventListener('keydown', onKeyDown); }
  });

  closeBtn.addEventListener('click', () => { dismiss(); document.removeEventListener('keydown', onKeyDown); });
  closeFooterBtn.addEventListener('click', () => { dismiss(); document.removeEventListener('keydown', onKeyDown); });

  // ── Mutation helpers ──────────────────────────────────
  function getCurrentPriority() {
    const v = prioritySelect.value;
    return v === '' ? null : Number(v);
  }

  async function doMutation(fn) {
    try {
      await fn();
      if (onChange) onChange();
      dismiss();
      document.removeEventListener('keydown', onKeyDown);
    } catch (err) {
      emit('Action failed: ' + (err?.message ?? err));
    }
  }

  // Save — diff against original, PATCH only changed fields
  saveBtn.addEventListener('click', async () => {
    const patch = {};
    const newTitle = titleInput.value.trim();
    if (newTitle !== (item.title ?? '')) patch.title = newTitle;

    const newPrompt = promptTA.value;
    if (newPrompt !== (item.prompt ?? '')) patch.prompt = newPrompt;

    const newState = stateSelect.value;
    if (newState !== (item.state ?? '')) patch.state = newState;

    const newPriority = getCurrentPriority();
    const origPriority = item.priority == null ? null : Number(item.priority);
    if (newPriority !== origPriority) patch.priority = newPriority;

    const newBranch = branchInput.value.trim();
    if (newBranch !== (item.branch ?? '')) patch.branch = newBranch || null;

    const newPrUrl = prUrlInput.value.trim();
    if (newPrUrl !== (item.prUrl ?? '')) patch.prUrl = newPrUrl || null;

    if (Object.keys(patch).length === 0) { dismiss(); document.removeEventListener('keydown', onKeyDown); return; }

    await doMutation(() => updateBacklogItem(item.id, patch));
  });

  // Run now — launch this specific card; keep the drawer open on failure so the
  // reason stays in view.
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    const prev = runBtn.textContent;
    runBtn.textContent = 'Launching…';
    try {
      const { status, body } = await runBacklogItem(item.id);
      if (status === 200) {
        emit(`Launched in ${RUNNER_LABELS[body.target] ?? body.target ?? 'your editor'}`);
        if (onChange) onChange();
        dismiss();
        document.removeEventListener('keydown', onKeyDown);
      } else {
        emit(body?.error ? `Couldn't run: ${body.error}` : "Couldn't start the session");
        runBtn.disabled = false;
        runBtn.textContent = prev;
      }
    } catch {
      emit("Couldn't reach the runner");
      runBtn.disabled = false;
      runBtn.textContent = prev;
    }
  });

  // Cancel ticket
  cancelTicketBtn.addEventListener('click', async () => {
    await doMutation(() => updateBacklogItem(item.id, { state: 'cancelled' }));
  });

  // Delete
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Delete this ticket? This cannot be undone.')) return;
    await doMutation(() => deleteBacklogItem(item.id));
  });

  return { dismiss };
}

function emit(msg) { window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg })); }
