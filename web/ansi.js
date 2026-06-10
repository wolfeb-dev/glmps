// web/ansi.js
// ANSI SGR -> token / DOM rendering, XSS-safe (createElement + textContent only).
// parseAnsi() is pure and unit-tested; renderAnsi() builds a DocumentFragment.
//
// Reference for the SGR subset handled here (color/style codes ending in 'm'):
// D:/_scratch_cch_viewer/src/utils/ansiToHtml.ts (ansi-to-html based). We do NOT
// use that library; we map a small palette to the dashboard design tokens.

// Matches a single SGR escape: ESC [ <digits;digits...> m
// (only color/style sequences ending in 'm' — cursor/clear sequences are ignored).
const SGR_RE = /\x1b\[([\d;]*)m/g;

// Foreground 30-37 / bright 90-97 -> CSS color expressions (design tokens where natural).
const FG = {
  30: 'var(--bg)',            // black
  31: 'var(--err, #d8584a)',  // red
  32: 'var(--success)',       // green
  33: 'var(--primary)',       // yellow -> gold
  34: 'var(--info)',          // blue
  35: '#b07ad8',              // magenta
  36: '#3fb8b8',              // cyan
  37: 'var(--fg, #e6e8eb)',   // white
  90: 'var(--muted-fg)',      // bright black (grey)
  91: '#ff7a6e',              // bright red
  92: '#6fe0a6',              // bright green
  93: '#e6c25a',              // bright yellow
  94: '#7ab0ec',              // bright blue
  95: '#cd9be6',              // bright magenta
  96: '#6fe0e0',              // bright cyan
  97: '#ffffff',              // bright white
};

// Background 40-47 -> CSS color expressions.
const BG = {
  40: 'var(--bg)',
  41: 'rgba(216,88,74,.25)',
  42: 'rgba(63,184,127,.25)',
  43: 'rgba(212,164,55,.25)',
  44: 'rgba(74,140,216,.25)',
  45: 'rgba(176,122,216,.25)',
  46: 'rgba(63,184,184,.25)',
  47: 'var(--muted)',
};

function emptyStyle() {
  return { fg: null, bg: null, bold: false, italic: false, underline: false, dim: false };
}

// Apply a single numeric SGR code to a mutable style object.
function applyCode(style, code) {
  if (code === 0) { Object.assign(style, emptyStyle()); return; }
  if (code === 1) { style.bold = true; return; }
  if (code === 2) { style.dim = true; return; }
  if (code === 3) { style.italic = true; return; }
  if (code === 4) { style.underline = true; return; }
  if (code === 22) { style.bold = false; style.dim = false; return; }
  if (code === 23) { style.italic = false; return; }
  if (code === 24) { style.underline = false; return; }
  if (code === 39) { style.fg = null; return; }
  if (code === 49) { style.bg = null; return; }
  if (FG[code] !== undefined) { style.fg = code; return; }
  if (BG[code] !== undefined) { style.bg = code; return; }
  // Unknown / unsupported (e.g. 38;5;n 256-color) — ignored.
}

// parseAnsi(str) -> [{ text, style }]
// Pure tokenizer. Each token's `style` is a frozen snapshot of the active SGR state.
// Strings with no ANSI codes yield a single token (or [] for empty input).
export function parseAnsi(str) {
  const s = String(str ?? '');
  if (s === '') return [];
  const tokens = [];
  const style = emptyStyle();
  let last = 0;
  SGR_RE.lastIndex = 0;
  let m;
  const push = (text) => {
    if (text === '') return;
    tokens.push({ text, style: { ...style } });
  };
  while ((m = SGR_RE.exec(s)) !== null) {
    push(s.slice(last, m.index));
    // Empty params (ESC[m) is treated as reset (code 0).
    const raw = m[1] === '' ? '0' : m[1];
    for (const part of raw.split(';')) {
      applyCode(style, part === '' ? 0 : parseInt(part, 10));
    }
    last = SGR_RE.lastIndex;
  }
  push(s.slice(last));
  return tokens;
}

// Map a token style to an inline CSS string (computed palette values only, never user data).
function styleToCss(style) {
  const parts = [];
  if (style.fg != null && FG[style.fg]) parts.push('color:' + FG[style.fg]);
  if (style.bg != null && BG[style.bg]) parts.push('background:' + BG[style.bg]);
  if (style.bold) parts.push('font-weight:600');
  if (style.dim) parts.push('opacity:.7');
  if (style.italic) parts.push('font-style:italic');
  if (style.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

// renderAnsi(str) -> DocumentFragment of <span> nodes.
// XSS-safe: text goes through textContent; styling is inline CSS built from the
// fixed palette above (no user-derived values reach style or innerHTML).
export function renderAnsi(str) {
  const frag = document.createDocumentFragment();
  for (const tok of parseAnsi(str)) {
    const span = document.createElement('span');
    span.textContent = tok.text;
    const css = styleToCss(tok.style);
    if (css) span.setAttribute('style', css);
    frag.appendChild(span);
  }
  return frag;
}
