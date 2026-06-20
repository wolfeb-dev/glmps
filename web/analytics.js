// web/analytics.js
// Analytics view — consumes GET /api/usage and renders hand-rolled charts
// (CSS bars + inline SVG donut). ALL DOM via createElement/createElementNS + textContent.
// No charting library, no innerHTML with data (only innerHTML='' to clear).
// Usage panel (from budget.js) is rendered at the top of this view.

import {
  groupByModel,
  groupByProject,
  donutArcs,
  heatBuckets,
  maxOf,
} from './analytics-calc.js';

import { renderUsage } from './budget.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Token-distribution colors keyed to the house palette (see styles.css :root).
const DONUT_COLORS = {
  input: 'var(--info)',
  output: 'var(--primary)',
  cache: 'var(--success)',
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

// ── formatting helpers ──────────────────────────────
function fmtUsd(n) {
  const v = Number(n) || 0;
  return '$' + v.toFixed(2);
}

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString();
}

// 1234 -> '1.2k', 1500000 -> '1.5M'
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

// 'YYYY-MM-DD' -> short label 'Jun 5'
function shortDate(date) {
  if (!date) return '';
  const d = new Date(date + (String(date).length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── totals strip ────────────────────────────────────
function buildTotals(totals, daily) {
  const t = totals || {};
  const strip = el('div', 'an-totals');

  // Derive sensible fallbacks from daily if a total field is absent.
  const sum = (key) => (Array.isArray(daily) ? daily.reduce((s, d) => s + (d[key] ?? 0), 0) : 0);

  const cost = t.costUsd ?? sum('costUsd');
  const inputTok = t.inputTokens ?? sum('inputTokens');
  const outputTok = t.outputTokens ?? sum('outputTokens');
  const cacheTok = t.cacheReadTokens ?? sum('cacheReadTokens');
  const sessions = t.sessions ?? sum('sessions');

  const cards = [
    { label: 'Total cost', value: fmtUsd(cost), accent: 'gold' },
    { label: 'Input tokens', value: fmtTokens(inputTok), accent: 'blue' },
    { label: 'Output tokens', value: fmtTokens(outputTok), accent: 'gold' },
    { label: 'Cache reads', value: fmtTokens(cacheTok), accent: 'green' },
    { label: 'Sessions', value: fmtInt(sessions), accent: 'plain' },
  ];

  for (const c of cards) {
    const card = el('div', 'an-stat an-stat-' + c.accent);
    card.appendChild(el('div', 'an-stat-value', c.value));
    card.appendChild(el('div', 'an-stat-label', c.label));
    strip.appendChild(card);
  }
  return strip;
}

// ── section wrapper (panel + title) ─────────────────
function buildSection(title) {
  const panel = el('div', 'an-panel');
  panel.appendChild(el('div', 'an-panel-title', title));
  const body = el('div', 'an-panel-body');
  panel.appendChild(body);
  return { panel, body };
}

// ── daily cost + token bar chart ────────────────────
function buildDailyChart(daily) {
  const { panel, body } = buildSection('Daily cost & tokens');
  const rows = Array.isArray(daily) ? daily : [];

  if (rows.length === 0) {
    body.appendChild(el('div', 'an-empty', 'No daily usage recorded yet.'));
    return panel;
  }

  const maxCost = maxOf(rows, 'costUsd');
  const maxTok = maxOf(rows, (d) => (d.inputTokens ?? 0) + (d.outputTokens ?? 0) + (d.cacheReadTokens ?? 0));
  const lastDate = rows[rows.length - 1]?.date;

  const chart = el('div', 'an-bars');
  for (const d of rows) {
    const tokTotal = (d.inputTokens ?? 0) + (d.outputTokens ?? 0) + (d.cacheReadTokens ?? 0);
    const isLatest = d.date === lastDate;

    const col = el('div', 'an-bar-col' + (isLatest ? ' an-bar-latest' : ''));
    col.title = `${shortDate(d.date)}  ·  ${fmtUsd(d.costUsd)}  ·  ${fmtTokens(tokTotal)} tok  ·  ${fmtInt(d.sessions ?? 0)} sess`;

    const stack = el('div', 'an-bar-stack');
    // Cost bar (gold) + token bar (blue), side by side within the column.
    const costH = maxCost > 0 ? Math.max(2, Math.round((d.costUsd ?? 0) / maxCost * 48)) : 2;
    const tokH = maxTok > 0 ? Math.max(2, Math.round(tokTotal / maxTok * 48)) : 2;

    const costBar = el('div', 'an-bar an-bar-cost');
    costBar.style.height = costH + 'px';
    const tokBar = el('div', 'an-bar an-bar-tok');
    tokBar.style.height = tokH + 'px';

    stack.appendChild(costBar);
    stack.appendChild(tokBar);
    col.appendChild(stack);

    const lbl = el('div', 'an-bar-label', shortDate(d.date));
    col.appendChild(lbl);

    chart.appendChild(col);
  }
  body.appendChild(chart);

  // Legend
  const legend = el('div', 'an-legend');
  const costKey = el('span', 'an-legend-item');
  costKey.appendChild(el('span', 'an-swatch an-swatch-cost'));
  costKey.appendChild(el('span', null, 'cost'));
  const tokKey = el('span', 'an-legend-item');
  tokKey.appendChild(el('span', 'an-swatch an-swatch-tok'));
  tokKey.appendChild(el('span', null, 'tokens'));
  legend.appendChild(costKey);
  legend.appendChild(tokKey);
  body.appendChild(legend);

  return panel;
}

// ── GitHub-style activity heatmap ───────────────────
function buildHeatmap(heatmap) {
  const { panel, body } = buildSection('Activity');
  const buckets = heatBuckets(heatmap);

  if (buckets.length === 0) {
    body.appendChild(el('div', 'an-empty', 'No activity recorded yet.'));
    return panel;
  }

  // 7-row grid (one row per weekday), columns flow as weeks. CSS uses grid-auto-flow:column.
  const grid = el('div', 'an-heat');
  for (const b of buckets) {
    const cell = el('div', 'an-heat-cell an-heat-' + b.level);
    cell.title = `${shortDate(b.date)}  ·  ${fmtInt(b.count)} event${b.count === 1 ? '' : 's'}`;
    grid.appendChild(cell);
  }
  body.appendChild(grid);

  // Scale legend (less -> more)
  const scale = el('div', 'an-heat-scale');
  scale.appendChild(el('span', 'an-heat-scale-text', 'less'));
  for (let lvl = 0; lvl <= 4; lvl++) {
    scale.appendChild(el('span', 'an-heat-cell an-heat-' + lvl));
  }
  scale.appendChild(el('span', 'an-heat-scale-text', 'more'));
  body.appendChild(scale);

  return panel;
}

// ── token-distribution donut (inline SVG) ───────────
function buildDonut(totals, daily, perSession) {
  const { panel, body } = buildSection('Token distribution');

  // Prefer totals; fall back to summing daily, then perSession.
  let input = totals?.inputTokens;
  let output = totals?.outputTokens;
  let cacheRead = totals?.cacheReadTokens;
  let cacheCreate = totals?.cacheCreateTokens;

  if (input == null && Array.isArray(daily)) {
    input = daily.reduce((s, d) => s + (d.inputTokens ?? 0), 0);
    output = daily.reduce((s, d) => s + (d.outputTokens ?? 0), 0);
    cacheRead = daily.reduce((s, d) => s + (d.cacheReadTokens ?? 0), 0);
  }
  if (input == null && Array.isArray(perSession)) {
    input = perSession.reduce((s, r) => s + (r.input ?? 0), 0);
    output = perSession.reduce((s, r) => s + (r.output ?? 0), 0);
    cacheRead = perSession.reduce((s, r) => s + (r.cacheRead ?? 0), 0);
    cacheCreate = perSession.reduce((s, r) => s + (r.cacheCreate ?? 0), 0);
  }

  const parts = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheCreate: cacheCreate ?? 0,
  };
  const arcs = donutArcs(parts, { cx: 50, cy: 50, radius: 42, thickness: 16 });
  const total = arcs.reduce((s, a) => s + a.value, 0);

  const wrap = el('div', 'an-donut-wrap');

  // SVG
  const chart = svg('svg', { viewBox: '0 0 100 100', class: 'an-donut', role: 'img' });
  if (total <= 0) {
    // Empty ring
    chart.appendChild(svg('circle', { cx: 50, cy: 50, r: 34, fill: 'none', stroke: 'var(--border)', 'stroke-width': 16 }));
  } else {
    for (const a of arcs) {
      if (!a.d) continue;
      const path = svg('path', { d: a.d, fill: DONUT_COLORS[a.key] ?? 'var(--muted-fg)' });
      const titleNode = svg('title');
      titleNode.textContent = `${a.label}: ${fmtTokens(a.value)} (${Math.round(a.fraction * 100)}%)`;
      path.appendChild(titleNode);
      chart.appendChild(path);
    }
  }
  wrap.appendChild(chart);

  // Legend with values
  const legend = el('div', 'an-donut-legend');
  for (const a of arcs) {
    const item = el('div', 'an-donut-legend-item');
    const sw = el('span', 'an-swatch');
    sw.style.background = DONUT_COLORS[a.key] ?? 'var(--muted-fg)';
    item.appendChild(sw);
    const name = el('span', 'an-donut-legend-name', a.label);
    item.appendChild(name);
    const val = el('span', 'an-donut-legend-val', total > 0 ? `${fmtTokens(a.value)} · ${Math.round(a.fraction * 100)}%` : '0');
    item.appendChild(val);
    legend.appendChild(item);
  }
  wrap.appendChild(legend);

  body.appendChild(wrap);
  return panel;
}

// ── ranked progress bars (projects / models) ────────
function buildRanked(title, groups, opts = {}) {
  const { panel, body } = buildSection(title);
  const rows = Array.isArray(groups) ? groups : [];

  if (rows.length === 0) {
    body.appendChild(el('div', 'an-empty', 'No data yet.'));
    return panel;
  }

  const top = rows.slice(0, opts.limit ?? 8);
  const maxCost = maxOf(top, 'costUsd');
  const barClass = opts.barClass ?? 'an-rank-fill-gold';

  for (const g of top) {
    const row = el('div', 'an-rank-row');

    const head = el('div', 'an-rank-head');
    const name = el('span', 'an-rank-name', g.label);
    name.title = g.label;
    head.appendChild(name);
    const val = el('span', 'an-rank-val', `${fmtUsd(g.costUsd)} · ${fmtTokens(g.tokens)}`);
    head.appendChild(val);
    row.appendChild(head);

    const track = el('div', 'an-rank-track');
    const fill = el('div', 'an-rank-fill ' + barClass);
    const pct = maxCost > 0 ? Math.max(2, Math.round((g.costUsd / maxCost) * 100)) : 2;
    fill.style.width = pct + '%';
    track.appendChild(fill);
    row.appendChild(track);

    const meta = el('div', 'an-rank-meta', `${g.sessions} session${g.sessions === 1 ? '' : 's'}`);
    row.appendChild(meta);

    body.appendChild(row);
  }
  return panel;
}

// ── fetch ───────────────────────────────────────────
async function fetchUsage() {
  const res = await fetch('/api/usage');
  if (!res.ok) throw new Error('usage ' + res.status);
  return res.json();
}

// ── main entry ──────────────────────────────────────
export async function renderAnalytics(container) {
  if (!container) return;
  container.innerHTML = '';

  const loading = el('div', 'an-empty', 'Loading analytics…');
  container.appendChild(loading);

  // Fetch budget and analytics data in parallel
  let budgetData, analyticsData;
  [budgetData, analyticsData] = await Promise.allSettled([
    fetch('/api/budget').then(r => r.json()),
    fetchUsage(),
  ]).then(([b, a]) => [
    b.status === 'fulfilled' ? b.value : null,
    a.status === 'fulfilled' ? a.value : null,
  ]);

  container.innerHTML = '';

  const root = el('div', 'an-root');

  // 0) Usage panel — top of Analytics
  const usageSection = el('div');
  root.appendChild(usageSection);
  renderUsage(usageSection, budgetData ?? { available: false });

  if (!analyticsData) {
    root.appendChild(el('div', 'an-empty', 'Failed to load usage data.'));
    container.appendChild(root);
    return;
  }

  const daily = analyticsData?.daily ?? [];
  const heatmap = analyticsData?.heatmap ?? [];
  const perSession = analyticsData?.perSession ?? [];
  const totals = analyticsData?.totals ?? {};

  // 1) Totals strip
  root.appendChild(buildTotals(totals, daily));

  // 2) Daily bar chart (full width)
  root.appendChild(buildDailyChart(daily));

  // 3) Heatmap + donut side by side
  const midRow = el('div', 'an-row');
  midRow.appendChild(buildHeatmap(heatmap));
  midRow.appendChild(buildDonut(totals, daily, perSession));
  root.appendChild(midRow);

  // 4) Top projects + per-model ranked bars side by side
  const bottomRow = el('div', 'an-row');
  bottomRow.appendChild(buildRanked('Top projects', groupByProject(perSession), { barClass: 'an-rank-fill-blue', limit: 8 }));
  bottomRow.appendChild(buildRanked('By model', groupByModel(perSession), { barClass: 'an-rank-fill-gold', limit: 8 }));
  root.appendChild(bottomRow);

  container.appendChild(root);
}
