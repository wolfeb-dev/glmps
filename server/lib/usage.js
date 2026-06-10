// server/lib/usage.js
const norm = p => (p ?? '').toLowerCase().replace(/\//g, '\\');
const tsVal = t => typeof t === 'string' ? (Date.parse(t) || 0) : (t ?? 0);

export function contextNow(events) {
  const map = new Map();
  for (const e of events) {
    if (e.lane !== 'context') continue;
    const key = `${e.kind}|${norm(e.path) || e.label}`;
    const prev = map.get(key);
    if (!prev || tsVal(e.ts) >= tsVal(prev.ts)) map.set(key, e);
  }
  return [...map.values()].sort((a, b) => tsVal(b.ts) - tsVal(a.ts));
}

export function splitUsage(inventory, events) {
  const usedPaths = new Set(), usedSkillNames = new Set(), usedAgentNames = new Set();
  for (const e of events) {
    if (e.path) usedPaths.add(norm(e.path));
    if (e.kind === 'skill') {
      // label may be 'plugin:skill', a bare name, or a SKILL.md path
      usedSkillNames.add((e.label ?? '').toLowerCase());
      const segs = (e.label ?? '').split(':').pop().split(/[\\/]/).filter(Boolean);
      if (segs.length >= 2 && segs[segs.length - 1].toLowerCase() === 'skill.md')
        usedSkillNames.add(segs[segs.length - 2].toLowerCase());
      else if (segs.length) usedSkillNames.add(segs[segs.length - 1].toLowerCase());
    }
    if (e.kind === 'agent') usedAgentNames.add((e.label ?? '').split(':')[0].trim().toLowerCase());
  }
  const isUsed = {
    skills: s => usedSkillNames.has(s.name.toLowerCase())
      || usedSkillNames.has(`${s.plugin}:${s.name}`.toLowerCase())
      || usedPaths.has(norm(s.path)),
    agents: a => usedAgentNames.has(a.name.toLowerCase()) || usedPaths.has(norm(a.path)),
    memory: m => usedPaths.has(norm(m.path)),
    contextFiles: c => usedPaths.has(norm(c.path)),
  };
  const used = {}, unused = {};
  for (const cat of ['skills', 'agents', 'memory', 'contextFiles']) {
    used[cat] = (inventory[cat] ?? []).filter(isUsed[cat]);
    unused[cat] = (inventory[cat] ?? []).filter(i => !isUsed[cat](i));
  }
  return { used, unused };
}
