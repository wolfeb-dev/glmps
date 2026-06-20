// server/lib/budget.js
// Usage/quota meter — reads the SAME real data the Claude Code (Antigravity)
// extension shows: GET https://api.anthropic.com/api/oauth/usage with the OAuth
// token from ~/.claude/.credentials.json. Claude computes utilization against the
// user's actual plan, so the percentages are plan-correct (no denominators to
// guess). Falls back to the claude-manager statusline.json (5h/7d only) when the
// authed call can't be made.
//
// Limiters returned by the endpoint: five_hour, seven_day, seven_day_sonnet
// (seven_day_opus is null on Max plans — there is no separate Opus weekly limit).
// `utilization` is already a percent (0-100); `resets_at` is an ISO-8601 string
// (the endpoint) or unix seconds (statusline.json).
import fs from 'node:fs';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60_000; // match the extension's ~60s poll
const _cache = { at: 0, value: null };

const readFileDefault = (p) => fs.readFileSync(p, 'utf-8');

// Read the Claude.ai OAuth token + plan from ~/.claude/.credentials.json.
export function readCredentials(credentialsFile, readFile = readFileDefault) {
  try {
    const j = JSON.parse(readFile(credentialsFile));
    const o = (j && j.claudeAiOauth) || {};
    return {
      accessToken: typeof o.accessToken === 'string' ? o.accessToken : null,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
      subscriptionType: o.subscriptionType ?? null,
      rateLimitTier: o.rateLimitTier ?? null,
    };
  } catch { return null; }
}

// Normalize one limiter. utilization is a percent; resets_at is ISO string or unix sec.
function limiter(x) {
  if (!x || typeof x.utilization !== 'number') return null;
  const r = x.resets_at ?? x.resetsAt;
  let resetsAt = null;
  if (typeof r === 'number') resetsAt = r * 1000;
  else if (typeof r === 'string') { const t = Date.parse(r); if (!Number.isNaN(t)) resetsAt = t; }
  return { usedPercent: Math.max(0, Math.min(100, x.utilization)), resetsAt };
}

// Parse the /api/oauth/usage response into the normalized usage shape.
export function parseUsage(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    fiveHour: limiter(data.five_hour),
    sevenDay: limiter(data.seven_day),
    sevenDaySonnet: limiter(data.seven_day_sonnet),
    sevenDayOpus: limiter(data.seven_day_opus), // null on most plans
  };
}

// Call the authenticated usage endpoint. Returns normalized usage or throws.
export async function fetchUsage(accessToken, fetchImpl) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!accessToken || !f) return null;
  const res = await f(USAGE_URL, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error('usage HTTP ' + res.status);
  return parseUsage(await res.json());
}

// Pull model / context% / session-cost from the claude-manager statusline.json (the
// "cost/models" line — the extension shows this in its statusline).
export function readMeta(statuslineFile, readFile = readFileDefault) {
  try {
    const j = JSON.parse(readFile(statuslineFile));
    return {
      model: j.model?.displayName ?? j.model?.id ?? null,
      contextPercent: typeof j.context?.usedPercent === 'number' ? j.context.usedPercent : null,
      costUsd: typeof j.cost?.totalUsd === 'number' ? j.cost.totalUsd : null,
    };
  } catch { return null; }
}

// Fallback usage from statusline.json (5h/7d only — already as usedPercent).
function usageFromStatusline(statuslineFile, readFile) {
  try {
    const rl = (JSON.parse(readFile(statuslineFile)).rateLimits) || {};
    const s = (x) => (x && typeof x.usedPercent === 'number')
      ? { usedPercent: x.usedPercent, resetsAt: typeof x.resetsAt === 'number' ? x.resetsAt * 1000 : null } : null;
    const fiveHour = s(rl.fiveHour), sevenDay = s(rl.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, sevenDaySonnet: null, sevenDayOpus: null };
  } catch { return null; }
}

// Warn flags when a limiter crosses the extension's >=80% (orange) threshold.
export function quotaFlags(usage) {
  const out = [];
  const check = (k, label) => {
    const p = usage?.[k]?.usedPercent;
    if (typeof p === 'number' && p >= 80) {
      out.push({ code: `${k}-high`, severity: p >= 95 ? 'warn' : 'info', message: `${label} at ${Math.round(p)}%` });
    }
  };
  check('fiveHour', 'Session (5h)');
  check('sevenDay', 'Weekly');
  check('sevenDaySonnet', 'Weekly Sonnet');
  return out;
}

// readBudget — orchestrates: credentials -> authed fetch (cached 60s) -> statusline
// fallback, plus meta (model/ctx/cost). Injectable for tests; uses the module cache
// in the server (pass a fresh `cache` in tests).
export async function readBudget({
  credentialsFile, statuslineFile, now = Date.now(),
  readFile = readFileDefault, fetchImpl, cache = _cache,
} = {}) {
  if (cache.value && now - cache.at < CACHE_TTL_MS) return cache.value;

  const creds = readCredentials(credentialsFile, readFile);
  let usage = null, source = 'none';
  try {
    usage = await fetchUsage(creds?.accessToken, fetchImpl);
    if (usage) source = 'oauth-usage';
  } catch { /* fall through to statusline */ }
  if (!usage && statuslineFile) {
    usage = usageFromStatusline(statuslineFile, readFile);
    if (usage) source = 'statusline-fallback';
  }

  const value = {
    usage,
    meta: statuslineFile ? readMeta(statuslineFile, readFile) : null,
    plan: creds ? { subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier } : null,
    flags: usage ? quotaFlags(usage) : [],
    available: !!usage,
    source,
    updatedTs: now,
  };
  cache.at = now; cache.value = value;
  return value;
}
