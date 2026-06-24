// Thin drag wrapper. Prefers vendored SortableJS; falls back to native HTML5 DnD.
let SortableMod = null;
try { SortableMod = (await import('./vendor/sortable.esm.js')).default; } catch { SortableMod = null; }

export function enableColumnDnd(colEl, group, onDrop) {
  if (SortableMod) {
    const inst = SortableMod.create(colEl, {
      group, animation: 120, draggable: '.backlog-card', ghostClass: 'backlog-card-ghost',
      onEnd: () => onDrop(colEl),
    });
    return () => inst.destroy();
  }
  // Native fallback
  let dragId = null;
  const onDragStart = (e) => { const c = e.target.closest('.backlog-card'); if (c) { dragId = c.dataset.id; e.dataTransfer.effectAllowed = 'move'; } };
  const onDragOver = (e) => { e.preventDefault(); };
  const onDropEv = (e) => {
    e.preventDefault();
    if (dragId == null) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(dragId) : String(dragId).replace(/["\\\]]/g, '\\$&');
    const card = colEl.ownerDocument.querySelector(`.backlog-card[data-id="${sel}"]`);
    if (!card) return;
    const after = [...colEl.querySelectorAll('.backlog-card')].find(c => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
    colEl.insertBefore(card, after ?? null);
    onDrop(colEl); dragId = null;
  };
  colEl.querySelectorAll('.backlog-card').forEach(c => { c.draggable = true; });
  colEl.addEventListener('dragstart', onDragStart);
  colEl.addEventListener('dragover', onDragOver);
  colEl.addEventListener('drop', onDropEv);
  return () => { colEl.removeEventListener('dragstart', onDragStart); colEl.removeEventListener('dragover', onDragOver); colEl.removeEventListener('drop', onDropEv); };
}
