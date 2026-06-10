// server/lib/search.js
import fs from 'node:fs';
import readline from 'node:readline';

// Parse a JSONL transcript line into an object, or null if it is not JSON.
function parseRecord(line) {
  const s = line.trimStart();
  if (s[0] !== '{' && s[0] !== '[') return null;
  try { return JSON.parse(line); } catch { return null; }
}

// Pull a timestamp (epoch ms) out of a transcript record, if present.
function recordTs(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const t = rec.timestamp ?? rec.ts;
  if (t == null) return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

// Normalize a record's message content to a flat array of content blocks.
function contentBlocks(rec) {
  const c = rec?.message?.content;
  if (Array.isArray(c)) return c.filter(b => b && typeof b === 'object');
  return [];
}

// Coerce a {from,to} range to epoch-ms bounds. Accepts ISO strings or epoch numbers.
function rangeBounds(range) {
  if (!range || typeof range !== 'object') return null;
  const toMs = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  };
  return { from: toMs(range.from), to: toMs(range.to) };
}

// Decide whether a single matched line (raw + parsed record + target) passes the filters.
// Returns true when no filters are active or all active filters are satisfied.
function passesFilters(line, rec, target, filters, bounds) {
  if (!filters) return true;

  // project: matched against target metadata only (cwd basename / project field).
  if (filters.project) {
    const want = String(filters.project).toLowerCase();
    const candidates = [target?.project, target?.cwd, target?.transcriptPath]
      .filter(v => typeof v === 'string' && v);
    const hit = candidates.some(v => {
      const lower = v.toLowerCase();
      if (lower.includes(want)) return true;
      const base = v.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
      return base ? base.toLowerCase() === want : false;
    });
    if (!hit) return false;
  }

  // All remaining filters need the parsed JSONL record.
  const needsRecord = filters.messageType || filters.hasErrors ||
    filters.hasToolCalls || filters.hasFileChanges || bounds;
  if (needsRecord && !rec) return false;

  if (filters.messageType) {
    const want = String(filters.messageType).toLowerCase();
    if (String(rec.type ?? '').toLowerCase() !== want) return false;
  }

  if (bounds && (bounds.from != null || bounds.to != null)) {
    const ts = recordTs(rec);
    if (ts == null) return false;
    if (bounds.from != null && ts < bounds.from) return false;
    if (bounds.to != null && ts > bounds.to) return false;
  }

  if (filters.hasErrors) {
    const blocks = contentBlocks(rec);
    const blockErr = blocks.some(b => b.is_error === true ||
      (b.type === 'tool_result' && b.is_error === true));
    const flagErr = rec.isError === true || rec.toolUseResult?.is_error === true;
    if (!blockErr && !flagErr) return false;
  }

  if (filters.hasToolCalls) {
    const blocks = contentBlocks(rec);
    const has = blocks.some(b => b.type === 'tool_use' || b.type === 'server_tool_use' ||
      b.type === 'mcp_tool_use');
    if (!has) return false;
  }

  if (filters.hasFileChanges) {
    const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'create_file']);
    const blocks = contentBlocks(rec);
    const has = blocks.some(b => b.type === 'tool_use' && fileTools.has(b.name)) ||
      (typeof rec.toolUseResult === 'object' && rec.toolUseResult != null &&
        (Array.isArray(rec.toolUseResult.edits) || typeof rec.toolUseResult.filePath === 'string'));
    if (!has) return false;
  }

  return true;
}

// Returns true if any filter field is actually set (so we can keep the fast path otherwise).
function hasActiveFilters(filters) {
  if (!filters || typeof filters !== 'object') return false;
  if (filters.messageType || filters.project) return true;
  if (filters.hasErrors || filters.hasToolCalls || filters.hasFileChanges) return true;
  const r = filters.dateRange;
  if (r && (r.from || r.to)) return true;
  return false;
}

// targets: [{id, transcriptPath, cwd?, project?}]  ->  [{sessionId, lineNo, snippet}] (+ .capped)
// filters (optional): { messageType, hasErrors, hasToolCalls, hasFileChanges, dateRange:{from,to}, project }
//   applied per matched record. With no filters, behaviour is identical to the unfiltered search.
export async function searchTranscripts(targets, query, { cap = 200, filters = null } = {}) {
  const q = query.toLowerCase();
  const active = hasActiveFilters(filters);
  const bounds = active ? rangeBounds(filters.dateRange) : null;
  const results = [];
  results.capped = false;
  for (const t of targets) {
    if (results.length >= cap) { results.capped = true; break; }
    let stream;
    try { stream = fs.createReadStream(t.transcriptPath, 'utf-8'); } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    try {
      for await (const line of rl) {
        lineNo += 1;
        const idx = line.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        if (active) {
          const rec = parseRecord(line);
          if (!passesFilters(line, rec, t, filters, bounds)) continue;
        }
        const start = Math.max(0, idx - 60);
        results.push({ sessionId: t.id, lineNo,
          snippet: line.slice(start, idx + q.length + 120).replace(/\\n/g, ' ') });
        if (results.length >= cap) { results.capped = true; break; }
      }
    } catch { /* unreadable mid-file: skip rest of this transcript */ }
    rl.close(); stream.destroy();
  }
  return results;
}
