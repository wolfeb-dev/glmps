// server/lib/ag-labels.js
// Parse Antigravity's agyhub_summaries_proto.pb to extract conversation titles and workspaces.
import fs from 'node:fs';
import path from 'node:path';
import { extractRuns } from './strings-scan.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FILE_URI_RE = /^file:\/\//i;

/**
 * Scan buffer for runs of printable ASCII (>= 6 chars) separated by control/non-ASCII bytes,
 * then walk those runs to extract UUID → {title, workspace} pairs.
 *
 * @param {Buffer} buf
 * @returns {Map<string, {title: string|null, workspace: string|null}>}
 */
export function parseAgSummaries(buf) {
  const result = new Map();
  try {
    const runs = extractRuns(buf, 6);

    // Walk runs: when a run contains a UUID (possibly with junk prefix), start a record.
    // The NEXT non-UUID, non-URL, non-git-remote run (4..120 chars) becomes the title.
    // Any later run starting file:/// before the next UUID becomes workspace.
    let current = null; // { uuid, title, workspace }

    function flush() {
      if (!current) return;
      const { uuid, title, workspace } = current;
      const prev = result.get(uuid) ?? {};
      result.set(uuid, {
        title: prev.title ?? title,
        workspace: prev.workspace ?? workspace,
      });
      current = null;
    }

    for (const run of runs) {
      // Strip leading non-alphanumeric chars (junk prefix like '$', etc.)
      const stripped = run.replace(/^[^0-9a-zA-Z]+/, '');
      const uuidMatch = stripped.match(UUID_RE);

      if (uuidMatch) {
        // Check if the UUID is at the very start of stripped (not embedded mid-word)
        const uuidIdx = stripped.indexOf(uuidMatch[0]);
        if (uuidIdx === 0) {
          // Start a new record
          flush();
          current = { uuid: uuidMatch[0].toLowerCase(), title: null, workspace: null };
          continue;
        }
      }

      if (!current) continue;

      // Check if it's a file:/// URI
      if (FILE_URI_RE.test(run)) {
        if (current.workspace === null) {
          // Decode file URI to local path: file:///d:/X → d:\X (Windows), file:///home/x → /home/x
          const withoutScheme = run.slice('file:///'.length);
          // On Windows the path starts with drive letter: d:/foo → d:\foo
          // On POSIX: /home/foo — we prepend the slash back
          const decoded = decodeURIComponent(withoutScheme.replace(/\//g, path.sep));
          // If it looks like a Windows absolute path (single letter + colon), keep as-is
          // Otherwise prepend path.sep for POSIX
          current.workspace = /^[a-zA-Z]:/.test(decoded) ? decoded : (path.sep + decoded);
        }
        continue;
      }

      // Skip git remote URLs (git@..., https://..., ssh://...)
      if (/^(git@|https?:\/\/|ssh:\/\/)/.test(run)) continue;

      // Skip if this run itself contains a UUID (it's another id run, treat as new record start)
      const runUuidMatch = run.replace(/^[^0-9a-zA-Z]+/, '').match(UUID_RE);
      if (runUuidMatch && run.replace(/^[^0-9a-zA-Z]+/, '').indexOf(runUuidMatch[0]) === 0) {
        flush();
        current = { uuid: runUuidMatch[0].toLowerCase(), title: null, workspace: null };
        continue;
      }

      // Candidate for title: 4..120 chars; strip leading non-letter/digit junk
      if (current.title === null && run.length >= 4 && run.length <= 120) {
        const cleanTitle = run.replace(/^[^A-Za-z0-9]+/, '');
        if (cleanTitle.length >= 4) current.title = cleanTitle;
      }
    }

    flush();
  } catch {
    // never throw — return whatever was accumulated
  }

  return result;
}

/**
 * Load and merge labels from agyhub_summaries_proto.pb files in each root.
 * Missing files are silently skipped.
 *
 * @param {string[]} antigravityDirs
 * @returns {Map<string, {title: string|null, workspace: string|null}>}
 */
export function loadAgLabels(antigravityDirs) {
  const merged = new Map();
  for (const dir of antigravityDirs) {
    const pbPath = path.join(dir, 'agyhub_summaries_proto.pb');
    let buf;
    try { buf = fs.readFileSync(pbPath); } catch { continue; }
    const labels = parseAgSummaries(buf);
    for (const [uuid, rec] of labels) {
      const prev = merged.get(uuid);
      if (!prev) { merged.set(uuid, rec); }
      else {
        // merge: prefer first non-null seen
        merged.set(uuid, {
          title: prev.title ?? rec.title,
          workspace: prev.workspace ?? rec.workspace,
        });
      }
    }
  }
  return merged;
}
