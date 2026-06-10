// server/lib/tailer.js
import fs from 'node:fs';

// Read bytes [offset..EOF), split into complete lines.
// carry = unterminated tail from the previous call.
// Returns { lines, offset, carry }. Never throws on FS errors (returns input state).
export function readNewLines(file, offset, carry, opts = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch { return { lines: [], offset, carry }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) { offset = 0; carry = ''; } // file truncated/rotated
    if (size === offset) return { lines: [], offset, carry };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    let text = carry + buf.toString('utf-8');
    const parts = text.split('\n');
    const newCarry = parts.pop(); // '' when text ends with \n
    if (opts.discardFirstPartial && carry === '' && offset > 0) parts.shift();
    let lines = parts.map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
    return { lines, offset: size, carry: newCarry };
  } catch {
    return { lines: [], offset, carry };
  } finally {
    fs.closeSync(fd);
  }
}
