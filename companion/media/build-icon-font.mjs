// Build the single-glyph GLMPS icon font (media/glmps-icons.woff) from
// glmps-mark-glyph.svg, so the status bar can show the brand mark via
// `$(glmps-mark)` (contributes.icons). Dev-only; run on demand:
//
//   npm install --no-save svgicons2svgfont svg2ttf ttf2woff
//   node media/build-icon-font.mjs
//
// The generated .woff is committed; you only need to re-run this if the glyph
// changes. Glyph maps to private-use codepoint U+E900 -> fontCharacter "\\E900".
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const CODEPOINT = 0xe900;

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'glmps',
  normalize: true,
  fontHeight: 1000,
  centerHorizontally: true,
  centerVertically: true,
  log: () => {},
});

let svgFont = '';
const done = new Promise((resolve, reject) => {
  fontStream.on('data', d => { svgFont += d; });
  fontStream.on('finish', resolve);
  fontStream.on('error', reject);
});

const glyph = fs.createReadStream(path.join(dir, 'glmps-mark-glyph.svg'));
glyph.metadata = { unicode: [String.fromCodePoint(CODEPOINT)], name: 'glmps-mark' };
fontStream.write(glyph);
fontStream.end();
await done;

const ttf = svg2ttf(svgFont, { description: 'GLMPS icon font', version: '1.0' });
const woff = ttf2woff(new Uint8Array(Buffer.from(ttf.buffer)));
const woffBuf = Buffer.from(woff.buffer);
const out = path.join(dir, 'glmps-icons.woff');
fs.writeFileSync(out, woffBuf);
console.log(`wrote ${out} (${woffBuf.length} bytes); fontCharacter "\\\\${CODEPOINT.toString(16).toUpperCase()}"`);
