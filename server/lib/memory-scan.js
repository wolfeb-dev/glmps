// server/lib/memory-scan.js
// Integrity + poisoning scan for agent memory directories (the auto-loaded
// MEMORY.md index plus per-topic memory files). Memory is the highest-durability,
// lowest-visibility poisoning surface: a planted entry steers every future
// session (coding AND trading) and can inject instructions into their context.
//
// This gives memory two things it otherwise lacks: content scanning (reuse the
// poison-scan detectors) and a hash manifest so drift between sessions is
// auditable. Pure diffManifest core + an fs-backed scanMemoryDir.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanText, SEVERITY } from './poison-scan.js';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Compare two {file -> hash} manifests. Used to surface memory files that
// appeared or changed between sessions without a corresponding operator edit.
export function diffManifest(prev = {}, curr = {}) {
  const added = [], changed = [], removed = [];
  for (const k of Object.keys(curr)) {
    if (!(k in prev)) added.push(k);
    else if (prev[k] !== curr[k]) changed.push(k);
  }
  for (const k of Object.keys(prev)) if (!(k in curr)) removed.push(k);
  return { added, changed, removed };
}

// Scan one memory directory: hash + poison-scan every .md file.
export function scanMemoryDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.md')); }
  catch { return { dir, files: [], flagged: [], severity: 'none', manifest: {} }; }

  const files = [];
  const manifest = {};
  let severity = 'none';
  for (const name of names) {
    let content = '';
    try { content = fs.readFileSync(path.join(dir, name), 'utf-8'); } catch { continue; }
    const hash = sha(content);
    manifest[name] = hash;
    const r = scanText(content);
    files.push({ name, severity: r.severity, flags: r.flags, matches: r.matches, hash });
    if (SEVERITY[r.severity] > SEVERITY[severity]) severity = r.severity;
  }
  const flagged = files.filter(f => f.severity !== 'none');
  return { dir, files, flagged, severity, manifest };
}
