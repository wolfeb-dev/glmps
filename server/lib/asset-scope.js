// server/lib/asset-scope.js
// Utilities for annotating unused inventory items with applicability/location
// relative to the current session's project.

/**
 * Convert a munged project key back to a friendly path label.
 * "D--"           → "D:\\"
 * "D--my-project"  → "D:\\my-project"
 * Non-match       → input unchanged
 * Non-string      → ''
 */
export function demungeProject(munged) {
  if (typeof munged !== 'string') return '';
  const m = /^([A-Za-z])--(.*)$/.exec(munged);
  if (!m) return munged;
  const drive = m[1];
  const rest  = m[2];
  // rest has segments separated by '-' that were originally path separators,
  // but dashes in directory names are also '-', so we just replace the first
  // separator structure: drive letter + '--' + rest (rest keeps its dashes as-is,
  // since the munging only replaces \ with - and the directory names may contain -)
  // The munging rule: drive letter, then ':' → '-', then '\' → '-' per segment.
  // So "D:\my-project" → "D--my-project", where 'my-project' stays as-is.
  // We reconstruct: drive + ':' + rest (replacing leading '-' separators with '\').
  // The rest after '--' is the path after 'D:\' — it used '\' replaced by '-'.
  // But since directory names can also contain '-', there is ambiguity.
  // Best-effort: just return drive:\rest (rest as-is, no further transform).
  return `${drive}:\\${rest}`;
}

/**
 * Annotate the unused asset groups with applicability and location fields.
 *
 * @param {object} unused - { skills, agents, memory, contextFiles }
 * @param {string|null} sessionProjectKey - basename of the session's transcript dir (e.g. "D--")
 * @param {string|null} sessionCwd - the session's working directory
 * @returns {{ skills, agents, memory, contextFiles }} new object with annotated items
 */
export function annotateUnused(unused, sessionProjectKey, sessionCwd) {
  if (!unused || typeof unused !== 'object') {
    return { skills: [], agents: [], memory: [], contextFiles: [] };
  }

  const skills = (unused.skills ?? []).map(item => ({
    ...item,
    applicable: true,
  }));

  const agents = (unused.agents ?? []).map(item => ({
    ...item,
    applicable: true,
  }));

  const memory = (unused.memory ?? []).map(item => ({
    ...item,
    applicable: item.project === sessionProjectKey,
    location: demungeProject(item.project ?? ''),
  }));

  const contextFiles = (unused.contextFiles ?? []).map(item => {
    const nameStr = item.name ?? '';
    const itemPath = item.path ?? '';
    const rootStr  = item.root ?? '';

    // applicable: global context files always apply; project ones only if under sessionCwd
    let applicable = false;
    if (nameStr.toLowerCase().includes('global')) {
      applicable = true;
    } else if (sessionCwd && itemPath && itemPath.startsWith(sessionCwd)) {
      applicable = true;
    }

    // location: if root looks like a .claude dir → 'global', else use root
    let location;
    if (rootStr && /\.claude$/i.test(rootStr)) {
      location = 'global';
    } else {
      location = rootStr;
    }

    return { ...item, applicable, location };
  });

  return { skills, agents, memory, contextFiles };
}
