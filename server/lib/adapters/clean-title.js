// Collapse agent-chat text into a single-line human title.
export function cleanTitle(text, max = 80) {
  if (typeof text !== 'string') return null;
  let t = text;
  const lines = t.split(/\r?\n/);

  // Patterns that identify a context-block line (metadata, not real user content)
  const isContextLine = l => l === '' || l === '---'
    || /^[-*]\s+\*\*[^*]+\*\*/.test(l)    // markdown bullet key: - **Key** value
    || /^[A-Z][\w\s]{0,30}:\s*$/.test(l); // "Current File Path:" style header

  // Skip leading context-block lines
  let start = 0;
  while (start < lines.length && isContextLine(lines[start].trim())) { start++; }

  // From the first non-context line, collect until we hit a trailing context block:
  // a blank line or separator or context-header that starts a metadata section
  let end = start;
  while (end < lines.length) {
    const l = lines[end].trim();
    // A blank line or separator signals end of the human-readable section
    if (l === '' || l === '---') break;
    // A context-header line (Key: at end of line) signals metadata start
    if (/^[A-Z][\w\s]{0,30}:\s*$/.test(l)) break;
    end++;
  }

  let slice = lines.slice(start, end);
  t = slice.join(' ');
  t = t.replace(/[`*_#>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) { t = text.replace(/\s+/g, ' ').trim(); } // everything was context — fall back to collapsed raw
  return t.slice(0, max) || null;
}
