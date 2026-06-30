// server/server.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { getPaths, ensureStateDirs, graphPathFor } from './lib/paths.js';
import { computeGraphStatus } from './lib/graph-status.js';
import { sessionScope } from './lib/zones.js';
import { loadGraph } from './lib/code-graph.js';
import { readNewLines } from './lib/tailer.js';
import { extractClaudeEvents } from './lib/extract-claude.js';
import { extractAgEvents } from './lib/extract-antigravity.js';
import { discoverClaudeSessions, discoverAgSessions, livenessOf } from './lib/sessions.js';
import { loadAgLabels } from './lib/ag-labels.js';
import { scanInventory } from './lib/inventory.js';
import { contextNow, splitUsage } from './lib/usage.js';
import { IndexStore } from './lib/index-store.js';
import { searchTranscripts } from './lib/search.js';
import { FileApi } from './lib/file-api.js';
import { adapters, detectAll } from './lib/adapters/index.js';
import { assertCanAct } from './lib/act-gate.js';
import { computeGuiding } from './lib/guiding.js';
import { annotateUnused } from './lib/asset-scope.js';
import { detectGaps } from './lib/gap-detect.js';
import { doneGateEvents } from './lib/done-gate-feed.js';
import { scanFleet } from './lib/agent-fleet.js';
import { loopStage } from './lib/loop-stage.js';
import * as learningStore from './lib/learning-store.js';
import * as backlogStore from './lib/backlog-store.js';
import * as runnerStore from './lib/runner-store.js';
import * as memoryScan from './lib/memory-scan.js';
import { SEVERITY as POISON_SEVERITY } from './lib/poison-scan.js';
import { TARGET_IDS, resolveTarget, launchTargetFor, seededCommand, nativeTerminalRecipe, companionRecord, procNamesFor } from './lib/editor-targets.js';
import { pickNextJob, shouldClaim, reconcileLedger, shouldIsolate, worktreePlan, worktreeAddRecipe, worktreeRemoveRecipe, worktreePruneRecipe, launchHeader } from './lib/queue-runner.js';
import { applyGuard, enqueueIdeaApply, buildIdeaApplyCommand, buildMemoryApplyCommand, ingestResults } from './lib/learning-apply.js';
import { buildTerminalRequest } from './lib/terminal-request.js';
import { readUsage, appendSnapshot } from './lib/usage-store.js';
import { readOutcomes } from './lib/outcome-store.js';
import { summarizeOutcomes } from './lib/outcome-metrics.js';
import { finalizeSession } from './lib/session-outcome.js';
import { listReplayTasks } from './lib/replay-set.js';
import { promotionView } from './lib/promotion-view.js';
import { readBudget } from './lib/budget.js';
import { pickTitle, cleanFirstPrompt } from './lib/session-title.js';
import { engagementView, loadProfile, deriveTierRoots } from './lib/profile.js';

const WEB_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'web');
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Resolve the graphify binary's full path once, so a rebuild can spawn it
// WITHOUT a shell and DETACHED. `windowsHide` only hides the direct child
// (cmd.exe); graphify's ~24 AST worker subprocesses each pop a console window.
// Spawning the resolved exe with detached:true gives DETACHED_PROCESS, which
// propagates "no console" through the whole worker tree (the same trick the
// graphify git hook uses). Falls back to a shelled `graphify` if unresolved.
let _graphifyBin = null, _graphifyResolved = false;
function resolveGraphifyBin() {
  if (_graphifyResolved) return _graphifyBin;
  _graphifyResolved = true;
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['graphify'], { encoding: 'utf-8' });
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) _graphifyBin = first;
  } catch {}
  return _graphifyBin;
}
const PKG = readJsonSafe(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'package.json')) ?? {};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 5 * 1024 * 1024; // editor payload cap

const branchCache = new Map(); // root -> { value, ts }
function branchFor(root) {
  const hit = branchCache.get(root);
  if (hit && (Date.now() - hit.ts) < 15000) return Promise.resolve(hit.value);
  return new Promise(res => {
    execFile('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], (e, out) => {
      const value = e ? null : out.trim();
      branchCache.set(root, { value, ts: Date.now() });
      res(value);
    });
  });
}
function normRoot(p) { return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''; }

function resolveIcons() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  // claude-code: newest anthropic.claude-code-* in .antigravity-ide/extensions, else .vscode/extensions
  function findCCIcon() {
    const bases = [
      path.join(home, '.antigravity-ide', 'extensions'),
      path.join(home, '.vscode', 'extensions'),
    ];
    for (const base of bases) {
      try {
        const entries = fs.readdirSync(base);
        const matches = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();
        for (const m of matches) {
          const candidate = path.join(base, m, 'resources', 'claude-logo.svg');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* not found */ }
    }
    return null;
  }

  // antigravity: fixed path under LOCALAPPDATA
  function findAgIcon() {
    const candidate = path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'out', 'vs', 'platform', 'browserOnboarding', 'static', 'antigravity.svg');
    return fs.existsSync(candidate) ? candidate : null;
  }

  const base = {
    'claude-code': findCCIcon(),
    'antigravity': findAgIcon(),
  };
  return {
    ...base,
    // Antigravity-family tools share the Antigravity icon
    'agy-cli': base['antigravity'],
    // Tools without an install-resolved logo ship a bundled brand mark.
    'codex-cli': path.join(WEB_DIR, 'icons', 'codex.svg'),
    'hermes': path.join(WEB_DIR, 'icons', 'hermes.svg'),
  };
}

const ICON_PATHS = resolveIcons();

export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    model: {
      id: raw.model?.id ?? null,
      displayName: raw.model?.display_name ?? raw.model?.displayName ?? raw.model?.id ?? null,
    },
    context: { usedPercent: raw.context_window?.used_percentage ?? raw.context?.usedPercent ?? null },
    cost: { totalUsd: raw.cost?.total_cost_usd ?? raw.cost?.totalUsd ?? null },
    rateLimits: raw.rate_limits ?? raw.rateLimits ?? null,
    sessionName: raw.session_name ?? null,
    capturedAt: raw.capturedAt ?? null,
  };
}

export async function startServer({ port, pollMs = 1000, env = process.env, configFile, restartFn } = {}) {
  const cfg = Object.assign({
    port: 8123, workingThresholdMs: 10000, idleThresholdMs: 60000,
    inventoryScanMs: 60000, agCheckMs: 5000, runnerTickMs: 5000, searchResultCap: 200, backfillBytes: 2 * 1024 * 1024,
    antigravityCommand: null, openInEditorArgs: ['-g', '{path}'], editableRoots: [],
    terminals: [
      { label: 'Claude', command: 'claude', icon: 'claude' },
      { label: 'Gemini', command: 'gemini', icon: 'gemini' },
      { label: 'Codex', command: 'codex', icon: 'codex' },
      { label: 'Blank', command: '', icon: 'terminal' },
    ],
  }, readJsonSafe(configFile));
  if (port !== undefined) cfg.port = port;

  const profile = loadProfile({ cwd: process.cwd(), env, home: os.homedir() });
  const P = getPaths(env, profile);
  P.zoneConfig = { ...P.zoneConfig, tierRoots: deriveTierRoots(P, adapters) };
  ensureStateDirs(P);
  const index = new IndexStore(P.indexFile);
  // Project roots the dashboard / map / navigator surface files from must be
  // openable in the in-app editor. This is a localhost tool over the user's own
  // repos, so allow REPO_ROOT + the synced additionalDirectories (the same repo
  // set the navigator lists), on top of the configured editableRoots.
  const _projectRoots = [REPO_ROOT];
  try {
    const dirs = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'))?.permissions?.additionalDirectories;
    if (Array.isArray(dirs)) _projectRoots.push(...dirs.filter((d) => typeof d === 'string'));
  } catch {}
  const fileApi = new FileApi([P.claudeDir, ...P.antigravityDirs, ...cfg.editableRoots, ..._projectRoots, ...(configFile ? [configFile] : [])], P.undoDir);
  const offsets = readJsonSafe(P.offsetsFile) ?? {};      // { key: {offset, carry} }
  const eventLog = new Map();                              // sessionId -> events[] (ring, cap 2000)
  const clients = new Set();                               // SSE responses
  const buildId = String(Date.now());                     // per-process id; lets the UI detect a restart and reload
  let sessions = [];                                       // last discovery result
  let inventory = { skills: [], agents: [], memory: [], contextFiles: [] };
  let agAlive = false;
  let agLabels = new Map();                                // uuid -> {title, workspace}
  let agLabelsMtimes = new Map();                          // pbPath -> mtimeMs (for refresh detection)
  const tokenStats = new Map();                            // sessionId -> { totalInput, totalOutput, totalCached, contextWindow, lastTurnTokens, ts }

  function applyMetaEvents(sessionId, metaEvents) {
    for (const e of metaEvents) {
      if (e.label === 'cwd' && e.path) index.upsert(sessionId, { cwd: e.path });
      else if (e.label === 'model' && e.model) index.upsert(sessionId, { model: e.model });
    }
  }

  // Track cumulative token totals from adapters that embed them in tokens events
  // (codex-cli today). Feeds status synthesis and the usage-store bridge.
  function trackTokens(sessionId, events) {
    for (const e of events) {
      if (e.kind !== 'tokens' || typeof e.change?.totalInput !== 'number') continue;
      const prev = tokenStats.get(sessionId);
      tokenStats.set(sessionId, {
        totalInput: e.change.totalInput,
        totalOutput: e.change.totalOutput ?? 0,
        totalCached: e.change.totalCached ?? 0,
        contextWindow: e.change.contextWindow ?? prev?.contextWindow ?? null,
        lastTurnTokens: e.change.lastTurnTokens ?? prev?.lastTurnTokens ?? null,
        ts: e.ts ?? prev?.ts ?? null,
      });
    }
  }

  function ctxPctOf(tk) {
    return tk?.contextWindow > 0 && tk?.lastTurnTokens > 0
      ? Math.min(100, Math.max(0, Math.round(100 * tk.lastTurnTokens / tk.contextWindow)))
      : null;
  }

  function pushEvents(sessionId, events) {
    if (!events.length) return;
    // Handle meta events (e.g. kind:'meta' label:'cwd'): upsert index, never log or stream.
    const metaEvents = events.filter(e => e.kind === 'meta');
    const logEvents = events.filter(e => e.kind !== 'meta');
    applyMetaEvents(sessionId, metaEvents);
    if (!logEvents.length) return;
    trackTokens(sessionId, logEvents);
    // Bridge cumulative token events into the usage store (Analytics). Only
    // adapters that embed cumulative totals emit these (codex-cli); tap-backed
    // tools (Claude Code) never do, so there is no double counting.
    for (const e of logEvents) {
      if (e.kind !== 'tokens' || typeof e.change?.totalInput !== 'number') continue;
      const rec = index.get(sessionId) ?? {};
      const tk = tokenStats.get(sessionId);
      const parsed = typeof e.ts === 'string' ? Date.parse(e.ts) : (typeof e.ts === 'number' ? e.ts : NaN);
      const capturedAt = Number.isFinite(parsed) ? parsed : Date.now();
      try {
        appendSnapshot(P.stateDir, {
          sid: sessionId, ts: capturedAt, capturedAt,
          model: rec.model ?? null, costUsd: null,
          input: e.change.totalInput, output: e.change.totalOutput ?? null,
          cacheRead: e.change.totalCached ?? null, cacheCreate: null,
          ctxUsedPct: ctxPctOf(tk), cwd: rec.cwd ?? null,
        });
      } catch {}
    }
    const log = eventLog.get(sessionId) ?? [];
    log.push(...logEvents);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    eventLog.set(sessionId, log);
    index.applyEvents(sessionId, logEvents);
    const payload = `data: ${JSON.stringify({ type: 'events', sessionId, events: logEvents })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function broadcastBacklog() {
    const payload = `data: ${JSON.stringify({ type: 'backlog' })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  const heartbeatCache = new Map(); // adapterId -> ms (refreshed each poll)
  const replayed = new Set();

  function loadHistoryEvents(antigravityDirs) {
    const bySession = new Map();
    for (const root of antigravityDirs) {
      const historyFile = path.join(root, 'history.jsonl');
      try {
        if (!fs.existsSync(historyFile)) continue;
        const lines = fs.readFileSync(historyFile, 'utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.conversationId && obj.display) {
              const sid = obj.conversationId;
              const list = bySession.get(sid) ?? [];
              list.push({
                kind: 'tool',
                lane: 'feed',
                tool: obj.type === 'shell' ? 'command' : 'user',
                path: null,
                ts: obj.timestamp,
                sessionId: sid,
                label: (obj.type === 'shell' ? 'Shell: ' : 'User: ') + obj.display.slice(0, 120),
              });
              bySession.set(sid, list);
            }
          } catch {}
        }
      } catch {}
    }
    return bySession;
  }

  function loadAgMessageEvents(brainSessionDir, sessionId) {
    const events = [];
    const msgDir = path.join(brainSessionDir, '.system_generated', 'messages');
    let files = [];
    try { files = fs.readdirSync(msgDir); } catch { return events; }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'cursor.json' || f === 'read.json') continue;
      try {
        const filepath = path.join(msgDir, f);
        const msg = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        const ts = msg.timestamp ? Date.parse(msg.timestamp) : null;
        if (msg.renderDetails && msg.renderDetails.messageTitle) {
          let kind = 'tool';
          let lane = 'feed';
          let tool = 'task';
          let label = msg.renderDetails.messageTitle;
          let p = null;
          const toolCall = msg.sourceMetadata?.tool?.toolCall;
          if (toolCall) {
            tool = toolCall.name;
            let args = {};
            try { args = JSON.parse(toolCall.argumentsJson ?? '{}'); } catch {}
            p = args.AbsolutePath ?? args.TargetFile ?? '';
            if (typeof p === 'string' && p.startsWith('"')) {
              try { p = JSON.parse(p); } catch {}
            }
            if (toolCall.name === 'run_command') {
              kind = 'command';
              label = args.toolSummary ?? args.CommandLine ?? 'command';
            } else if (/^(write_to_file|replace_file_content|multi_replace_file_content)$/.test(toolCall.name)) {
              kind = 'file-edit';
              label = p || toolCall.name;
            } else if (toolCall.name === 'view_file') {
              const isSkill = args.IsSkillFile === 'true' || args.IsSkillFile === true;
              if (isSkill) {
                kind = 'skill';
                lane = 'context';
                label = p;
              } else if (p && /(CLAUDE|AGENTS|GEMINI)\.md$/i.test(p)) {
                kind = 'context-file';
                lane = 'context';
                label = p;
              }
            }
          }
          events.push({ kind, lane, tool, path: p || null, ts, sessionId, label });
        }
      } catch {}
    }
    return events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }

  function replayIfEmpty(sessionId, file, extractor) {
    if (replayed.has(sessionId) || (eventLog.get(sessionId) ?? []).length > 0) return;
    replayed.add(sessionId);
    let events = [];
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > 0) {
      const start = Math.max(0, size - cfg.backfillBytes);
      const r = readNewLines(file, start, '', { discardFirstPartial: start > 0 });
      events = r.lines.flatMap(l => extractor(l, sessionId));
      // Meta events carry session facts (cwd/model), not feed entries: upsert + strip.
      applyMetaEvents(sessionId, events.filter(e => e.kind === 'meta'));
      events = events.filter(e => e.kind !== 'meta');
      trackTokens(sessionId, events);
    }

    // Fallback for empty/missing log files: load from history.jsonl and messages folder
    if (events.length === 0 && extractor === extractAgEvents) {
      const s = sessions.find(x => x.id === sessionId);
      if (s) {
        const historyMap = loadHistoryEvents(P.antigravityDirs);
        const hEvents = historyMap.get(sessionId) ?? [];
        const mEvents = loadAgMessageEvents(s.dir, sessionId);
        events = [...hEvents, ...mEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      }
    }

    if (events.length) eventLog.set(sessionId, events.slice(-2000));
    // NOTE: deliberately does not touch offsets, index, or SSE — pure in-memory rehydration
  }

  function tailOne(key, file, extractor, sessionId) {
    const st = offsets[key] ?? { offset: 0, carry: '' };
    const first = !(key in offsets);
    let start = st.offset;
    let discard = false;
    if (first) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size > cfg.backfillBytes) { start = size - cfg.backfillBytes; discard = true; }
    }
    const r = readNewLines(file, start, st.carry, { discardFirstPartial: discard });
    offsets[key] = { offset: r.offset, carry: r.carry };
    const events = r.lines.flatMap(l => extractor(l, sessionId));
    // first user line of a Claude transcript becomes the session title
    if (extractor === extractClaudeEvents && !index.get(sessionId)?.title) {
      for (const l of r.lines) {
        try {
          const o = JSON.parse(l);
          const c = o?.type === 'user' ? o.message?.content : null;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.find(x => x.type === 'text')?.text : null;
          if (text) { const t = cleanFirstPrompt(text, 120) ?? text.slice(0, 120); index.upsert(sessionId, { title: t }); break; }
        } catch {}
      }
    }
    pushEvents(sessionId, events);
  }

  function findSubagentFiles(transcriptPath) {
    const dir = transcriptPath.replace(/\.jsonl$/, '');
    const out = [];
    const stack = [path.join(dir, 'subagents')];
    while (stack.length) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(full);
      }
    }
    return out;
  }

  const ACTIVE_WINDOW = cfg.idleThresholdMs * 10; // treat as live if any signal within this window
  function ccLive(s, now) {
    if (s.live) return true; // registry ppid alive
    let m = 0;
    try { m = fs.statSync(s.transcriptPath).mtimeMs; } catch {}
    if (now - m <= ACTIVE_WINDOW) return true;
    try {
      const cap = JSON.parse(fs.readFileSync(path.join(P.statusDir, `${s.id}.json`), 'utf-8')).capturedAt ?? 0;
      if (now - cap <= ACTIVE_WINDOW) return true;
    } catch {}
    return false;
  }

  function refreshAgLabelsIfNeeded() {
    // Check mtime of each root's summaries pb; reload if any changed
    let changed = false;
    for (const dir of P.antigravityDirs) {
      const pbPath = path.join(dir, 'agyhub_summaries_proto.pb');
      let mtime = 0;
      try { mtime = fs.statSync(pbPath).mtimeMs; } catch {}
      if (mtime !== (agLabelsMtimes.get(pbPath) ?? -1)) {
        agLabelsMtimes.set(pbPath, mtime);
        changed = true;
      }
    }
    if (changed) agLabels = loadAgLabels(P.antigravityDirs);
  }

  function pollSnapshot(desc, adapter) {
    // json-snapshot: on mtime change, reload entire file and replace event log
    const snapKey = `snap:${desc.id}`;
    const prev = offsets[snapKey];
    if (prev?.snapMtime === desc.mtimeMs) return; // unchanged

    let text;
    try {
      const stat = fs.statSync(desc.file);
      if (stat.size > 5 * 1024 * 1024) return; // cap 5MB
      text = fs.readFileSync(desc.file, 'utf-8');
    } catch { return; }

    let result;
    try { result = adapter.extractSnapshot(text, desc.id); } catch { return; }

    const { events = [], title, cwd } = result;
    // Apply meta events (cwd, model, etc.) so they land on the index record.
    applyMetaEvents(desc.id, events.filter(e => e.kind === 'meta'));
    // Replace event log entirely (even when empty, to clear stale events from a previous parse)
    if (eventLog.has(desc.id) || events.length > 0) {
      eventLog.set(desc.id, events.slice(-2000));
    }
    index.upsert(desc.id, {
      tool: adapter.id,
      cwd: desc.cwd ?? cwd ?? index.get(desc.id)?.cwd ?? null,
      lastTs: desc.mtimeMs,
      ...(title ? { title } : {}),
    });
    offsets[snapKey] = { snapMtime: desc.mtimeMs };

    // Emit SSE refresh so the UI coalesced-refresh picks it up
    const payload = `data: ${JSON.stringify({ type: 'refresh', sessionId: desc.id })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function poll() {
    refreshAgLabelsIfNeeded();
    sessions = [
      ...discoverClaudeSessions(P),
      ...discoverAgSessions({ antigravityDirs: P.antigravityDirs }),
    ];
    for (const s of sessions) {
      if (s.tool === 'claude-code') {
        index.upsert(s.id, { tool: s.tool, cwd: s.cwd ?? index.get(s.id)?.cwd ?? null,
          lastTs: s.mtimeMs, transcriptPath: s.transcriptPath });
        if (ccLive(s, Date.now()) || eventLog.has(s.id)) {
          replayIfEmpty(s.id, s.transcriptPath, extractClaudeEvents);
          tailOne(`cc:${s.id}`, s.transcriptPath, extractClaudeEvents, s.id);
          for (const f of findSubagentFiles(s.transcriptPath))
            tailOne(`sub:${f}`, f, extractClaudeEvents, s.id);
        }
      } else {
        // pb-only sessions: store workspace from labels if available; no tailing
        const labelCwd = agLabels.get(s.id)?.workspace ?? null;
        const labelTitle = agLabels.get(s.id)?.title ?? null;
        index.upsert(s.id, {
          tool: s.tool,
          cwd: s.format === 'log' ? s.dir : (labelCwd ?? s.dir),
          lastTs: s.mtimeMs,
          logPath: s.logPath ?? null,
          ...(labelTitle ? { title: labelTitle } : {}),
        });
        if (s.format === 'log') {
          const agKey = `ag:${s.id}`;
          if (agKey in offsets || (Date.now() - s.mtimeMs) <= cfg.idleThresholdMs * 50) {
            replayIfEmpty(s.id, s.logPath, extractAgEvents);
            tailOne(agKey, s.logPath, extractAgEvents, s.id);
          }
        }
        // pb-only: no tailing — mtime is the only signal
      }
    }
    // Append label-only (cloud/remote) AG sessions — ids in agLabels not already in sessions
    const sessionIds = new Set(sessions.map(s => s.id));
    for (const [id, { title, workspace }] of agLabels) {
      if (sessionIds.has(id)) continue;
      // Push a remote-only sentinel entry into sessions
      sessions.push({ id, tool: 'antigravity', dir: workspace ?? null,
        logPath: null, pbPath: null, mtimeMs: 0, format: 'remote' });
      // Upsert into index — only set lastTs if not already present (use 0 so they sort last)
      const existing = index.get(id);
      index.upsert(id, {
        tool: 'antigravity',
        cwd: workspace ?? null,
        title: title ?? null,
        ...(existing?.lastTs ? {} : { lastTs: 0 }),
      });
    }

    // Generic adapters (gemini-cli, copilot-chat, future tools)
    // claude-code and antigravity have bespoke handling above; skip them here.
    // Refresh heartbeat cache for adapters that export processAliveMs
    const GENERIC_TOOL_IDS = new Set(['gemini-cli', 'copilot-chat', 'codex-cli', 'openclaw', 'hermes', 'agy-cli', 'opencode', 'cline']);
    for (const adapter of adapters) {
      if (!GENERIC_TOOL_IDS.has(adapter.id)) continue;
      // Refresh heartbeat once per poll per adapter
      if (typeof adapter.processAliveMs === 'function') {
        try { heartbeatCache.set(adapter.id, adapter.processAliveMs(P)); } catch { heartbeatCache.set(adapter.id, 0); }
      }
      if (typeof adapter.discover !== 'function') continue;
      let descs;
      try { descs = adapter.discover(P); } catch { continue; }
      for (const desc of descs) {
        if (desc.kind === 'json-snapshot' && typeof adapter.extractSnapshot === 'function') {
          pollSnapshot(desc, adapter);
          // Register in sessions list for /api/state coverage
          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            const now = Date.now();
            const fakeLive = (now - desc.mtimeMs) <= cfg.idleThresholdMs * 10;
            sessions.push({
              id: desc.id, tool: desc.tool, format: 'snapshot',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: fakeLive,
            });
          }
        } else if (desc.kind === 'jsonl-tail' && typeof adapter.extractLine === 'function') {
          const tailKey = `${desc.tool}:${desc.id}`;
          index.upsert(desc.id, { tool: desc.tool, cwd: desc.cwd ?? index.get(desc.id)?.cwd ?? null, lastTs: desc.mtimeMs });
          replayIfEmpty(desc.id, desc.file, adapter.extractLine);
          tailOne(tailKey, desc.file, adapter.extractLine, desc.id);
          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            sessions.push({ id: desc.id, tool: desc.tool, format: 'jsonl',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: false });
          }
        } else if (desc.kind === 'sqlite-steps' && typeof adapter.extractSteps === 'function') {
          const sqlKey = `sql:${desc.id}`;
          const prev = offsets[sqlKey] ?? { lastIdx: -1, mtime: 0 };

          // extractSteps is capped per call (LIMIT 500); loop to drain all steps after `from`.
          const drain = (from, sink) => {
            let cursor = from, title = null, guard = 0;
            for (;;) {
              const ex = adapter.extractSteps(desc.file, cursor, desc);
              if (ex.title && !title) title = ex.title;
              if (ex.events.length) sink(ex.events);
              if (ex.lastIdx <= cursor || ++guard > 100) break; // no progress / safety cap (~50k steps)
              cursor = ex.lastIdx;
            }
            return { lastIdx: cursor, title };
          };

          // Rehydrate in-memory log after a restart (offsets exist, log empty): re-read all, replace.
          if (!eventLog.has(desc.id) && prev.lastIdx > -1) {
            const buf = [];
            const r = drain(-1, evs => buf.push(...evs));
            if (buf.length) eventLog.set(desc.id, buf.slice(-2000));
            if (r.title && !index.get(desc.id)?.title) index.upsert(desc.id, { title: r.title });
          }

          // Incremental (or first-ever) read on mtime change, draining past the per-call LIMIT.
          if (prev.mtime !== desc.mtimeMs) {
            const r = drain(prev.lastIdx, evs => pushEvents(desc.id, evs));
            if (r.title && !index.get(desc.id)?.title) index.upsert(desc.id, { title: r.title });
            offsets[sqlKey] = { lastIdx: r.lastIdx, mtime: desc.mtimeMs };
            index.upsert(desc.id, { tool: desc.tool, cwd: desc.cwd ?? index.get(desc.id)?.cwd ?? null, lastTs: desc.mtimeMs });
          }

          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            const now = Date.now();
            const hbMs = heartbeatCache.get(adapter.id);
            const isLive = hbMs !== undefined
              ? genericLive(hbMs, desc.mtimeMs, now, cfg)
              : (now - desc.mtimeMs) <= cfg.idleThresholdMs * 10;
            sessions.push({
              id: desc.id, tool: desc.tool, format: 'sqlite',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: isLive,
            });
          }
        }
      }
    }

    writeJsonSafe(P.offsetsFile, offsets);
    index.flush();
  }

  function checkAgAlive() {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Antigravity IDE.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (err, stdout) => { agAlive = !err && /Antigravity/.test(stdout ?? ''); });
  }

  function sessionSummaries() {
    const now = Date.now();
    return sessions.map(s => {
      const rec = index.get(s.id) ?? {};

      // Remote (cloud-only) sessions: no local files, never live, sorted last
      if (s.format === 'remote') {
        const label = agLabels.get(s.id);
        const cwd = label?.workspace ?? null;
        const title = label?.title ?? pickTitle(rec, []);
        return {
          id: s.id, tool: s.tool, format: 'remote', cwd, title, live: false,
          state: 'ended', lastTs: 0,
          skillsUsed: rec.skillsUsed ?? [], status: null,
          recentContext: [],
          counts: { skills: 0, memory: 0, agents: 0, contextFiles: 0, mcp: 0, git: 0 },
          loop: null,
        };
      }

      let mtimeMs = s.mtimeMs;
      if (s.tool === 'claude-code') {
        try { mtimeMs = fs.statSync(s.transcriptPath).mtimeMs; } catch {}
      } else if (s.format === 'log' && s.logPath) {
        try { mtimeMs = fs.statSync(s.logPath).mtimeMs; } catch {}
      } else if (s.format === 'pb' && s.pbPath) {
        try { mtimeMs = fs.statSync(s.pbPath).mtimeMs; } catch {}
      }
      const hbMs = heartbeatCache.get(s.tool);
      const alive = s.tool === 'claude-code'
        ? ccLive(s, now)
        : s.tool === 'antigravity'
          ? agAlive && (now - mtimeMs) <= cfg.idleThresholdMs * 5
          : hbMs !== undefined
            ? genericLive(hbMs, mtimeMs, now, cfg)
            : (s.live === true) || (now - mtimeMs) <= cfg.idleThresholdMs * 10;
      let status = normalizeStatus(readJsonSafe(path.join(P.statusDir, `${s.id}.json`)));
      if (!status && s.tool === 'antigravity') {
        let modelName = 'Gemini 3.5 Flash (Medium)';
        try {
          const settings = JSON.parse(fs.readFileSync(path.join(P.agyCliDir, 'settings.json'), 'utf-8'));
          if (settings.model) modelName = settings.model;
        } catch {}

        const events = eventLog.get(s.id) ?? [];
        const eventCount = events.length;
        const usedPercent = Math.min(100, Math.max(1, Math.round(1 + eventCount * 0.15)));
        const totalUsd = Number((0.002 + eventCount * 0.0003).toFixed(4));

        status = {
          model: {
            id: modelName.toLowerCase().replace(/ /g, '-'),
            displayName: modelName,
          },
          context: {
            usedPercent: usedPercent,
          },
          cost: {
            totalUsd: totalUsd,
          },
          rateLimits: null,
          sessionName: null,
          capturedAt: now,
        };
      }
      // Generic synthesis for tapless tools (codex-cli, future gemini-cli):
      // model captured via meta events, context % from cumulative token events.
      if (!status) {
        const tk = tokenStats.get(s.id);
        if (rec.model || tk) {
          status = {
            model: { id: rec.model ?? null, displayName: rec.model ? rec.model.replace(/^gpt-/, 'GPT-') : null },
            context: { usedPercent: ctxPctOf(tk) },
            cost: { totalUsd: null },
            rateLimits: null, sessionName: null, capturedAt: tk?.ts ?? null,
          };
        }
      }
      const events = eventLog.get(s.id) ?? [];
      const ctxNow = contextNow(events);
      const counts = { skills: 0, memory: 0, agents: 0, contextFiles: 0, mcp: 0, git: 0 };
      for (const e of ctxNow) {
        if (e.kind === 'skill') counts.skills++;
        else if (e.kind === 'memory') counts.memory++;
        else if (e.kind === 'agent') counts.agents++;
        else if (e.kind === 'context-file') counts.contextFiles++;
        else if (e.kind === 'mcp') counts.mcp++;
        else if (e.kind === 'git') counts.git++;
      }
      const label = agLabels.get(s.id);
      // For pb sessions: prefer workspace label over the conversations dir
      const cwd = rec.cwd ?? (s.tool === 'antigravity' ? (label?.workspace ?? null) : null);
      const title = status?.sessionName ?? label?.title ?? pickTitle(rec, events);
      return {
        id: s.id, tool: s.tool, format: s.format ?? null, cwd, title, live: alive,
        state: livenessOf(alive, mtimeMs, now, cfg), lastTs: mtimeMs,
        skillsUsed: rec.skillsUsed ?? [], status: status ?? null,
        recentContext: events.filter(e => e.lane === 'context').slice(-3),
        counts,
        gapCount: detectGaps(events, rec.skillsUsed ?? []).length,
        loop: alive ? loopStage(events) : null,
        scope: alive ? sessionScope(
          events.filter(e => e.kind === 'file-edit').map(e => e.path),
          { projectRoot: rec.cwd ?? cwd ?? null, config: P.zoneConfig }) : null,
      };
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (u.pathname === '/api/health') return send(200, { ok: true });
      const iconMatch = u.pathname.match(/^\/api\/icon\/([^/]+)$/);
      if (iconMatch) {
        const tool = iconMatch[1];
        const iconPath = ICON_PATHS[tool];
        if (!iconPath) return send(404, { error: 'icon not found' });
        const ext = path.extname(iconPath).toLowerCase();
        const contentType = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'max-age=3600' });
        return res.end(fs.readFileSync(iconPath));
      }
      if (u.pathname === '/api/state') {
        const sid = u.searchParams.get('session');
        if (sid) {
          const s = sessions.find(x => x.id === sid);
          if (s) {
            if (s.tool === 'antigravity' && s.format === 'log' && s.logPath)
              replayIfEmpty(sid, s.logPath, extractAgEvents);
            else if (s.tool === 'claude-code' && s.transcriptPath)
              replayIfEmpty(sid, s.transcriptPath, extractClaudeEvents);
            // pb-only: no replay (binary format — no parseable events)
          }
          const log = eventLog.get(sid) ?? [];
          const sessionCwd = (s ?? sessions.find(x => x.id === sid))?.cwd ?? index.get(sid)?.cwd ?? null;
          const sessionProjectKey = s?.transcriptPath ? path.basename(path.dirname(s.transcriptPath)) : null;
          const projectMemoryDir  = s?.transcriptPath ? path.join(path.dirname(s.transcriptPath), 'memory') : null;
          const guiding = computeGuiding(sessionCwd, P.claudeDir, projectMemoryDir);
          // Full skill list from the persisted index (the event-log window can age out early skills).
          const skillsUsed = index.get(sid)?.skillsUsed ?? [];
          const u = splitUsage(inventory, log);
          const usage = { used: u.used, unused: annotateUnused(u.unused, sessionProjectKey, sessionCwd) };
          // Learning loop: fold detected gaps into the persisted queue (dedup),
          // auto-applying templated guards when the toggle is on. Enrich each gap
          // with its queue item id + status so the per-session callout can act.
          const rawGaps = detectGaps(log, skillsUsed);
          let lq = learningStore.load(P.stateDir);
          let lqDirty = false;
          for (const g of rawGaps) {
            const up = learningStore.upsertGapInto(lq, g, { project: sessionCwd ?? '', sessionId: sid });
            lq = up.state;
            if (up.changed) lqDirty = true;
            if (up.isNew && lq.config.autoApplyGaps && up.item.proposedGuard?.rule) {
              try {
                const { commit } = applyGuard({ assetsDir: P.assetsDir,
                  file: up.item.proposedGuard.file, section: up.item.proposedGuard.section,
                  rule: up.item.proposedGuard.rule, message: `learning: apply ${up.item.code}` });
                lq = learningStore.markApplied(lq, up.item.id, commit).state; lqDirty = true;
              } catch (e) { lq = learningStore.markFailed(lq, up.item.id, e.message).state; lqDirty = true; }
            }
          }
          if (lqDirty) learningStore.save(P.stateDir, lq);   // only write when something changed (no per-poll churn)
          // Enrich gaps with their queue item id + status for the actionable callout.
          // INVARIANT: this key must match upsertGapInto's. Both run `project` through
          // normalizeProject() inside learning-store.js, so passing the raw sessionCwd
          // here stays in lockstep with the upsert above (raw cwd -> canonical slug).
          const gaps = rawGaps.map(g => {
            const key = learningStore.dedupKey({ source: 'gap', code: g.code, project: sessionCwd ?? '' });
            const it = lq.items.find(i => i.id === key);
            return { ...g, id: it ? it.id : null, status: it ? it.status : 'pending' };
          });
          // Done-gate results (Stop-hook acceptance gate): merge this session's gate
          // results into the feed/context as shared-shape events, bound by session id.
          let dgEvents = [];
          try { dgEvents = doneGateEvents(fs.readFileSync(path.join(P.doneGateDir, `${sid}.jsonl`), 'utf8'), sid); } catch {}
          const feedLog = dgEvents.length ? [...log, ...dgEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)) : log;
          const loop = loopStage(feedLog, guiding, gaps);
          const scope = sessionScope(
            feedLog.filter(e => e.kind === 'file-edit').map(e => e.path),
            { projectRoot: sessionCwd, config: P.zoneConfig });
          return send(200, { events: feedLog, contextNow: contextNow(feedLog), usage, guiding, skillsUsed, gaps, loop, scope });
        }
        const allEvents = [...eventLog.values()].flat();
        const toolDetection = detectAll(P);
        // Per-tool session counts from current sessions list
        const toolCounts = {};
        for (const s of sessions) toolCounts[s.tool] = (toolCounts[s.tool] ?? 0) + 1;
        const tools = toolDetection.map(t => ({ ...t, sessionsFound: toolCounts[t.id] ?? 0 }));
        return send(200, { sessions: sessionSummaries(), inventory,
          usage: splitUsage(inventory, allEvents),
          history: index.list({}), tools });
      }

      // ── Code graph ──────────────────────────────────────────
      if (u.pathname === '/api/graph') {
        const project = u.searchParams.get('project')
          || sessions.find(s => s.id === u.searchParams.get('session'))?.cwd
          || null;
        const gp = graphPathFor(project);
        let headCommit = null;
        if (project) {
          try { headCommit = await new Promise(res =>
            execFile('git', ['rev-parse', 'HEAD'], { cwd: project }, (e, out) => res(e ? null : out.trim()))); } catch {}
        }
        const graph = gp ? loadGraph(gp, { config: P.zoneConfig, headCommit }) : null;
        const graphRoot = gp ? path.dirname(path.dirname(gp)).replace(/\\/g, '/') : null;
        return send(200, { project, graph, graphRoot, zoneConfig: P.zoneConfig });
      }
      // ── Agent fleet (dashboard Section A) ───────────────────
      if (u.pathname === '/api/agents') {
        const fleet = scanFleet({ agentsDir: P.agentsDir, pluginsCacheDir: P.pluginsCacheDir });
        // dispatchCount: count kind:'agent' events naming each agent, across all sessions
        const counts = {};
        for (const ev of [...eventLog.values()].flat()) {
          if (ev.kind !== 'agent') continue;
          const nm = (ev.label ?? ev.tool ?? '').split(':')[0].trim().toLowerCase();
          if (nm) counts[nm] = (counts[nm] ?? 0) + 1;
        }
        const agents = fleet.agents.map(a => ({ ...a, dispatchCount: counts[(a.name ?? '').toLowerCase()] ?? 0 }));
        return send(200, { agents });
      }
      if (u.pathname === '/api/usage') {
        return send(200, readUsage(P.stateDir));
      }
      if (u.pathname === '/api/engagement' && req.method === 'GET') {
        return send(200, engagementView(P, adapters));
      }
      // Top-end self-improvement loop: per-session outcome records + per-task-class summary.
      if (u.pathname === '/api/outcomes' && req.method === 'GET') {
        const unit = u.searchParams.get('unit') || undefined;
        const taskClass = u.searchParams.get('taskClass') || undefined;
        return send(200, { outcomes: readOutcomes(P.stateDir, { unit, taskClass }) });
      }
      if (u.pathname === '/api/outcomes/summary' && req.method === 'GET') {
        return send(200, summarizeOutcomes(readOutcomes(P.stateDir)));
      }
      // Top-end eval/replay set: the fixed task suite a challenger is scored against.
      if (u.pathname === '/api/replay' && req.method === 'GET') {
        return send(200, { tasks: listReplayTasks(P.stateDir) });
      }
      // Champion/challenger promotion verdict over per-unit outcome aggregates.
      // ?champion=<unit>&challenger=<unit> override the defaults (incumbent vs next).
      if (u.pathname === '/api/promotion' && req.method === 'GET') {
        const champion = u.searchParams.get('champion') || undefined;
        const challenger = u.searchParams.get('challenger') || undefined;
        return send(200, promotionView(readOutcomes(P.stateDir), { champion, challenger }));
      }
      // Finalize one session into an outcome row (idempotent). Driven on demand by a
      // Stop feeder or manual trigger; pulls events from the in-memory log + latest usage.
      if (u.pathname === '/api/outcomes/finalize' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const sid = body.session;
        if (!sid) return send(400, { error: 'session required' });
        const events = eventLog.get(sid) || [];
        const usageRow = (readUsage(P.stateDir).perSession || []).find(s => s.sid === sid) || null;
        const usage = usageRow ? { input: usageRow.input, output: usageRow.output, ctxUsedPct: usageRow.ctxUsedPct } : null;
        const firstPrompt = (events.find(e => e.kind === 'prompt') || {}).label || '';
        const filesTouched = [...new Set(events.filter(e => e.path).map(e => e.path))];
        const { row, appended } = finalizeSession(P.stateDir, { sessionId: sid, events, usage, firstPrompt, filesTouched });
        return send(200, { row, appended });
      }
      if (u.pathname === '/api/budget') {
        // Usage/quota meter: the real Claude.ai plan utilization (5h / weekly /
        // weekly-Sonnet) from /api/oauth/usage — the same data the Claude Code
        // extension shows. Cached ~60s; falls back to claude-manager statusline.json.
        const b = await readBudget({ credentialsFile: P.credentialsFile, statuslineFile: P.cmStatuslineFile });
        return send(200, b);
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(':ok\n\n');
        // Send the build id on connect. EventSource auto-reconnects after a restart,
        // so the client compares this against the first one it saw and reloads on change.
        res.write(`data: ${JSON.stringify({ type: 'hello', buildId })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q') ?? '';
        const sp = u.searchParams;
        const dr = { from: sp.get('from') || null, to: sp.get('to') || null };
        const filters = {
          messageType: sp.get('messageType') || null,
          hasErrors: sp.get('hasErrors') === '1' || sp.get('hasErrors') === 'true',
          hasToolCalls: sp.get('hasToolCalls') === '1' || sp.get('hasToolCalls') === 'true',
          hasFileChanges: sp.get('hasFileChanges') === '1' || sp.get('hasFileChanges') === 'true',
          dateRange: (dr.from || dr.to) ? dr : null,
          project: sp.get('project') || null,
        };
        const targets = index.list({}).filter(r => r.transcriptPath)
          .map(r => ({ id: r.id, transcriptPath: r.transcriptPath, cwd: r.cwd ?? null }));
        const results = await searchTranscripts(targets, q, { cap: cfg.searchResultCap, filters });
        return send(200, { results: [...results], capped: results.capped === true });
      }
      if (u.pathname === '/api/file' && req.method === 'GET')
        return send(200, fileApi.read(u.searchParams.get('path')));
      if (u.pathname === '/api/file' && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        try { return send(200, fileApi.save(body.path, body.content, body.hash, { force: body.force === true })); }
        catch (e) { return send(/conflict/i.test(e.message) ? 409 : 403, { error: e.message }); }
      }
      if (u.pathname === '/api/file/undo' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        return send(200, fileApi.undo(body.path));
      }
      if (u.pathname === '/api/resume' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        fs.appendFileSync(P.requestsFile, JSON.stringify({
          sessionId: body.sessionId, cwd: body.cwd ?? null,
          location: body.location ?? 'panel', ts: Date.now() }) + '\n');
        if (!agAlive && cfg.antigravityCommand)
          spawn(cfg.antigravityCommand, body.cwd ? [body.cwd] : [], { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
        return send(200, { queued: true });
      }
      if (u.pathname === '/api/config') {
        const projectRoots = [...new Set(index.list({}).map(r => r.cwd).filter(Boolean))];
        return send(200, { terminals: cfg.terminals, projectRoots, repoRoot: REPO_ROOT,
          configPath: configFile ?? null, version: PKG.version ?? null, port: actualPort });
      }
      if (u.pathname === '/api/restart' && req.method === 'POST') {
        send(200, { restarting: true });
        setTimeout(() => { try { triggerRestart(); } catch {} }, 200);
        return;
      }
      if (u.pathname === '/api/terminal' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const { record, error } = buildTerminalRequest(body, cfg.terminals);
        if (error) return send(400, { error });
        fs.appendFileSync(P.requestsFile, JSON.stringify(record) + '\n');
        if (!agAlive && cfg.antigravityCommand)
          spawn(cfg.antigravityCommand, record.cwd ? [record.cwd] : [], { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
        return send(200, { queued: true });
      }
      if (u.pathname === '/api/open-in-editor' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        fileApi.read(body.path); // reuse allowlist check
        if (!cfg.antigravityCommand) return send(400, { error: 'openInEditor not configured' });
        const args = cfg.openInEditorArgs.map(a => a.replace('{path}', body.path));
        spawn(cfg.antigravityCommand, args, { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
        return send(200, { ok: true });
      }
      // ── Learning loop ──────────────────────────────────────
      if (u.pathname === '/api/learning' && req.method === 'GET') {
        const results = ingestResults(P.stateDir);
        if (results.length) {
          let st = learningStore.load(P.stateDir);
          for (const r of results) {
            if (!st.items.find(i => i.id === r.id)) continue;
            if (r.status === 'failed') st = learningStore.markFailed(st, r.id, r.error ?? 'apply failed').state;
            else st = learningStore.markApplied(st, r.id, r.commit ?? null).state;
          }
          learningStore.save(P.stateDir, st);
        }
        return send(200, learningStore.load(P.stateDir));
      }
      if (u.pathname === '/api/learning/idea' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = (body.text ?? '').trim();
        if (!text) return send(400, { error: 'empty idea' });
        return send(200, learningStore.addIdeaTo(P.stateDir, text).item);
      }
      if (u.pathname === '/api/learning/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const st = learningStore.setConfigIn(P.stateDir, { autoApplyGaps: !!body.autoApplyGaps });
        return send(200, st.config);
      }
      const learnMatch = u.pathname.match(/^\/api\/learning\/item\/([^/]+)\/(approve|discard|alternative|promote)$/);
      if (learnMatch && req.method === 'POST') {
        const id = decodeURIComponent(learnMatch[1]);
        const action = learnMatch[2];
        const body = JSON.parse((await readBody(req)) || '{}');
        let st = learningStore.load(P.stateDir);
        const item = st.items.find(i => i.id === id);
        if (!item) return send(404, { error: 'item not found' });
        if (action === 'discard' || action === 'alternative') {
          const r = learningStore.applyAction(st, id, action, { rule: body.rule });
          learningStore.save(P.stateDir, r.state);
          return send(200, r.item);
        }
        // Gate: approve and promote write governance rules or launch harness actions (discard/alternative already returned above).
        if (!(env.GLMPS_RUNNER_DRYRUN || env.GLMPS_ALLOW_ACT === '1')) {
          const gate = assertCanAct(P, adapters);
          if (!gate.ok) return send(gate.status, gate.body);
        }
        // promote: lift a learning to a broader scope so all agents see it.
        //  target 'global' (default) -> deterministic guard commit into CLAUDE.global.md.
        //  target 'memory' -> agent-composed memory file via the headless hand.
        if (action === 'promote') {
          if ((body.target ?? 'global') === 'global') {
            const rule = (item.proposedGuard && item.proposedGuard.rule)
              || `- ${(item.title || item.body || '').trim()}`;
            try {
              const { commit } = applyGuard({ assetsDir: P.assetsDir,
                file: 'CLAUDE.global.md', section: 'Learned guards',
                rule, message: `learning: promote ${item.code ?? item.id} to global` });
              const r = learningStore.markApplied(st, id, commit);
              learningStore.save(P.stateDir, r.state);
              return send(200, r.item);
            } catch (e) {
              const r = learningStore.markFailed(st, id, e.message);
              learningStore.save(P.stateDir, r.state);
              return send(200, r.item);
            }
          }
          // target memory -> agent-composed memory file in the item's project memory dir.
          const reqDir = path.join(P.stateDir, 'learning', 'requests');
          const resDir = path.join(P.stateDir, 'learning', 'results');
          fs.mkdirSync(reqDir, { recursive: true });
          fs.mkdirSync(resDir, { recursive: true });
          const requestPath = path.join(reqDir, id + '.json');
          const resultPath = path.join(resDir, id + '.json');
          const munged = (item.project || '').replace(/[\\/:]/g, '-');
          const memoryDir = munged ? path.join(P.projectsDir, munged, 'memory') : path.join(P.projectsDir);
          fs.writeFileSync(requestPath, JSON.stringify({ id, learning: item.body ?? item.title ?? '',
            project: item.project ?? null, memoryDir, resultPath }));
          const command = buildMemoryApplyCommand(id, { requestPath, resultPath, memoryDir });
          enqueueIdeaApply({ requestsFile: P.requestsFile, command, cwd: P.assetsDir });
          if (!agAlive && cfg.antigravityCommand)
            spawn(cfg.antigravityCommand, [], { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
          const r = learningStore.markDispatched(st, id);
          learningStore.save(P.stateDir, r.state);
          return send(200, r.item);
        }
        // approve: deterministic apply when a guard rule exists; else dispatch the hand
        if (item.proposedGuard && item.proposedGuard.rule) {
          try {
            const { commit } = applyGuard({ assetsDir: P.assetsDir,
              file: item.proposedGuard.file ?? 'CLAUDE.global.md',
              section: item.proposedGuard.section ?? 'Learned guards',
              rule: item.proposedGuard.rule, message: `learning: apply ${item.code ?? item.id}` });
            const r = learningStore.markApplied(st, id, commit);
            learningStore.save(P.stateDir, r.state);
            return send(200, r.item);
          } catch (e) {
            const r = learningStore.markFailed(st, id, e.message);
            learningStore.save(P.stateDir, r.state);
            return send(200, r.item);
          }
        }
        const reqDir = path.join(P.stateDir, 'learning', 'requests');
        const resDir = path.join(P.stateDir, 'learning', 'results');
        fs.mkdirSync(reqDir, { recursive: true });
        fs.mkdirSync(resDir, { recursive: true });
        const requestPath = path.join(reqDir, id + '.json');
        const resultPath = path.join(resDir, id + '.json');
        fs.writeFileSync(requestPath, JSON.stringify({ id, idea: item.body,
          assetsDir: P.assetsDir, file: 'CLAUDE.global.md', section: 'Learned guards', resultPath }));
        const command = buildIdeaApplyCommand(id, P.assetsDir, { requestPath, resultPath });
        enqueueIdeaApply({ requestsFile: P.requestsFile, command, cwd: P.assetsDir });
        if (!agAlive && cfg.antigravityCommand)
          spawn(cfg.antigravityCommand, [], { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
        const r = learningStore.markDispatched(st, id);
        learningStore.save(P.stateDir, r.state);
        return send(200, r.item);
      }

      // ── Graph status / rebuild (Settings panel) ──────────────
      // Helper: collect all candidate repo roots from settings additionalDirectories
      // + known session CWDs + this server's own repo root.
      function collectGraphRoots() {
        // Dedup by a normalized key (forward slashes, no trailing slash,
        // lowercased for case-insensitive Windows paths) but keep the first
        // original spelling. Otherwise D:/x, d:/x and D:/x/ list the same repo 3x.
        const seen = new Map();
        const add = (p) => {
          if (!p) return;
          const root = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
          const key = root.toLowerCase();
          if (!seen.has(key)) seen.set(key, root);
        };
        add(REPO_ROOT);
        for (const r of index.list({})) add(r.cwd);          // known session CWDs
        try {                                                 // additionalDirectories
          const settings = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'));
          const dirs = settings?.permissions?.additionalDirectories;
          if (Array.isArray(dirs)) dirs.forEach(add);
        } catch {}
        return [...seen.values()];
      }

      // Helper: build a graph status object for one root (fails soft -> null).
      async function graphStatusForRoot(root) {
        const gp = graphPathFor(root);
        if (!gp) return null;
        let nodes = 0, builtAtCommit = null, mtimeMs = null;
        try {
          const raw = JSON.parse(fs.readFileSync(gp, 'utf-8'));
          nodes = Array.isArray(raw.nodes) ? raw.nodes.length : 0;
          builtAtCommit = raw.built_at_commit ?? null;
        } catch {}
        try { mtimeMs = fs.statSync(gp).mtimeMs; } catch {}
        let headCommit = null;
        try {
          headCommit = await new Promise(res =>
            execFile('git', ['-C', root, 'rev-parse', 'HEAD'], (e, out) => res(e ? null : out.trim())));
        } catch {}
        const project = path.basename(root);
        return computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs });
      }

      // Sort: glmps first, then alpha.
      function sortGraphs(graphs) {
        return graphs.sort((a, b) => {
          const aIsMC = a.project === 'glmps' ? 0 : 1;
          const bIsMC = b.project === 'glmps' ? 0 : 1;
          if (aIsMC !== bIsMC) return aIsMC - bIsMC;
          return a.project.localeCompare(b.project);
        });
      }

      if (u.pathname === '/api/graph/status' && req.method === 'GET') {
        try {
          const roots = collectGraphRoots();
          const results = await Promise.all(roots.map(graphStatusForRoot));
          const graphs = sortGraphs(results.filter(Boolean));
          return send(200, { graphs });
        } catch { return send(200, { graphs: [] }); }
      }

      if (u.pathname === '/api/graph/rebuild' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          let targets;
          if (body.root) {
            // Only ever rebuild a root the server already knows about. Without this,
            // body.root flows into spawn(..., { shell: true }) and an attacker-
            // controlled string ("x && calc.exe") becomes shell command execution.
            const allow = collectGraphRoots().map(r => path.resolve(r));
            const want = path.resolve(String(body.root));
            const match = allow.find(r => r.toLowerCase() === want.toLowerCase());
            if (!match) return send(400, { error: 'root not in graph allowlist' });
            targets = [match];
          } else {
            // Build current status to determine stale graphs
            const roots = collectGraphRoots();
            const statuses = (await Promise.all(roots.map(graphStatusForRoot))).filter(Boolean);
            const stale = statuses.filter(s => s.needsUpdate);
            targets = (stale.length ? stale : statuses).map(s => s.root);
          }
          // Run graphify update for each target sequentially, fail-soft per repo.
          for (const root of targets) {
            await new Promise(res => {
              const bin = resolveGraphifyBin();
              // detached:true => DETACHED_PROCESS, so graphify's worker subprocesses
              // inherit "no console" and don't pop up windows. stdio:'ignore' keeps
              // no console handles. We still await close (no unref).
              const child = bin
                ? spawn(bin, ['update', root], { detached: true, windowsHide: true, stdio: 'ignore', timeout: 120000 })
                : spawn('graphify', ['update', root], { shell: true, windowsHide: true, stdio: 'ignore', timeout: 120000 });
              child.on('close', () => res());
              child.on('error', () => res());
            });
          }
          // Return fresh status
          const roots = collectGraphRoots();
          const results = await Promise.all(roots.map(graphStatusForRoot));
          const graphs = sortGraphs(results.filter(Boolean));
          return send(200, { graphs });
        } catch (e) { return send(500, { error: e.message }); }
      }

      // ── Memory integrity + poisoning scan ─────────────────────
      // GET scans every project memory dir for injected/poisoned entries and
      // reports drift against a persisted baseline manifest; POST re-baselines
      // (operator acknowledges the current memory state as trusted).
      if (u.pathname === '/api/memory/scan' && (req.method === 'GET' || req.method === 'POST')) {
        let subs = [];
        try {
          subs = fs.readdirSync(P.projectsDir, { withFileTypes: true })
            .filter(d => d.isDirectory()).map(d => d.name);
        } catch { /* no projects dir */ }
        const dirs = [];
        const flagged = [];
        const manifest = {};
        let severity = 'none';
        for (const proj of subs) {
          const r = memoryScan.scanMemoryDir(path.join(P.projectsDir, proj, 'memory'));
          if (!r.files.length) continue;
          dirs.push({ project: proj, severity: r.severity, files: r.files });
          for (const [name, h] of Object.entries(r.manifest)) manifest[`${proj}/${name}`] = h;
          for (const f of r.flagged) flagged.push({ project: proj, ...f });
          if (POISON_SEVERITY[r.severity] > POISON_SEVERITY[severity]) severity = r.severity;
        }
        const baseFile = path.join(P.stateDir, 'memory-baseline.json');
        let baseline = {};
        try { baseline = JSON.parse(fs.readFileSync(baseFile, 'utf-8')); } catch { /* no baseline yet */ }
        const integrity = memoryScan.diffManifest(baseline, manifest);
        if (req.method === 'POST' || Object.keys(baseline).length === 0) {
          try { fs.mkdirSync(P.stateDir, { recursive: true }); fs.writeFileSync(baseFile, JSON.stringify(manifest, null, 2)); } catch {}
        }
        return send(200, { severity, dirs, flagged, integrity, acknowledged: req.method === 'POST' });
      }

      // ── Projects summary ──────────────────────────────────────
      if (u.pathname === '/api/projects' && req.method === 'GET') {
        try {
          // Only surface real repositories: this server's own root, plus any
          // candidate root that is an actual git repo (.git dir or worktree file).
          // Drops transient session cwds (UUID/temp dirs) that pollute the list.
          const roots = collectGraphRoots().filter((root) => {
            if (normRoot(root) === normRoot(REPO_ROOT)) return true;
            try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
          });
          const sums = sessionSummaries();
          const history = index.list({});
          const projects = await Promise.all(roots.map(async (root) => {
            const k = normRoot(root);
            const hist = history.filter(r => normRoot(r.cwd) === k);
            const live = sums.filter(s => normRoot(s.cwd) === k && s.live);
            const lastTs = hist.reduce((m, r) => Math.max(m, r.lastTs || 0), 0) || null;
            const gs = await graphStatusForRoot(root).catch(() => null);
            const key = path.basename(root);
            const open = backlogStore.listFrom(P.stateDir, { project: key })
              .filter(i => i.state !== 'done' && i.state !== 'cancelled').length;
            return {
              name: key, key, path: root,
              sessionCount: hist.length, liveCount: live.length, lastTs,
              branch: await branchFor(root),
              graph: gs ? { nodes: gs.nodes, needsUpdate: gs.needsUpdate } : { nodes: 0, needsUpdate: false },
              backlogOpen: open,
            };
          }));
          const sorted = projects.sort((a, b) => {
            const aMC = a.key === 'glmps' ? 0 : 1, bMC = b.key === 'glmps' ? 0 : 1;
            return aMC !== bMC ? aMC - bMC : a.key.localeCompare(b.key);
          });
          return send(200, { projects: sorted });
        } catch { return send(200, { projects: [] }); }
      }

      // ── Learning status / synth (Settings panel) ──────────────
      if (u.pathname === '/api/learning/status' && req.method === 'GET') {
        try {
          // Read watermark
          let lastRunMs = null;
          try {
            const wmPath = path.join(P.stateDir, 'learning', 'synth-watermark.json');
            const wm = JSON.parse(fs.readFileSync(wmPath, 'utf-8'));
            if (typeof wm.lastRunMs === 'number') lastRunMs = wm.lastRunMs;
          } catch {}
          const st = learningStore.load(P.stateDir);
          const pending = st.items.filter(i => i.status === 'pending').length;
          return send(200, { lastRunMs, pending, total: st.items.length });
        } catch (e) { return send(500, { error: e.message }); }
      }

      if (u.pathname === '/api/learning/synth' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const scriptPath = path.join(REPO_ROOT, 'scripts', 'capability-synth.mjs');
          const args = ['days' in body && body.days != null
            ? `--days ${Number(body.days)}`
            : '--all'];
          const { stdout, stderr, code } = await new Promise(res => {
            let stdout = '', stderr = '';
            const child = spawn(
              'node',
              [scriptPath, ...args[0].split(' ')],
              { cwd: REPO_ROOT, shell: false, windowsHide: true, timeout: 180000 }
            );
            child.stdout?.on('data', d => { stdout += d; });
            child.stderr?.on('data', d => { stderr += d; });
            child.on('close', code => res({ stdout, stderr, code }));
            child.on('error', err => res({ stdout, stderr: err.message, code: 1 }));
          });
          if (code !== 0) {
            return send(200, { ok: false, scanned: null, upserted: null, message: (stderr || stdout).trim() });
          }
          // Parse "scanned X transcript(s), Y gap(s) upserted" from stdout
          const all = stdout + '\n' + stderr;
          const m = all.match(/scanned\s+(\d+)\s+transcript[^,]*,\s*(\d+)\s+gap/i);
          const scanned = m ? Number(m[1]) : null;
          const upserted = m ? Number(m[2]) : null;
          return send(200, { ok: true, scanned, upserted, message: stdout.trim() });
        } catch (e) { return send(500, { error: e.message }); }
      }

      if (u.pathname === '/api/backlog' && req.method === 'GET') {
        const project = u.searchParams.get('project') ?? undefined;
        const status = u.searchParams.get('status') ?? undefined;
        return send(200, { items: backlogStore.listFrom(P.stateDir, { project, status }) });
      }
      if (u.pathname === '/api/backlog' && req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!body.title || !String(body.title).trim()) return send(400, { error: 'empty title' });
        const { item } = backlogStore.addItemTo(P.stateDir, {
          project: body.project, title: String(body.title).trim(), prompt: body.prompt, state: body.state,
          origin: body.origin,
        });
        broadcastBacklog();
        return send(201, item);
      }
      if (u.pathname === '/api/backlog/pause' && req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const s = backlogStore.setPausedIn(P.stateDir, !!body.paused);
        broadcastBacklog();
        return send(200, { paused: s.paused });
      }
      if (u.pathname === '/api/backlog/reorder' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!Array.isArray(body.ids)) return send(400, { error: 'ids must be an array' });
        const { items } = backlogStore.reorderItemsIn(P.stateDir, { ids: body.ids, status: body.status, project: body.project });
        broadcastBacklog();
        return send(200, { items });
      }
      // Operator-only release of a poison-quarantined card (human-in-the-loop).
      const approveMatch = u.pathname.match(/^\/api\/backlog\/([^/]+)\/approve$/);
      if (approveMatch && req.method === 'POST') {
        const id = decodeURIComponent(approveMatch[1]);
        const r = backlogStore.approveItemIn(P.stateDir, id);
        if (!r.item) return send(404, { error: 'item not found' });
        broadcastBacklog();
        return send(200, r.item);
      }
      const backlogMatch = u.pathname.match(/^\/api\/backlog\/([^/]+)$/);
      if (backlogMatch && req.method === 'GET') {
        const id = decodeURIComponent(backlogMatch[1]);
        const item = backlogStore.load(P.stateDir).items.find(i => i.id === id);
        if (!item) return send(404, { error: 'item not found' });
        return send(200, item);
      }
      if (backlogMatch && req.method === 'PATCH') {
        const id = decodeURIComponent(backlogMatch[1]);
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const isLabelDelta = 'labels' in body || 'removeLabels' in body || 'comment' in body;
        const r = isLabelDelta
          ? backlogStore.applyLabelDeltaIn(P.stateDir, id, body)
          : backlogStore.updateItemIn(P.stateDir, id, body);
        if (!r.item) return send(404, { error: 'item not found' });
        broadcastBacklog();
        return send(200, r.item);
      }
      if (backlogMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(backlogMatch[1]);
        const { removed } = backlogStore.removeItemIn(P.stateDir, id);
        if (!removed) return send(404, { error: 'item not found' });
        broadcastBacklog();
        return send(200, { removed: true });
      }
      // ── Queue runner (launches queued cards as interactive sessions) ──
      if (u.pathname === '/api/runner' && req.method === 'GET') {
        return send(200, {
          config: runnerStore.loadConfig(P.stateDir),
          ledger: runnerStore.loadLedger(P.stateDir),
          targets: TARGET_IDS,
        });
      }
      if (u.pathname === '/api/runner/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['enabled', 'maxConcurrent', 'maxRuntimeMs', 'maxRetries', 'lastTarget', 'useWorktrees'];
        const patch = {};
        for (const k of allowed) if (k in body) patch[k] = body[k];
        return send(200, runnerStore.saveConfig(P.stateDir, patch));
      }
      const runMatch = u.pathname.match(/^\/api\/runner\/run\/([^/]+)$/);
      if (runMatch && req.method === 'POST') {
        if (!(env.GLMPS_RUNNER_DRYRUN || env.GLMPS_ALLOW_ACT === '1')) {
          const gate = assertCanAct(P, adapters);
          if (!gate.ok) return send(gate.status, gate.body);
        }
        const { status, body } = runJobNow(decodeURIComponent(runMatch[1]));
        return send(status, body);
      }

      // static files
      const file = path.join(WEB_DIR, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (path.resolve(file).startsWith(path.resolve(WEB_DIR)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
      // SPA route fallback: GET with no file extension and not /api/* -> serve the
      // app shell so client-side routes (/history, /detail/<id>, ...) load + refresh.
      if (req.method === 'GET' && !u.pathname.startsWith('/api/') && !path.extname(u.pathname)) {
        const indexFile = path.join(WEB_DIR, 'index.html');
        if (fs.existsSync(indexFile)) {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end(fs.readFileSync(indexFile));
        }
      }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: e.message }); }
  });

  // Restart: release the port, respawn the same entry detached, then exit.
  // Injectable so it can be unit-tested without killing the test runner.
  const defaultRestart = async () => {
    // Drain our timers and SSE clients first. Otherwise server.close() never fires its
    // callback (open /api/events streams keep it pending), the await hangs, process.exit
    // is never reached, and the old process leaks -- still polling tasklist every tick.
    try { clearInterval(pollTimer); clearInterval(agTimer); clearInterval(invTimer); } catch {}
    try { for (const c of clients) c.end(); } catch {}
    try { server.close(); } catch {}
    try {
      const entry = process.argv[1];
      if (entry) spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
    process.exit(0);
  };
  const triggerRestart = restartFn ?? defaultRestart;

  // Bind with retry: the respawned process may briefly race the old one for the port.
  await new Promise((resolve, reject) => {
    let attempts = 0;
    const onErr = (e) => {
      if (e && e.code === 'EADDRINUSE' && attempts < 20) {
        attempts++;
        setTimeout(() => server.listen(cfg.port, '127.0.0.1'), 250);
      } else {
        server.removeListener('error', onErr);
        reject(e);
      }
    };
    server.on('error', onErr);
    server.once('listening', () => { server.removeListener('error', onErr); resolve(); });
    server.listen(cfg.port, '127.0.0.1');
  });
  const actualPort = server.address().port;

  agLabels = loadAgLabels(P.antigravityDirs);
  poll(); checkAgAlive();
  const scanInv = () => {
    inventory = scanInventory({ pluginsCacheDir: P.pluginsCacheDir, projectsDir: P.projectsDir,
      claudeDir: P.claudeDir,
      projectRoots: [...new Set(index.list({}).map(r => r.cwd).filter(Boolean))] });
  };
  scanInv();
  // ── Queue runner ───────────────────────────────────────────
  // Claims the top queued card and launches an interactive, agent-self-reporting
  // session seeded with the card's prompt (via a file the agent reads). Opt-in
  // (config.enabled), honors board pause, reconciles dead/overrunning sessions.
  const claudeCmd = (cfg.terminals.find(t => t.label === 'Claude')?.command) || 'claude';

  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  function detectEditors() {
    const running = [];
    if (agAlive) running.push('antigravity');
    let names = '';
    try {
      names = process.platform === 'win32'
        ? execFileSync('tasklist', { encoding: 'utf-8' }).toLowerCase()
        : execFileSync('ps', ['-A', '-o', 'comm'], { encoding: 'utf-8' }).toLowerCase();
    } catch { return running; }
    for (const id of TARGET_IDS) {
      if (id === 'native-terminal' || id === 'antigravity') continue;
      if (procNamesFor(id).some(n => names.includes(n))) running.push(id);
    }
    return running;
  }

  function repoForProject(project) {
    // Mirror the /api/projects root set (collectGraphRoots is request-scoped):
    // REPO_ROOT + known session cwds + settings additionalDirectories, deduped,
    // then keep only real git repos and match basename === project (the card key).
    const seen = new Map();
    const add = (p) => { if (!p) return; const root = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); const k = root.toLowerCase(); if (!seen.has(k)) seen.set(k, root); };
    add(REPO_ROOT);
    for (const r of index.list({})) add(r.cwd);
    try { const dirs = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'))?.permissions?.additionalDirectories; if (Array.isArray(dirs)) dirs.forEach(add); } catch {}
    const roots = [...seen.values()].filter(root => {
      if (normRoot(root) === normRoot(REPO_ROOT)) return true;
      try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
    });
    return roots.find(r => path.basename(r) === project) ?? null;
  }

  // Impure worktree edge: give a job its own git worktree so two same-project
  // agents never share one checkout (cwd) and clobber each other's files.
  // Returns { dir, branch } or null (git failed -> caller falls back to the
  // shared repo cwd). Never throws — the runner must not crash on git hiccups.
  function createWorktree({ repo, project, jobId }) {
    const plan = worktreePlan({ baseDir: P.worktreesDir, project, jobId });
    try {
      fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
      const prune = worktreePruneRecipe({ repo });
      try { execFileSync(prune.file, prune.args, { stdio: 'ignore' }); } catch {}
      if (fs.existsSync(plan.dir)) { // leftover checkout from a crashed run
        const rm = worktreeRemoveRecipe({ repo, dir: plan.dir });
        try { execFileSync(rm.file, rm.args, { stdio: 'ignore' }); } catch {}
      }
      const add = worktreeAddRecipe({ repo, dir: plan.dir, branch: plan.branch });
      execFileSync(add.file, add.args, { stdio: 'ignore' });
      return plan;
    } catch { return null; }
  }

  // Remove a finished job's worktree checkout once it leaves the live ledger.
  // The branch is kept so any work the agent committed stays recoverable.
  function removeWorktree(worktree) {
    if (!worktree?.repo || !worktree?.dir) return;
    const rm = worktreeRemoveRecipe({ repo: worktree.repo, dir: worktree.dir });
    try { execFileSync(rm.file, rm.args, { stdio: 'ignore' }); } catch {}
    const prune = worktreePruneRecipe({ repo: worktree.repo });
    try { execFileSync(prune.file, prune.args, { stdio: 'ignore' }); } catch {}
  }

  function launchSession({ target, seeded, cwd }) {
    if (env.GLMPS_RUNNER_DRYRUN) return process.pid; // tests: no real window, pid looks alive
    if (target !== 'native-terminal') {
      const rec = companionRecord({ targetId: target, seededCmd: seeded, cwd, now: Date.now() });
      fs.appendFileSync(P.requestsFile, JSON.stringify(rec) + '\n');
      if (!agAlive && cfg.antigravityCommand)
        spawn(cfg.antigravityCommand, cwd ? [cwd] : [], { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
      return null; // editor owns the process; liveness tracked via card state + timeout
    }
    const recipe = nativeTerminalRecipe({ platform: process.platform, seededCmd: seeded, cwd: cwd ?? process.cwd() });
    try { const child = spawn(recipe.file, recipe.args, recipe.options); child.unref(); return child.pid ?? null; }
    catch { return null; }
  }

  // One card -> a launched session. Writes the prompt to a file (never on a
  // command line) and opens it in the resolved editor target; the agent then
  // self-reports the card to done. Returns { target, pid }.
  function launchJob(job) {
    const rc = runnerStore.loadConfig(P.stateDir);
    const repo = repoForProject(job.project);
    let cwd = repo;
    // Isolate the job in a private worktree when concurrency makes a shared
    // checkout unsafe (or the user forced it on). Falls back to the repo cwd if
    // there is no repo or git could not create the worktree.
    let worktree = null;
    if (repo && shouldIsolate({ useWorktrees: rc.useWorktrees, maxConcurrent: rc.maxConcurrent })) {
      const wt = createWorktree({ repo, project: job.project, jobId: job.id });
      if (wt) { worktree = { ...wt, repo }; cwd = wt.dir; }
    }
    const running = env.GLMPS_RUNNER_DRYRUN ? [] : detectEditors();
    const preferred = resolveTarget({ item: job, lastTarget: rc.lastTarget, running });
    // Downgrade a companion-less editor target to native-terminal so the session
    // actually opens (glmps-12); the ledger/label below then reflect the real target.
    const target = launchTargetFor(preferred, { agAlive, antigravityCommand: cfg.antigravityCommand });
    const header = launchHeader({ job, port: actualPort });
    const promptFile = runnerStore.writePrompt(P.stateDir, job.id, `${header}\n\n${job.prompt ?? ''}`);
    const seeded = seededCommand(claudeCmd, promptFile);
    const pid = launchSession({ target, seeded, cwd });
    backlogStore.applyLabelDeltaIn(P.stateDir, job.id, { labels: ['agent:in-progress'], comment: `runner: launched in ${target}${worktree ? ' (worktree)' : ''}` });
    return { target, pid, worktree };
  }

  // Reconcile the live ledger against current cards (dead/overrunning -> requeue/held),
  // persist it, and return fresh { rc, bl, ledger, hadActions }.
  function reconcileNow() {
    const rc = runnerStore.loadConfig(P.stateDir);
    const before = runnerStore.loadLedger(P.stateDir);
    const rec = reconcileLedger({
      ledger: before, items: backlogStore.load(P.stateDir).items, isAlive: pidAlive,
      now: Date.now(), maxRuntimeMs: rc.maxRuntimeMs, maxRetries: rc.maxRetries,
    });
    let ledger = rec.ledger;
    // Any job that left the live ledger (done/held) gets its worktree reclaimed.
    // Requeued jobs keep their entry, so their worktree is left in place.
    for (const id of Object.keys(before)) if (!(id in ledger)) removeWorktree(before[id].worktree);
    for (const a of rec.actions) {
      if (a.action === 'requeue') backlogStore.applyLabelDeltaIn(P.stateDir, a.id, { labels: ['agent:backlog'], comment: `runner: requeued (${a.reason})` });
      else backlogStore.updateItemIn(P.stateDir, a.id, { state: 'held' });
    }
    runnerStore.saveLedger(P.stateDir, ledger);
    return { rc, bl: backlogStore.load(P.stateDir), ledger, hadActions: rec.actions.length > 0 };
  }

  function runnerTick() {
    try {
      const { rc, bl, ledger, hadActions } = reconcileNow();
      const runningCount = Object.keys(ledger).length;
      if (shouldClaim({ enabled: rc.enabled, paused: bl.paused, runningCount, maxConcurrent: rc.maxConcurrent })) {
        const job = pickNextJob(bl.items);
        if (job) {
          const { target, pid, worktree } = launchJob(job);
          ledger[job.id] = { pid: pid ?? null, startedAt: Date.now(), target, retries: ledger[job.id]?.retries ?? 0, worktree: worktree ?? null };
          runnerStore.saveLedger(P.stateDir, ledger);
          broadcastBacklog();
          return;
        }
      }
      if (hadActions) broadcastBacklog();
    } catch { /* the runner must never crash the server */ }
  }

  // Manual "Run now": launch one specific card immediately, regardless of the
  // Auto-run toggle or board pause, but still honoring maxConcurrent.
  function runJobNow(id) {
    const { rc, bl, ledger } = reconcileNow();
    const job = bl.items.find(i => i.id === id);
    if (!job) return { status: 404, body: { error: 'item not found' } };
    if (ledger[id]) return { status: 409, body: { error: 'already running' } };
    if (job.state === 'done' || job.state === 'cancelled') return { status: 409, body: { error: `card is ${job.state}` } };
    // Poison gate: even an explicit "Run now" cannot launch a quarantined card.
    // Force the operator to review and approve it first (POST .../approve).
    if (job.quarantined) return { status: 409, body: { error: 'card is poison-quarantined — review and approve it before running', flags: job.provenance?.flags ?? [] } };
    if (Object.keys(ledger).length >= rc.maxConcurrent) return { status: 409, body: { error: 'runner at capacity — finish or wait for the running session' } };
    const { target, pid, worktree } = launchJob(job);
    ledger[id] = { pid: pid ?? null, startedAt: Date.now(), target, retries: 0, worktree: worktree ?? null };
    runnerStore.saveLedger(P.stateDir, ledger);
    broadcastBacklog();
    return { status: 200, body: { id, target, state: 'in_progress' } };
  }

  const pollTimer = setInterval(poll, pollMs);
  const agTimer = setInterval(checkAgAlive, cfg.agCheckMs);
  const invTimer = setInterval(scanInv, cfg.inventoryScanMs);
  const runnerTimer = setInterval(runnerTick, cfg.runnerTickMs);

  console.log(`GLMPS: http://127.0.0.1:${actualPort}`);
  return {
    port: actualPort,
    runnerTick, // exposed for deterministic tests
    close: async () => {
      clearInterval(pollTimer); clearInterval(agTimer); clearInterval(invTimer); clearInterval(runnerTimer);
      for (const c of clients) c.end();
      await new Promise(r => server.close(r));
    },
  };
}

/**
 * Liveness rule for adapters that export processAliveMs (e.g. agy-cli).
 * heartbeatMs: result of adapter.processAliveMs(P) — ms since epoch of the newest heartbeat file.
 * mtimeMs: mtime of the session's data file (db/jsonl/etc).
 * Returns true when the process heartbeat is fresh AND the session has activity within 8h.
 * @param {number} heartbeatMs
 * @param {number} mtimeMs
 * @param {number} now
 * @param {object} cfg
 * @returns {boolean}
 */
export function genericLive(heartbeatMs, mtimeMs, now, cfg) {
  const heartbeatFresh = (now - heartbeatMs) <= cfg.idleThresholdMs * 10;
  if (!heartbeatFresh) return false;
  return (now - mtimeMs) <= 8 * 3600 * 1000;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return undefined; } }
function writeJsonSafe(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  } catch {}
}

// CLI entry: `npm start`
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const configFile = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'config.json');
  startServer({ configFile });
}
