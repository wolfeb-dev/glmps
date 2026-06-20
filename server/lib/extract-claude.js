// server/lib/extract-claude.js
import { makeChange } from './change-capture.js';
import { classifyGit } from './git-events.js';

const CONTEXT_FILE_RE = /(^|[\\/])(CLAUDE|AGENTS|GEMINI|acceptance)\.md$/i;
const MEMORY_RE = /[\\/]memory[\\/][^\\/]+\.md$/i;

export function extractClaudeEvents(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (obj?.type !== 'assistant') return [];
  const content = obj.message?.content;
  if (!Array.isArray(content)) return [];
  const ts = obj.timestamp ?? null;
  const out = [];
  for (const item of content) {
    if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;
    out.push(classify(item, ts, sessionId));
  }
  return out;
}

function classify(item, ts, sessionId) {
  const { name, input = {} } = item;
  const base = { tool: name, ts, sessionId, path: input.file_path ?? null };
  if (name === 'Skill')
    return { ...base, kind: 'skill', lane: 'context', label: input.skill ?? 'unknown skill' };
  if (name === 'Agent' || name === 'Task')
    return { ...base, kind: 'agent', lane: 'context',
      label: [input.subagent_type, input.description].filter(Boolean).join(': ') || 'subagent',
      model: input.model ?? null };
  if (name === 'Workflow')
    return { ...base, kind: 'agent', lane: 'context', label: input.name ?? 'workflow', model: null };
  if (name.startsWith('mcp__'))
    return { ...base, kind: 'mcp', lane: 'context', label: name.replace(/^mcp__/, '') };
  const p = input.file_path ?? '';
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && CONTEXT_FILE_RE.test(p)) {
    const op = name === 'Read' ? 'read' : 'write';
    const change = op === 'write' ? buildChange(name, input) : undefined;
    const c = op === 'write' ? countEdit(name, input) : null;
    return { ...base, kind: 'context-file', lane: 'context', label: p, op, ...(change !== undefined && { change }), ...(c && { add: c.add, del: c.del }) };
  }
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && MEMORY_RE.test(p)) {
    const op = name === 'Read' ? 'read' : 'write';
    const change = op === 'write' ? buildChange(name, input) : undefined;
    const c = op === 'write' ? countEdit(name, input) : null;
    return { ...base, kind: 'memory', lane: 'context', label: p, op, ...(change !== undefined && { change }), ...(c && { add: c.add, del: c.del }) };
  }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit') {
    const c = countEdit(name, input);
    return { ...base, kind: 'file-edit', lane: 'feed', label: p || name, ...(c && { add: c.add, del: c.del }) };
  }
  if (name === 'Bash') {
    const g = classifyGit(input.command);
    if (g) return { ...base, ...g, ts, sessionId };
    return { ...base, kind: 'command', lane: 'feed', label: input.description ?? input.command ?? 'command' };
  }
  return { ...base, kind: 'tool', lane: 'feed', label: name };
}

function buildChange(name, input) {
  if (name === 'Edit') return makeChange(input.old_string, input.new_string);
  if (name === 'Write') return makeChange(null, input.content);
  // NotebookEdit: no tracked content
  return undefined;
}

// Approximate added/removed line counts for an edit, for the feed's +N/-M badge.
function lineCount(s) { return (typeof s === 'string' && s.length) ? s.split('\n').length : 0; }
function countEdit(name, input = {}) {
  if (name === 'Edit') return { add: lineCount(input.new_string), del: lineCount(input.old_string) };
  if (name === 'Write') return { add: lineCount(input.content), del: 0 };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let add = 0, del = 0;
    for (const e of input.edits) { add += lineCount(e?.new_string); del += lineCount(e?.old_string); }
    return { add, del };
  }
  return null; // NotebookEdit / unknown
}
