// web/diff-view.js
// Shared diff renderer extracted from detail.js fillDiffPopup.
// XSS-safe: all user data goes through renderAnsi (textContent-based), never innerHTML.
import { renderAnsi } from './ansi.js';

function setText(el, s) { el.textContent = String(s ?? ''); }

/**
 * renderDiff(change) → DocumentFragment
 * change = { old: {text, truncated}|null, new: {text, truncated}|null }
 * Renders red (.diff-old) and green (.diff-new) blocks with "- "/" + " prefixes,
 * plus .diff-truncated notices when truncated flags are set.
 */
export function renderDiff(change) {
  const frag = document.createDocumentFragment();
  if (!change) return frag;

  if (change.old) {
    const oldEl = document.createElement('div');
    oldEl.className = 'diff-old';
    const lines = change.old.text.split('\n').map(l => '- ' + l).join('\n');
    oldEl.appendChild(renderAnsi(lines));
    frag.appendChild(oldEl);
    if (change.old.truncated) {
      const note = document.createElement('div');
      note.className = 'diff-truncated';
      setText(note, '… truncated');
      frag.appendChild(note);
    }
  }

  if (change.new) {
    const newEl = document.createElement('div');
    newEl.className = 'diff-new';
    const lines = change.new.text.split('\n').map(l => '+ ' + l).join('\n');
    newEl.appendChild(renderAnsi(lines));
    frag.appendChild(newEl);
    if (change.new.truncated) {
      const note = document.createElement('div');
      note.className = 'diff-truncated';
      setText(note, '… truncated');
      frag.appendChild(note);
    }
  }

  return frag;
}

/**
 * findChangeRange(content, change) → { start, end } | null
 * Locates the change's new-text block as a contiguous run of lines within the
 * current file content, so the editor can inline-highlight the changed region.
 * Returns 0-based line indices (end exclusive), or null when the block cannot be
 * located unambiguously (no match, multiple matches, or no usable new text).
 */
export function findChangeRange(content, change) {
  if (!change || !change.new || typeof change.new.text !== 'string') return null;
  if (typeof content !== 'string' || content.length === 0) return null;

  let needle = change.new.text.split('\n');
  // Truncated capture can cut the last line mid-string — drop that partial line.
  if (change.new.truncated && needle.length > 1) needle = needle.slice(0, -1);
  // A trailing newline in the written block yields a trailing '' the file may
  // not have; drop it so the match isn't blocked by a phantom blank line.
  if (needle.length > 1 && needle[needle.length - 1] === '') needle = needle.slice(0, -1);
  if (needle.length === 0 || (needle.length === 1 && needle[0] === '')) return null;

  const hay = content.split('\n');
  if (needle.length > hay.length) return null;

  let foundAt = -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) {
      if (foundAt !== -1) return null; // ambiguous — refuse to guess
      foundAt = i;
    }
  }
  if (foundAt === -1) return null;
  return { start: foundAt, end: foundAt + needle.length };
}
