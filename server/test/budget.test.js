// server/test/budget.test.js — usage/quota meter (real /api/oauth/usage data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCredentials, parseUsage, quotaFlags, readMeta, fetchUsage, readBudget } from '../lib/budget.js';

// fake readFile keyed by path
function fakeFs(map) { return (p) => { if (Object.prototype.hasOwnProperty.call(map, p)) return map[p]; throw new Error('ENOENT ' + p); }; }

test('readCredentials extracts oauth token + plan; null on missing/bad file', () => {
  const rf = fakeFs({ '/c': JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 123, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }) });
  const c = readCredentials('/c', rf);
  assert.equal(c.accessToken, 'tok');
  assert.equal(c.subscriptionType, 'max');
  assert.equal(c.rateLimitTier, 'default_claude_max_5x');
  assert.equal(readCredentials('/missing', rf), null);
});

test('parseUsage: utilization is a percent; resets_at accepts ISO or unix seconds', () => {
  const u = parseUsage({
    five_hour: { utilization: 39, resets_at: '2026-06-13T06:29:59+00:00' },
    seven_day: { utilization: 4, resets_at: 1781762400 },
    seven_day_sonnet: { utilization: 2, resets_at: '2026-06-18T06:00:00+00:00' },
    seven_day_opus: null,
  });
  assert.equal(u.fiveHour.usedPercent, 39);
  assert.equal(u.sevenDay.usedPercent, 4);
  assert.equal(u.sevenDaySonnet.usedPercent, 2);
  assert.equal(u.sevenDayOpus, null);
  assert.equal(typeof u.fiveHour.resetsAt, 'number');       // ISO parsed to ms
  assert.equal(u.sevenDay.resetsAt, 1781762400 * 1000);     // unix sec -> ms
  assert.equal(parseUsage({ five_hour: { utilization: 150 } }).fiveHour.usedPercent, 100); // clamp
  assert.equal(parseUsage(null), null);
});

test('quotaFlags warns only at >=80% (warn at >=95)', () => {
  assert.deepEqual(quotaFlags({ fiveHour: { usedPercent: 39 }, sevenDay: { usedPercent: 4 } }), []);
  const f = quotaFlags({ fiveHour: { usedPercent: 96 }, sevenDay: { usedPercent: 82 } });
  assert.ok(f.find(x => x.code === 'fiveHour-high' && x.severity === 'warn'));
  assert.ok(f.find(x => x.code === 'sevenDay-high' && x.severity === 'info'));
});

test('readMeta pulls model / context% / cost from statusline.json', () => {
  const rf = fakeFs({ '/s': JSON.stringify({ model: { displayName: 'Opus 4.8' }, context: { usedPercent: 58 }, cost: { totalUsd: 143.19 } }) });
  const m = readMeta('/s', rf);
  assert.equal(m.model, 'Opus 4.8');
  assert.equal(m.contextPercent, 58);
  assert.equal(m.costUsd, 143.19);
});

test('fetchUsage hits the oauth/usage endpoint with a bearer token and parses', async () => {
  let url, headers;
  const fake = async (u, opts) => { url = u; headers = opts.headers; return { ok: true, json: async () => ({ five_hour: { utilization: 39, resets_at: 1781762400 }, seven_day: { utilization: 4 } }) }; };
  const u = await fetchUsage('tok', fake);
  assert.match(url, /\/api\/oauth\/usage$/);
  assert.equal(headers.authorization, 'Bearer tok');
  assert.equal(u.fiveHour.usedPercent, 39);
  assert.equal(await fetchUsage(null, fake), null); // no token -> no call
});

test('readBudget: oauth path returns usage + plan + meta + flags, and caches within TTL', async () => {
  const rf = fakeFs({
    '/c': JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }),
    '/s': JSON.stringify({ model: { displayName: 'Opus 4.8' }, context: { usedPercent: 58 }, cost: { totalUsd: 143 } }),
  });
  const fake = async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 96 }, seven_day: { utilization: 4 }, seven_day_sonnet: { utilization: 2 } }) });
  const cache = { at: 0, value: null };
  const b = await readBudget({ credentialsFile: '/c', statuslineFile: '/s', readFile: rf, fetchImpl: fake, cache, now: 1000 });
  assert.equal(b.available, true);
  assert.equal(b.source, 'oauth-usage');
  assert.equal(b.usage.fiveHour.usedPercent, 96);
  assert.equal(b.plan.rateLimitTier, 'default_claude_max_5x');
  assert.equal(b.meta.model, 'Opus 4.8');
  assert.ok(b.flags.find(f => f.code === 'fiveHour-high'));

  let calls = 0;
  const fake2 = async () => { calls++; return { ok: true, json: async () => ({ five_hour: { utilization: 1 } }) }; };
  const b2 = await readBudget({ credentialsFile: '/c', statuslineFile: '/s', readFile: rf, fetchImpl: fake2, cache, now: 1500 });
  assert.equal(b2.usage.fiveHour.usedPercent, 96); // served from cache
  assert.equal(calls, 0);
});

test('readBudget: falls back to statusline.json when the authed call fails', async () => {
  const rf = fakeFs({
    '/c': JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
    '/s': JSON.stringify({ rateLimits: { fiveHour: { usedPercent: 31, resetsAt: 1781332200 }, sevenDay: { usedPercent: 3 } }, model: { displayName: 'M' } }),
  });
  const cache = { at: 0, value: null };
  const b = await readBudget({ credentialsFile: '/c', statuslineFile: '/s', readFile: rf, fetchImpl: async () => { throw new Error('network'); }, cache, now: 2000 });
  assert.equal(b.source, 'statusline-fallback');
  assert.equal(b.usage.fiveHour.usedPercent, 31);
  assert.equal(b.usage.fiveHour.resetsAt, 1781332200 * 1000);
  assert.equal(b.usage.sevenDaySonnet, null);
  assert.equal(b.available, true);
});

test('readBudget: no creds and no statusline -> unavailable, no flags', async () => {
  const cache = { at: 0, value: null };
  const b = await readBudget({ credentialsFile: '/x', statuslineFile: '/y', readFile: fakeFs({}), fetchImpl: async () => { throw new Error('x'); }, cache, now: 1 });
  assert.equal(b.available, false);
  assert.deepEqual(b.flags, []);
});
