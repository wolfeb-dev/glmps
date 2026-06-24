// Pure, testable logic for the backlog board.
export const COLUMNS = ['queued', 'in_progress', 'in_review', 'done'];

export function groupByColumn(items) {
  const g = { queued: [], in_progress: [], in_review: [], done: [], held: [] };
  for (const it of items) (g[it.state] ?? (g[it.state] = [])).push(it);
  for (const k of Object.keys(g)) g[k].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return g;
}

export function nextOrder(items) {
  return items.reduce((m, i) => Math.max(m, i.order ?? 0), 0) + 1;
}

export const ORDERED = ['held', 'queued', 'in_progress', 'in_review', 'done'];

export function orderedColumns(showArchived) {
  return showArchived ? [...ORDERED, 'cancelled'] : [...ORDERED];
}

export function priorityRank(priority) {
  return (priority == null) ? -1 : Number(priority);
}

export function filterItems(items, { project, query, minPriority, showCancelled } = {}) {
  const q = (query ?? '').trim().toLowerCase();
  return (items ?? []).filter(it => {
    if (!showCancelled && it.state === 'cancelled') return false;
    if (project && project !== 'all' && it.project !== project) return false;
    if (minPriority != null && priorityRank(it.priority) < minPriority) return false;
    if (q) {
      const hay = `${it.title ?? ''} ${it.prompt ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Enrich backlog items with live-session info from the queue runner ledger.
// The runner tracks launched jobs in state/runner/launched.json keyed by card id
// (exposed via GET /api/runner as { config, ledger, targets }). A card is "live"
// while a ledger entry exists for it, and the entry's launch target (the editor it
// opened in) surfaces as the agent label. Items without an entry pass through
// untouched. Pure: returns a new array, never mutates the inputs.
export function joinRunner(items, runner) {
  const ledger = (runner && runner.ledger) || {};
  return (items ?? []).map(it => {
    const entry = ledger[it.id];
    if (!entry) return it;
    return { ...it, live: true, agent: entry.target ?? it.agent };
  });
}

export function groupByLane(items, laneKey) {
  if (!laneKey) return [{ lane: 'all', label: '', items: [...(items ?? [])] }];
  const map = new Map();
  for (const it of items ?? []) {
    const key = laneKey === 'priority'
      ? String(priorityRank(it.priority))
      : String(it.project ?? 'default');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.entries()]
    .sort((a, b) => laneKey === 'priority' ? Number(b[0]) - Number(a[0]) : a[0].localeCompare(b[0]))
    .map(([lane, laneItems]) => ({ lane, label: lane, items: laneItems }));
}
