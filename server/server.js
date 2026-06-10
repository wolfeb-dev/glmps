// server/server.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { getPaths, ensureStateDirs } from './lib/paths.js';
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
import { computeGuiding } from './lib/guiding.js';
import { annotateUnused } from './lib/asset-scope.js';
import { detectGaps } from './lib/gap-detect.js';
import * as learningStore from './lib/learning-store.js';
import { applyGuard, enqueueIdeaApply, buildIdeaApplyCommand, ingestResults } from './lib/learning-apply.js';
import { buildTerminalRequest } from './lib/terminal-request.js';
import { readUsage, appendSnapshot } from './lib/usage-store.js';
import { pickTitle, cleanFirstPrompt } from './lib/session-title.js';

const WEB_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'web');
const PKG = readJsonSafe(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'package.json')) ?? {};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 5 * 1024 * 1024; // editor payload cap

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
    inventoryScanMs: 60000, agCheckMs: 5000, searchResultCap: 200, backfillBytes: 2 * 1024 * 1024,
    antigravityCommand: null, openInEditorArgs: ['-g', '{path}'], editableRoots: [],
    terminals: [
      { label: 'Claude', command: 'claude', icon: 'claude' },
      { label: 'Gemini', command: 'gemini', icon: 'gemini' },
      { label: 'Codex', command: 'codex', icon: 'codex' },
      { label: 'Blank', command: '', icon: 'terminal' },
    ],
  }, readJsonSafe(configFile));
  if (port !== undefined) cfg.port = port;

  const P = getPaths(env);
  ensureStateDirs(P);
  const index = new IndexStore(P.indexFile);
  const fileApi = new FileApi([P.claudeDir, ...P.antigravityDirs, ...cfg.editableRoots, ...(configFile ? [configFile] : [])], P.undoDir);
  const offsets = readJsonSafe(P.offsetsFile) ?? {};      // { key: {offset, carry} }
  const eventLog = new Map();                              // sessionId -> events[] (ring, cap 2000)
  const clients = new Set();                               // SSE responses
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
          // INVARIANT: this key must match upsertGapInto's — both sha1(code|project)
          // with project = (sessionCwd ?? ''). Keep the two computations in lockstep.
          const gaps = rawGaps.map(g => {
            const key = learningStore.dedupKey({ source: 'gap', code: g.code, project: sessionCwd ?? '' });
            const it = lq.items.find(i => i.id === key);
            return { ...g, id: it ? it.id : null, status: it ? it.status : 'pending' };
          });
          return send(200, { events: log, contextNow: contextNow(log), usage, guiding, skillsUsed, gaps });
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
      if (u.pathname === '/api/usage') {
        return send(200, readUsage(P.stateDir));
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(':ok\n\n');
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
        return send(200, { terminals: cfg.terminals, projectRoots,
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
      const learnMatch = u.pathname.match(/^\/api\/learning\/item\/([^/]+)\/(approve|discard|alternative)$/);
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

      // static files
      const file = path.join(WEB_DIR, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (path.resolve(file).startsWith(path.resolve(WEB_DIR)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
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
  const pollTimer = setInterval(poll, pollMs);
  const agTimer = setInterval(checkAgAlive, cfg.agCheckMs);
  const invTimer = setInterval(scanInv, cfg.inventoryScanMs);

  console.log(`GLMPS: http://127.0.0.1:${actualPort}`);
  return {
    port: actualPort,
    close: async () => {
      clearInterval(pollTimer); clearInterval(agTimer); clearInterval(invTimer);
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
