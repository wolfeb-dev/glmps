// web/budget.js
// Usage panel — renderUsage(container, data)
// Matches the official Claude Code extension usage panel.
// Fetches via fetchBudget() from api.js when called from renderAnalytics.
// Pure DOM construction: createElement / textContent ONLY.
// innerHTML = '' is used only to clear containers (no data assigned to innerHTML).

import { fetchBudget } from './api.js';

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function setText(node, s) {
  node.textContent = String(s ?? '');
}

// ── Plan tier label ───────────────────────────────────────────
function fmtPlan(tier) {
  if (!tier) return null;
  if (tier === 'default_claude_max_5x')  return 'Claude Max 5x';
  if (tier === 'default_claude_max_20x') return 'Max 20x';
  if (tier === 'pro') return 'Pro';
  // Fallback: capitalise first letter, strip "default_claude_" prefix
  const cleaned = tier.replace(/^default_claude_/, '').replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ── Reset countdown from ms epoch ────────────────────────────
function fmtReset(resetsAt) {
  if (!resetsAt) return null;
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return 'soon';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return 'in ' + diffMin + 'm';
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 48) return 'in ' + diffH + 'h';
  const diffD = Math.floor(diffH / 24);
  return 'in ' + diffD + 'd';
}

// ── Bar fill class: normal (<80%) vs warn (>=80%) ─────────────
function fillClass(pct) {
  return pct >= 80 ? 'usage-bar-fill usage-bar-fill-warn' : 'usage-bar-fill usage-bar-fill-normal';
}

function pctTextClass(pct) {
  return pct >= 80 ? 'usage-bar-pct usage-bar-pct-warn' : 'usage-bar-pct';
}

// ── Build one bar row ─────────────────────────────────────────
function buildBar(label, limiter) {
  if (!limiter) return null;

  const pct = Math.floor(limiter.usedPercent ?? 0);

  const row = el('div', 'usage-bar-row');

  // Label + % line
  const top = el('div', 'usage-bar-top');

  const labelEl = el('span', 'usage-bar-label');
  setText(labelEl, label);
  top.appendChild(labelEl);

  const pctEl = el('span', pctTextClass(pct));
  setText(pctEl, pct + '%');
  top.appendChild(pctEl);

  row.appendChild(top);

  // Track + fill
  const track = el('div', 'usage-bar-track');
  const fill = el('div', fillClass(pct));
  fill.style.width = Math.min(100, pct) + '%';
  track.appendChild(fill);
  row.appendChild(track);

  // Reset countdown
  const reset = fmtReset(limiter.resetsAt);
  if (reset) {
    const resetEl = el('div', 'usage-bar-reset');
    setText(resetEl, 'Resets ' + reset);
    row.appendChild(resetEl);
  }

  return row;
}

// ── Build flag chips ──────────────────────────────────────────
function buildFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return null;

  const wrap = el('div', 'usage-flags');
  for (const flag of flags) {
    const chip = el('span', 'usage-flag-chip usage-flag-chip-' + (flag.severity ?? 'info'));
    setText(chip, flag.message ?? flag.code ?? flag.severity ?? 'flag');
    wrap.appendChild(chip);
  }
  return wrap;
}

/**
 * renderUsage(container, data)
 *
 * Renders the Usage panel into container.
 * data is the shape returned by GET /api/budget.
 */
export function renderUsage(container, data) {
  container.innerHTML = '';

  const root = el('div', 'usage-root');

  // ── USAGE heading ─────────────────────────────────────────
  const card = el('div', 'usage-card');

  const heading = el('div', 'usage-heading');
  setText(heading, 'USAGE');
  card.appendChild(heading);

  // Not-available guard
  if (!data?.available) {
    const note = el('div', 'usage-unavailable');
    setText(note, 'Usage tracking requires an active Claude.ai session');
    card.appendChild(note);
    root.appendChild(card);
    container.appendChild(root);
    return;
  }

  // ── Plan + model header line ──────────────────────────────
  const plan = data?.plan ?? null;
  const meta = data?.meta ?? null;

  if (plan || meta) {
    const metaRow = el('div', 'usage-meta-row');

    const planLabel = fmtPlan(plan?.rateLimitTier);
    if (planLabel) {
      const planChip = el('span', 'usage-plan-chip');
      setText(planChip, planLabel);
      metaRow.appendChild(planChip);
    }

    if (meta?.model) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '·');
      metaRow.appendChild(sep);

      const modelEl = el('span', 'usage-meta-model');
      setText(modelEl, meta.model);
      metaRow.appendChild(modelEl);
    }

    if (meta?.contextPercent != null) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '·');
      metaRow.appendChild(sep);

      const ctxEl = el('span', 'usage-meta-ctx');
      setText(ctxEl, meta.contextPercent + '% context');
      metaRow.appendChild(ctxEl);
    }

    if (meta?.costUsd != null && meta.costUsd > 0) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '·');
      metaRow.appendChild(sep);

      const costEl = el('span', 'usage-meta-cost');
      setText(costEl, '$' + meta.costUsd.toFixed(2) + ' session');
      metaRow.appendChild(costEl);
    }

    if (metaRow.childNodes.length > 0) card.appendChild(metaRow);
  }

  // ── Progress bars: Session (5hr), Weekly (7 day), Weekly Sonnet ──
  const usage = data?.usage ?? {};
  const barsWrap = el('div', 'usage-bars');

  const bar1 = buildBar('Session (5hr)', usage.fiveHour);
  const bar2 = buildBar('Weekly (7 day)', usage.sevenDay);
  const bar3 = buildBar('Weekly Sonnet', usage.sevenDaySonnet);

  let hasBars = false;
  if (bar1) { barsWrap.appendChild(bar1); hasBars = true; }
  if (bar2) { barsWrap.appendChild(bar2); hasBars = true; }
  if (bar3) { barsWrap.appendChild(bar3); hasBars = true; }

  if (hasBars) card.appendChild(barsWrap);

  // ── Flags ─────────────────────────────────────────────────
  const flagEl = buildFlags(data?.flags);
  if (flagEl) card.appendChild(flagEl);

  // ── Manage link + updated timestamp ──────────────────────
  const manageRow = el('div', 'usage-manage-row');

  const link = el('a', 'usage-manage-link');
  link.href = 'https://claude.ai/settings/usage';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  setText(link, 'Manage usage on claude.ai');
  manageRow.appendChild(link);

  if (data?.updatedTs) {
    const d = new Date(data.updatedTs);
    if (!isNaN(d.getTime())) {
      const tsEl = el('span', 'usage-updated-ts');
      setText(tsEl, 'Updated ' + d.toLocaleTimeString());
      manageRow.appendChild(tsEl);
    }
  }

  card.appendChild(manageRow);

  root.appendChild(card);
  container.appendChild(root);
}

// ── Convenience: fetch + render in one shot ───────────────────
export async function fetchAndRenderUsage(container) {
  let data;
  try {
    data = await fetchBudget();
  } catch {
    // Render unavailable state on error
    data = { available: false };
  }
  renderUsage(container, data);
  return data;
}
