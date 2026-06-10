// taps/statusline-chain-lib.js
import fs from 'node:fs';
import path from 'node:path';

// Build the usage snapshot record from a raw statusline payload.
// Be defensive: every field is null when absent. Field paths mirror the
// canonical ones used by normalizeStatus() in server/server.js.
export function usageRecordFrom(raw, capturedAt = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const sid = typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : null;
  const cost = raw.cost ?? {};
  const cw = raw.context_window ?? {};
  const cu = raw.current_usage ?? {};
  return {
    sid,
    ts: typeof raw.ts === 'number' ? raw.ts : capturedAt,
    capturedAt,
    model: raw.model?.id ?? null,
    costUsd: cost.total_cost_usd ?? cost.totalUsd ?? null,
    durationMs: cost.total_duration_ms ?? null,
    apiDurationMs: cost.total_api_duration_ms ?? null,
    linesAdded: cost.total_lines_added ?? null,
    linesRemoved: cost.total_lines_removed ?? null,
    input: cw.total_input_tokens ?? null,
    output: cw.total_output_tokens ?? null,
    cacheRead: cu.cache_read_input_tokens ?? null,
    cacheCreate: cu.cache_creation_input_tokens ?? null,
    ctxUsedPct: cw.used_percentage ?? raw.context?.usedPercent ?? null,
    cwd: raw.cwd ?? null,
  };
}

// Append one NDJSON line to <stateDir>/usage/<YYYY-MM-DD>.ndjson.
// The date bucket is derived from the record's capturedAt (local date).
export function appendSnapshot(stateDir, record) {
  if (!record || typeof record !== 'object') return;
  const usageDir = path.join(stateDir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const d = new Date(typeof record.capturedAt === 'number' ? record.capturedAt : Date.now());
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  fs.appendFileSync(path.join(usageDir, `${day}.ndjson`), JSON.stringify(record) + '\n');
}

export function recordStatus(input, statusDir) {
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !sid) return;
  const capturedAt = Date.now();
  const safe = sid.replace(/[^a-zA-Z0-9_-]/g, '_');
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, `${safe}.json`),
    JSON.stringify({ ...input, capturedAt }));
  // Also append a usage time-series snapshot. statusDir is <stateDir>/status,
  // so its parent is <stateDir>. Never let usage logging break status capture.
  try {
    const stateDir = path.dirname(statusDir);
    const record = usageRecordFrom(input, capturedAt);
    if (record && record.sid) appendSnapshot(stateDir, record);
  } catch {}
}

export function buildSettingsPatch(settings, chainPath) {
  const previousCommand = settings?.statusLine?.command ?? null;
  const patched = { ...settings, statusLine: {
    type: 'command',
    ...(settings.statusLine ?? {}),
    command: `node "${chainPath}"` } };
  return { patched, previousCommand };
}
