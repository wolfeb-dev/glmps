// web/engagement.js
// Engagement tier section — renderEngagement(container, data)
// XSS discipline: ALL endpoint data goes through textContent/createElement.
// innerHTML = '' is the ONLY innerHTML use (container clear). No data in innerHTML.

export { renderEngagement };

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function txt(tag, cls, text) {
  const n = el(tag, cls);
  n.textContent = String(text ?? '');
  return n;
}

const TIER_LABELS = {
  artifact:  'Artifact',
  brain:     'Durable Brain',
  ephemeral: 'Ephemeral',
};

// Map policy value to CSS modifier class
const POLICY_CLS = {
  gate:      'eng-policy-gate',
  versioned: 'eng-policy-versioned',
  readonly:  'eng-policy-readonly',
};

function buildTierGroup(tierKey, tierData, policyValue) {
  const roots = Array.isArray(tierData?.roots) ? tierData.roots : [];
  const count = roots.length;

  const details = el('details', 'eng-tier');
  // Open by default when the tier has at least one root so content is visible on first load
  if (count > 0) details.open = true;

  const summary = el('summary', 'eng-tier-summary');

  // Arrow indicator via ::before CSS — no emoji, no SVG dep
  const labelEl = txt('span', 'eng-tier-label', TIER_LABELS[tierKey] ?? tierKey);
  summary.appendChild(labelEl);

  const countEl = txt('span', 'eng-tier-count', String(count));
  summary.appendChild(countEl);

  const policyCls = 'eng-policy-chip ' + (POLICY_CLS[policyValue] ?? 'eng-policy-readonly');
  const policyChip = txt('span', policyCls, policyValue ?? '');
  summary.appendChild(policyChip);

  details.appendChild(summary);

  const body = el('div', 'eng-tier-body');

  if (count === 0) {
    const empty = txt('p', 'eng-tier-empty', 'No roots configured');
    body.appendChild(empty);
  } else {
    const list = el('ul', 'eng-roots-list');
    for (const root of roots) {
      const item = el('li', 'eng-root-item');
      const pathEl = txt('code', 'eng-root-path', root);
      item.appendChild(pathEl);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  details.appendChild(body);
  return details;
}

function renderEngagement(container, data) {
  container.innerHTML = ''; // clear only — no data assigned to innerHTML

  if (!data || typeof data !== 'object') {
    container.appendChild(txt('p', 'eng-error', 'Engagement data unavailable'));
    return;
  }

  const wrap = el('div', 'eng-panel');

  // ── Header: engagement name + controllable badge ──
  const header = el('div', 'eng-header');

  const nameEl = txt('h2', 'eng-name', data.engagement ?? 'default');
  header.appendChild(nameEl);

  const isActing = !!data.controllable;
  const badgeCls = 'eng-badge ' + (isActing ? 'eng-badge-acting' : 'eng-badge-observe');
  const badgeLabel = isActing ? 'acting' : 'observe-only';
  const badge = txt('span', badgeCls, badgeLabel);
  header.appendChild(badge);

  wrap.appendChild(header);

  // ── Identity row (only when at least one field is set) ──
  const id = data.identity;
  if (id && (id.handle || id.name || id.email)) {
    const idRow = el('div', 'eng-identity');

    const display = id.name || id.handle;
    if (display) {
      idRow.appendChild(txt('span', 'eng-identity-handle', display));
    }
    if (id.email) {
      idRow.appendChild(txt('span', 'eng-identity-email', id.email));
    }

    wrap.appendChild(idRow);
  }

  // ── Three tier groups: artifact / brain / ephemeral ──
  const tiers = data.tiers ?? {};
  const policy = data.mutationPolicy ?? {};

  const tiersSection = el('div', 'eng-tiers');

  for (const key of ['artifact', 'brain', 'ephemeral']) {
    tiersSection.appendChild(buildTierGroup(key, tiers[key], policy[key]));
  }

  wrap.appendChild(tiersSection);
  container.appendChild(wrap);
}
