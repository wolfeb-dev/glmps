// server/lib/adapters/gemini-cli.js
// Gemini CLI adapter. Sessions: ~/.gemini/tmp/<projectHash>/chats/session-*.json
// (json-snapshot) and legacy *.jsonl (jsonl-tail). Format mirrors
// D:/_scratch_cch_viewer/src-tauri/src/providers/gemini.rs.
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'gemini-cli';
export const displayName = 'Gemini CLI';

export function detect(P) {
  let installed = false;
  try {
    const entries = fs.readdirSync(P.geminiTmpDir, { withFileTypes: true });
    installed = entries.some(e => e.isDirectory());
  } catch {}
  return { installed, dataDirs: [P.geminiTmpDir] };
}

/** Read <projectDir>/.project_root for the real cwd (best-effort). */
function readProjectRoot(projectDir) {
  const rootFile = path.join(projectDir, '.project_root');
  try {
    const st = fs.lstatSync(rootFile);
    if (st.isSymbolicLink()) return null;
    const s = fs.readFileSync(rootFile, 'utf-8').trim();
    return s || null;
  } catch { return null; }
}

export function discover(P) {
  const out = [];
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(P.geminiTmpDir, { withFileTypes: true }); } catch { return out; }

  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const projectDirPath = path.join(P.geminiTmpDir, d.name);
    const chatsDir = path.join(projectDirPath, 'chats');
    let chatFiles = [];
    try { chatFiles = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { continue; }

    const cwd = readProjectRoot(projectDirPath);

    for (const f of chatFiles) {
      if (!f.isFile()) continue;
      const name = f.name;
      const isJsonl = name.endsWith('.jsonl');
      const isJson = !isJsonl && name.endsWith('.json');
      if (!isJsonl && !isJson) continue;

      const filePath = path.join(chatsDir, name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }

      const basename = name.replace(/\.(jsonl|json)$/, '');
      const sessionId = `gemini:${d.name}:${basename}`;

      out.push({
        id: sessionId,
        tool: id,
        kind: isJsonl ? 'jsonl-tail' : 'json-snapshot',
        file: filePath,
        cwd: cwd ?? null,
        label: null,
        mtimeMs,
        extra: { projectDir: d.name },
      });
    }
  }
  return out;
}

/** Map Gemini tool names to common capitalised names (mirrors gemini.rs). */
export function mapToolName(name) {
  switch (name) {
    case 'read_file': case 'ReadFile': return 'Read';
    case 'write_file': case 'WriteFile': case 'create_file': return 'Write';
    case 'edit_file': case 'EditFile': case 'replace': return 'Edit';
    case 'shell': case 'run_command': case 'run_shell_command': case 'execute_command': return 'Bash';
    case 'list_directory': case 'list_dir': return 'Glob';
    case 'search_files': case 'grep': case 'search_file_content': return 'Grep';
    case 'web_search': case 'google_web_search': return 'WebSearch';
    case 'web_fetch': return 'WebFetch';
    default: return name || 'tool';
  }
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit']);

/** Pull a file path out of a toolCall args object. */
function pathFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const p = args.file_path ?? args.filePath ?? args.path ?? args.absolute_path ?? null;
  return typeof p === 'string' ? p : null;
}

/** Pull a shell command string out of a toolCall args object. */
function cmdFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const c = args.command ?? args.cmd ?? null;
  return typeof c === 'string' ? c : null;
}

/** Convert one toolCall into a feed/context event. */
function toolCallToEvent(tc, ts, sessionId) {
  const rawName = tc?.name ?? 'tool';
  const name = mapToolName(rawName);
  const args = tc?.args ?? tc?.input ?? null;

  if (name === 'Bash') {
    const cmd = cmdFromArgs(args);
    if (cmd) {
      const g = classifyGit(cmd);
      if (g) return { ...g, tool: name, path: null, ts, sessionId };
      const label = cleanTitle(cmd, 120) ?? name;
      return { kind: 'command', lane: 'feed', tool: name, path: null, ts, sessionId, label };
    }
    return { kind: 'command', lane: 'feed', tool: name, path: null, ts, sessionId, label: name };
  }

  const p = pathFromArgs(args);
  if (FILE_EDIT_TOOLS.has(name)) {
    return { kind: 'file-edit', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name };
  }
  // Read/Glob/Grep and everything else -> generic tool event
  return { kind: 'tool', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name };
}

/** Build a tokens event from a gemini message's tokens object, or null. */
function tokensEvent(tokens, ts, sessionId) {
  if (!tokens || typeof tokens !== 'object') return null;
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const cached = Number(tokens.cached) || 0;
  if (input === 0 && output === 0) return null;
  return {
    kind: 'tokens', lane: 'feed', tool: 'tokens', path: null, ts, sessionId,
    label: `tokens ${input} in / ${output} out`,
    change: { input, output, cached },
  };
}

/** Parse one message object into events. */
function messageToEvents(msg, sessionId) {
  if (!msg || typeof msg !== 'object') return [];
  if (!msg.id || !msg.type) return []; // skip metadata-only lines ($set, headers)

  const ts = msg.timestamp ?? null;
  const type = msg.type;

  if (type === 'user') {
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
    if (!text) return [];
    return [{
      kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
    }];
  }

  if (type === 'gemini' || type === 'model') {
    const events = [];

    // thinking from thoughts[]
    const thoughts = msg.thoughts;
    if (Array.isArray(thoughts)) {
      for (const t of thoughts) {
        const subject = t?.subject ?? '';
        const description = t?.description ?? '';
        const txt = subject ? (description ? `${subject}: ${description}` : subject) : description;
        if (txt) {
          events.push({
            kind: 'thinking', lane: 'feed', tool: 'thinking', path: null, ts, sessionId,
            label: cleanTitle(txt, 120) ?? txt.slice(0, 120), model: msg.model ?? null,
          });
        }
      }
    }

    // tool events from toolCalls[]
    const toolCalls = msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) events.push(toolCallToEvent(tc, ts, sessionId));
    }

    // tokens
    const te = tokensEvent(msg.tokens, ts, sessionId);
    if (te) events.push(te);

    return events;
  }

  return [];
}

/** jsonl-tail kind: one line -> events[] */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  return messageToEvents(obj, sessionId);
}

/** json-snapshot kind: whole file text -> { events, title, cwd } */
export function extractSnapshot(text, sessionId) {
  let data;
  try { data = JSON.parse(text); } catch { return { events: [] }; }

  // Skip subagent session files entirely (they double-count the main session).
  if (data?.kind === 'subagent') return { events: [], title: null, cwd: null };

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const events = messages.flatMap(m => messageToEvents(m, sessionId));

  // Title: explicit summary, else first user message.
  let title = null;
  if (typeof data?.summary === 'string' && data.summary) {
    title = cleanTitle(data.summary, 80);
  }
  if (!title) {
    for (const m of messages) {
      if (m?.type !== 'user') continue;
      const content = m.content;
      let t = '';
      if (typeof content === 'string') t = content;
      else if (Array.isArray(content)) t = content.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
      if (t) { title = cleanTitle(t, 80); break; }
    }
  }

  return { events, title, cwd: null };
}
