// server/lib/strings-scan.js
// Shared helper: scan a buffer for runs of printable ASCII (0x20..0x7e).

/**
 * Extract runs of printable ASCII characters from a buffer.
 * Accepts Buffer or Uint8Array.
 *
 * @param {Buffer|Uint8Array} bufOrUa
 * @param {number} [minLen=6]  minimum run length to include
 * @returns {string[]}
 */
export function extractRuns(bufOrUa, minLen = 6) {
  const buf = Buffer.isBuffer(bufOrUa) ? bufOrUa : Buffer.from(bufOrUa);
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const printable = b >= 0x20 && b <= 0x7e;
    if (printable) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= minLen) {
        runs.push(buf.slice(start, i).toString('ascii'));
      }
      start = -1;
    }
  }
  return runs;
}
