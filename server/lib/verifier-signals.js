const PATTERNS = {
  tests: /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bpytest\b|\bnode\s+--test\b|\bvitest\b|\bjest\b/i,
  lint:  /\b(eslint|ruff|flake8|lint)\b/i,
  build: /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\btsc\b|\bcargo\s+build\b|\bmake\b/i,
};

export function verifierFromEvents(events = []) {
  const last = { tests: null, lint: null, build: null };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== 'tool' || ev.tool !== 'Bash') continue;
    const next = events[i + 1];
    if (!next || next.kind !== 'tool_result') continue;

    for (const [cat, re] of Object.entries(PATTERNS)) {
      if (re.test(ev.label)) {
        last[cat] = next.ok === true;
      }
    }
  }

  const values = Object.values(last).filter(v => v !== null);
  const exitOk = values.length === 0 ? null : values.every(Boolean);

  return { ...last, exitOk };
}

export function acceptanceCoverage(acceptanceText = '', events = []) {
  if (!acceptanceText) return { stated: null, met: null };

  const lines = acceptanceText.split('\n');
  const statedLines = lines.filter(l => /^\s*[-*]\s+\[[ xX]\]/.test(l));
  const metLines    = lines.filter(l => /^\s*[-*]\s+\[[xX]\]/.test(l));

  return { stated: statedLines.length, met: metLines.length };
}
