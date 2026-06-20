// web/learning.js
// Learning queue view — renderLearning(root, data, handlers)
// Pure DOM construction: createElement / textContent ONLY.
// innerHTML = '' is used only to clear containers (no data assigned to innerHTML).

function setText(el, s) { el.textContent = String(s ?? ''); }

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function chip(label, extraClass) {
  const span = el('span', 'chip lrn-chip ' + (extraClass || ''));
  setText(span, label);
  return span;
}

function severityChip(item) {
  if (item.source === 'idea') return chip('idea', 'lrn-chip-idea');
  if (item.severity === 'warn') return chip('gap warn', 'lrn-chip-warn');
  return chip('gap info', 'lrn-chip-info');
}

function statusNote(status) {
  if (status === 'dispatched') return '[dispatching to hand...]';
  if (status === 'failed') return '[failed]';
  return null;
}

function shortSha(sha) {
  if (!sha) return '';
  return sha.slice(0, 7);
}

// Build one Pending item card
function buildPendingCard(item, handlers) {
  const card = el('div', 'lrn-card lrn-card-pending');

  // Top row: chip + title + recurrence badge
  const topRow = el('div', 'lrn-card-top');
  topRow.appendChild(severityChip(item));

  const title = el('span', 'lrn-card-title');
  setText(title, item.title || '(untitled)');
  topRow.appendChild(title);

  if ((item.count || 1) > 1) {
    const badge = el('span', 'lrn-recurrence-badge');
    setText(badge, '×' + item.count);
    topRow.appendChild(badge);
  }

  const note = statusNote(item.status);
  if (note) {
    const noteEl = el('span', 'lrn-status-note');
    setText(noteEl, note);
    topRow.appendChild(noteEl);
  }

  card.appendChild(topRow);

  // Body text
  if (item.body) {
    const body = el('p', 'lrn-card-body');
    setText(body, item.body);
    card.appendChild(body);
  }

  // Meta row: project + error if failed
  if (item.project || item.sessionId) {
    const meta = el('div', 'lrn-card-meta');
    if (item.project) {
      const proj = el('span', 'lrn-card-project');
      setText(proj, item.project);
      meta.appendChild(proj);
    }
    card.appendChild(meta);
  }

  if (item.status === 'failed' && item.error) {
    const errEl = el('div', 'lrn-card-error');
    setText(errEl, item.error);
    card.appendChild(errEl);
  }

  // Proposed guard preview
  if (item.proposedGuard?.rule) {
    const preview = el('div', 'lrn-guard-preview');
    const previewLabel = el('span', 'lrn-guard-label');
    setText(previewLabel, 'proposed guard');
    preview.appendChild(previewLabel);
    const previewCode = el('code', 'lrn-guard-rule');
    setText(previewCode, item.proposedGuard.rule);
    preview.appendChild(previewCode);
    card.appendChild(preview);
  }

  // Alternative editor (hidden by default)
  const altSection = el('div', 'lrn-alt-section lrn-alt-hidden');
  const altTextarea = el('textarea', 'lrn-alt-textarea');
  altTextarea.rows = 3;
  altTextarea.placeholder = 'Enter guard rule...';
  setText(altTextarea, item.proposedGuard?.rule || '');
  altSection.appendChild(altTextarea);

  const altSaveRow = el('div', 'lrn-alt-save-row');
  const saveBtn = el('button', 'lrn-btn lrn-btn-save');
  setText(saveBtn, 'Save alternative');
  saveBtn.addEventListener('click', () => {
    const rule = altTextarea.value.trim();
    if (rule) handlers.onAction(item.id, 'alternative', rule);
  });
  const cancelBtn = el('button', 'lrn-btn lrn-btn-cancel');
  setText(cancelBtn, 'Cancel');
  cancelBtn.addEventListener('click', () => {
    altSection.classList.add('lrn-alt-hidden');
    altToggleBtn.classList.remove('lrn-btn-active');
  });
  altSaveRow.appendChild(saveBtn);
  altSaveRow.appendChild(cancelBtn);
  altSection.appendChild(altSaveRow);
  card.appendChild(altSection);

  // Promote section (hidden by default) — lift this learning to a broader scope so
  // all agents see it: a deterministic guard in global CLAUDE.md, or an agent-composed
  // memory note.
  const promoteSection = el('div', 'lrn-alt-section lrn-alt-hidden');
  const promoteLabel = el('span', 'lrn-guard-label');
  setText(promoteLabel, 'promote to');
  promoteSection.appendChild(promoteLabel);
  const promoteRow = el('div', 'lrn-alt-save-row');
  const promoteGlobalBtn = el('button', 'lrn-btn lrn-btn-promote');
  setText(promoteGlobalBtn, 'Global CLAUDE.md');
  promoteGlobalBtn.addEventListener('click', () => handlers.onAction(item.id, 'promote', 'global'));
  const promoteMemoryBtn = el('button', 'lrn-btn lrn-btn-promote');
  setText(promoteMemoryBtn, 'Memory');
  promoteMemoryBtn.addEventListener('click', () => handlers.onAction(item.id, 'promote', 'memory'));
  promoteRow.appendChild(promoteGlobalBtn);
  promoteRow.appendChild(promoteMemoryBtn);
  promoteSection.appendChild(promoteRow);
  card.appendChild(promoteSection);

  // Action buttons
  const actions = el('div', 'lrn-card-actions');

  const approveBtn = el('button', 'lrn-btn lrn-btn-approve');
  setText(approveBtn, 'Approve');
  approveBtn.addEventListener('click', () => handlers.onAction(item.id, 'approve'));
  actions.appendChild(approveBtn);

  const discardBtn = el('button', 'lrn-btn lrn-btn-discard');
  setText(discardBtn, 'Discard');
  discardBtn.addEventListener('click', () => handlers.onAction(item.id, 'discard'));
  actions.appendChild(discardBtn);

  var altToggleBtn = el('button', 'lrn-btn lrn-btn-alt');
  setText(altToggleBtn, 'Alternative');
  altToggleBtn.addEventListener('click', () => {
    const hidden = altSection.classList.toggle('lrn-alt-hidden');
    altToggleBtn.classList.toggle('lrn-btn-active', !hidden);
    if (!hidden) altTextarea.focus();
  });
  actions.appendChild(altToggleBtn);

  var promoteToggleBtn = el('button', 'lrn-btn lrn-btn-promote');
  setText(promoteToggleBtn, 'Promote');
  promoteToggleBtn.addEventListener('click', () => {
    const hidden = promoteSection.classList.toggle('lrn-alt-hidden');
    promoteToggleBtn.classList.toggle('lrn-btn-active', !hidden);
  });
  actions.appendChild(promoteToggleBtn);

  card.appendChild(actions);
  return card;
}

// Build one Applied item card
function buildAppliedCard(item) {
  const card = el('div', 'lrn-card lrn-card-applied');

  const topRow = el('div', 'lrn-card-top');
  topRow.appendChild(severityChip(item));

  const title = el('span', 'lrn-card-title');
  setText(title, item.title || '(untitled)');
  topRow.appendChild(title);

  if (item.applyCommit) {
    const sha = el('code', 'lrn-commit-sha');
    setText(sha, shortSha(item.applyCommit));
    topRow.appendChild(sha);
  }

  card.appendChild(topRow);

  if (item.body) {
    const body = el('p', 'lrn-card-body');
    setText(body, item.body);
    card.appendChild(body);
  }

  if (item.project) {
    const meta = el('div', 'lrn-card-meta');
    const proj = el('span', 'lrn-card-project');
    setText(proj, item.project);
    meta.appendChild(proj);
    card.appendChild(meta);
  }

  return card;
}

// Build one Discarded item card (compact)
function buildDiscardedCard(item) {
  const card = el('div', 'lrn-card lrn-card-discarded');

  const topRow = el('div', 'lrn-card-top');
  topRow.appendChild(severityChip(item));

  const title = el('span', 'lrn-card-title');
  setText(title, item.title || '(untitled)');
  topRow.appendChild(title);

  card.appendChild(topRow);
  return card;
}

// Section heading with the panel-title style (gold left-border, uppercase muted)
function buildSectionHead(label, count) {
  const head = el('div', 'lrn-section-head');
  const text = el('span', 'lrn-section-label');
  setText(text, label);
  head.appendChild(text);
  const badge = el('span', 'lrn-section-count');
  setText(badge, String(count));
  head.appendChild(badge);
  return head;
}

// Empty state placeholder
function buildEmpty(msg) {
  const p = el('p', 'lrn-empty');
  setText(p, msg);
  return p;
}

/**
 * renderLearning(root, data, handlers)
 *
 * @param {HTMLElement} root        - container to render into
 * @param {{ items: Array, config: { autoApplyGaps: boolean } }} data
 * @param {{ onIdea(text), onAction(id, action, rule?), onToggle(autoApplyGaps) }} handlers
 */
export function renderLearning(root, data, handlers) {
  // Clear the root — only innerHTML = '' to clear; no data assigned
  root.innerHTML = '';
  root.className = 'lrn-root';

  const items = data?.items ?? [];
  const config = data?.config ?? {};

  const pending   = items.filter(i => i.status === 'pending' || i.status === 'dispatched' || i.status === 'failed');
  const applied   = items.filter(i => i.status === 'applied');
  const discarded = items.filter(i => i.status === 'discarded');

  // ── Header ──────────────────────────────────────────────
  const header = el('div', 'lrn-header');

  // Left: title + pending count badge
  const headerLeft = el('div', 'lrn-header-left');
  const headTitle = el('span', 'lrn-header-title');
  setText(headTitle, 'Learning Queue');
  headerLeft.appendChild(headTitle);

  if (pending.length > 0) {
    const countBadge = el('span', 'lrn-pending-count');
    setText(countBadge, String(pending.length));
    headerLeft.appendChild(countBadge);
  }
  header.appendChild(headerLeft);

  // Right: auto-apply toggle + idea input
  const headerRight = el('div', 'lrn-header-right');

  // Toggle
  const toggleLabel = el('label', 'lrn-toggle-label');
  const toggleInput = el('input');
  toggleInput.type = 'checkbox';
  toggleInput.className = 'lrn-toggle-input';
  toggleInput.checked = !!config.autoApplyGaps;
  toggleInput.addEventListener('change', () => handlers.onToggle(toggleInput.checked));
  const toggleTrack = el('span', 'lrn-toggle-track');
  const toggleThumb = el('span', 'lrn-toggle-thumb');
  toggleTrack.appendChild(toggleThumb);
  const toggleText = el('span', 'lrn-toggle-text');
  setText(toggleText, 'Auto-apply gaps');
  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleTrack);
  toggleLabel.appendChild(toggleText);
  headerRight.appendChild(toggleLabel);

  // Idea input
  const ideaRow = el('div', 'lrn-idea-row');
  const ideaInput = el('input', 'lrn-idea-input');
  ideaInput.type = 'text';
  ideaInput.placeholder = 'Add a learning idea...';

  const ideaBtn = el('button', 'lrn-btn lrn-btn-idea');
  setText(ideaBtn, 'Add');

  const submitIdea = () => {
    const text = ideaInput.value.trim();
    if (!text) return;
    handlers.onIdea(text);
    ideaInput.value = '';
  };
  ideaBtn.addEventListener('click', submitIdea);
  ideaInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitIdea(); });

  ideaRow.appendChild(ideaInput);
  ideaRow.appendChild(ideaBtn);
  headerRight.appendChild(ideaRow);

  header.appendChild(headerRight);
  root.appendChild(header);

  // ── Pending section ─────────────────────────────────────
  const pendingSection = el('div', 'lrn-section');
  pendingSection.appendChild(buildSectionHead('Pending', pending.length));
  if (pending.length === 0) {
    pendingSection.appendChild(buildEmpty('No pending items.'));
  } else {
    const list = el('div', 'lrn-card-list');
    for (const item of pending) {
      list.appendChild(buildPendingCard(item, handlers));
    }
    pendingSection.appendChild(list);
  }
  root.appendChild(pendingSection);

  // ── Applied section ─────────────────────────────────────
  const appliedSection = el('div', 'lrn-section');
  appliedSection.appendChild(buildSectionHead('Applied', applied.length));
  if (applied.length === 0) {
    appliedSection.appendChild(buildEmpty('No applied guards yet.'));
  } else {
    const list = el('div', 'lrn-card-list');
    for (const item of applied) {
      list.appendChild(buildAppliedCard(item));
    }
    appliedSection.appendChild(list);
  }
  root.appendChild(appliedSection);

  // ── Discarded section (collapsed) ───────────────────────
  const discardedDetails = el('details', 'lrn-section lrn-section-discarded');
  const discardedSummary = el('summary', 'lrn-discarded-summary');

  const discardHead = buildSectionHead('Discarded', discarded.length);
  discardHead.className = 'lrn-section-head lrn-section-head-inline';
  discardedSummary.appendChild(discardHead);
  discardedDetails.appendChild(discardedSummary);

  if (discarded.length > 0) {
    const list = el('div', 'lrn-card-list lrn-discarded-list');
    for (const item of discarded) {
      list.appendChild(buildDiscardedCard(item));
    }
    discardedDetails.appendChild(list);
  } else {
    const emp = buildEmpty('Nothing discarded.');
    discardedDetails.appendChild(emp);
  }
  root.appendChild(discardedDetails);
}
