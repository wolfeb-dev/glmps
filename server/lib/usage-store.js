// server/lib/usage-store.js
// Reads the per-session usage time-series written by the statusline tap
// (<stateDir>/usage/<YYYY-MM-DD>.ndjson) and rolls it up into the shapes the
// analytics UI charts: daily series, an activity heatmap, per-session latest
// snapshots, and grand totals.
//
// Cumulative semantics: costUsd / token counts are CUMULATIVE per session
// (each tick reports the running total for that session). So a day's value for
// a metric = sum over sessions of (that session's last value that day - that
// session's last value the previous day it appeared), clamped >= 0.
import fs from 'node:fs';
import path from 'node:path';

export { appendSnapshot } from '../../taps/statusline-chain-lib.js';

// Local-date bucket for a timestamp, matching appendSnapshot's filename scheme.
function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

export function readUsage(stateDir) {
  const empty = {
    daily: [], heatmap: [], perSession: [],
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: 0, days: 0 },
  };
  const usageDir = path.join(stateDir, 'usage');
  let files;
  try {
    files = fs.readdirSync(usageDir).filter(f => f.endsWith('.ndjson'));
  } catch {
    return empty;
  }
  if (!files.length) return empty;

  // Collect all records.
  const records = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(usageDir, f), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (!rec || typeof rec !== 'object' || typeof rec.sid !== 'string' || !rec.sid) continue;
      const capturedAt = typeof rec.capturedAt === 'number' ? rec.capturedAt
        : (typeof rec.ts === 'number' ? rec.ts : null);
      if (capturedAt == null) continue;
      records.push({ ...rec, capturedAt, date: dayOf(capturedAt) });
    }
  }
  if (!records.length) return empty;

  // For each session, per date, keep the LAST snapshot of that date (by capturedAt),
  // and track the latest snapshot overall (for perSession).
  // bySession: sid -> { latest, byDate: Map<date, lastRecOfThatDate> }
  const bySession = new Map();
  for (const rec of records) {
    let s = bySession.get(rec.sid);
    if (!s) { s = { latest: rec, byDate: new Map() }; bySession.set(rec.sid, s); }
    if (rec.capturedAt >= s.latest.capturedAt) s.latest = rec;
    const cur = s.byDate.get(rec.date);
    if (!cur || rec.capturedAt >= cur.capturedAt) s.byDate.set(rec.date, rec);
  }

  // Per-date accumulators for daily series and heatmap.
  // daily: date -> { costUsd, inputTokens, outputTokens, cacheReadTokens, sessions:Set }
  const daily = new Map();
  const ensureDay = (date) => {
    let d = daily.get(date);
    if (!d) { d = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: new Set() }; daily.set(date, d); }
    return d;
  };

  for (const [sid, s] of bySession) {
    // Ordered list of (date, lastRecOfThatDate) for this session.
    const days = [...s.byDate.keys()].sort();
    let prev = null; // previous appeared day's last record
    for (const date of days) {
      const rec = s.byDate.get(date);
      const d = ensureDay(date);
      d.sessions.add(sid);
      const dCost = num(rec.costUsd) - num(prev?.costUsd);
      const dIn = num(rec.input) - num(prev?.input);
      const dOut = num(rec.output) - num(prev?.output);
      const dCacheR = num(rec.cacheRead) - num(prev?.cacheRead);
      d.costUsd += Math.max(0, dCost);
      d.inputTokens += Math.max(0, dIn);
      d.outputTokens += Math.max(0, dOut);
      d.cacheReadTokens += Math.max(0, dCacheR);
      prev = rec;
    }
  }

  const dailyArr = [...daily.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    .map(([date, d]) => ({
      date,
      costUsd: d.costUsd,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      sessions: d.sessions.size,
    }));

  const heatmap = dailyArr.map(d => ({ date: d.date, count: daily.get(d.date).sessions.size }));

  const perSession = [...bySession.values()]
    .map(s => s.latest)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .map(r => ({
      sid: r.sid,
      model: r.model ?? null,
      costUsd: r.costUsd ?? null,
      input: r.input ?? null,
      output: r.output ?? null,
      cacheRead: r.cacheRead ?? null,
      cacheCreate: r.cacheCreate ?? null,
      ctxUsedPct: r.ctxUsedPct ?? null,
      cwd: r.cwd ?? null,
      lastTs: r.capturedAt,
    }));

  const totals = dailyArr.reduce((acc, d) => {
    acc.costUsd += d.costUsd;
    acc.inputTokens += d.inputTokens;
    acc.outputTokens += d.outputTokens;
    acc.cacheReadTokens += d.cacheReadTokens;
    return acc;
  }, { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: 0, days: 0 });
  totals.sessions = bySession.size;
  totals.days = dailyArr.length;

  return { daily: dailyArr, heatmap, perSession, totals };
}
