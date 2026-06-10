// server/lib/session-title.js
// Derive a concise, human-readable session title from a session's index record
// and its event log. Zero-dependency, deterministic, no LLM calls.
//
// Inputs (read-only):
//   record: index record { id, tool, cwd, title, skillsUsed, ... }
//   events: array of shared-shape events { kind, lane, label, path, tool, op, gitOp, ts, sessionId }
//
// Many sessions (antigravity pb-only, agy-cli, some adapters) never captured a
// first-user-message title, so the UI falls back to entry.id.slice(0,8). This
// module produces a meaningful title by naming the project plus what the session
// is actually DOING (preferred for active sessions) or a cleaned opening prompt.

// ---------------------------------------------------------------------------
// looksLikeCode — is this string an id/hash rather than human text?
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-f]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_TOKEN_RE = /^[\w.-]+$/;

export function looksLikeCode(s) {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  if (t === '') return true;
  if (UUID_RE.test(t)) return true;
  if (t.length >= 6 && HEX_RE.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  if (OPAQUE_TOKEN_RE.test(t) && !t.includes(' ')) {
    const idShaped = /[_]/.test(t) || /\d/.test(t) || /-/.test(t);
    if (idShaped) return true;
    if (t.length <= 4) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// cleanFirstPrompt — strip wrappers/markup from a raw user prompt -> <=80 chars
// ---------------------------------------------------------------------------

export function cleanFirstPrompt(text, max = 80) {
  if (typeof text !== 'string') return null;
  let t = text;
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  t = t.replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, ' ');
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(t);
  if (reqMatch) t = reqMatch[1];
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  t = t.replace(/[`*_#>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.slice(0, max);
}

// ---------------------------------------------------------------------------
// Project name — prefer an informative cwd basename; when the cwd is a drive
// root (D:\, C:\) or otherwise uninformative, infer the project from the most
// common top-level directory among the session's file paths. When there is no
// cwd at all, return null (no prefix) so prompt-derived titles stay clean.
// ---------------------------------------------------------------------------

const DRIVE_ROOT_RE = /^[a-zA-Z]:$/;

function lastSegment(p) {
  if (typeof p !== 'string' || !p) return null;
  const seg = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return seg || null;
}

function isUninformativeProject(seg) {
  return !seg || DRIVE_ROOT_RE.test(seg) || seg === '~';
}

function projectFromPaths(events) {
  const counts = new Map();
  for (const e of events) {
    const p = e?.path;
    if (typeof p !== 'string' || !p) continue;
    const norm = p.replace(/\\/g, '/');
    const m = /^(?:[a-zA-Z]:)?\/?(.+)$/.exec(norm);
    if (!m) continue;
    const seg = m[1].split('/')[0];
    if (!seg || /\.[a-z0-9]+$/i.test(seg)) continue; // skip a bare filename
    counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [seg, n] of counts) if (n > bestN) { best = seg; bestN = n; }
  return best;
}

function projectName(record, events) {
  const seg = lastSegment(record?.cwd);
  if (seg && !isUninformativeProject(seg)) return seg;
  if (seg && isUninformativeProject(seg)) return projectFromPaths(events) || null;
  return null; // no cwd -> no prefix
}

function shortId(record) {
  const id = typeof record?.id === 'string' ? record.id : '';
  return id.slice(0, 8) || 'session';
}

// Pull a clean first substantive user prompt out of the event log.
function firstUserPromptFromEvents(events) {
  for (const e of events) {
    if (!e) continue;
    const label = typeof e.label === 'string' ? e.label : '';
    let raw = null;
    if (/^User:\s*/.test(label)) raw = label.replace(/^User:\s*/, '');
    else if (e.kind === 'user-input' || e.tool === 'user') raw = label;
    if (raw == null) continue;
    if (/^\(input\)$/.test(raw.trim())) continue;
    const cleaned = cleanFirstPrompt(raw);
    if (cleaned && !looksLikeCode(cleaned)) return cleaned;
  }
  return null;
}

// ---------------------------------------------------------------------------
// deriveSessionTitle
// ---------------------------------------------------------------------------

const SUBSTANTIAL = 3; // work-event count beyond which current activity beats the opening prompt

export function deriveSessionTitle({ record = {}, events = [] } = {}) {
  const evs = Array.isArray(events) ? events.filter(Boolean) : [];
  const tool = typeof record.tool === 'string' && record.tool ? record.tool : 'session';

  // Gather activity signal.
  const skills = [];
  const edits = [];
  const commands = [];
  const gitOps = [];
  let memoryCount = 0, ctxFileCount = 0, agentCount = 0, grepCount = 0;

  for (const e of evs) {
    switch (e.kind) {
      case 'skill': {
        const name = lastSegment(e.label) ?? e.label;
        if (name && !skills.includes(name)) skills.push(name);
        break;
      }
      case 'agent': agentCount++; break;
      case 'file-edit': {
        const name = lastSegment(e.path) ?? lastSegment(e.label) ?? e.label;
        if (name) edits.push(name);
        break;
      }
      case 'memory': memoryCount++; break;
      case 'context-file': ctxFileCount++; break;
      case 'git': gitOps.push(e.gitOp ?? 'git'); break;
      case 'command': {
        const lbl = typeof e.label === 'string' ? e.label : '';
        if (/\bgrep\b/i.test(lbl) || (typeof e.tool === 'string' && /grep/i.test(e.tool))) grepCount++;
        if (lbl) commands.push(lbl);
        break;
      }
      default: break;
    }
  }
  if (!skills.length && Array.isArray(record.skillsUsed)) {
    for (const s of record.skillsUsed) {
      const name = lastSegment(s) ?? s;
      if (name && !skills.includes(name)) skills.push(name);
    }
  }

  const workCount = edits.length + skills.length + gitOps.length + commands.length
    + memoryCount + ctxFileCount + agentCount;

  const project = projectName(record, evs);
  const withProject = (body) => (project ? `${project}: ${body}` : body);

  // Synthesize a body describing the activity (no project prefix).
  const activity = synthActivity({ skills, edits, gitOps, commands, grepCount, memoryCount, ctxFileCount, agentCount });

  // A clean opening prompt, from events or the persisted record.title.
  let prompt = firstUserPromptFromEvents(evs);
  if (!prompt && typeof record.title === 'string') {
    const c = cleanFirstPrompt(record.title);
    if (c && !looksLikeCode(c)) prompt = c;
  }

  // Active session: lead with project + current activity (the opening prompt is
  // often stale for long, evolving sessions).
  if (workCount >= SUBSTANTIAL && activity) return clip(withProject(activity));

  // Otherwise a real opening prompt is the best descriptor.
  if (prompt) return clip(prompt);

  // Low activity but some signal.
  if (activity) return clip(withProject(activity));

  // Fallback.
  if (project) return clip(`${project} session`);
  return clip(`${tool} session ${shortId(record)}`);
}

function synthActivity({ skills, edits, gitOps, commands, grepCount, memoryCount, ctxFileCount, agentCount }) {
  if (skills.length) {
    const primarySkill = skills[0];
    const keyFile = uniqueFirst(edits);
    if (keyFile) return `${primarySkill} — ${keyFile}`;
    if (skills.length > 1) return `${primarySkill} (+${skills.length - 1} skills)`;
    return primarySkill;
  }
  if (edits.length) {
    const uniq = [...new Set(edits)];
    const head = uniq[0];
    const extra = uniq.length - 1;
    return extra > 0 ? `Edit ${head} (+${extra} file${extra > 1 ? 's' : ''})` : `Edit ${head}`;
  }
  if (gitOps.length || grepCount) {
    const parts = [];
    if (grepCount) parts.push('grep');
    if (gitOps.includes('commit')) parts.push('git commit');
    else if (gitOps.length) parts.push(`git ${gitOps[0]}`);
    if (parts.length) return `Debug: ${parts.join(' + ')}`;
  }
  if (memoryCount) return `Memory updates (${memoryCount})`;
  if (ctxFileCount) return `Context files (${ctxFileCount})`;
  if (commands.length) {
    const topic = firstWords(commands[0], 6);
    if (topic) return `Explore: ${topic}`;
  }
  if (agentCount) return `Delegated to ${agentCount} agent${agentCount > 1 ? 's' : ''}`;
  return null;
}

function uniqueFirst(arr) {
  for (const x of arr) if (x) return x;
  return null;
}

function firstWords(s, n) {
  if (typeof s !== 'string') return null;
  const words = s.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  return words || null;
}

function clip(s, max = 80) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// pickTitle — top-level entry point used by the server.
// deriveSessionTitle already considers record.title as an opening-prompt source
// and prefers current activity for active sessions.
// ---------------------------------------------------------------------------

export function pickTitle(record = {}, events = []) {
  return deriveSessionTitle({ record, events });
}
