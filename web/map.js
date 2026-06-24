// web/map.js — Map view: graphify code-knowledge graph by zone with live edit overlay
// XSS rule: all user/file-derived data (paths, labels, node names) goes through
// textContent / createElementNS. innerHTML='' to clear only (no data).

import { getGraph, getState, rebuildGraph } from './api.js';
import { computeLitNodeIds, isLitPath } from './lit-match.js';
import { groupByDirectory, dirDisplayLabel, dirZoneColor } from './map-zones.js';
import { aggregateToFiles, layoutPills } from './file-graph.js';
import { fillRoster, fillProjectNav } from './agents.js';

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag) { return document.createElementNS(NS, tag); }
function svgAttr(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function setText(node, s) { node.textContent = String(s ?? ''); }

// ── Module state ─────────────────────────────────────────────────────────────
let _container = null;
let _handlers = null;
let _nodePositions = null;  // Map<nodeId, {x, y}>
let _activeSession = null;  // session object from /api/state
let _litNodeIds = new Set(); // node.id values currently lit (from per-session file-edit events)
let _fileGraph = null;      // aggregated file-level graph (nodes/links)
let _graphRoot = null;      // absolute dir that source_files are relative to
let _mapWrap = null;        // the SVG container, for resize reflow
let _resizeBound = false;   // window resize listener installed once
let _mapRail = null;        // the live-sessions roster rail (left pane)
let _activeProjectPath = null; // absolute path of project being viewed (null = session mode)
let _activeProjectKey = null;  // basename of _activeProjectPath

// ── Zone color map ────────────────────────────────────────────────────────────
// Each zone gets a color and a CSS class. Non-protected zones share the palette;
// protected/prod zones always get --destructive treatment.
const ZONE_COLORS = {
  'lib':       { stroke: 'var(--primary)',     fill: 'rgba(212,164,55,.03)',  label: 'var(--primary)',     cls: 'zone-lib'    },
  'server.js': { stroke: 'var(--info)',        fill: 'rgba(74,140,216,.04)', label: 'var(--info)',        cls: 'zone-server' },
  'test':      { stroke: 'var(--accent)',      fill: 'rgba(168,120,216,.03)', label: 'var(--accent)',      cls: 'zone-test'   },
  'web':       { stroke: 'var(--success)',     fill: 'rgba(63,184,127,.03)', label: 'var(--success)',     cls: 'zone-web'    },
  'server':    { stroke: 'var(--info)',        fill: 'rgba(74,140,216,.04)', label: 'var(--info)',        cls: 'zone-server' },
  'server/lib':{ stroke: 'var(--primary)',     fill: 'rgba(212,164,55,.03)', label: 'var(--primary)',     cls: 'zone-lib'    },
  'taps':      { stroke: 'var(--warning)',     fill: 'rgba(224,162,58,.03)', label: 'var(--warning)',     cls: 'zone-taps'   },
  'companion': { stroke: 'var(--muted-fg)',    fill: 'rgba(138,146,156,.03)',label: 'var(--muted-fg)',    cls: 'zone-comp'   },
};
function zoneColor(zone, isProtected) {
  if (isProtected) return { stroke: 'var(--destructive)', fill: 'rgba(224,86,86,.06)', label: 'var(--destructive)', cls: 'zone-prod' };
  return ZONE_COLORS[zone] ?? { stroke: 'var(--border)', fill: 'rgba(255,255,255,.012)', label: 'var(--muted-fg)', cls: 'zone-other' };
}

// Node color by community (deterministic from community index)
const COMMUNITY_PALETTE = [
  '#d4a437','#4a8cd8','#3fb87f','#a878d8','#e0a23a','#e05656',
  '#5ac8d8','#8fd45a','#d87a4a','#7a8cd8','#d45a8c','#5ad4a4',
];
function communityColor(communityId) {
  return COMMUNITY_PALETTE[communityId % COMMUNITY_PALETTE.length];
}

// ── Deterministic layout engine ───────────────────────────────────────────────
// One pill per file, flowed in wrapping rows inside its directory rectangle.
// Directory boxes are packed left-to-right and wrap to fill the available
// width (responsive: 1 column when narrow, more as it widens). No randomness.
function computeLayout(fileNodes, { graphRoot, availableWidth = 1200 } = {}) {
  const byDir = groupByDirectory(fileNodes);
  const dirNames = [...byDir.keys()].sort((a, b) => a.localeCompare(b));

  const ZONE_PAD = 18, ZONE_HGAP = 24, ZONE_VGAP = 24;
  const HEADER_H = 40, CANVAS_MARGIN = 20, MAX_CONTENT_W = 600;
  const avail = Math.max(360, availableWidth);

  // Size each directory box from its pill flow.
  const boxes = new Map(); // dir -> { w, h, pills: Map<id, pill> }
  for (const dir of dirNames) {
    const nodes = byDir.get(dir);
    const { pills, contentW, contentH } = layoutPills(nodes.map(n => n.label), { maxContentW: MAX_CONTENT_W });
    const pmap = new Map();
    nodes.forEach((n, i) => pmap.set(n.id, pills[i]));
    boxes.set(dir, { w: Math.max(contentW + ZONE_PAD * 2, 200), h: HEADER_H + contentH + ZONE_PAD, pills: pmap });
  }

  // Protected directories walled off after the regular ones.
  const isProt = dir => (byDir.get(dir) ?? []).some(n => n.protected || n.env === 'prod');
  const ordered = [...dirNames.filter(d => !isProt(d)), ...dirNames.filter(isProt)];

  let gx = CANVAS_MARGIN, gy = CANVAS_MARGIN + 24, rowMaxH = 0, canvasW = 0;
  const dirRects = new Map();
  for (const dir of ordered) {
    const { w, h } = boxes.get(dir);
    // Wrap when this box would overflow the available width (but always place
    // at least one box per row, even if it is wider than the viewport).
    if (gx > CANVAS_MARGIN && gx + w > avail - CANVAS_MARGIN) {
      gy += rowMaxH + ZONE_VGAP; gx = CANVAS_MARGIN; rowMaxH = 0;
    }
    dirRects.set(dir, { x: gx, y: gy, w, h });
    gx += w + ZONE_HGAP;
    rowMaxH = Math.max(rowMaxH, h);
    canvasW = Math.max(canvasW, gx - ZONE_HGAP + CANVAS_MARGIN);
  }
  // Span the full available width so the map fills the screen like other views.
  canvasW = Math.max(canvasW, avail);
  const canvasH = gy + rowMaxH + CANVAS_MARGIN + 32;

  // Absolute pill positions (box origin + pill offset).
  const pillPos = new Map();
  for (const dir of ordered) {
    const rect = dirRects.get(dir);
    const ox = rect.x + ZONE_PAD, oy = rect.y + HEADER_H;
    for (const [id, p] of boxes.get(dir).pills) {
      pillPos.set(id, { x: ox + p.x, y: oy + p.y, w: p.w, h: p.h, text: p.text, full: p.full });
    }
  }

  return { pillPos, dirRects, byDir, canvasW, canvasH };
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
let _tooltipEl = null;
function ensureTooltip() {
  if (_tooltipEl) return _tooltipEl;
  _tooltipEl = el('div', 'map-tooltip hidden');
  document.body.appendChild(_tooltipEl);
  return _tooltipEl;
}
function showTooltip(e, node, graphRoot) {
  const tip = ensureTooltip();
  tip.textContent = '';
  const abs = graphRoot ? graphRoot.replace(/\\/g, '/') + '/' + node.source_file : node.source_file;
  const path = el('div', 'map-tip-path'); setText(path, abs); tip.appendChild(path);
  const meta = el('div', 'map-tip-meta');
  const sym = node.symbolCount != null ? `${node.symbolCount} symbol${node.symbolCount === 1 ? '' : 's'}  ·  ` : '';
  setText(meta, `${sym}degree ${node.degree}${node.god ? '  ·  god file' : ''}`);
  tip.appendChild(meta);
  tip.classList.remove('hidden');
  positionTooltip(e);
}
function positionTooltip(e) {
  if (!_tooltipEl || _tooltipEl.classList.contains('hidden')) return;
  _tooltipEl.style.left = (e.clientX + 14) + 'px';
  _tooltipEl.style.top  = (e.clientY - 8) + 'px';
}
function hideTooltip() {
  if (_tooltipEl) _tooltipEl.classList.add('hidden');
}

// ── Blast-radius callout ──────────────────────────────────────────────────────
function buildBlastCallout(node, incomingCount) {
  const div = el('div', 'map-blast');
  const k = el('span', 'map-blast-key'); setText(k, 'blast radius'); div.appendChild(k);
  const v = el('span', 'map-blast-val');
  const bold = el('b'); setText(bold, node.source_file); v.appendChild(bold);
  const txt2 = document.createTextNode(` is a god file — `);
  v.appendChild(txt2);
  const b2 = el('b'); setText(b2, String(incomingCount)); v.appendChild(b2);
  const t3 = document.createTextNode(` files depend on it. Edit carefully.`);
  v.appendChild(t3);
  div.appendChild(v);
  const tag = el('span', 'map-blast-tag'); setText(tag, 'run tests before stop'); div.appendChild(tag);
  return div;
}

// ── Scope guard header ─────────────────────────────────────────────────────────
function buildScopeGuard(session, graph) {
  const bar = el('div', 'map-scope');

  const lab = el('span', 'map-scope-lab'); setText(lab, 'Scope'); bar.appendChild(lab);

  const scope = session?.scope;
  const zones = scope?.zones ?? [];
  if (zones.length === 0) {
    const empty = el('span', 'map-scope-empty'); setText(empty, 'no file edits this session'); bar.appendChild(empty);
  } else {
    for (const z of zones) {
      const chip = el('span', 'map-zchip ' + (z.env === 'dev' ? 'map-zchip-dev' : 'map-zchip-prod'));
      const dot = el('span', 'map-zchip-dot'); dot.style.background = z.env === 'dev' ? 'var(--primary)' : 'var(--destructive)';
      chip.appendChild(dot);
      const b = el('b'); setText(b, z.zone); chip.appendChild(b);
      const cnt = document.createTextNode(` · ${z.count} edit${z.count === 1 ? '' : 's'}`);
      chip.appendChild(cnt);
      bar.appendChild(chip);
    }
  }

  // Project arm
  const arm = el('span', 'map-scope-arm');
  if (scope?.allDev) setText(arm, 'all DEV · ' + (session?.cwd ?? ''));
  else setText(arm, session?.cwd ?? '');
  bar.appendChild(arm);

  // Guard status
  const guard = el('span', scope?.protected?.length ? 'map-scope-guard map-scope-guard-warn' : 'map-scope-guard map-scope-guard-ok');
  if (scope?.protected?.length) {
    setText(guard, '⚠ protected-zone hit — guard tripped');
  } else {
    setText(guard, '🔒 prod untouched · guard armed');
  }
  bar.appendChild(guard);

  // Commit + stale badge
  if (graph?.builtAtCommit) {
    const commit = el('span', 'map-scope-commit');
    setText(commit, 'graph @ ' + graph.builtAtCommit.slice(0, 7));
    bar.appendChild(commit);
    if (graph.stale) {
      const stale = el('span', 'map-stale-badge'); setText(stale, 'stale — run `graphify update .`'); bar.appendChild(stale);
    }
  }

  return bar;
}

// ── Panel header ──────────────────────────────────────────────────────────────
function buildPanelHead(session, graph, handlers) {
  const head = el('div', 'map-panel-head');

  const info = el('div', 'map-panel-info');
  const title = el('div', 'map-panel-title');
  const summary = session?.summary ?? session?.id ?? 'No active session';
  setText(title, summary.length > 80 ? summary.slice(0, 77) + '…' : summary);
  if (session?.id && handlers?.onOpenJob) {
    title.classList.add('map-panel-title-link');
    title.addEventListener('click', () => handlers.onOpenJob(session.id));
  }
  info.appendChild(title);

  if (graph) {
    const sub = el('div', 'map-panel-sub');
    setText(sub, `${graph.nodes.length} files · ${graph.links.length} dependencies`);
    info.appendChild(sub);
  }
  head.appendChild(info);

  if (graph) {
    const meta = el('div', 'map-panel-meta');
    const godCount = graph.nodes.filter(n => n.god).length;
    const metaB = el('b'); setText(metaB, String(godCount)); meta.appendChild(metaB);
    meta.appendChild(document.createTextNode(' god files'));
    head.appendChild(meta);
  }

  return head;
}

// ── SVG graph renderer ────────────────────────────────────────────────────────
function buildGraphSVG(graph, pillPos, dirRects, byDir, canvasW, canvasH, litNodeIds, handlers, graphRoot) {
  const svg = svgEl('svg');
  svgAttr(svg, {
    viewBox: `0 0 ${canvasW} ${canvasH}`,
    class: 'map-svg',
    role: 'img',
    'aria-label': 'code file dependency map partitioned by directory',
  });

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const center = id => { const p = pillPos.get(id); return p ? { x: p.x + p.w / 2, y: p.y + p.h / 2 } : null; };

  // Count incoming links per file (for blast radius)
  const incomingCount = new Map();
  for (const link of graph.links) incomingCount.set(link.target, (incomingCount.get(link.target) ?? 0) + 1);

  // ── Edges layer (below pills) ──
  const edgesG = svgEl('g');
  edgesG.setAttribute('class', 'map-edges');
  for (const link of graph.links) {
    const sp = center(link.source), tp = center(link.target);
    if (!sp || !tp) continue;
    const sn = nodeById.get(link.source), tn = nodeById.get(link.target);
    if (!sn || !tn) continue;
    const crossZone = sn.zone !== tn.zone;
    const devToProtected = (!sn.protected && (tn.protected || tn.env === 'prod'));
    const edgeLit = crossZone && (litNodeIds.has(sn.id) || litNodeIds.has(tn.id));
    const line = svgEl('line');
    svgAttr(line, { x1: sp.x, y1: sp.y, x2: tp.x, y2: tp.y });
    line.setAttribute('class',
      devToProtected ? 'map-edge map-edge-danger'
      : edgeLit ? 'map-edge map-edge-hot'
      : crossZone ? 'map-edge map-edge-cross'
      : 'map-edge');
    edgesG.appendChild(line);
  }
  svg.appendChild(edgesG);

  // ── Directory rectangles ──
  const zonesG = svgEl('g');
  zonesG.setAttribute('class', 'map-zones');
  for (const [dir, rect] of dirRects.entries()) {
    const dNodes = byDir.get(dir) ?? [];
    const isProtected = dNodes.some(n => n.protected || n.env === 'prod');
    const col = dirZoneColor(dNodes, zoneColor);

    const r = svgEl('rect');
    svgAttr(r, { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 12 });
    r.setAttribute('class', 'map-zone ' + col.cls);
    r.style.fill = col.fill;
    r.style.stroke = col.stroke;
    if (isProtected) r.style.strokeDasharray = '5 4';
    zonesG.appendChild(r);

    // Directory label — full absolute path, truncated to the rect width, full on hover via <title>.
    // Font: map-zlabel is ui-monospace 11px (--fs-micro) with letter-spacing .04em.
    // Char width ≈ 11 * 0.6 + 11 * 0.04 ≈ 6.8px. Padding: 14px each side (28px total).
    // Protected prefix '🔒 ' costs 2 extra chars; subtract from the budget.
    const ZLABEL_CHAR_W = 6.8, ZLABEL_PAD = 28;
    const protPrefix = isProtected ? '🔒 ' : '';
    const innerW = rect.w - ZLABEL_PAD;
    const charBudget = Math.max(4, Math.floor(innerW / ZLABEL_CHAR_W) - protPrefix.length);
    const absDir = graphRoot ? graphRoot.replace(/\\/g, '/') + '/' + dir : dir;
    const { text, full } = dirDisplayLabel(absDir, charBudget);
    const label = svgEl('text');
    svgAttr(label, { x: rect.x + 14, y: rect.y + 20, class: 'map-zlabel' });
    label.style.fill = col.label;
    label.textContent = protPrefix + text;
    const title = svgEl('title'); title.textContent = full; label.appendChild(title);
    zonesG.appendChild(label);

    const count = svgEl('text');
    svgAttr(count, { x: rect.x + 14, y: rect.y + 33, class: 'map-zpath' });
    count.textContent = `${dNodes.length} file${dNodes.length === 1 ? '' : 's'}`;
    zonesG.appendChild(count);
  }
  svg.appendChild(zonesG);

  // ── File pills (top layer, above edges) ──
  const pillsG = svgEl('g');
  pillsG.setAttribute('class', 'map-pills');
  let activeGodNode = null;
  for (const node of graph.nodes) {
    const p = pillPos.get(node.id);
    if (!p) continue;
    const isLit = litNodeIds.has(node.id);
    const isGod = node.god;
    const isProtected = node.protected || node.env === 'prod';
    const accent = isProtected ? 'var(--destructive)' : communityColor(node.community);

    const g = svgEl('g');
    g.setAttribute('class', 'map-pill-group');

    if (isLit || isGod) {
      const pulse = svgEl('rect');
      svgAttr(pulse, { x: p.x - 3, y: p.y - 3, width: p.w + 6, height: p.h + 6, rx: 12 });
      pulse.setAttribute('class', isGod ? 'map-pill-pulse map-pill-pulse-god' : 'map-pill-pulse');
      g.appendChild(pulse);
      if (isLit && isGod) activeGodNode = node;
    }

    const rect = svgEl('rect');
    svgAttr(rect, { x: p.x, y: p.y, width: p.w, height: p.h, rx: 9 });
    rect.setAttribute('class', 'map-pill'
      + (isGod ? ' map-pill-god' : '')
      + (isLit ? ' map-pill-lit' : '')
      + (isProtected ? ' map-pill-prot' : ''));
    rect.style.stroke = accent;
    g.appendChild(rect);

    const txt = svgEl('text');
    svgAttr(txt, { x: p.x + 7, y: p.y + p.h / 2 + 3.4, class: 'map-pill-text' + (isLit ? ' map-pill-text-lit' : '') });
    // Clamp displayed label to the pill rect. layoutPills already truncated p.text
    // to fit p.w, but the lit marker ' ✎' adds ~3 chars that would overrun the box.
    // Budget: (pill inner width) / charW, minus the suffix length.
    const PILL_CHAR_W = 6.2, PILL_PAD_X = 7, LIT_SUFFIX = ' ✎';
    if (isLit) {
      const innerW = p.w - PILL_PAD_X * 2;
      const budget = Math.max(1, Math.floor(innerW / PILL_CHAR_W) - LIT_SUFFIX.length);
      const base = p.text.length > budget ? p.text.slice(0, budget - 1) + '…' : p.text;
      txt.textContent = base + LIT_SUFFIX;
    } else {
      txt.textContent = p.text;
    }
    g.appendChild(txt);

    g.addEventListener('mouseenter', e => showTooltip(e, node, graphRoot));
    g.addEventListener('mousemove', e => positionTooltip(e));
    g.addEventListener('mouseleave', () => hideTooltip());

    // Compute absolute path for this node (used by open-file click).
    const absPath = graphRoot ? graphRoot.replace(/\\/g, '/') + '/' + node.source_file : node.source_file;

    // All nodes are clickable: plain click opens the file; god nodes also
    // show blast-radius on shift/alt-click.
    g.style.cursor = 'pointer';
    g.addEventListener('click', e => {
      if (isGod && (e.shiftKey || e.altKey)) {
        showBlastRadius(node, incomingCount.get(node.id) ?? 0);
        return;
      }
      handlers?.onOpenFile?.(absPath);
    });

    pillsG.appendChild(g);
  }
  svg.appendChild(pillsG);

  return { svg, activeGodNode, incomingCount };
}

// ── Blast radius panel (below the SVG, toggled by god-node click) ──
let _blastContainer = null;
function showBlastRadius(node, count) {
  if (!_blastContainer) return;
  _blastContainer.innerHTML = '';
  _blastContainer.appendChild(buildBlastCallout(node, count));
}

// ── Legend ─────────────────────────────────────────────────────────────────────
function buildLegend(byDir) {
  const legend = el('div', 'map-legend');
  // Legend shows distinct zone families (colors), not every directory.
  const seen = new Set();
  const entries = [];
  for (const nodes of byDir.values()) {
    for (const n of nodes) {
      const zone = n.zone ?? 'unknown';
      if (seen.has(zone)) continue;
      seen.add(zone);
      const col = zoneColor(zone, false);
      entries.push({ label: zone, color: col.stroke });
    }
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  for (const entry of entries) {
    const it = el('span', 'map-legend-it');
    const dot = el('span', 'map-legend-dot');
    dot.style.background = entry.color;
    it.appendChild(dot);
    it.appendChild(document.createTextNode(' ' + entry.label));
    legend.appendChild(it);
  }
  const live = el('span', 'map-legend-live');
  setText(live, '● active edits pulsing');
  legend.appendChild(live);
  return legend;
}

// ── Empty state ───────────────────────────────────────────────────────────────
function buildEmptyState(project, projRoot) {
  const wrap = el('div', 'map-empty');
  const icon = el('div', 'map-empty-icon'); setText(icon, '◎'); wrap.appendChild(icon);

  if (projRoot) {
    const name = projRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
    const btn = el('button', 'map-empty-build-btn');
    setText(btn, `No graph yet for ${name} — click to build it.`);
    btn.addEventListener('click', () => {
      setText(btn, 'Building…');
      btn.disabled = true;
      rebuildGraph(projRoot).catch(() => {});
      window.dispatchEvent(new CustomEvent('mc-toast', {
        detail: `Building graph for ${name}… refresh in a moment`,
      }));
    });
    wrap.appendChild(btn);
  } else {
    const msg = el('p', 'map-empty-msg');
    setText(msg, 'No graph for this project yet.'); wrap.appendChild(msg);
  }

  const cmd = el('code', 'map-empty-cmd');
  setText(cmd, `graphify . ` + (project ? `in ${project}` : '')); wrap.appendChild(cmd);
  const hint = el('p', 'map-empty-hint');
  setText(hint, 'Build one to see zones, god files, and live edit overlays here.'); wrap.appendChild(hint);
  return wrap;
}

// ── renderMap ─────────────────────────────────────────────────────────────────
// ── Responsive width + resize reflow ──────────────────────────────────────────
function measureWrapWidth(wrap) {
  if (!wrap || !wrap.isConnected) return 1200;
  const cs = getComputedStyle(wrap);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  // Reserve ~18px for a possible vertical scrollbar so the SVG never forces a
  // horizontal one. Fall back to 1200 before the element has been laid out.
  const inner = wrap.clientWidth - padL - padR - 18;
  return inner > 0 ? Math.max(360, inner) : 1200;
}

// Rebuild only the SVG from cached graph state at the current width — no refetch.
function reflowMapSvg() {
  if (!_mapWrap || !_mapWrap.isConnected || !_fileGraph) return;
  const layout = computeLayout(_fileGraph.nodes, { graphRoot: _graphRoot, availableWidth: measureWrapWidth(_mapWrap) });
  _nodePositions = layout.pillPos;
  const { svg } = buildGraphSVG(
    _fileGraph, layout.pillPos, layout.dirRects, layout.byDir,
    layout.canvasW, layout.canvasH, _litNodeIds, _handlers, _graphRoot,
  );
  _mapWrap.innerHTML = '';
  _mapWrap.appendChild(svg);
}

function bindMapResize() {
  if (_resizeBound) return;
  _resizeBound = true;
  let t = null;
  window.addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      // Reflow only while the map view is visible (offsetParent is null when
      // its .view container is display:none).
      if (_mapWrap && _mapWrap.offsetParent !== null) reflowMapSvg();
    }, 200);
  });
}

// Fill the left-pane live-sessions roster (reuses the dashboard's component),
// then append the project navigator below it.
function _fillMapRoster(state, session) {
  if (!_mapRail) return;
  fillRoster(_mapRail, state, _handlers, {
    onSelect: s => renderMap(_container, _handlers, s.id),
    focusedId: session?.id ?? null,
  });
  fillProjectNav(_mapRail, {
    onSelectProject: (key, proj) => {
      if (key === 'all') { renderMap(_container, _handlers); }
      else { renderMap(_container, _handlers, null, proj?.path); }
    },
    selectedProject: _activeProjectKey,
  }).catch(() => {});
}

export async function renderMap(container, handlers, sessionId, projectOverride) {
  _container = container;
  _handlers = handlers;
  container.innerHTML = '';

  // Two-column layout: live-sessions roster (left) + scrolling map column
  // (right), mirroring the dashboard's roster rail.
  const rail = el('aside', 'dash-roster-rail map-roster-rail');
  rail.setAttribute('aria-label', 'Live sessions');
  container.appendChild(rail);
  _mapRail = rail;
  const main = el('div', 'map-main');
  container.appendChild(main);

  const shell = el('div', 'map-shell');
  main.appendChild(shell);

  // Eyebrow
  const eyebrow = el('div', 'map-eyebrow');
  const eyeText = el('span');
  setText(eyeText, projectOverride ? 'Project map' : 'Session scope map');
  eyebrow.appendChild(eyeText);
  const rule = el('span', 'map-eyebrow-rule'); eyebrow.appendChild(rule);
  shell.appendChild(eyebrow);

  // Resolve active session: prefer sessionId param, then first live MC session, then first live
  let state;
  try { state = await getState(); } catch { state = { sessions: [] }; }
  const sessions = state.sessions ?? [];

  // Project-override mode: show a project's file graph with no session/lit overlay.
  if (projectOverride) {
    _activeProjectPath = projectOverride;
    _activeProjectKey = projectOverride.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
    _activeSession = null;
    _fillMapRoster(state, null);

    let graphResp;
    try { graphResp = await getGraph(projectOverride); }
    catch { graphResp = { project: projectOverride, graph: null, zoneConfig: null }; }

    const graph = graphResp?.graph ?? null;
    _graphRoot = graphResp?.graphRoot ?? null;

    shell.appendChild(buildScopeGuard(null, graph));

    const panel = el('div', 'map-panel');
    shell.appendChild(panel);

    if (!graph) {
      panel.appendChild(buildPanelHead(null, null, handlers));
      panel.appendChild(buildEmptyState(projectOverride, projectOverride));
      return;
    }

    const fileGraph = aggregateToFiles(graph);
    _fileGraph = fileGraph;
    panel.appendChild(buildPanelHead(null, fileGraph, handlers));

    // No session events — no lit overlay
    const litNodeIds = new Set();
    _litNodeIds = litNodeIds;

    const mapWrap = el('div', 'map-wrap');
    panel.appendChild(mapWrap);
    _mapWrap = mapWrap;

    const layout = computeLayout(fileGraph.nodes, { graphRoot: _graphRoot, availableWidth: measureWrapWidth(mapWrap) });
    _nodePositions = layout.pillPos;

    const { svg } = buildGraphSVG(
      fileGraph, layout.pillPos, layout.dirRects, layout.byDir,
      layout.canvasW, layout.canvasH, litNodeIds, handlers, _graphRoot,
    );
    mapWrap.appendChild(svg);
    bindMapResize();

    _blastContainer = el('div', 'map-blast-container');
    panel.appendChild(_blastContainer);

    panel.appendChild(buildLegend(layout.byDir));
    return;
  }

  // Session mode: clear project state.
  _activeProjectPath = null;
  _activeProjectKey = null;

  let session = null;
  if (sessionId) {
    session = sessions.find(s => s.id === sessionId) ?? null;
  }
  if (!session) {
    session = sessions.find(s => s.live && s.cwd && s.cwd.includes('glmps')) ??
              sessions.find(s => s.live) ??
              null;
  }
  _activeSession = session;

  // Fill the live-sessions roster (left pane). Clicking a row re-focuses the
  // map onto that session; the row's → opens it in Detail.
  _fillMapRoster(state, session);

  const project = session?.cwd ?? null;

  // Fetch graph
  let graphResp;
  try { graphResp = await getGraph(project); }
  catch { graphResp = { project, graph: null, zoneConfig: null }; }

  const graph = graphResp?.graph ?? null;
  _graphRoot = graphResp?.graphRoot ?? null;

  // Scope guard (uses the symbol graph's commit/stale metadata)
  shell.appendChild(buildScopeGuard(session, graph));

  // Panel
  const panel = el('div', 'map-panel');
  shell.appendChild(panel);

  if (!graph) {
    panel.appendChild(buildPanelHead(session, null, handlers));
    panel.appendChild(buildEmptyState(project, project));
    return;
  }

  // Collapse the symbol-level graph to one node per file.
  const fileGraph = aggregateToFiles(graph);
  _fileGraph = fileGraph;
  panel.appendChild(buildPanelHead(session, fileGraph, handlers));

  // Fetch per-session events (global /api/state omits events; per-session endpoint includes them)
  let sessionEvents = [];
  if (session?.id) {
    try {
      const detail = await getState(session.id);
      sessionEvents = detail.events ?? [];
    } catch { sessionEvents = []; }
  }

  // Compute lit node IDs from the session's file-edit events + the file nodes.
  const litNodeIds = computeLitNodeIds(sessionEvents, fileGraph.nodes);
  _litNodeIds = litNodeIds;

  // Map wrap — append first so we can measure the width available for layout.
  const mapWrap = el('div', 'map-wrap');
  panel.appendChild(mapWrap);
  _mapWrap = mapWrap;

  // Layout (one pill per file; directory boxes packed to fill the wrap width)
  const layout = computeLayout(fileGraph.nodes, { graphRoot: _graphRoot, availableWidth: measureWrapWidth(mapWrap) });
  _nodePositions = layout.pillPos;

  const { svg, activeGodNode, incomingCount } = buildGraphSVG(
    fileGraph,
    layout.pillPos,
    layout.dirRects,
    layout.byDir,
    layout.canvasW,
    layout.canvasH,
    litNodeIds,
    handlers,
    _graphRoot,
  );
  mapWrap.appendChild(svg);
  bindMapResize();

  // Blast radius container (empty until a god node is clicked)
  _blastContainer = el('div', 'map-blast-container');
  panel.appendChild(_blastContainer);

  // If the session is editing a god node, show blast radius immediately
  if (activeGodNode) {
    const incoming = incomingCount.get(activeGodNode.id) ?? 0;
    _blastContainer.appendChild(buildBlastCallout(activeGodNode, incoming));
  }

  // Legend
  panel.appendChild(buildLegend(layout.byDir));
}

// ── updateMap (SSE tick) ──────────────────────────────────────────────────────
export async function updateMap(state) {
  if (!_container) return;
  const sessions = state?.sessions ?? [];

  // If a project is being viewed (not a live session), keep the roster fresh
  // but do not clobber the project view with a session re-render.
  if (_activeProjectPath) {
    _fillMapRoster(state, null);
    return;
  }

  // Re-resolve active session
  let session = _activeSession;
  if (session) {
    session = sessions.find(s => s.id === session.id) ?? session;
  } else {
    session = sessions.find(s => s.live && s.cwd?.includes('glmps')) ??
              sessions.find(s => s.live) ?? null;
  }
  if (session) _activeSession = session;

  // Keep the live-sessions roster fresh every tick (elapsed times, new/ended
  // sessions), independent of whether the graph overlay changes.
  _fillMapRoster(state, session);

  if (!_fileGraph || !session) return;

  // Fetch per-session events (global state omits events)
  let sessionEvents = [];
  if (session.id) {
    try {
      const detail = await getState(session.id);
      sessionEvents = detail.events ?? [];
    } catch { sessionEvents = []; }
  }

  const newLit = computeLitNodeIds(sessionEvents, _fileGraph.nodes);
  // Only re-render if lit node set changed
  const changed = newLit.size !== _litNodeIds.size || [...newLit].some(id => !_litNodeIds.has(id));
  if (!changed) return;
  _litNodeIds = newLit;

  // Re-render: since the SVG is deterministic, just re-render the whole panel
  // (cheaper than patching; 421 nodes renders in <1ms)
  renderMap(_container, _handlers, session.id);
}

// (computeLitPaths removed — replaced by computeLitNodeIds from ./lit-match.js)
