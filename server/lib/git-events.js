// server/lib/git-events.js
// Detect 'saved work' git operations in a shell command string.
// Returns { kind:'git', lane:'context', label, gitOp } or null.
export function classifyGit(cmd) {
  if (typeof cmd !== 'string') return null;
  const c = cmd.trim();
  if (/\bgit\s[^\n]*\bcommit\b/.test(c)) {
    const m = c.match(/-m\s+"([^"\n]+)"|-m\s+'([^'\n]+)'|--message[= ]"?([^"\n]+)"?/);
    const msg = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '(commit)';
    return { kind: 'git', lane: 'context', gitOp: 'commit', label: 'commit: ' + msg.slice(0, 100) };
  }
  if (/\bgit\s[^\n]*\bpush\b/.test(c)) {
    // Skip leading flags (e.g. --force-with-lease) to capture remote + branch
    const t = c.match(/push\s+(?:--?\S+\s+)*(\S+)\s+(\S+)/);
    return { kind: 'git', lane: 'context', gitOp: 'push', label: t ? `push → ${t[1]}/${t[2]}` : 'push' };
  }
  if (/\bgh\b[^\n]*\bpr\b[^\n]*\bcreate\b/.test(c)) {
    return { kind: 'git', lane: 'context', gitOp: 'pr', label: 'gh pr create' };
  }
  return null;
}
