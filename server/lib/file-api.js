// server/lib/file-api.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Secret/credential material is never readable or writable through the dashboard
// file API, even when it lives inside an allowed editing root (the roots include
// ~/.claude, so .credentials.json would otherwise be exfiltratable, and a
// poisoned write could plant SSH keys / .env secrets). Basename + path-segment
// deny, independent of the root allowlist below.
const DENY_BASENAME = /^(\.credentials\.json|\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|ppk|pfx|p12|asc))$/i;
const DENY_SEGMENT = new Set(['.ssh', '.aws', '.gnupg', '.gpg']);

function isSensitive(resolved) {
  const base = path.basename(resolved);
  if (DENY_BASENAME.test(base)) return true;
  return resolved.toLowerCase().split(/[\\/]/).some(seg => DENY_SEGMENT.has(seg));
}

export class FileApi {
  constructor(roots, undoDir) {
    this.roots = roots.map(r => path.resolve(r).toLowerCase());
    this.undoDir = undoDir;
  }

  _check(p) {
    if (typeof p !== 'string' || !p) throw new Error('Path not allowed: (empty)');
    const resolved = path.resolve(p);
    if (resolved.indexOf(':', 2) !== -1) throw new Error(`Path not allowed: ${resolved}`);
    if (isSensitive(resolved)) throw new Error(`Path not allowed (sensitive): ${resolved}`);
    const low = resolved.toLowerCase();
    if (!this.roots.some(r => low === r || low.startsWith(r + path.sep)))
      throw new Error(`Path not allowed: ${resolved}`);
    return resolved;
  }

  read(p) {
    const f = this._check(p);
    const content = fs.readFileSync(f, 'utf-8');
    return { path: f, content, hash: sha(content), mtimeMs: fs.statSync(f).mtimeMs };
  }

  save(p, content, expectedHash, { force = false } = {}) {
    const f = this._check(p);
    let prev = null;
    try { prev = fs.readFileSync(f, 'utf-8'); } catch {}
    if (!force && prev !== null && sha(prev) !== expectedHash)
      throw new Error('Conflict: file changed on disk since it was loaded');
    if (prev !== null) {
      fs.mkdirSync(this.undoDir, { recursive: true });
      fs.writeFileSync(path.join(this.undoDir, sha(f.toLowerCase()) + '.undo'), prev);
    }
    fs.writeFileSync(f, content);
    return { hash: sha(content) };
  }

  undo(p) {
    const f = this._check(p);
    const u = path.join(this.undoDir, sha(f.toLowerCase()) + '.undo');
    const prev = fs.readFileSync(u, 'utf-8'); // throws if no undo exists
    fs.writeFileSync(f, prev);
    fs.rmSync(u);
    return { hash: sha(prev) };
  }
}
