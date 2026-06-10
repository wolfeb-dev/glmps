// server/lib/adapters/codex-cli.js
// OpenAI Codex CLI adapter. Format mirrors
// D:/_scratch_cch_viewer/src-tauri/src/providers/codex.rs.
// base = P.codexDir ($CODEX_HOME, else ~/.codex). Sessions live under
//   sessions/**/rollout-*.jsonl  and  archived_sessions/**/rollout-*.jsonl
// walked recursively (date subdirs vary in depth across versions).
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'codex-cli';
export const displayName = 'Codex CLI';

function statDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }

export function detect(P) {
  const base = P?.codexDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  const sessions = path.join(base, 'sessions');
  const archived = path.join(base, 'archived_sessions');
  return { installed: statDir(sessions) || statDir(archived), dataDirs: [base] };
}

/** Recursively collect rollout-*.jsonl files under a root (any depth). */
function walkRollouts(root, out, depth = 0) {
  if (depth > 12) return; // safety cap against pathological trees
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      walkRollouts(full, out, depth + 1);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

export function discover(P) {
  const base = P?.codexDir;
  const out = [];
  if (typeof base !== 'string') return out;
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = path.join(base, sub);
    if (!statDir(root)) continue;
    const files = [];
    walkRollouts(root, files);
    for (const filePath of files) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }
      const basename = path.basename(filePath).replace(/\.jsonl$/, '');
      out.push({
        id: `codex:${basename}`,
        tool: id,
        kind: 'jsonl-tail',
        file: filePath,
        cwd: null,
        label: null,
        mtimeMs,
      });
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const TOOL_NAME_MAP = { exec_command: 'Bash', shell: 'Bash', shell_command: 'Bash', write_stdin: 'Bash' };
function mapToolName(name) { return TOOL_NAME_MAP[name] ?? name; }

/** Pull concatenated text out of a Codex message content array/string. */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const c of content) {
    if (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') {
      text += (c.text ?? '');
    } else if (typeof c?.text === 'string') {
      text += c.text;
    }
  }
  return text;
}

/** True when user text is an auto-injected wrapper (codex prepends these). */
function isAutoInjectedUserText(text) {
  return text.trimStart().startsWith('<environment_context>');
}

/** Strip a leading <environment_context>...</environment_context> wrapper. */
function stripEnvironmentContext(text) {
  return text.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/, '').trim();
}

/** Parse a function_call arguments value (string JSON or object) to an object. */
function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return {};
}

/** Normalise a Bash command argument (cmd/command, string or array) to a string. */
function bashCommand(input) {
  let cmd = input?.command ?? input?.cmd ?? null;
  if (Array.isArray(cmd)) cmd = cmd.filter(x => typeof x === 'string').join(' ');
  return typeof cmd === 'string' ? cmd : null;
}

// Per-session cumulative token state for computing per-turn deltas.
// Keyed by sessionId. Stateless extractLine otherwise.
const tokenState = new Map();

/** Extract cumulative (input, output, cached) totals from a token_count payload. */
function extractTokenTotals(payload) {
  const total = payload?.info?.total_token_usage;
  if (total && typeof total === 'object') {
    const input = Number(total.input_tokens);
    const output = Number(total.output_tokens);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      const cached = Number(total.cached_input_tokens) || 0;
      return { input, output, cached };
    }
  }
  const last = payload?.info?.last_token_usage;
  if (last && typeof last === 'object') {
    const input = Number(last.input_tokens);
    const output = Number(last.output_tokens);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      const cached = Number(last.cached_input_tokens) || 0;
      return { input, output, cached };
    }
  }
  return null;
}

/**
 * Reset cumulative token tracking for a session. Exported for tests so token
 * delta assertions start from a clean slate.
 */
export function resetTokenState(sessionId) {
  if (sessionId == null) tokenState.clear();
  else tokenState.delete(sessionId);
}

/** jsonl-tail: one line -> events[] */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  const type = obj.type ?? null;
  const payload = obj.payload ?? obj;
  const ts = obj.timestamp ?? null;

  // session_meta / turn_context: surface cwd + model as meta events (server upserts)
  if (type === 'session_meta' || type === 'turn_context') {
    const out = [];
    const cwd = payload?.cwd ?? null;
    if (cwd) out.push({ kind: 'meta', lane: 'feed', label: 'cwd', path: cwd, sessionId });
    const model = typeof payload?.model === 'string' && payload.model ? payload.model : null;
    if (model) out.push({ kind: 'meta', lane: 'feed', label: 'model', model, sessionId });
    return out;
  }

  // event_msg: dedup user_message/agent_message against response_item copies;
  // compute per-turn token deltas from cumulative token_count.
  if (type === 'event_msg') {
    const etype = payload?.type ?? null;
    if (etype === 'user_message' || etype === 'agent_message') return []; // duplicate of response_item
    if (etype === 'token_count') {
      const totals = extractTokenTotals(payload);
      if (!totals) return [];
      const prev = tokenState.get(sessionId);
      let delta;
      if (!prev) {
        delta = { input: totals.input, output: totals.output, cached: totals.cached };
      } else {
        delta = {
          input: Math.max(0, totals.input - prev.input),
          output: Math.max(0, totals.output - prev.output),
          cached: Math.max(0, totals.cached - prev.cached),
        };
      }
      tokenState.set(sessionId, totals);
      const nonCachedInput = Math.max(0, delta.input - delta.cached);
      const contextWindow = Number(payload?.info?.model_context_window);
      const lastTurn = Number(payload?.info?.last_token_usage?.total_tokens);
      return [{
        kind: 'tokens', lane: 'feed', tool: 'tokens', path: null, ts, sessionId,
        label: `tokens +${nonCachedInput} in / +${delta.output} out`,
        change: {
          input: nonCachedInput, output: delta.output, cached: delta.cached,
          totalInput: totals.input, totalOutput: totals.output, totalCached: totals.cached,
          ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
          ...(Number.isFinite(lastTurn) ? { lastTurnTokens: lastTurn } : {}),
        },
      }];
    }
    return [];
  }

  if (type !== 'response_item') return [];

  const ptype = payload?.type ?? null;

  // User / assistant message
  if (ptype === 'message') {
    const role = payload?.role ?? 'user';
    if (role !== 'user') return []; // assistant text is not a feed action
    let text = textFromContent(payload?.content);
    if (!text) return [];
    if (isAutoInjectedUserText(text)) {
      text = stripEnvironmentContext(text);
      if (!text) return [];
    }
    return [{
      kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
    }];
  }

  // local_shell_call -> Bash command
  if (ptype === 'local_shell_call') {
    let command = payload?.action?.command ?? null;
    if (Array.isArray(command)) command = command.filter(x => typeof x === 'string').join(' ');
    const cmdStr = typeof command === 'string' ? command : '';
    if (cmdStr) {
      const g = classifyGit(cmdStr);
      if (g) return [{ ...g, tool: 'Bash', path: null, ts, sessionId }];
    }
    const label = cleanTitle(cmdStr || 'Bash', 120) ?? 'Bash';
    return [{ kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts, sessionId, label }];
  }

  // function_call -> tool (Bash for exec/shell, else named tool)
  if (ptype === 'function_call') {
    const rawName = payload?.name ?? 'tool call';
    const name = mapToolName(rawName);
    const input = parseArgs(payload?.arguments);
    if (name === 'Bash') {
      const cmd = bashCommand(input);
      if (cmd) {
        const g = classifyGit(cmd);
        if (g) return [{ ...g, tool: name, path: null, ts, sessionId }];
        const label = cleanTitle(cmd, 120) ?? name;
        return [{ kind: 'command', lane: 'feed', tool: name, path: null, ts, sessionId, label }];
      }
      return [{ kind: 'command', lane: 'feed', tool: name, path: null, ts, sessionId, label: name }];
    }
    const filePath = input?.file_path ?? input?.filePath ?? input?.path ?? null;
    const p = typeof filePath === 'string' ? filePath : null;
    return [{ kind: 'tool', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name }];
  }

  // function_call_output -> tool result (skip: not a feed action on its own)
  if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
    return [];
  }

  // custom_tool_call -> tool
  if (ptype === 'custom_tool_call') {
    const name = payload?.name ?? 'custom_tool';
    return [{ kind: 'tool', lane: 'feed', tool: name, path: null, ts, sessionId, label: name }];
  }

  // reasoning / web_search_call / other: skip
  return [];
}
