// server/lib/inventory.js
import fs from 'node:fs';
import path from 'node:path';

function frontmatter(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8').slice(0, 2000); } catch { return {}; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const lineText of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+?)\s*$/.exec(lineText);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function* walk(dir, depth) {
  if (depth < 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    // Follow symlinks/junctions (e.g. skills deployed from the private asset
    // store into ~/.claude/skills): a dirent that is neither a plain dir nor a
    // plain file gets resolved. The depth cap is the cycle guard.
    if (!isDir && !e.isFile()) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
    if (isDir) yield* walk(full, depth - 1);
    else yield full;
  }
}

// Collect agent definitions (*.md, excluding SKILL.md) from a directory tree.
function addAgentsFrom(dir, plugin, sink) {
  for (const f of walk(dir, 4)) {
    if (!f.endsWith('.md') || f.endsWith(`${path.sep}SKILL.md`)) continue;
    const fm = frontmatter(f);
    sink.push({ name: fm.name ?? path.basename(f, '.md'),
      description: fm.description ?? '', plugin, path: f });
  }
}

// Collect skills (SKILL.md files) from a directory tree.
function addSkillsFrom(dir, plugin, sink) {
  for (const f of walk(dir, 4)) {
    if (!f.endsWith(`${path.sep}SKILL.md`)) continue;
    const fm = frontmatter(f);
    sink.push({ name: fm.name ?? path.basename(path.dirname(f)),
      description: fm.description ?? '', plugin, path: f });
  }
}

// projectRoots: cwds seen in session history (for CLAUDE.md/.agents scans)
export function scanInventory({ pluginsCacheDir, projectsDir, projectRoots = [], claudeDir }) {
  const skills = [], agents = [], memory = [], contextFiles = [];

  for (const f of walk(pluginsCacheDir, 7)) {
    const rel = path.relative(pluginsCacheDir, f);
    const parts = rel.split(path.sep);
    const plugin = parts.length >= 2 ? parts[1] : 'unknown';
    if (f.endsWith(`${path.sep}SKILL.md`) && rel.includes(`${path.sep}skills${path.sep}`)) {
      const fm = frontmatter(f);
      skills.push({ name: fm.name ?? path.basename(path.dirname(f)),
        description: fm.description ?? '', plugin, path: f });
    } else if (rel.includes(`${path.sep}agents${path.sep}`) && f.endsWith('.md')) {
      const fm = frontmatter(f);
      agents.push({ name: fm.name ?? path.basename(f, '.md'),
        description: fm.description ?? '', plugin, path: f });
    }
  }

  let projDirs = [];
  try { projDirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch {}
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const memDir = path.join(projectsDir, d.name, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir); } catch { continue; }
    for (const f of files) if (f.endsWith('.md'))
      memory.push({ name: f, project: d.name, path: path.join(memDir, f),
        description: frontmatter(path.join(memDir, f)).description ?? '' });
  }

  for (const root of projectRoots) {
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const f = path.join(root, name);
      if (fs.existsSync(f)) contextFiles.push({ name, root, path: f });
    }
    // Claude Code project-level agents and skills (<root>/.claude/{agents,skills})
    addAgentsFrom(path.join(root, '.claude', 'agents'), 'project', agents);
    addSkillsFrom(path.join(root, '.claude', 'skills'), 'project', skills);
    // Antigravity project skills (<root>/.agents/skills)
    addSkillsFrom(path.join(root, '.agents', 'skills'), 'project', skills);
  }

  if (claudeDir) {
    const g = path.join(claudeDir, 'CLAUDE.md');
    if (fs.existsSync(g))
      contextFiles.push({ name: 'CLAUDE.md (global)', root: claudeDir, path: g });
    // Claude Code user-level (global) agents and skills (~/.claude/{agents,skills})
    addAgentsFrom(path.join(claudeDir, 'agents'), 'user', agents);
    addSkillsFrom(path.join(claudeDir, 'skills'), 'user', skills);
  }
  return { skills, agents, memory, contextFiles };
}
