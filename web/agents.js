// web/agents.js — Dashboard view: agent architecture map + live progress
// XSS rule: all user/file data goes through textContent/createElement.
// innerHTML='' used ONLY to clear elements (safe per project XSS discipline).

import { getAgents, getLearning, getProjects, addBacklogItem, postTerminal, getState, rebuildGraph, getConfig } from './api.js';
import { sessionColor } from './session-color.js';
import { mostRecentSessionId } from './grid.js';

// ── DOM helpers ───────────────────────────────────────────────────────────────
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function txt(s) { return document.createTextNode(String(s ?? '')); }
function setText(node, s) { node.textContent = String(s ?? ''); }
function chip(cls, label) {
  const c = el('span', cls);
  setText(c, label);
  return c;
}
function safeInnerClear(node) { node.innerHTML = ''; }

// ── Chip factories ────────────────────────────────────────────────────────────
function accBadge(access) {
  if (access === 'write')     return chip('dash-acc dash-acc-wr',  'WR');
  if (access === 'read-only') return chip('dash-acc dash-acc-ro',  'RO');
  return chip('dash-acc dash-acc-ext', 'EXT');
}

function modelTierBadge(model, reasoning, runtime) {
  if (runtime === 'antigravity') {
    const w = el('span', '');
    w.style.cssText = 'display:inline-flex;gap:3px;align-items:center;';
    w.appendChild(chip('dash-tier dash-tier-gemini', 'Gemini'));
    if (reasoning === 'max') w.appendChild(chip('dash-tier dash-tier-max', 'max'));
    return w;
  }
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus'))   return chip('dash-tier dash-tier-opus',   'Opus');
  if (m.includes('sonnet')) return chip('dash-tier dash-tier-sonnet', 'Sonnet');
  if (m.includes('haiku'))  return chip('dash-tier dash-tier-haiku',  'Haiku');
  return null;
}

function toolChipEl(toolName) {
  const isWrite = ['Edit','Write','Bash','git','gh'].includes(toolName) || toolName === '*';
  const c = el('span', isWrite ? 'dash-tchip dash-tchip-wr' : 'dash-tchip');
  setText(c, toolName);
  return c;
}

// ── SVG namespace helpers ─────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag) { return document.createElementNS(NS, tag); }
function svgAttr(el, attrs) { for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }

// ── One agent card ────────────────────────────────────────────────────────────
function buildAgentCard(agent, acCls) {
  const card = el('div', `dash-agent-card ${acCls}`);
  card.tabIndex = 0;

  const top = el('div', 'dash-card-top');
  const nameEl = el('span', 'dash-card-name');
  setText(nameEl, agent.name ?? '');
  top.appendChild(nameEl);
  top.appendChild(accBadge(agent.access));
  if (agent.runtime === 'antigravity') top.appendChild(chip('dash-runtime-badge', 'Antigravity'));
  if ((agent.dispatchCount ?? 0) > 0) {
    const dc = chip('dash-cnt-badge', `×${agent.dispatchCount}`);
    dc.title = 'times dispatched this session';
    top.appendChild(dc);
  }
  card.appendChild(top);

  const role = el('div', 'dash-card-role');
  const full = agent.role ?? '';
  setText(role, full.length > 120 ? full.slice(0, 117) + '…' : full);
  card.appendChild(role);

  if (Array.isArray(agent.tools) && agent.tools.length > 0) {
    const toolsRow = el('div', 'dash-tools');
    for (const t of agent.tools.slice(0, 6)) toolsRow.appendChild(toolChipEl(t));
    const tier = modelTierBadge(agent.model, agent.reasoning, agent.runtime);
    if (tier) toolsRow.appendChild(tier);
    card.appendChild(toolsRow);
  }

  if (agent.path) {
    card.style.cursor = 'pointer';
    const base = agent.path.replace(/\\/g, '/').split('/').pop() ?? (agent.name + '.md');
    card.title = 'Open ' + base;
    card.addEventListener('click', () => _handlers?.onOpenFile?.(agent.path));
  }

  return card;
}

// ── Lane column (for Execute bubble) ─────────────────────────────────────────
function buildLane(label, colorCls, swColor, agents, acCls) {
  const col = el('div', '');
  col.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;';

  const lbl = el('div', `dash-lane-label ${colorCls}`);
  const sw = el('span', 'dash-lgsw');
  sw.style.background = swColor;
  lbl.appendChild(sw);
  lbl.appendChild(txt(label));
  col.appendChild(lbl);

  for (const agent of agents) {
    const c = buildAgentCard(agent, acCls);
    c.style.cssText = 'flex:1;height:auto;';
    col.appendChild(c);
  }
  return col;
}

// ── Ribbon SVG (all createElementNS, no innerHTML) ───────────────────────────
function buildRibbonSvg() {
  const svg = svgAttr(svgEl('svg'), {
    class: 'dash-ribbon-svg',
    viewBox: '0 0 1700 1140',
    'aria-hidden': 'true',
  });

  const defs = svgEl('defs');
  const gradDefs = [
    { id:'rg-exec',  x1:'0%',y1:'100%',x2:'100%',y2:'0%',   c0:['#d4a437',.85], c1:['#4a8cd8',.92] },
    { id:'rg-adv',   x1:'0%',y1:'0%',  x2:'100%',y2:'0%',   c0:['#d4a437',.82], c1:['#a878d8',.92] },
    { id:'rg-gate',  x1:'0%',y1:'0%',  x2:'100%',y2:'100%', c0:['#d4a437',.82], c1:['#3fb87f',.92] },
    { id:'rg-learn', x1:'0%',y1:'0%',  x2:'100%',y2:'100%', c0:['#d4a437',.88], c1:['#e0a23a',.95] },
  ];
  for (const g of gradDefs) {
    const lg = svgAttr(svgEl('linearGradient'), { id:g.id, x1:g.x1, y1:g.y1, x2:g.x2, y2:g.y2 });
    const s0 = svgAttr(svgEl('stop'), { offset:'0%',   'stop-color':g.c0[0], 'stop-opacity':g.c0[1] });
    const s1 = svgAttr(svgEl('stop'), { offset:'100%', 'stop-color':g.c1[0], 'stop-opacity':g.c1[1] });
    lg.appendChild(s0); lg.appendChild(s1);
    defs.appendChild(lg);
  }
  svg.appendChild(defs);

  // Paths are drawn by drawRibbons() once the (content-sized) bubble centres are known.
  return svg;
}

// Step → ribbon gradient + arrow colour, in DOM order (Execute, Adversarial, Gate, Learning).
const RIBBONS = [
  { grad: 'rg-exec',  arrow: '#4a8cd8' },
  { grad: 'rg-adv',   arrow: '#a878d8' },
  { grad: 'rg-gate',  arrow: '#3fb87f' },
  { grad: 'rg-learn', arrow: '#e0a23a' },
];

// Redraw the orchestrator→bubble ribbons to the measured bubble centres.
// The orchestrator anchor band is fixed (right edge x=490, vertical centre 580).
function drawRibbons(svg, centers) {
  if (!svg) return;
  for (const node of [...svg.querySelectorAll('path, polygon')]) node.remove();
  centers.forEach((cy, i) => {
    const cfg = RIBBONS[i];
    if (!cfg) return;
    const d = `M 490,548 C 512,548 512,${cy - 20} 534,${cy - 20} `
            + `L 534,${cy + 20} C 512,${cy + 20} 512,612 490,612 Z`;
    svg.appendChild(svgAttr(svgEl('path'), { d, fill: `url(#${cfg.grad})` }));
    svg.appendChild(svgAttr(svgEl('polygon'),
      { points: `528,${cy - 4} 540,${cy} 528,${cy + 4}`, fill: cfg.arrow, opacity: '.92' }));
  });
}

// Grow each step bubble to fit its content, restack them top-to-bottom, resize the
// canvas, and redraw the ribbons to the new centres. In the narrow (<=760px) layout
// the CSS switches the nodes to normal flow, so we just clear the inline geometry.
function layoutBubbles(canvas) {
  if (!canvas) return;
  const svg = canvas.querySelector('.dash-ribbon-svg');
  const bubbles = [...canvas.querySelectorAll('.dash-branch-bubble')];
  const scroll = canvas.parentElement;   // .dash-graph-scroll
  const CANVAS_W = 1700;

  if (!window.matchMedia('(min-width: 761px)').matches) {
    // Narrow layout: CSS switches to normal flow; clear all inline geometry/scale.
    for (const b of bubbles) { b.style.top = ''; b.style.height = ''; }
    canvas.style.height = '';
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    canvas.style.marginLeft = '';
    if (scroll) scroll.style.height = '';
    return;
  }
  if (canvas.offsetParent === null) return;   // hidden: keep the default geometry

  const TOP = 22, GAP = 18, ORCH_BOTTOM = 910;
  let y = TOP;
  const centers = [];
  for (const b of bubbles) {
    b.style.height = 'auto';
    b.style.top = y + 'px';
    const h = b.offsetHeight;
    centers.push(y + h / 2);
    y += h + GAP;
  }
  const canvasH = Math.max(y - GAP, ORCH_BOTTOM) + 20;
  canvas.style.height = canvasH + 'px';
  svg?.setAttribute('height', String(canvasH));
  svg?.setAttribute('viewBox', `0 0 1700 ${canvasH}`);
  // The CSS pins the svg element height to 1140px; override it to canvasH so the
  // viewBox maps 1:1 (otherwise the ribbons stretch vertically off the bubbles).
  if (svg) svg.style.height = canvasH + 'px';
  drawRibbons(svg, centers);

  // Scale the whole graph to fit the available width so Section A never needs its
  // own horizontal scrollbar. Centre it and collapse the wrapper to the scaled
  // height so Section C sits directly below in the page's single vertical scroll.
  const avail = scroll ? scroll.clientWidth : CANVAS_W;
  const s = Math.min(1, avail / CANVAS_W);
  canvas.style.transformOrigin = 'top left';
  canvas.style.transform = s < 1 ? `scale(${s})` : '';
  canvas.style.marginLeft = Math.max(0, Math.round((avail - CANVAS_W * s) / 2)) + 'px';
  if (scroll) scroll.style.height = Math.ceil(canvasH * s) + 'px';
}

// Re-run the layout on resize (the wide/narrow breakpoint and content widths change
// bubble heights). Bound once; looks up the live canvas via module state.
let _resizeBound = false;
function bindResize() {
  if (_resizeBound) return;
  _resizeBound = true;
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const canvas = _container?.querySelector('#dash-tree-canvas');
      if (canvas) layoutBubbles(canvas);
    }, 150);
  });
}

// ── Radar SVG ─────────────────────────────────────────────────────────────────
function buildRadar() {
  const svg = svgAttr(svgEl('svg'), {
    class: 'dash-radar',
    viewBox: '0 0 168 168',
    'aria-label': 'radar: agent fleet at a glance',
  });

  const defs = svgEl('defs');
  const sweepGrad = svgAttr(svgEl('linearGradient'), { id:'rdr-sweep', x1:'0', y1:'0', x2:'1', y2:'0' });
  const s0 = svgAttr(svgEl('stop'), { offset:'0%',   'stop-color':'#d4a437', 'stop-opacity':'0' });
  const s1 = svgAttr(svgEl('stop'), { offset:'100%', 'stop-color':'#d4a437', 'stop-opacity':'.28' });
  sweepGrad.appendChild(s0); sweepGrad.appendChild(s1);
  defs.appendChild(sweepGrad);
  svg.appendChild(defs);

  function sCircle(cx, cy, r, cls) {
    return svgAttr(svgEl('circle'), { cx, cy, r, class: cls });
  }
  function sLine(x1, y1, x2, y2, cls) {
    return svgAttr(svgEl('line'), { x1, y1, x2, y2, class: cls });
  }

  svg.appendChild(sCircle(84, 84, 78, 'dash-radar-ring faint'));
  svg.appendChild(sCircle(84, 84, 56, 'dash-radar-ring'));
  svg.appendChild(sCircle(84, 84, 32, 'dash-radar-ring faint'));
  svg.appendChild(sLine(84, 6, 84, 162, 'dash-radar-cross'));
  svg.appendChild(sLine(6, 84, 162, 84, 'dash-radar-cross'));

  const sweep = svgEl('g');
  sweep.setAttribute('class', 'dash-radar-sweep');
  sweep.appendChild(svgAttr(svgEl('path'), {
    d: 'M84 84 L84 6 A78 78 0 0 1 150 46 Z',
    fill: 'url(#rdr-sweep)',
  }));
  svg.appendChild(sweep);

  const blips = [
    { cx:120, cy:58,  r:3, fill:'#4a8cd8', cls:'dash-radar-blip' },
    { cx:60,  cy:118, r:3, fill:'#3fb87f', cls:'dash-radar-blip b2' },
    { cx:118, cy:116, r:3, fill:'#a878d8', cls:'dash-radar-blip b3' },
  ];
  for (const b of blips) {
    svg.appendChild(svgAttr(svgEl('circle'), { cx:b.cx, cy:b.cy, r:b.r, fill:b.fill, class:b.cls }));
  }
  svg.appendChild(svgAttr(svgEl('circle'), { cx:84, cy:84, r:3.4, fill:'#d4a437' }));

  return svg;
}

// ── Orchestrator card ─────────────────────────────────────────────────────────
function buildOrchCard(agents, learningData) {
  const skillCount = 70;
  const agentCount = agents.length;

  const root = el('div', 'dash-orch-root');

  // Tab header
  const tab = el('div', 'dash-orch-tab');
  const liveDot = el('span', 'dash-live-dot');
  liveDot.setAttribute('aria-label', 'in use');
  liveDot.style.display = 'none';
  tab.appendChild(liveDot);
  const nameEl = el('span', 'dash-orch-name');
  setText(nameEl, 'Orchestrate');
  tab.appendChild(nameEl);
  tab.appendChild(chip('dash-acc dash-acc-wr', 'write'));
  tab.appendChild(chip('dash-tchip dash-tchip-wr', 'all tools'));
  tab.appendChild(chip('dash-tier dash-tier-opus', 'Opus 4.8'));

  const countRow = el('div', 'dash-pills-row');
  countRow.style.cssText = 'width:100%;padding-left:27px;gap:3px;margin-top:2px;';
  countRow.appendChild(chip('dash-cnt-badge', `${skillCount} skills`));
  countRow.appendChild(chip('dash-cnt-badge', `${agentCount} agents`));
  countRow.appendChild(chip('dash-cnt-badge', 'hooks'));
  countRow.appendChild(chip('dash-cnt-badge', 'MCP'));
  const scanHint = el('span', '');
  scanHint.style.cssText = 'font-family:ui-monospace,monospace;font-size:7.5px;color:var(--muted-fg);';
  setText(scanHint, 'scan surface');
  countRow.appendChild(scanHint);
  tab.appendChild(countRow);
  root.appendChild(tab);

  // Body
  const body = el('div', 'dash-orch-body');

  // Main session identity
  const identCard = el('div', 'dash-orch-id');
  const identTop = el('div', 'dash-card-top');
  identTop.style.marginBottom = '3px';
  const identNameEl = el('span', 'dash-card-name');
  setText(identNameEl, 'Main session');
  identTop.appendChild(identNameEl);
  identCard.appendChild(identTop);
  const identRole = el('div', 'dash-card-role');
  setText(identRole, 'Orchestrator — scans capabilities, dispatches the right specialist, owns the conversation & merge/PR decisions.');
  identCard.appendChild(identRole);
  body.appendChild(identCard);

  body.appendChild(el('hr', 'dash-card-divider'));

  // Sub 1: Capability scan
  const sub1 = el('div', 'dash-orch-sub');
  const sub1Label = el('div', 'dash-orch-sub-label');
  setText(sub1Label, 'Capability scan');
  sub1.appendChild(sub1Label);
  const sub1Desc = el('div', 'dash-card-role');
  sub1Desc.style.fontSize = '10px';
  setText(sub1Desc, 'Scan available skills / agents / hooks / MCP and use what fits.');
  sub1.appendChild(sub1Desc);
  const sub1Src = el('div', 'dash-card-source');
  sub1Src.style.marginTop = '3px';
  setText(sub1Src, 'CLAUDE.md rule · gap-detect.js');
  sub1.appendChild(sub1Src);

  const sub1Pills = el('div', 'dash-pills-row');
  sub1Pills.style.marginTop = '4px';
  const skillPill = chip('dash-tchip', `Skills · ${skillCount}`);
  skillPill.style.cssText = 'color:var(--primary);border-color:rgba(212,164,55,.28);background:rgba(212,164,55,.06);';
  sub1Pills.appendChild(skillPill);
  const agentPill = chip('dash-tchip', `Agents · ${agentCount}`);
  agentPill.style.cssText = 'color:var(--accent);border-color:rgba(168,120,216,.28);background:rgba(168,120,216,.06);';
  sub1Pills.appendChild(agentPill);
  sub1Pills.appendChild(chip('dash-tchip', 'Hooks'));
  sub1Pills.appendChild(chip('dash-tchip', 'MCP'));
  sub1Pills.appendChild(chip('dash-acc dash-acc-ro', 'RO'));
  sub1.appendChild(sub1Pills);

  const exPills = el('div', 'dash-pills-row');
  exPills.style.marginTop = '3px';
  for (const s of ['frontend-design', 'systematic-debugging', 'brainstorming', 'tdd'])
    exPills.appendChild(chip('dash-chip dash-chip-skill', s));
  sub1.appendChild(exPills);

  const inheritBadge = el('div', 'dash-loop-badge');
  inheritBadge.appendChild(txt('↻ inherits guards from last session'));
  sub1.appendChild(inheritBadge);
  body.appendChild(sub1);

  // Sub 2: Skill / agent select
  const sub2 = el('div', 'dash-orch-sub');
  sub2.style.marginTop = '2px';
  const sub2Label = el('div', 'dash-orch-sub-label');
  setText(sub2Label, 'Skill / agent select');
  sub2.appendChild(sub2Label);
  const sub2Desc = el('div', 'dash-card-role');
  sub2Desc.style.fontSize = '10px';
  setText(sub2Desc, 'Route by purpose & model pool; dispatch the right specialist.');
  sub2.appendChild(sub2Desc);
  const sub2Src = el('div', 'dash-card-source');
  sub2Src.style.marginTop = '3px';
  setText(sub2Src, 'guiding.js — reads CLAUDE.md, skills, agents, hooks per-session.');
  sub2.appendChild(sub2Src);

  const selSkills = el('div', 'dash-pills-row');
  selSkills.style.marginTop = '4px';
  for (const s of ['frontend-design', 'systematic-debugging', 'brainstorming', 'tdd'])
    selSkills.appendChild(chip('dash-chip dash-chip-skill', s));
  sub2.appendChild(selSkills);

  const selAgents = el('div', 'dash-pills-row');
  selAgents.style.marginTop = '3px';
  for (const a of agents.slice(0, 5))
    selAgents.appendChild(chip('dash-chip dash-chip-agent', a.name));
  sub2.appendChild(selAgents);

  const sub2Note = el('div', 'dash-card-note');
  sub2Note.style.cssText = 'font-family:ui-monospace,monospace;font-size:9px;color:var(--muted-fg);margin-top:4px;border-left:2px solid rgba(212,164,55,.3);padding-left:6px;';
  setText(sub2Note, 'Opus reserved for hard reasoning. Sonnet implements. Haiku for git/bulk. Adversarial routes to Antigravity (Gemini) — a different model family by design.');
  sub2.appendChild(sub2Note);
  const hint = el('div', '');
  hint.style.cssText = 'font-family:ui-monospace,monospace;font-size:9px;color:var(--muted-fg);margin-top:4px;';
  setText(hint, 'Four branches fan out to the right →');
  sub2.appendChild(hint);
  body.appendChild(sub2);

  root.appendChild(body);
  return root;
}

// ── Execute bubble (blue, step 2) ─────────────────────────────────────────────
function buildExecuteBubble(agents) {
  const scoutAgents   = agents.filter(a => a.group === 'scout');
  const implAgents    = agents.filter(a => a.group === 'implement');
  const gitAgents     = agents.filter(a => a.group === 'git');
  const planAgents    = agents.filter(a => a.group === 'plan');
  const genAgents     = agents.filter(a => a.group === 'general');
  const executeTotal  = scoutAgents.length + implAgents.length + gitAgents.length + planAgents.length + genAgents.length;

  const bubble = el('div', 'dash-branch-bubble dash-tc-node dash-bb-blue');
  bubble.style.cssText = 'left:534px;top:22px;width:1148px;height:320px;';
  bubble.dataset.step = '2';

  // Tab
  const tab = el('div', 'dash-bubble-tab');
  const liveDot = el('span', 'dash-live-dot');
  liveDot.setAttribute('aria-label', 'in use');
  liveDot.style.display = 'none';
  tab.appendChild(liveDot);
  const nameEl = el('span', 'dash-bubble-name');
  setText(nameEl, 'Execute');
  tab.appendChild(nameEl);
  const meta = el('span', 'dash-bubble-meta');
  setText(meta, `${executeTotal} agents · 4 lanes`);
  tab.appendChild(meta);
  bubble.appendChild(tab);

  // Body
  const body = el('div', 'dash-bubble-body dash-bubble-body-row');
  body.appendChild(buildLane('Research / Scout · RO', 'dash-ll-blue', 'var(--info)',    scoutAgents,   'dash-ac-blue'));
  body.appendChild(buildLane('Implement · WR',         'dash-ll-green', 'var(--success)', implAgents,    'dash-ac-green'));
  body.appendChild(buildLane('Git / Ops · WR',        'dash-ll-amber', 'var(--warning)', gitAgents,     'dash-ac-amber'));
  body.appendChild(buildLane('Plan',                        'dash-ll-purple','var(--accent)',  [...planAgents,...genAgents], 'dash-ac-purple'));
  bubble.appendChild(body);

  return bubble;
}

// ── Adversarial bubble (purple, step 3) ──────────────────────────────────────
function buildAdversarialBubble(agents) {
  const verifyAgents = agents.filter(a => a.group === 'verify');

  const bubble = el('div', 'dash-branch-bubble dash-tc-node dash-bb-purple');
  bubble.style.cssText = 'left:534px;top:360px;width:1148px;height:220px;';
  bubble.dataset.step = '3';

  const tab = el('div', 'dash-bubble-tab');
  const liveDot = el('span', 'dash-live-dot');
  liveDot.setAttribute('aria-label', 'in use');
  liveDot.style.display = 'none';
  tab.appendChild(liveDot);
  const nameEl = el('span', 'dash-bubble-name');
  setText(nameEl, 'Adversarial Review');
  tab.appendChild(nameEl);
  tab.appendChild(chip('dash-runtime-badge', 'Antigravity · Gemini'));
  bubble.appendChild(tab);

  const body = el('div', 'dash-bubble-body dash-bubble-body-row');

  for (const agent of verifyAgents) {
    const col = el('div', '');
    col.style.cssText = 'flex:1.1;display:flex;flex-direction:column;gap:5px;min-width:0;';
    const card = buildAgentCard(agent, 'dash-ac-purple');
    card.style.cssText = 'flex:1;height:auto;';
    col.appendChild(card);
    body.appendChild(col);
  }

  // Side note column
  const noteCol = el('div', '');
  noteCol.style.cssText = 'flex:0.8;display:flex;flex-direction:column;gap:5px;min-width:0;justify-content:center;';
  const note = el('div', 'dash-card-note dash-card-note-purple');
  setText(note, 'Cross-runtime branch — Gemini at MAX reasoning, structurally independent of Claude Code. Adversarial verdict arrives before the gate runs.');
  noteCol.appendChild(note);
  const tierRow = el('div', 'dash-pills-row');
  tierRow.style.cssText = 'margin-top:4px;gap:4px;';
  tierRow.appendChild(chip('dash-tier dash-tier-gemini', 'Gemini'));
  tierRow.appendChild(chip('dash-tier dash-tier-max',    'max reasoning'));
  noteCol.appendChild(tierRow);
  body.appendChild(noteCol);

  bubble.appendChild(body);
  return bubble;
}

// ── Gate bubble (green, step 4) ───────────────────────────────────────────────
function buildGateBubble() {
  const bubble = el('div', 'dash-branch-bubble dash-tc-node dash-bb-green');
  bubble.style.cssText = 'left:534px;top:598px;width:1148px;height:200px;';
  bubble.dataset.step = '4';

  const tab = el('div', 'dash-bubble-tab');
  const liveDot = el('span', 'dash-live-dot');
  liveDot.setAttribute('aria-label', 'in use');
  liveDot.style.display = 'none';
  tab.appendChild(liveDot);
  const nameEl = el('span', 'dash-bubble-name');
  setText(nameEl, 'Acceptance Gate');
  tab.appendChild(nameEl);
  const meta = el('span', 'dash-bubble-meta');
  setText(meta, 'deterministic Stop-hook · not an agent · not counted');
  tab.appendChild(meta);
  bubble.appendChild(tab);

  const body = el('div', 'dash-bubble-body dash-bubble-body-row');

  // done-gate card
  const col1 = el('div', '');
  col1.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;';
  const card = el('div', 'dash-agent-card dash-ac-green');
  card.tabIndex = 0;
  card.style.cursor = 'pointer';
  card.title = 'Open done-gate.js';
  card.addEventListener('click', () => {
    if (_repoRoot) _handlers?.onOpenFile?.(_repoRoot + '/hooks/done-gate.js');
  });
  const cardTop = el('div', 'dash-card-top');
  const cardName = el('span', 'dash-card-name');
  setText(cardName, 'done-gate');
  cardTop.appendChild(cardName);
  cardTop.appendChild(chip('dash-acc dash-acc-ext', 'external'));
  card.appendChild(cardTop);
  const cardRole = el('div', 'dash-card-role');
  setText(cardRole, 'Deterministic Stop-hook. Runs npm test on every dirty stop. Fail blocks; pass allows. Not on Gemini; not counted as an agent.');
  card.appendChild(cardRole);
  const cardTools = el('div', 'dash-tools');
  cardTools.appendChild(chip('dash-tchip', 'git status'));
  cardTools.appendChild(chip('dash-tchip', 'npm test'));
  card.appendChild(cardTools);
  col1.appendChild(card);
  body.appendChild(col1);

  // verdict column
  const col2 = el('div', '');
  col2.style.cssText = 'flex:0.7;display:flex;flex-direction:column;gap:5px;min-width:0;justify-content:center;';
  const verdict = el('div', 'dash-gate-verdict');
  const vDot = el('span', 'dash-gv-dot');
  const vT   = el('span', 'dash-gv-t');
  const vC   = el('span', 'dash-gv-c');
  setText(vT, 'npm test → PASS');
  setText(vC, '0 fail');
  verdict.appendChild(vDot); verdict.appendChild(vT); verdict.appendChild(vC);
  col2.appendChild(verdict);
  const cnote = el('div', 'dash-card-note dash-card-note-green');
  setText(cnote, 'Receives both the deterministic test result and the Antigravity adversarial verdict before deciding "done."');
  col2.appendChild(cnote);
  body.appendChild(col2);

  bubble.appendChild(body);
  return bubble;
}

// ── Learning bubble (amber, step 5) ──────────────────────────────────────────
function buildLearningBubble(learningData) {
  const items        = learningData?.items ?? [];
  const pending      = items.filter(i => i.status === 'pending').length;
  const applied      = items.filter(i => i.status === 'applied').length;

  const bubble = el('div', 'dash-branch-bubble dash-tc-node dash-bb-amber');
  bubble.style.cssText = 'left:534px;top:815px;width:1148px;height:305px;';
  bubble.dataset.step = '5';

  const tab = el('div', 'dash-bubble-tab');
  const liveDot = el('span', 'dash-live-dot');
  liveDot.setAttribute('aria-label', 'in use');
  liveDot.style.display = 'none';
  tab.appendChild(liveDot);
  const nameEl = el('span', 'dash-bubble-name');
  setText(nameEl, 'Learning Loop');
  tab.appendChild(nameEl);
  const meta = el('span', 'dash-bubble-meta');
  setText(meta, `capture → propose → apply → feedback to step 1 · ${pending} pending · ${applied} applied`);
  tab.appendChild(meta);
  bubble.appendChild(tab);

  const body = el('div', 'dash-bubble-body dash-bubble-body-row');

  function learnCol(laneLabel, stepName, fileName, desc, extraFn) {
    const col = el('div', '');
    col.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;';

    const lbl = el('div', 'dash-lane-label dash-ll-amber');
    const sw = el('span', 'dash-lgsw');
    sw.style.background = 'var(--warning)';
    lbl.appendChild(sw); lbl.appendChild(txt(laneLabel));
    col.appendChild(lbl);

    const step = el('div', 'dash-learn-step');
    step.style.flex = '1';
    if (fileName) {
      step.style.cursor = 'pointer';
      step.title = 'Open ' + fileName;
      step.addEventListener('click', () => {
        if (_repoRoot) _handlers?.onOpenFile?.(_repoRoot + '/server/lib/' + fileName);
      });
    }
    const sN = el('div', 'dash-ls-name'); setText(sN, stepName); step.appendChild(sN);
    const sF = el('div', 'dash-ls-file'); setText(sF, fileName);  step.appendChild(sF);
    const sD = el('div', 'dash-ls-desc'); setText(sD, desc);      step.appendChild(sD);
    if (extraFn) extraFn(step);
    const sDiv = el('hr', 'dash-card-divider');
    sDiv.style.marginTop = '6px';
    step.appendChild(sDiv);
    col.appendChild(step);

    return col;
  }

  // Capture column
  const capCol = learnCol('Capture', 'capture', 'learning-store.js',
    `Upserts each gap into a deduped queue. Recurrence = distinct sessions that triggered the same miss. ${items.length} item${items.length !== 1 ? 's' : ''} in queue.`,
    (step) => {
      const pills = el('div', 'dash-pills-row');
      pills.style.marginTop = '2px';
      pills.appendChild(chip('dash-acc dash-acc-wr', 'WR'));
      pills.appendChild(chip('dash-tchip dash-tchip-wr', 'Edit'));
      step.appendChild(pills);
    });
  const capNote = el('div', 'dash-card-note');
  capNote.style.borderLeftColor = 'rgba(224,162,58,.45)';
  setText(capNote, 'Gap codes accumulate. Recurrence > 1 session triggers auto-propose.');
  capCol.appendChild(capNote);
  body.appendChild(capCol);

  // Propose column
  const propCol = learnCol('Propose Guard', 'propose guard', 'learning-templates.js',
    'Drafts the guard line from the gap code and its recurrence count. Ready for review or auto-apply.',
    (step) => {
      const pills = el('div', 'dash-pills-row');
      pills.style.marginTop = '2px';
      pills.appendChild(chip('dash-acc dash-acc-ro', 'RO'));
      pills.appendChild(chip('dash-tchip', 'Read'));
      step.appendChild(pills);
    });
  const propNote = el('div', 'dash-card-note');
  propNote.style.borderLeftColor = 'rgba(224,162,58,.45)';
  setText(propNote, 'Guard line drafted in CLAUDE.md format. Presented in dashboard queue for approval.');
  propCol.appendChild(propNote);

  // Show live items
  if (items.length > 0) {
    const itemsEl = el('div', '');
    itemsEl.style.cssText = 'margin-top:4px;display:flex;flex-direction:column;gap:3px;';
    for (const item of items.slice(0, 2)) {
      const row = el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;font-family:ui-monospace,monospace;font-size:8px;';
      const sEl = el('span', '');
      sEl.style.color = item.status === 'applied' ? 'var(--success)' : 'var(--warning)';
      setText(sEl, item.status === 'applied' ? '✓' : '○');
      row.appendChild(sEl);
      const tEl = el('span', '');
      tEl.style.color = 'var(--muted-fg)';
      setText(tEl, item.title ?? '');
      row.appendChild(tEl);
      itemsEl.appendChild(row);
    }
    propCol.appendChild(itemsEl);
  }
  body.appendChild(propCol);

  // Apply column
  const applyCol = learnCol('Apply → Feedback', 'apply', 'learning-apply.js',
    'Commits guard to global CLAUDE.md and propagates to GEMINI.md / AGENTS.md — or composes a memory file via headless claude -p. Both runtimes inherit the learning.',
    (step) => {
      const targets = el('div', '');
      targets.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;margin-top:6px;';
      for (const t of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'])
        targets.appendChild(chip('dash-target-chip', t));
      step.appendChild(targets);

      const pills = el('div', 'dash-pills-row');
      pills.style.marginTop = '6px';
      pills.appendChild(chip('dash-acc dash-acc-wr', 'WR'));
      pills.appendChild(chip('dash-tchip dash-tchip-wr', 'Edit'));
      pills.appendChild(chip('dash-tchip dash-tchip-wr', 'Bash'));
      step.appendChild(pills);
    });
  applyCol.style.flex = '1.1';

  const applyBadge = el('div', 'dash-loop-badge');
  applyBadge.appendChild(txt('→ applies to next session · inherited by Step 1'));
  applyCol.appendChild(applyBadge);
  body.appendChild(applyCol);

  bubble.appendChild(body);
  return bubble;
}

// ── Hero banner ───────────────────────────────────────────────────────────────
function buildHero(agents, learningData) {
  const pendingCount = (learningData?.items ?? []).filter(i => i.status === 'pending').length;
  const antiCount    = agents.filter(a => a.runtime === 'antigravity').length;

  const hero = el('div', 'dash-hero');
  const grid = el('div', 'dash-hero-grid');

  // Text column
  const textCol = el('div', '');

  const brand = el('div', 'dash-hero-brand');
  // Brand SVG mark (static geometry, no data)
  const markSvg = svgAttr(svgEl('svg'), { width:'16', height:'16', viewBox:'0 0 24 24', fill:'none', 'aria-hidden':'true' });
  markSvg.appendChild(svgAttr(svgEl('circle'), { cx:'12', cy:'12', r:'9', stroke:'#d4a437', 'stroke-width':'1.5' }));
  markSvg.appendChild(svgAttr(svgEl('circle'), { cx:'12', cy:'12', r:'2.2', fill:'#d4a437' }));
  brand.appendChild(markSvg);
  brand.appendChild(txt('GLMPS · Agent Architecture'));
  textCol.appendChild(brand);

  const h1 = el('div', 'dash-hero-h1');
  // Color highlights via safe spans
  h1.appendChild(txt('Five steps. Four '));
  const hl1 = el('span', 'hl-gold');
  setText(hl1, 'color-coded branches');
  h1.appendChild(hl1);
  h1.appendChild(txt(', one '));
  const hl2 = el('span', 'hl-purple');
  setText(hl2, 'orchestrator');
  h1.appendChild(hl2);
  h1.appendChild(txt('.'));
  textCol.appendChild(h1);

  const lede = el('p', 'dash-hero-lede');
  setText(lede, 'One orchestrator scans capabilities and dispatches the right specialist. Execution fans through four color-coded branches — adversarial review, acceptance gate, and learning loop back to the next session.');
  textCol.appendChild(lede);

  // Ticker row
  const ticker = el('div', 'dash-ticker');

  function pip(dotCls, content) {
    const p = el('span', 'dash-pip');
    const d = el('span', `dash-dot ${dotCls}`);
    p.appendChild(d);
    if (typeof content === 'string') {
      p.appendChild(txt(content));
    } else {
      p.appendChild(content);
    }
    return p;
  }

  const agentTxt = el('span', '');
  const agB = el('b', ''); setText(agB, String(agents.length));
  agentTxt.appendChild(agB); agentTxt.appendChild(txt(' agents in fleet'));
  ticker.appendChild(pip('dash-dot-gold', agentTxt));

  const runtimeTxt = el('span', '');
  const ccB = el('b', ''); setText(ccB, String(agents.filter(a => a.runtime === 'claude').length));
  runtimeTxt.appendChild(ccB); runtimeTxt.appendChild(txt(' Claude Code · '));
  const agB2 = el('b', ''); setText(agB2, String(antiCount));
  runtimeTxt.appendChild(agB2); runtimeTxt.appendChild(txt(' Antigravity'));
  ticker.appendChild(pip('dash-dot-blue', runtimeTxt));

  const learnTxt = el('span', '');
  const lB = el('b', ''); setText(lB, String(pendingCount));
  learnTxt.appendChild(lB); learnTxt.appendChild(txt(' learnings pending'));
  ticker.appendChild(pip('dash-dot-purple', learnTxt));

  textCol.appendChild(ticker);
  grid.appendChild(textCol);

  // Radar widget
  grid.appendChild(buildRadar());
  hero.appendChild(grid);
  return hero;
}

// ── Scope strip (zone chips + prod guard) ─────────────────────────────────────
function buildScopeStrip(session, handlers) {
  const scope = session?.scope;
  if (!scope) return null;

  // The job card is a <button>, so we cannot nest another <button> inside it.
  // Use a div with role="button" + tabindex so it's keyboard-accessible.
  const strip = el('div', 'dash-scope');
  strip.setAttribute('role', 'button');
  strip.setAttribute('tabindex', '0');
  strip.setAttribute('aria-label', 'open code map');
  strip.addEventListener('click', (e) => {
    e.stopPropagation();          // don't bubble to the parent onOpenJob
    handlers?.onOpenMap?.(session.id);
  });
  strip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      handlers?.onOpenMap?.(session.id);
    }
  });

  // Zone chips
  const zones = Array.isArray(scope.zones) ? scope.zones : [];
  for (const z of zones) {
    const envCls = z.env === 'prod' ? 'dash-zchip dash-zchip-prod' : 'dash-zchip dash-zchip-dev';
    const chip = el('span', envCls);
    const nameSpan = el('span', 'dash-zname');
    setText(nameSpan, z.zone ?? '');
    chip.appendChild(nameSpan);
    const countSpan = el('span', 'dash-zcount');
    setText(countSpan, String(z.count ?? 0));
    chip.appendChild(countSpan);
    strip.appendChild(chip);
  }

  // Guard pill
  const guardCls = scope.allDev ? 'dash-guard ok' : 'dash-guard warn';
  const guard = el('span', guardCls);
  if (scope.allDev) {
    setText(guard, '🔒 prod safe');
  } else {
    const n = Array.isArray(scope.protected) ? scope.protected.length : 0;
    setText(guard, '⚠ ' + n + ' in prod');
  }
  strip.appendChild(guard);

  return strip;
}

// (The old single-job panel — buildRailStages + fillJobPanel — was replaced by
// the multi-session roster rail; see fillRoster below.)

// ── Stage highlight on the tree canvas (multi-session: pucks + focus flood) ───
//
// For the FOCUSED session: flood its target bubble/orch-root with
// --focused-color (CSS custom property), toggle .dash-step-focused on the
// bubble and .dash-focused-agent on the matching agent card (if in Execute).
// For every OTHER live session: append a small faint puck button over the
// bubble, using that session's sessionColor.
// All prior pucks are cleared on every call.
//
function _stageTarget(canvas, stage) {
  if (stage == null) return null;
  if (stage === 1) return canvas.querySelector('.dash-orch-root');
  return canvas.querySelector(`.dash-branch-bubble[data-step="${stage}"]`);
}

function applyStageHighlight(canvas, liveSessions, focusedId, handlers) {
  // 1. Clear prior state
  for (const node of canvas.querySelectorAll('.in-use, .dash-step-focused')) {
    node.classList.remove('in-use', 'dash-step-focused');
    node.style.removeProperty('--focused-color');
    for (const dot of node.querySelectorAll('.dash-live-dot')) {
      dot.style.display = 'none';
    }
  }
  for (const card of canvas.querySelectorAll('.dash-focused-agent')) {
    card.classList.remove('dash-focused-agent');
    card.style.removeProperty('--focused-color');
  }
  // Remove all prior pucks
  for (const puck of canvas.querySelectorAll('.dash-session-puck')) {
    puck.remove();
  }

  if (!liveSessions || liveSessions.length === 0) return;

  // 2. Paint each live session
  for (const session of liveSessions) {
    const stage  = session.loop?.stage ?? null;
    const color  = sessionColor(session.id);
    const target = _stageTarget(canvas, stage);
    if (!target) continue;

    const isFocused = session.id === focusedId;

    if (isFocused) {
      // Flood: set CSS var + class; show live dot
      target.style.setProperty('--focused-color', color);
      target.classList.add('dash-step-focused');
      // Keep old .in-use for live dot visibility (CSS uses it to show dot)
      target.classList.add('in-use');
      const dot = target.querySelector('.dash-live-dot');
      if (dot) dot.style.display = '';

      // If in Execute (stage 2) and loop.agent is set, highlight the agent card
      if (stage === 2 && session.loop?.agent) {
        const agentName = session.loop.agent;
        for (const card of target.querySelectorAll('.dash-agent-card')) {
          const nameEl = card.querySelector('.dash-card-name');
          if (nameEl && nameEl.textContent.trim() === agentName) {
            card.classList.add('dash-focused-agent');
            card.style.setProperty('--focused-color', color);
          }
        }
      }
    }

    // A session pill, tethered inline in the step's title bar (tab). Every live
    // session gets one on its current step; the focused one is brightened.
    // Click → focus the graph on that session.
    const tab = target.querySelector('.dash-bubble-tab, .dash-orch-tab');
    if (tab) {
      const pill = el('button', 'dash-session-puck' + (isFocused ? ' is-focused' : ''));
      pill.type = 'button';
      pill.style.setProperty('--puck-color', color);
      pill.title = (session.title ?? session.id ?? '') + (isFocused ? ' — focused' : ' — click to focus');
      pill.setAttribute('aria-label',
        `Session ${session.title ?? session.id} — ${isFocused ? 'focused' : 'click to focus'}`);
      const pdot = el('span', 'dash-puck-dot');
      pill.appendChild(pdot);
      const plbl = el('span', 'dash-puck-label');
      setText(plbl, session.title ?? session.id ?? '');
      pill.appendChild(plbl);
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        setFocusedSession(session.id, handlers);
        handlers?.onOpenJob?.(session.id);   // every session pill clicks through to Detail
      });
      tab.appendChild(pill);
    }
  }
}

// ── Roster rail (replaces Section C / fillJobPanel) ──────────────────────────
//
// One compact capsule row per live session. Each row:
//   session-colored left border | dot | title | elapsed | step badge | agent
//   + a .dash-roster-scope slot for the scope strip (buildScopeStrip output)
// Single-click → setFocusedSession; "→" open control → handlers.onOpenJob(id)
//
function _elapsedStr(lastTs) {
  if (!lastTs) return '';
  const sec = Math.floor((Date.now() - lastTs) / 1000);   // lastTs is epoch ms
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

const STAGE_NAMES = ['', 'Orchestrate', 'Execute', 'Adversarial', 'Gate', 'Learning'];

export function fillRoster(rail, state, handlers, opts = {}) {
  // Preserve the project-nav section across roster rebuilds: it lives in this
  // same rail, and safeInnerClear would tear it down every SSE tick (the cause
  // of the nav flicker). Detach the live node, rebuild the roster, then
  // re-attach the SAME node at the end so it is reused, not recreated.
  const navSection = rail.querySelector('.dash-nav-section');
  safeInnerClear(rail);
  const onSelect = opts.onSelect ?? null;
  const focused = opts.focusedId !== undefined ? opts.focusedId : focusedSessionId;

  const hdr = el('div', 'dash-roster-header');
  const titleRow = el('div', 'dash-roster-title');
  const bar = el('span', '');
  bar.setAttribute('aria-hidden', 'true');
  titleRow.appendChild(bar);
  titleRow.appendChild(txt('Live sessions'));
  const sessions   = state?.sessions ?? [];
  const liveSessions = sessions.filter(s => s.live)
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const countBadge = el('span', 'dash-roster-live-count');
  setText(countBadge, liveSessions.length > 0 ? `${liveSessions.length} active` : '0 active');
  titleRow.appendChild(countBadge);
  hdr.appendChild(titleRow);
  rail.appendChild(hdr);

  const list = el('div', 'dash-roster-list');
  list.setAttribute('role', 'list');

  if (liveSessions.length === 0) {
    const empty = el('div', 'dash-roster-empty');
    setText(empty, 'No active sessions right now.');
    list.appendChild(empty);
  } else {
    for (const session of liveSessions) {
      const color = sessionColor(session.id);
      const loop  = session.loop ?? null;
      const stage = loop?.stage ?? null;
      const isFocused = session.id === focused;

      const row = el('div', `dash-roster-row${isFocused ? ' is-focused' : ''}`);
      row.setAttribute('role', 'listitem');
      row.style.setProperty('--session-color', color);
      row.tabIndex = 0;
      row.setAttribute('aria-current', isFocused ? 'true' : 'false');

      // Click → select this session. Pages pass opts.onSelect; the dashboard
      // default focuses the graph on it.
      const select = () => (onSelect ? onSelect(session) : setFocusedSession(session.id, handlers));
      row.addEventListener('click', select);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      });

      // Inner content
      const inner = el('div', 'dash-roster-inner');

      // Top row: dot + title + elapsed
      const top = el('div', 'dash-roster-top');
      const dot = el('span', 'dash-roster-dot');
      top.appendChild(dot);
      const titleEl = el('span', 'dash-roster-name');
      setText(titleEl, session.title ?? session.id ?? 'Untitled');
      top.appendChild(titleEl);
      const elapsed = el('span', 'dash-roster-elapsed');
      setText(elapsed, _elapsedStr(session.lastTs));
      top.appendChild(elapsed);
      inner.appendChild(top);

      // Meta row: step badge + agent name
      const meta = el('div', 'dash-roster-meta');
      if (stage != null) {
        const stepBadge = el('span', 'dash-roster-step');
        setText(stepBadge, STAGE_NAMES[stage] ?? `Step ${stage}`);
        meta.appendChild(stepBadge);
      }
      if (loop?.agent) {
        const agentEl = el('span', 'dash-roster-agent');
        setText(agentEl, loop.agent);
        meta.appendChild(agentEl);
      }
      inner.appendChild(meta);

      // Scope strip slot
      const scopeSlot = el('div', 'dash-roster-scope');
      const strip = buildScopeStrip(session, handlers);
      if (strip) scopeSlot.appendChild(strip);
      inner.appendChild(scopeSlot);

      row.appendChild(inner);

      // "→" open control (navigates to Detail view)
      const openBtn = el('button', 'dash-roster-open');
      openBtn.type = 'button';
      openBtn.title = 'Open in Detail view';
      openBtn.setAttribute('aria-label', 'Open detail for ' + (session.title ?? session.id ?? ''));
      setText(openBtn, '→');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers?.onOpenJob?.(session.id);
      });
      row.appendChild(openBtn);

      list.appendChild(row);
    }
  }

  rail.appendChild(list);

  // Optional "Recent" section of ended sessions (Detail rail keeps the ability
  // to reopen past sessions). Ended dots are static — they don't pulse.
  if (opts.includeEnded) {
    const ended = (state?.sessions ?? [])
      .filter(s => !s.live && s.format !== 'remote')
      .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .slice(0, 12);
    if (ended.length > 0) {
      const sub = el('div', 'dash-roster-subhead');
      setText(sub, 'Recent');
      rail.appendChild(sub);
      const elist = el('div', 'dash-roster-list');
      elist.setAttribute('role', 'list');
      for (const session of ended) {
        const sel = session.id === focused;
        const row = el('div', `dash-roster-row is-ended${sel ? ' is-focused' : ''}`);
        row.setAttribute('role', 'listitem');
        row.style.setProperty('--session-color', sessionColor(session.id));
        row.tabIndex = 0;
        const choose = () => (onSelect ? onSelect(session) : setFocusedSession(session.id, handlers));
        row.addEventListener('click', choose);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
        });
        const inner = el('div', 'dash-roster-inner');
        const top = el('div', 'dash-roster-top');
        top.appendChild(el('span', 'dash-roster-dot'));
        const nameEl = el('span', 'dash-roster-name');
        setText(nameEl, session.title ?? session.id ?? 'Untitled');
        top.appendChild(nameEl);
        const elapsed = el('span', 'dash-roster-elapsed');
        setText(elapsed, _elapsedStr(session.lastTs));
        top.appendChild(elapsed);
        inner.appendChild(top);
        row.appendChild(inner);
        elist.appendChild(row);
      }
      rail.appendChild(elist);
    }
  }

  // Re-attach the preserved project-nav node so roster rebuilds reuse it
  // instead of recreating it (eliminates the per-tick flicker).
  if (navSection) rail.appendChild(navSection);
}

// ── Focus bar — shows which session is driving the graph ──────────────────────
function _updateFocusBar(liveSessions) {
  if (!_container) return;
  const bar = _container.querySelector('.dash-focus-bar');
  if (!bar) return;
  const focused = liveSessions.find(s => s.id === focusedSessionId)
               ?? liveSessions[0]
               ?? null;
  if (!focused) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  const color = sessionColor(focused.id);
  bar.style.setProperty('--focused-color', color);

  const nameEl = bar.querySelector('.dash-focus-bar-name');
  if (nameEl) setText(nameEl, focused.title ?? focused.id ?? '');

  const stepEl = bar.querySelector('.dash-focus-bar-step');
  if (stepEl) {
    const s = focused.loop?.stage;
    setText(stepEl, s != null ? STAGE_NAMES[s] ?? `Step ${s}` : '');
  }

  const agentEl = bar.querySelector('.dash-focus-bar-agent');
  if (agentEl) {
    const a = focused.loop?.agent;
    setText(agentEl, a ? `agent: ${a}` : '');
  }

  // Recently-edited files for the focused session, as clickable chips that open
  // the in-app editor (same mechanism as the Detail page). Fetch only when the
  // focused session changes or has new activity, not on every idle SSE tick.
  const filesEl = bar.querySelector('.dash-focus-bar-files');
  if (filesEl && (focused.id !== _focusFilesFor || (focused.lastTs ?? 0) !== _focusFilesTs)) {
    _focusFilesFor = focused.id;
    _focusFilesTs  = focused.lastTs ?? 0;
    const want = focused.id;
    getState(want).then((detail) => {
      if (_focusFilesFor !== want) return;   // focus moved on while we fetched
      const events = detail?.events ?? [];
      const seen = new Set(); const files = [];
      for (let i = events.length - 1; i >= 0 && files.length < 6; i--) {
        const e = events[i];
        if (e.kind !== 'file-edit' || !e.path) continue;
        const norm = String(e.path).replace(/\\/g, '/');
        if (seen.has(norm)) continue;
        seen.add(norm); files.push(norm);
      }
      safeInnerClear(filesEl);
      if (files.length === 0) return;
      const lbl = el('span', 'dash-focus-files-label');
      setText(lbl, 'edited');
      filesEl.appendChild(lbl);
      for (const f of files) {
        const chip = el('button', 'dash-focus-file');
        chip.type = 'button';
        setText(chip, f.split('/').pop());   // basename only
        chip.title = `Open ${f}`;
        chip.addEventListener('click', () => _handlers?.onOpenFile?.(f));
        filesEl.appendChild(chip);
      }
    }).catch(() => {});
  }
}

// ── Module state ──────────────────────────────────────────────────────────────
let _container       = null;
let _handlers        = null;
let _repoRoot        = null;   // set once from getConfig() — used for file-open clicks
let focusedSessionId = null;   // the session currently flooding the graph
let _navCollapsed    = false;  // persists the Projects section collapsed/expanded state across SSE rebuilds
let _focusFilesFor   = null;   // session id whose edited-files chips are currently shown
let _focusFilesTs    = 0;      // its lastTs at fetch time (refetch when it changes)

// ── Project-nav fetch cache (throttle: reuse data for 15s between SSE ticks) ──
let _navCache = null;   // { projects, terminals, fetchedAt }
const NAV_TTL_MS = 15_000;

function setFocusedSession(id, handlers) {
  focusedSessionId = id;
  // Re-apply overlay immediately so the focus change is instant
  if (!_container) return;
  const canvas       = _container.querySelector('#dash-tree-canvas');
  const roster       = _container.querySelector('.dash-roster-rail');
  const lastState    = _lastState;
  const liveSessions = (lastState?.sessions ?? []).filter(s => s.live)
                       .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  if (canvas) applyStageHighlight(canvas, liveSessions, focusedSessionId, handlers ?? _handlers);
  if (roster) fillRoster(roster, lastState, handlers ?? _handlers);
  _updateFocusBar(liveSessions);
}

let _lastState = null;

// ── Public API ────────────────────────────────────────────────────────────────

// ── Project navigator ─────────────────────────────────────────────────────────
// Stable per-project accent derived from a simple hash of the key string.
// Returns one of the design-system accent hex values so pills pick up color.
const _NAV_COLORS = [
  '#4a8cd8', // info
  '#a878d8', // accent
  '#3fb87f', // success
  '#e0a23a', // warning
  '#d4a437', // primary
];
function _projectColor(key) {
  let h = 0;
  for (let i = 0; i < (key ?? '').length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return _NAV_COLORS[h % _NAV_COLORS.length];
}

/**
 * Build (or rebuild) the ".dash-nav-section" inside railEl.
 * Guard: if any quick-add input inside the existing nav has focus, skip the rebuild.
 * handlers: { onOpenProject } (optional, currently unused — rows are non-navigable stubs)
 */
export async function fillProjectNav(railEl, { onSelectProject = null, selectedProject = null } = {}) {
  // Early-out: don't disturb a section the user is mid-interaction with, and
  // skip the (cached) fetch when we'd bail anyway. The authoritative swap below
  // re-checks these guards at DOM-mutation time.
  const pre = railEl.querySelector('.dash-nav-section');
  if (pre) {
    const focused = document.activeElement;
    if (focused && pre.contains(focused) && focused.tagName === 'INPUT') return;
    if (pre.querySelector('.dash-nav-term-menu:not([hidden])')) return;
  }

  // Throttle network fetches: reuse cached data if it is less than NAV_TTL_MS old.
  let projects = [];
  let terminals = [];
  let failed = false;   // true when /api/projects could not be reached (server needs a restart)
  const now = Date.now();
  if (_navCache && (now - _navCache.fetchedAt) < NAV_TTL_MS) {
    projects  = _navCache.projects;
    terminals = _navCache.terminals;
  } else {
    let projOk = true;
    const [projData, cfgData] = await Promise.all([
      getProjects().catch(() => { projOk = false; return { projects: [] }; }),
      fetch('/api/config').then(r => r.json()).catch(() => ({ terminals: [] })),
    ]);
    projects  = projData?.projects  ?? [];
    terminals = cfgData?.terminals  ?? [];
    // Only cache a successful fetch, so a failed one retries on the next tick.
    if (projOk) _navCache = { projects, terminals, fetchedAt: Date.now() };
    else failed = true;
  }

  // Skip the rebuild entirely when nothing visible changed. Combined with
  // fillRoster preserving the existing node, this kills the per-tick churn that
  // made the Projects list blank-and-reload every few seconds.
  const sig = JSON.stringify({
    s: selectedProject ?? null, c: _navCollapsed, f: failed,
    t: terminals.map((t) => t.label),
    p: projects.map((p) => [p.key, p.sessionCount, p.liveCount, p.lastTs, p.branch, p.backlogOpen, p.graph?.needsUpdate]),
  });
  const cur = railEl.querySelector('.dash-nav-section');
  if (cur && cur.dataset.navSig === sig) return;

  const section = el('div', 'dash-nav-section');
  section.dataset.navSig = sig;

  // ── Header ────────────────────────────────────────────────────────────────
  // Read module-level state so the collapsed position survives SSE rebuilds.
  const hdr = el('div', 'dash-nav-header');

  const titleRow = el('div', 'dash-nav-title-row');
  const bar = el('span', 'dash-nav-accent-bar');
  bar.setAttribute('aria-hidden', 'true');
  titleRow.appendChild(bar);

  const titleTxt = el('span', 'dash-nav-title');
  setText(titleTxt, 'Projects');
  titleRow.appendChild(titleTxt);

  const countBadge = el('span', 'dash-roster-live-count dash-nav-count');
  setText(countBadge, String(projects.length));
  titleRow.appendChild(countBadge);

  const toggle = el('button', 'dash-nav-toggle');
  toggle.type = 'button';
  toggle.title = _navCollapsed ? 'Expand Projects' : 'Collapse Projects';
  toggle.setAttribute('aria-label', 'Toggle Projects section');
  setText(toggle, _navCollapsed ? '▸' : '▾');
  titleRow.appendChild(toggle);

  hdr.appendChild(titleRow);
  section.appendChild(hdr);

  // ── Project list ──────────────────────────────────────────────────────────
  const list = el('div', 'dash-nav-list');
  list.setAttribute('role', 'list');
  // Reflect persisted collapsed state immediately so the section renders correctly.
  if (_navCollapsed) list.style.display = 'none';

  // In select mode (Kanban), a leading "All projects" row clears the filter.
  if (onSelectProject) {
    const allSelected = selectedProject == null || selectedProject === 'all';
    const allRow = el('div', 'dash-roster-row dash-nav-row dash-nav-all dash-nav-selectable' + (allSelected ? ' is-focused' : ''));
    allRow.dataset.projKey = 'all'; // lets callers swap the active highlight in place (no re-render)
    allRow.setAttribute('role', 'listitem');
    allRow.tabIndex = 0;
    const allInner = el('div', 'dash-roster-inner');
    const allTop = el('div', 'dash-roster-top');
    const allName = el('span', 'dash-roster-name');
    setText(allName, 'All projects');
    allTop.appendChild(allName);
    const allHint = el('span', 'dash-roster-elapsed');
    setText(allHint, 'show every ticket');
    allTop.appendChild(allHint);
    allInner.appendChild(allTop);
    allRow.appendChild(allInner);
    const selectAll = () => onSelectProject('all');
    allRow.addEventListener('click', selectAll);
    allRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAll(); } });
    list.appendChild(allRow);
  }

  for (const proj of projects) {
    const color = _projectColor(proj.key ?? proj.name ?? '');
    const isSelected = !!onSelectProject && selectedProject === (proj.key ?? proj.name);
    const row = el('div', 'dash-roster-row dash-nav-row' + (onSelectProject ? ' dash-nav-selectable' : '') + (isSelected ? ' is-focused' : ''));
    row.dataset.projKey = String(proj.key ?? proj.name ?? ''); // for in-place highlight swap
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--session-color', color);
    if (onSelectProject) row.tabIndex = 0;

    const inner = el('div', 'dash-roster-inner');

    // Top line: name + last-activity elapsed
    const top = el('div', 'dash-roster-top');
    const nameEl = el('span', 'dash-roster-name');
    setText(nameEl, proj.name ?? proj.key ?? '');
    top.appendChild(nameEl);
    const elapsed = el('span', 'dash-roster-elapsed');
    setText(elapsed, _elapsedStr(proj.lastTs));
    top.appendChild(elapsed);
    inner.appendChild(top);

    // Pill row
    const meta = el('div', 'dash-roster-meta dash-nav-pills');

    // Session count
    const sessCount = proj.sessionCount ?? 0;
    meta.appendChild(chip('dash-roster-step', `${sessCount} sess`));

    // Live count — only if > 0
    if ((proj.liveCount ?? 0) > 0) {
      const liveP = chip('dash-roster-step dash-nav-pill-live', `${proj.liveCount} live`);
      meta.appendChild(liveP);
    }

    // Branch
    if (proj.branch) {
      meta.appendChild(chip('dash-roster-step', proj.branch));
    }

    // Backlog open count
    if ((proj.backlogOpen ?? 0) > 0) {
      meta.appendChild(chip('dash-roster-step dash-nav-pill-backlog', `${proj.backlogOpen} open`));
    }

    // Graph stale — clickable rebuild button
    if (proj.graph?.needsUpdate) {
      const staleBtn = el('button', 'dash-roster-step dash-nav-pill-stale dash-nav-pill-btn');
      staleBtn.type = 'button';
      setText(staleBtn, 'graph stale ⟳');
      staleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        staleBtn.disabled = true;
        setText(staleBtn, 'rebuilding…');
        rebuildGraph(proj.path).catch(() => {});
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding graph for ' + proj.key + '…' }));
      });
      meta.appendChild(staleBtn);
    } else if ((proj.graph?.nodes ?? 0) === 0) {
      // No graph yet — offer to build one
      const buildBtn = el('button', 'dash-roster-step dash-nav-pill-build dash-nav-pill-btn');
      buildBtn.type = 'button';
      setText(buildBtn, 'build graph ⟳');
      buildBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        buildBtn.disabled = true;
        setText(buildBtn, 'building…');
        rebuildGraph(proj.path).catch(() => {});
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding graph for ' + proj.key + '…' }));
      });
      meta.appendChild(buildBtn);
    }

    inner.appendChild(meta);

    // ── Terminal button + flyout ──────────────────────────────────────────
    if (terminals.length > 0) {
      const termWrap = el('div', 'dash-nav-term-wrap');

      const termBtn = el('button', 'dash-nav-term-btn');
      termBtn.type = 'button';
      termBtn.title = 'Open terminal in this project';
      setText(termBtn, '>_');
      termWrap.appendChild(termBtn);

      const menu = el('div', 'dash-nav-term-menu');
      menu.setAttribute('role', 'menu');
      menu.hidden = true;

      for (const t of terminals) {
        const item = el('button', 'dash-nav-term-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        setText(item, t.label ?? t.command ?? '');
        const termLabel = t.label ?? t.command ?? '';
        const projPath  = proj.path ?? '';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.hidden = true;
          postTerminal({ terminal: termLabel, cwd: projPath }).catch(() => {});
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Terminal request queued' }));
        });
        menu.appendChild(item);
      }

      termBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.hidden) {
          menu.hidden = false;
          // Add a one-shot outside-click listener each time the menu opens.
          // Using { once: true } ensures it self-removes after one firing so
          // listeners do not accumulate across renders.
          setTimeout(() => {
            document.addEventListener('click', () => { menu.hidden = true; }, { once: true, capture: false });
          }, 0);
        } else {
          menu.hidden = true;
        }
      });

      termWrap.appendChild(menu);
      top.appendChild(termWrap);   // sits on the title line, not its own row (compact)
    }

    // ── Quick-add input ───────────────────────────────────────────────────
    const qaWrap = el('div', 'dash-nav-qa-wrap');
    const qaInput = el('input', 'dash-nav-qa-input');
    qaInput.type = 'text';
    qaInput.placeholder = 'File a ticket…';
    qaInput.setAttribute('aria-label', `File a ticket for ${proj.name ?? proj.key ?? ''}`);
    const projKey = proj.key ?? proj.name ?? '';
    qaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = qaInput.value.trim();
        if (!val) return;
        addBacklogItem({ project: projKey, title: val }).catch(() => {});
        qaInput.value = '';
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Ticket filed' }));
      }
    });
    qaWrap.appendChild(qaInput);
    inner.appendChild(qaWrap);

    row.appendChild(inner);

    // Select mode: clicking the row body (not the terminal/quick-add controls)
    // filters the Kanban board to this project.
    if (onSelectProject) {
      const projKeySel = proj.key ?? proj.name ?? '';
      row.addEventListener('click', (e) => {
        if (e.target.closest('.dash-nav-term-wrap, .dash-nav-qa-wrap')) return;
        onSelectProject(projKeySel, proj);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === row) { e.preventDefault(); onSelectProject(projKeySel, proj); }
      });
    }

    list.appendChild(row);
  }

  if (projects.length === 0) {
    const empty = el('div', 'dash-roster-empty');
    setText(empty, failed
      ? 'Projects unavailable. Restart the server to enable the project list.'
      : 'No projects found.');
    list.appendChild(empty);
  }

  section.appendChild(list);

  // Collapse toggle — writes back to module-level _navCollapsed so state
  // survives the next SSE rebuild (fillProjectNav reads it when rebuilding).
  toggle.addEventListener('click', () => {
    _navCollapsed = !_navCollapsed;
    list.style.display = _navCollapsed ? 'none' : '';
    setText(toggle, _navCollapsed ? '▸' : '▾');
    toggle.title = _navCollapsed ? 'Expand Projects' : 'Collapse Projects';
  });

  // Atomic swap — synchronous, no await between read and mutate, so two
  // concurrent fillProjectNav calls (e.g. a view re-render racing an SSE tick)
  // cannot both append. Remove EVERY existing section, which also self-heals any
  // duplicates that slipped in before this guard existed. Re-check the
  // focus/flyout guards here since state may have changed during the await.
  const existings = [...railEl.querySelectorAll('.dash-nav-section')];
  const focusedNow = document.activeElement;
  for (const ex of existings) {
    if (focusedNow && ex.contains(focusedNow) && focusedNow.tagName === 'INPUT') return;
    if (ex.querySelector('.dash-nav-term-menu:not([hidden])')) return;
  }
  existings.forEach((e) => e.remove());
  railEl.appendChild(section);
}

/** Initial render: fetches all data, builds the full dashboard DOM. */
export async function renderDashboard(container, handlers) {
  _container = container;
  _handlers  = handlers;
  safeInnerClear(container);

  const [agentsData, learningData] = await Promise.all([
    getAgents().catch(() => ({ agents: [] })),
    getLearning().catch(() => ({ items: [], config: {}, seq: 0 })),
  ]);

  // Fetch repoRoot once for file-open click handlers (non-blocking — best effort).
  if (_repoRoot === null) {
    getConfig().then(c => { if (c?.repoRoot) _repoRoot = c.repoRoot; }).catch(() => {});
  }

  const agents = agentsData?.agents ?? [];

  // ── Two-column layout ────────────────────────────────────────────────────────
  // .dash-cols = .dash-roster-rail (left, sticky ~260px) + .dash-graph-col (right, flexes)
  const cols = el('div', 'dash-cols');

  // ── LEFT: Roster rail ────────────────────────────────────────────────────────
  const rosterRail = el('aside', 'dash-roster-rail');
  rosterRail.setAttribute('aria-label', 'Live sessions');
  fillRoster(rosterRail, null, handlers);
  // Project navigator appended below the roster list (async, non-blocking)
  fillProjectNav(rosterRail).catch(() => {});
  cols.appendChild(rosterRail);

  // ── RIGHT: Graph column ──────────────────────────────────────────────────────
  const graphCol = el('div', 'dash-graph-col');

  // Hero
  graphCol.appendChild(buildHero(agents, learningData));

  // Focus bar (shows which session is focused; hidden when no live sessions)
  const focusBar = el('div', 'dash-focus-bar');
  focusBar.style.display = 'none';
  const fbDot = el('span', 'dash-focus-bar-dot');
  focusBar.appendChild(fbDot);
  const fbName = el('span', 'dash-focus-bar-name');
  focusBar.appendChild(fbName);
  const fbStep = el('span', 'dash-focus-bar-step');
  focusBar.appendChild(fbStep);
  const fbAgent = el('span', 'dash-focus-bar-agent');
  focusBar.appendChild(fbAgent);
  const fbFiles = el('div', 'dash-focus-bar-files');  // clickable recently-edited files
  focusBar.appendChild(fbFiles);
  const fbHint = el('div', 'dash-focus-bar-hint');
  setText(fbHint, 'Graph is focused on this session. Faint pucks show other sessions on their step. Click a puck or roster row to change focus.');
  focusBar.appendChild(fbHint);
  graphCol.appendChild(focusBar);

  // Section eyebrow (no section letter per Task 4)
  const eyeA = el('div', 'dash-eyebrow');
  eyeA.appendChild(txt('Agent workflow — five steps, left to right'));
  eyeA.appendChild(el('span', 'dash-eye-rule'));
  graphCol.appendChild(eyeA);

  // Tree canvas
  const scroll = el('div', 'dash-graph-scroll');
  const canvas = el('div', 'dash-tree-canvas');
  canvas.id = 'dash-tree-canvas';

  canvas.appendChild(buildRibbonSvg());

  const orchNode = el('div', 'dash-tc-node');
  orchNode.style.cssText = 'left:16px;top:250px;width:474px;height:660px;';
  orchNode.appendChild(buildOrchCard(agents, learningData));
  canvas.appendChild(orchNode);

  canvas.appendChild(buildExecuteBubble(agents));
  canvas.appendChild(buildAdversarialBubble(agents));
  canvas.appendChild(buildGateBubble());
  canvas.appendChild(buildLearningBubble(learningData));

  scroll.appendChild(canvas);
  graphCol.appendChild(scroll);

  // Fleet legend footer
  const foot = el('div', 'dash-graph-foot');

  const roLg = el('span', 'dash-foot-lg');
  roLg.appendChild(chip('dash-acc dash-acc-ro', 'RO'));
  roLg.appendChild(txt(' read-only — researches / verifies, hands findings back'));
  foot.appendChild(roLg);

  const wrLg = el('span', 'dash-foot-lg');
  wrLg.appendChild(chip('dash-acc dash-acc-wr', 'WR'));
  wrLg.appendChild(txt(' write — edits the working tree'));
  foot.appendChild(wrLg);

  const rtLg = el('span', 'dash-foot-lg');
  rtLg.style.cssText = 'border-left:1px solid var(--border);padding-left:14px;';
  const ccIcon = el('b',''); ccIcon.style.color = 'var(--info)';    setText(ccIcon, '■'); rtLg.appendChild(ccIcon);
  rtLg.appendChild(txt(` Claude Code (${agents.filter(a=>a.runtime==='claude').length}: main + specialists)  `));
  const agIcon = el('b',''); agIcon.style.color = 'var(--accent)';  setText(agIcon, '■'); rtLg.appendChild(agIcon);
  rtLg.appendChild(txt(` Antigravity / Gemini (${agents.filter(a=>a.runtime==='antigravity').length})  `));
  const gIcon = el('b',''); gIcon.style.color = 'var(--muted-fg)'; setText(gIcon, '■'); rtLg.appendChild(gIcon);
  rtLg.appendChild(txt(' done-gate (external Stop-hook)'));
  foot.appendChild(rtLg);

  const poolLg = el('span', 'dash-foot-lg');
  poolLg.appendChild(txt('Model pool: '));
  const oEl = el('b',''); oEl.style.color = 'var(--primary)'; setText(oEl, 'Opus'); poolLg.appendChild(oEl);
  poolLg.appendChild(txt(' hard reasoning · '));
  const sEl = el('b',''); sEl.style.color = 'var(--info)'; setText(sEl, 'Sonnet'); poolLg.appendChild(sEl);
  poolLg.appendChild(txt(' implements · '));
  const hEl = el('b',''); hEl.style.color = 'var(--success)'; setText(hEl, 'Haiku'); poolLg.appendChild(hEl);
  poolLg.appendChild(txt(' git/bulk · '));
  const gEl = el('b',''); gEl.style.color = 'var(--accent)'; setText(gEl, 'Gemini·max'); poolLg.appendChild(gEl);
  poolLg.appendChild(txt(' adversarial'));
  foot.appendChild(poolLg);

  const noteLg = el('span', 'dash-foot-full');
  setText(noteLg, 'Focused bubble gets a color flood; other live sessions show faint pucks. Click a puck or roster row to change focus.');
  foot.appendChild(noteLg);

  graphCol.appendChild(foot);
  cols.appendChild(graphCol);

  container.appendChild(cols);

  // Size the step bubbles to their (content-dependent) agent cards, restack, and
  // redraw the ribbons. Now that the canvas is in the DOM, offsetHeight is valid.
  bindResize();
  layoutBubbles(canvas);
}

/**
 * Called on every SSE tick from app.js render().
 * Re-applies the multi-session overlay + refreshes the roster rail.
 */
export function updateDashboard(state, handlers) {
  if (!_container) return;
  _lastState = state;
  _handlers  = handlers;

  const liveSessions = (state?.sessions ?? [])
    .filter(s => s.live)
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));

  // Auto-select the focused session: keep the current selection if it's still
  // live; otherwise fall back to the most recent session.
  const stillLive = focusedSessionId && liveSessions.some(s => s.id === focusedSessionId);
  if (!stillLive) {
    focusedSessionId = mostRecentSessionId(state) ?? (liveSessions[0]?.id ?? null);
  }

  const canvas = _container.querySelector('#dash-tree-canvas');
  if (canvas) applyStageHighlight(canvas, liveSessions, focusedSessionId, handlers);

  const roster = _container.querySelector('.dash-roster-rail');
  if (roster) {
    fillRoster(roster, state, handlers);
    // Refresh project nav — fillProjectNav internally guards against clobbering
    // a focused quick-add input, so it's safe to call on every SSE tick.
    fillProjectNav(roster).catch(() => {});
  }

  _updateFocusBar(liveSessions);
}
