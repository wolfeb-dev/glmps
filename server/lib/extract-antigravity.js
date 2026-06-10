// server/lib/extract-antigravity.js
import { makeChange } from './change-capture.js';
import { classifyGit } from './git-events.js';

const CONTEXT_FILE_RE = /(^|[\\/])(CLAUDE|AGENTS|GEMINI)\.md$/i;
const MEMORY_RE = /[\\/]memory[\\/][^\\/]+\.md$/i;
const SKILL_PATH_RE = /[\\/]\.agents[\\/]skills[\\/]/i;

export function unquote(v) {
  if (typeof v !== 'string') return '';
  try { const p = JSON.parse(v); return typeof p === 'string' ? p : v; }
  catch { return v; }
}

export function extractAgEvents(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const ts = obj.created_at ?? null;
  if (obj.type === 'USER_INPUT') {
    const m = /<USER_REQUEST>\s*([\s\S]*?)\s*</.exec(obj.content ?? '');
    return [{ kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (m ? m[1].slice(0, 120) : '(input)') }];
  }
  if (!Array.isArray(obj.tool_calls)) return [];
  return obj.tool_calls.map(tc => classify(tc, ts, sessionId)).filter(Boolean);
}

function classify(tc, ts, sessionId) {
  if (!tc || typeof tc.name !== 'string') return null;
  const a = tc.args ?? {};
  const p = unquote(a.AbsolutePath ?? a.TargetFile ?? '');
  const base = { tool: tc.name, ts, sessionId, path: p || null };

  // Skill file view
  if (tc.name === 'view_file' && (unquote(a.IsSkillFile) === 'true' || SKILL_PATH_RE.test(p)))
    return { ...base, kind: 'skill', lane: 'context', label: p };

  // view_file on context/memory files: add op:'read'
  if (tc.name === 'view_file') {
    if (CONTEXT_FILE_RE.test(p))
      return { ...base, kind: 'context-file', lane: 'context', label: p, op: 'read' };
    if (MEMORY_RE.test(p))
      return { ...base, kind: 'memory', lane: 'context', label: p, op: 'read' };
    // ordinary file view
    return { ...base, kind: 'tool', lane: 'feed', label: tc.name };
  }

  // Write operations — check if targeting context/memory path first
  if (/^(write_to_file|replace_file_content|multi_replace_file_content)$/.test(tc.name)) {
    const change = buildAgChange(tc.name, a);
    if (CONTEXT_FILE_RE.test(p)) {
      return { ...base, kind: 'context-file', lane: 'context', label: p, op: 'write',
        ...(change !== undefined && { change }) };
    }
    if (MEMORY_RE.test(p)) {
      return { ...base, kind: 'memory', lane: 'context', label: p, op: 'write',
        ...(change !== undefined && { change }) };
    }
    return { ...base, kind: 'file-edit', lane: 'feed', label: p || tc.name };
  }

  // run_command: try git classification first
  if (tc.name === 'run_command') {
    const cmdStr = unquote(a.CommandLine);
    const g = classifyGit(cmdStr);
    if (g) return { ...base, ...g, ts, sessionId };
    return { ...base, kind: 'command', lane: 'feed',
      label: unquote(a.toolSummary) || cmdStr || 'command' };
  }

  return { ...base, kind: 'tool', lane: 'feed', label: tc.name };
}

function buildAgChange(toolName, a) {
  if (toolName === 'write_to_file') {
    return makeChange(null, unquote(a.CodeContent));
  }
  if (toolName === 'replace_file_content') {
    return makeChange(unquote(a.TargetContent), unquote(a.ReplacementContent));
  }
  if (toolName === 'multi_replace_file_content') {
    // Try parsing ReplacementChunks JSON array for first chunk
    let oldText = unquote(a.TargetContent);
    let newText = unquote(a.ReplacementContent);
    if (!oldText) {
      try {
        const chunks = JSON.parse(unquote(a.ReplacementChunks) || a.ReplacementChunks || '[]');
        if (Array.isArray(chunks) && chunks.length > 0) {
          oldText = unquote(chunks[0].TargetContent ?? '');
          newText = unquote(chunks[0].ReplacementContent ?? newText);
        }
      } catch { /* best effort */ }
    }
    if (!oldText && !newText) return undefined;
    return makeChange(oldText || null, newText || null);
  }
  return undefined;
}
