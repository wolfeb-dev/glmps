// web/session-color.js — stable per-session color assignment
// Pure function, no DOM, no side effects. Deterministic: same id → same color.
// Palette is drawn from the house accent vars so pucks/floods
// read as intentional, not foreign, on the graph canvas.

const PALETTE = [
  '#4a8cd8',   // --info    (blue)
  '#a878d8',   // --accent  (purple)
  '#3fb87f',   // --success (green)
  '#e0a23a',   // --warning (amber)
  '#3fb8b8',   // teal
  '#d878a8',   // pink
  '#d4a437',   // --primary (gold)
  '#e05656',   // --destructive (red)
  '#6ad87a',   // lime-green
  '#78a8d8',   // sky-blue
];

/**
 * sessionColor(id) — stable hash of the session id string → hex color.
 * @param {string} id
 * @returns {string} '#rrggbb'
 */
export function sessionColor(id) {
  if (!id) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}
