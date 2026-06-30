// web/experiments.js
// Experiments view (Evaluation pillar) — top-end outcome/champion-challenger loop.
// renderExperiments(container) is called from app.js enterView.
//
// Sections:
//   1. Harness Quality   — KPI rollup by task class (delegates to outcomes.js)
//   2. Recent Outcomes   — compact table from /api/outcomes
//   3. Champion vs Challenger — per-unit metric comparison (client-side grouping)
//   4. Eval / Replay Set — task list from /api/replay
//
// XSS discipline: all data reaches the DOM only via textContent/createElement.
// innerHTML is never used with data; only innerHTML = '' to clear.

import { renderOutcomes } from './outcomes.js';

// ── DOM helpers ───────────────────────────────────────────────────────────────
function setText(node, s) { node.textContent = String(s ?? ''); }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtPct(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) + '%' : '—';
}

function fmtTurns(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

// ── Panel builder (reuses .an-panel / .an-panel-title from styles.css) ────────
function buildPanel(title) {
  const panel = el('div', 'an-panel');
  panel.appendChild(el('div', 'an-panel-title', title));
  return panel;
}

// ── Section 1: Harness Quality ────────────────────────────────────────────────
// Delegates entirely to outcomes.js which fetches /api/outcomes/summary.
async function buildHarnessQuality() {
  const wrap = el('div');
  await renderOutcomes(wrap);
  return wrap;
}

// ── Section 2: Recent Outcomes table ──────────────────────────────────────────
function buildOutcomesTable(outcomes) {
  const panel = buildPanel('Recent Outcomes');

  if (!outcomes.length) {
    panel.appendChild(el('div', 'an-empty',
      'No outcome records yet — records are written when sessions close.'));
    return panel;
  }

  const wrap = el('div', 'exp-table-wrap');
  const table = el('table', 'exp-table');

  // thead
  const thead = el('thead');
  const hrow = el('tr');
  for (const col of ['Class', 'Turns', '1st try', 'Verifier', 'Reverted', 'Committed', 'Ctx%']) {
    hrow.appendChild(el('th', null, col));
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  // tbody — most recent rows first, capped at 60
  const tbody = el('tbody');
  const rows = [...outcomes].reverse().slice(0, 60);

  for (const row of rows) {
    const tr = el('tr');

    // taskClass
    const tdClass = el('td');
    setText(tdClass, row.taskClass ?? '—');
    tr.appendChild(tdClass);

    // turns
    const tdTurns = el('td', 'exp-val-mono');
    setText(tdTurns, row.turns != null ? String(row.turns) : '—');
    tr.appendChild(tdTurns);

    // firstTry
    const tdFirst = el('td', row.firstTry ? 'exp-val-yes' : 'exp-val-no');
    setText(tdFirst, row.firstTry ? 'Y' : 'N');
    tr.appendChild(tdFirst);

    // verifier exitOk
    const exitOk = row.verifier?.exitOk;
    const verifyClass = exitOk === true ? 'exp-val-yes' : exitOk === false ? 'exp-val-no' : 'exp-val-dash';
    const tdVerify = el('td', verifyClass);
    setText(tdVerify, exitOk === true ? 'pass' : exitOk === false ? 'fail' : '—');
    tr.appendChild(tdVerify);

    // revertedLater
    const tdReverted = el('td', row.revertedLater ? 'exp-val-warn' : '');
    setText(tdReverted, row.revertedLater ? 'Y' : 'N');
    tr.appendChild(tdReverted);

    // committed
    const tdCommitted = el('td', row.committed ? 'exp-val-yes' : '');
    setText(tdCommitted, row.committed ? 'Y' : 'N');
    tr.appendChild(tdCommitted);

    // contextUsageRatio
    const tdCtx = el('td', 'exp-val-mono exp-val-ctx');
    setText(tdCtx, fmtPct(row.contextUsageRatio));
    tr.appendChild(tdCtx);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  return panel;
}

// ── Section 3: Champion vs Challenger ─────────────────────────────────────────
// Consumes /api/promotion payload. Server handles unit grouping + metric math.

// Renders verdict badge + two metric cards into `container`.
// Called from both the initial render and the picker's change handler.
// XSS: all data reaches DOM via textContent; class names are hardcoded literals.
function renderCCResults(container, promo) {
  // ── Verdict badge + rationale ────────────────────────────────────────────
  // Class names are hardcoded literals keyed from server enum — never from data.
  const VERDICT_CLS = {
    promote: 'exp-verdict-badge--promote',
    hold:    'exp-verdict-badge--hold',
    reject:  'exp-verdict-badge--reject',
  };
  const VERDICT_LABEL = { promote: 'Promote', hold: 'Hold', reject: 'Reject' };

  const vCls   = VERDICT_CLS[promo.verdict]   ?? 'exp-verdict-badge--hold';
  const vLabel = VERDICT_LABEL[promo.verdict] ?? String(promo.verdict ?? '—');

  const bar = el('div', 'exp-verdict-bar');
  const badge = el('span', 'exp-verdict-badge ' + vCls);
  setText(badge, vLabel);
  bar.appendChild(badge);

  if (promo.rationale) {
    const ratEl = el('span', 'exp-verdict-rationale');
    setText(ratEl, promo.rationale);
    bar.appendChild(ratEl);
  }
  container.appendChild(bar);

  // ── Two-card metric comparison ───────────────────────────────────────────
  const METRICS = [
    { key: 'medianTurns',        label: 'Median Turns',   fmt: fmtTurns },
    { key: 'verifierPassRate',   label: 'Verifier Pass',  fmt: fmtPct   },
    { key: 'firstTryRate',       label: 'First-Try Rate', fmt: fmtPct   },
    { key: 'medianContextUsage', label: 'Context Usage',  fmt: fmtPct   },
  ];

  // Hardcoded class literals keyed from server enum — perMetric value is only
  // ever used as a lookup key, never concatenated into a class name directly.
  const DELTA_CLS  = {
    better: 'exp-cc-delta--better',
    worse:  'exp-cc-delta--worse',
    same:   'exp-cc-delta--same',
    na:     'exp-cc-delta--same',
  };
  const DELTA_WORD = { better: 'better', worse: 'worse', same: '=', na: '—' };

  const grid = el('div', 'exp-cc-grid');

  const sides = [
    { role: 'Champion',   data: promo.champion,   cardCls: 'exp-cc-card exp-cc-card--champion',   isChallenger: false },
    { role: 'Challenger', data: promo.challenger, cardCls: 'exp-cc-card exp-cc-card--challenger', isChallenger: true  },
  ];

  for (const { role, data, cardCls, isChallenger } of sides) {
    const card = el('div', cardCls);

    const roleEl = el('div', 'exp-cc-role');
    setText(roleEl, role);
    card.appendChild(roleEl);

    const unitEl = el('div', 'exp-cc-unit');
    setText(unitEl, data.unit ?? '—');
    card.appendChild(unitEl);

    const nEl = el('div', 'exp-cc-n');
    setText(nEl, (data.n ?? 0) + ' outcome' + (data.n === 1 ? '' : 's'));
    card.appendChild(nEl);

    const metricsWrap = el('div', 'exp-cc-metrics');

    for (const { key, label, fmt } of METRICS) {
      const metRow = el('div', 'exp-cc-metric-row');

      const labelEl = el('span', 'exp-cc-metric-label');
      setText(labelEl, label);
      metRow.appendChild(labelEl);

      const valEl = el('span', 'exp-cc-value');
      setText(valEl, fmt(data[key]));
      metRow.appendChild(valEl);

      // Challenger metrics get a delta annotation — color is not the only signal.
      if (isChallenger) {
        const deltaKey = promo.perMetric?.[key];
        const dCls  = DELTA_CLS[deltaKey]  ?? 'exp-cc-delta--same';
        const dWord = DELTA_WORD[deltaKey] ?? '—';
        const deltaEl = el('span', 'exp-cc-delta ' + dCls);
        setText(deltaEl, dWord);
        metRow.appendChild(deltaEl);
      }

      metricsWrap.appendChild(metRow);
    }

    card.appendChild(metricsWrap);
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

function buildChampionChallenger(promo) {
  const panel = buildPanel('Champion vs Challenger');

  // Fetch failed or endpoint not present yet
  if (!promo) {
    panel.appendChild(el('div', 'an-empty', 'Promotion data unavailable.'));
    return panel;
  }

  // Fewer than two units — show server reason; no picker until we have units
  if (!promo.available) {
    panel.appendChild(el('div', 'an-empty',
      promo.reason ?? 'Need at least two units to compare.'));
    return panel;
  }

  // ── Picker row (stable — never rebuilt when results re-render) ─────────────
  // Uses .hist-select for select styling (already defined); layout via
  // .exp-cc-picker / .exp-cc-picker-group / .exp-cc-picker-label.
  const picker = el('div', 'exp-cc-picker');

  // Champion group
  const champGroup = el('div', 'exp-cc-picker-group');
  const champLabel = el('label', 'exp-cc-picker-label', 'Champion');
  champLabel.htmlFor = 'exp-cc-sel-champ';
  const champSel = document.createElement('select');
  champSel.id        = 'exp-cc-sel-champ';
  champSel.className = 'hist-select exp-cc-picker-select';
  champGroup.appendChild(champLabel);
  champGroup.appendChild(champSel);

  // Challenger group
  const chalGroup = el('div', 'exp-cc-picker-group');
  const chalLabel = el('label', 'exp-cc-picker-label', 'Challenger');
  chalLabel.htmlFor = 'exp-cc-sel-chal';
  const chalSel = document.createElement('select');
  chalSel.id        = 'exp-cc-sel-chal';
  chalSel.className = 'hist-select exp-cc-picker-select';
  chalGroup.appendChild(chalLabel);
  chalGroup.appendChild(chalSel);

  // Populate options from promo.units — textContent only, .value set directly
  for (const u of (promo.units ?? [])) {
    const optC = document.createElement('option');
    optC.textContent = u.unit;
    optC.value = u.unit;
    champSel.appendChild(optC);

    const optH = document.createElement('option');
    optH.textContent = u.unit;
    optH.value = u.unit;
    chalSel.appendChild(optH);
  }

  // Pre-select the server's default champion / challenger
  champSel.value = promo.champion.unit;
  chalSel.value  = promo.challenger.unit;

  picker.appendChild(champGroup);
  picker.appendChild(chalGroup);
  panel.appendChild(picker);

  // ── Results container (re-rendered on change; picker stays stable) ─────────
  const resultsContainer = el('div', 'exp-cc-results');
  renderCCResults(resultsContainer, promo);
  panel.appendChild(resultsContainer);

  // ── Change handler ─────────────────────────────────────────────────────────
  async function onPickerChange() {
    const champ = champSel.value;
    const chal  = chalSel.value;

    // Guard: same unit selected for both roles
    if (champ === chal) {
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(
        el('div', 'an-empty', 'Pick two different units to compare.')
      );
      return;
    }

    // Loading state
    resultsContainer.innerHTML = '';
    resultsContainer.appendChild(el('div', 'an-empty', 'Loading…'));

    let newPromo;
    try {
      const r = await fetch(
        '/api/promotion?champion=' + encodeURIComponent(champ) +
        '&challenger=' + encodeURIComponent(chal)
      );
      if (!r.ok) throw new Error('promotion ' + r.status);
      newPromo = await r.json();
    } catch (_) {
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(
        el('div', 'an-empty', 'Failed to load comparison.')
      );
      return;
    }

    resultsContainer.innerHTML = '';
    renderCCResults(resultsContainer, newPromo);
  }

  champSel.addEventListener('change', onPickerChange);
  chalSel.addEventListener('change', onPickerChange);

  return panel;
}

// ── Section 4: Eval / Replay Set ──────────────────────────────────────────────
function buildReplaySet(tasks) {
  const panel = buildPanel('Eval / Replay Set');

  if (!tasks.length) {
    panel.appendChild(el('div', 'an-empty', 'No replay tasks registered yet.'));
    return panel;
  }

  const list = el('div', 'exp-replay-list');

  for (const task of tasks) {
    const row = el('div', 'exp-replay-row');

    const idEl = el('span', 'exp-replay-id');
    setText(idEl, task.id ?? '?');
    row.appendChild(idEl);

    const projEl = el('span', 'exp-replay-project');
    setText(projEl, task.project ?? '—');
    row.appendChild(projEl);

    if (task.baseline) {
      const baseEl = el('span', 'exp-replay-baseline');
      setText(baseEl, 'baseline: ' + task.baseline);
      row.appendChild(baseEl);
    }

    list.appendChild(row);
  }

  panel.appendChild(list);
  return panel;
}

// ── Main entry ────────────────────────────────────────────────────────────────
export async function renderExperiments(container) {
  if (!container) return;
  container.innerHTML = '';
  // Add layout class without clobbering the structural `view` class that
  // showView() toggles. Same pattern as lrn-root in learning.js.
  container.classList.add('an-root');

  // Page header
  const header = el('div', 'exp-header');
  header.appendChild(el('span', 'exp-header-title', 'Experiments'));
  container.appendChild(header);

  // Loading indicator while we fetch
  const loading = el('div', 'an-empty', 'Loading…');
  container.appendChild(loading);

  // Fetch /api/outcomes, /api/replay, and /api/promotion in parallel.
  // /api/replay and /api/promotion are best-effort; failures fall back to null.
  let outcomesData, replayData, promotionData;
  [outcomesData, replayData, promotionData] = await Promise.allSettled([
    fetch('/api/outcomes').then(r => {
      if (!r.ok) throw new Error('outcomes ' + r.status);
      return r.json();
    }),
    fetch('/api/replay').then(r => {
      if (!r.ok) throw new Error('replay ' + r.status);
      return r.json();
    }),
    fetch('/api/promotion').then(r => {
      if (!r.ok) throw new Error('promotion ' + r.status);
      return r.json();
    }),
  ]).then(([o, r, p]) => [
    o.status === 'fulfilled' ? o.value : null,
    r.status === 'fulfilled' ? r.value : null,
    p.status === 'fulfilled' ? p.value : null,
  ]);

  loading.remove();

  const outcomes = outcomesData?.outcomes ?? [];
  const replayTasks = replayData?.tasks ?? [];

  // 1) Harness Quality — delegates to outcomes.js (fetches /api/outcomes/summary)
  container.appendChild(await buildHarnessQuality());

  // 2) Outcomes table
  container.appendChild(buildOutcomesTable(outcomes));

  // 3) Champion vs Challenger — uses /api/promotion verdict
  container.appendChild(buildChampionChallenger(promotionData));

  // 4) Eval / Replay Set
  container.appendChild(buildReplaySet(replayTasks));
}
