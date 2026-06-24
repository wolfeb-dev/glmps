// web/editor.js
import { readFile, saveFile, undoFile, openInEditor } from './api.js';
import { renderDiff, findChangeRange } from './diff-view.js';

let currentClose = null;

function setText(el, s) { el.textContent = String(s ?? ''); }

function basename(p) {
  return String(p ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p;
}

function dispatchToast(msg) {
  window.dispatchEvent(new CustomEvent('mc-toast', { detail: String(msg) }));
}

export function openEditor(path, { onClose, diff } = {}) {
  const pane = document.getElementById('editor-pane');
  if (!pane) return;

  // Tear down any previously open editor silently (no unsaved-changes prompt)
  currentClose?.({ silent: true });

  // State
  let content = '';
  let hash = '';
  let mode = 'preview'; // 'preview' | 'edit'

  // Clear and show pane
  pane.innerHTML = '';
  pane.classList.remove('hidden');

  // ── Header ─────────────────────────────────────
  const edHeader = document.createElement('div');
  edHeader.className = 'ed-header';

  const fileNameEl = document.createElement('span');
  fileNameEl.className = 'ed-filename';
  setText(fileNameEl, basename(path));
  fileNameEl.title = String(path ?? '');
  edHeader.appendChild(fileNameEl);

  const btnRow = document.createElement('div');
  btnRow.className = 'ed-btn-row';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'ed-btn';
  setText(toggleBtn, 'Edit');

  const saveBtn = document.createElement('button');
  saveBtn.className = 'ed-btn ed-btn-primary';
  setText(saveBtn, 'Save');

  const undoBtn = document.createElement('button');
  undoBtn.className = 'ed-btn';
  setText(undoBtn, 'Undo last save');

  const openBtn = document.createElement('button');
  openBtn.className = 'ed-btn';
  setText(openBtn, 'Open in editor');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ed-btn ed-close';
  setText(closeBtn, '×');

  btnRow.appendChild(toggleBtn);
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(undoBtn);
  btnRow.appendChild(openBtn);
  btnRow.appendChild(closeBtn);
  edHeader.appendChild(btnRow);
  pane.appendChild(edHeader);

  // ── Body ────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'ed-body';
  pane.appendChild(body);

  // Elements created lazily / managed by renderBody
  let previewEl = null;
  let textareaEl = null;

  function renderBody() {
    body.innerHTML = '';

    if (mode === 'preview') {
      setText(toggleBtn, 'Edit');

      // Show diff section above the file preview when a diff was provided
      if (diff) {
        const diffSection = document.createElement('div');
        diffSection.className = 'ed-diff-section';
        const diffHdr = document.createElement('div');
        diffHdr.className = 'ed-diff-label';
        setText(diffHdr, 'Recent change');
        diffSection.appendChild(diffHdr);
        diffSection.appendChild(renderDiff(diff));
        body.appendChild(diffSection);
      }

      previewEl = document.createElement('div');
      previewEl.className = 'md-preview';

      // When opened from a tracked change, locate the new block in the file so
      // those lines can carry the diff's green highlight inline (the red/removed
      // context still lives in the "Recent change" section above).
      const range = diff ? findChangeRange(content, diff) : null;

      // Per-line block rendering — no innerHTML
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineEl = document.createElement('div');
        lineEl.className = 'md-line';
        if (/^#{1,6}\s/.test(line)) lineEl.classList.add('md-h');
        if (range && i >= range.start && i < range.end) lineEl.classList.add('md-change-line');
        setText(lineEl, line);
        previewEl.appendChild(lineEl);
      }
      body.appendChild(previewEl);
      textareaEl = null;
    } else {
      setText(toggleBtn, 'Preview');
      textareaEl = document.createElement('textarea');
      textareaEl.className = 'ed-textarea';
      textareaEl.value = content;
      body.appendChild(textareaEl);
      previewEl = null;
    }
  }

  // ── Load content ────────────────────────────────
  async function load() {
    try {
      const res = await readFile(path);
      content = res?.content ?? '';
      hash = res?.hash ?? '';
      renderBody();
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'ed-error';
      setText(err, `Failed to load: ${e.message}`);
      body.appendChild(err);
    }
  }

  // ── Toggle mode ─────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    if (mode === 'preview') {
      mode = 'edit';
    } else {
      // capture textarea content before switching away
      if (textareaEl) content = textareaEl.value;
      mode = 'preview';
    }
    renderBody();
  });

  // ── Save ────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const currentContent = textareaEl ? textareaEl.value : content;
    const doSave = async (force) => {
      const result = await saveFile(path, currentContent, hash, force);
      if (result.status === 200) {
        content = currentContent;
        hash = result.body?.hash ?? hash;
        dispatchToast('Saved');
      } else if (result.status === 409) {
        const ok = confirm('File changed on disk — overwrite?');
        if (ok) await doSave(true);
      } else {
        dispatchToast(result.body?.error ?? `Save failed (${result.status})`);
      }
    };
    try {
      await doSave(false);
    } catch (e) {
      dispatchToast(`Save error: ${e.message}`);
    }
  });

  // ── Undo last save ──────────────────────────────
  undoBtn.addEventListener('click', async () => {
    try {
      await undoFile(path);
      const res = await readFile(path);
      content = res?.content ?? '';
      hash = res?.hash ?? '';
      if (mode === 'edit' && textareaEl) textareaEl.value = content;
      else renderBody();
      dispatchToast('Reverted');
    } catch {
      dispatchToast('Nothing to undo');
    }
  });

  // ── Open in editor ──────────────────────────────
  openBtn.addEventListener('click', async () => {
    try {
      const result = await openInEditor(path);
      if (!result.status || result.status >= 400) {
        dispatchToast(result.body?.error ?? 'Editor not configured');
      }
    } catch (e) {
      dispatchToast('Editor not configured');
    }
  });

  // ── Close ────────────────────────────────────────
  function close(opts = {}) {
    if (!opts.silent) {
      if (mode === 'edit' && textareaEl && textareaEl.value !== content) {
        const ok = confirm('Discard unsaved changes?');
        if (!ok) return;
      }
    }
    pane.classList.add('hidden');
    pane.innerHTML = '';
    window.removeEventListener('keydown', onEsc);
    document.removeEventListener('mousedown', onClickOff);
    currentClose = null;
    if (!opts.silent && typeof onClose === 'function') onClose();
  }

  currentClose = close;

  closeBtn.addEventListener('click', () => close());

  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  window.addEventListener('keydown', onEsc);

  // Click-off to close: close when mousedown lands outside #editor-pane.
  // Deferred so the click that opened the editor does not immediately close it.
  function onClickOff(e) {
    if (!pane.contains(e.target)) close();
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOff), 0);

  // Initial load
  load();
}
