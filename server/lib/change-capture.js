// server/lib/change-capture.js
const CAP = 4096;

export function clampSide(s) {
  if (typeof s !== 'string') return null;
  if (s.length <= CAP) return { text: s, truncated: false };
  return { text: s.slice(0, CAP), truncated: true };
}

export function makeChange(oldText, newText) {
  const o = clampSide(oldText), n = clampSide(newText);
  if (!o && !n) return undefined;
  return { old: o, new: n };
}
