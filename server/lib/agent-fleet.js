// server/lib/agent-fleet.js
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Frontmatter parser — mirrors inventory.js's approach (no YAML dep).
// Reads only the first 2000 chars; returns a flat key→value object.
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const slice = (text ?? '').slice(0, 2000);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(slice);
  if (!m) return {};
  const out = {};
  for (const lineText of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+?)\s*$/.exec(lineText);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool list normalisation.
// "All tools" / "all tools" / "*" → ['*']
// Otherwise split on comma and/or whitespace, filter empties.
// ---------------------------------------------------------------------------
const WILDCARD_LABELS = new Set(['*', 'all tools']);

function parseTools(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (WILDCARD_LABELS.has(trimmed.toLowerCase())) return ['*'];
  // Split on commas or whitespace runs, filter empties
  return trimmed
    .split(/[\s,]+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Access level — 'write' if any power tool is present, else 'read-only'.
// ---------------------------------------------------------------------------
// Edit/Write/* mean the agent mutates the working tree. Bash alone is NOT
// treated as write — read-only analysis agents (e.g. backtest-skeptic) run Bash
// to execute scripts without editing. The git agent is write via its group.
const WRITE_TOOLS = new Set(['Edit', 'Write', '*']);

function deriveAccess(tools) {
  return tools.some(t => WRITE_TOOLS.has(t)) ? 'write' : 'read-only';
}

// ---------------------------------------------------------------------------
// parseAgentFile — public API
// ---------------------------------------------------------------------------

/**
 * Parse a .md agent file's text into a structured record.
 * @param {string} text
 * @returns {{ name: string|null, role: string|null, tools: string[], model: string|null, access: 'write'|'read-only' }}
 */
export function parseAgentFile(text) {
  const fm = parseFrontmatter(text);
  const tools = parseTools(fm.tools ?? null);
  return {
    name:   fm.name   ?? null,
    role:   fm.description ?? null,
    tools,
    model:  fm.model  ?? null,
    access: deriveAccess(tools),
  };
}

// ---------------------------------------------------------------------------
// groupOf — keyword classifier over name + role
// ---------------------------------------------------------------------------

// Order matters: specific buckets are tested BEFORE the generic 'scout'
// (whose keyword "research" appears in many descriptions, e.g. a "research repo"
// in a coder's role, or "research finding" in a skeptic's). Most-specific wins.
const GROUP_PATTERNS = [
  { group: 'git',       re: /\bgit\b|\bgh\b/i },
  { group: 'verify',    re: /skeptic|adversar|validat|critic|\bgate\b|review|audit/i },
  { group: 'implement', re: /coder|simplif|implement|refactor/i },
  { group: 'plan',      re: /\bplan\b|architect/i },
  { group: 'scout',     re: /scout|explore|research|search|guide/i },
];

/**
 * Classify an agent into a functional group.
 * @param {{ name: string, role: string }} agent
 * @returns {'scout'|'implement'|'verify'|'plan'|'git'|'general'}
 */
export function groupOf(agent) {
  const name = (agent.name ?? '').toLowerCase();
  const role = (agent.role ?? '').toLowerCase();
  // The NAME is the strongest signal — test it first, in priority order, so e.g.
  // "Plan" (whose role mentions "implementation plans") classifies as plan, not
  // implement. Fall back to the role/description only when the name is ambiguous.
  for (const { group, re } of GROUP_PATTERNS) if (re.test(name)) return group;
  for (const { group, re } of GROUP_PATTERNS) if (re.test(role)) return group;
  return 'general';
}

// ---------------------------------------------------------------------------
// Runtime / reasoning classification
// ---------------------------------------------------------------------------

const ANTIGRAVITY_AGENTS = new Set(['backtest-skeptic', 'adversary']);

function runtimeOf(name) {
  return ANTIGRAVITY_AGENTS.has(name) ? 'antigravity' : 'claude';
}

function reasoningOf(runtime) {
  return runtime === 'antigravity' ? 'max' : 'default';
}

// ---------------------------------------------------------------------------
// DEFAULT_REGISTRY — harness agents that have no .md file on disk
// ---------------------------------------------------------------------------

export const DEFAULT_REGISTRY = [
  {
    name: 'Explore',
    role: 'Fast read-only search agent for locating code by file pattern, symbol, or keyword.',
    tools: ['Read', 'Grep', 'Glob'],
    model: null,
    access: 'read-only',
  },
  {
    name: 'Plan',
    role: 'Software architect agent for designing implementation plans and step-by-step strategies.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    model: null,
    access: 'read-only',
  },
  {
    name: 'general-purpose',
    role: 'Catch-all agent for tasks that do not fit a more specific agent.',
    tools: ['*'],
    model: null,
    access: 'write',
  },
  {
    name: 'code-simplifier',
    role: 'Simplifies and refines code for clarity, consistency, and maintainability.',
    tools: ['Edit', 'Read', 'Grep', 'Glob'],
    model: null,
    access: 'write',
  },
  {
    name: 'claude-code-guide',
    role: 'Answers questions about Claude Code, Claude Agent SDK, and the Claude API.',
    tools: ['Read', 'Grep', 'WebFetch', 'WebSearch'],
    model: null,
    access: 'read-only',
  },
  {
    name: 'statusline-setup',
    role: 'Configures the Claude Code status line setting.',
    tools: ['Read', 'Edit'],
    model: null,
    access: 'write',
  },
  {
    name: 'git',
    role: 'Dedicated git/gh subagent — groups changes into logical commits, pushes, branches, opens PRs/issues; private repos autonomous, public ask-first; runs under the git-guardrails hook.',
    tools: ['git', 'gh', 'Bash'],
    model: 'haiku',
    access: 'write',
  },
  {
    name: 'adversary',
    role: 'Independent adversarial reviewer — tries to refute a result or plan from a different model family; returns a verdict, never edits.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    model: null,
    access: 'read-only',
  },
];

// ---------------------------------------------------------------------------
// Recursive helper: walk a directory up to maxDepth levels, collecting any
// .md file found directly inside a directory named "agents".
// ---------------------------------------------------------------------------
function collectPluginAgentFiles(dir, depth, results) {
  if (depth <= 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const inAgentsDir = path.basename(dir) === 'agents';
  for (const e of entries) {
    if (e.isFile() && inAgentsDir && e.name.endsWith('.md')) {
      results.push(path.join(dir, e.name));
    } else if (e.isDirectory()) {
      collectPluginAgentFiles(path.join(dir, e.name), depth - 1, results);
    }
  }
}

// ---------------------------------------------------------------------------
// scanFleet — public API
// ---------------------------------------------------------------------------

/**
 * Scan an agents directory and merge with a static registry.
 * @param {{ agentsDir?: string, pluginsCacheDir?: string, registry?: object[] }} opts
 * @returns {{ agents: object[] }}
 */
export function scanFleet({ agentsDir, pluginsCacheDir, registry = DEFAULT_REGISTRY } = {}) {
  const diskAgents = [];

  // 1. Read assets from agentsDir
  if (agentsDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      // directory missing or unreadable — skip silently
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, e.name);
      let text = '';
      try { text = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const parsed = parseAgentFile(text);
      const runtime = runtimeOf(parsed.name);
      diskAgents.push({
        ...parsed,
        group:     groupOf(parsed),
        source:    'assets',
        runtime,
        reasoning: reasoningOf(runtime),
        path:      filePath,
      });
    }
  }

  // 2. Walk pluginsCacheDir recursively (depth 5) for agents/*.md files
  if (pluginsCacheDir) {
    const pluginFiles = [];
    try { collectPluginAgentFiles(pluginsCacheDir, 5, pluginFiles); } catch { /* skip */ }
    for (const filePath of pluginFiles) {
      let text = '';
      try { text = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const parsed = parseAgentFile(text);
      const runtime = runtimeOf(parsed.name);
      diskAgents.push({
        ...parsed,
        group:     groupOf(parsed),
        source:    'plugin',
        runtime,
        reasoning: reasoningOf(runtime),
        path:      filePath,
      });
    }
  }

  // 3. Build name→agent index from disk agents (case-insensitive dedup).
  //    Disk/plugin agents always win over registry entries.
  const byName = new Map();
  for (const a of diskAgents) {
    const key = (a.name ?? '').toLowerCase();
    if (key) byName.set(key, a);
  }

  // 4. Append registry entries only when the name isn't already present.
  for (const reg of registry) {
    const key = (reg.name ?? '').toLowerCase();
    if (byName.has(key)) continue;   // disk/plugin agent wins
    const runtime = runtimeOf(reg.name);
    const entry = {
      ...reg,
      group:     groupOf(reg),
      source:    'registry',
      runtime,
      reasoning: reasoningOf(runtime),
    };
    byName.set(key, entry);
  }

  return { agents: [...byName.values()] };
}
