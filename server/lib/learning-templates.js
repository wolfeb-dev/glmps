// server/lib/learning-templates.js
// Gap-code -> guard template map, plus the pure idempotent section-insert helper.
// Zero dependencies, no fs/os usage — pure functions only.

// ---------------------------------------------------------------------------
// TEMPLATES: gap code -> { file, section, rule }
// ---------------------------------------------------------------------------

export const TEMPLATES = new Map([
  [
    'ui-without-frontend-design',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.',
    },
  ],
  [
    'heavy-edits-no-subagents',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- When making many independent edits across files, dispatch parallel subagents instead of editing serially.',
    },
  ],
  [
    'ui-design-too-late',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Invoke frontend-design BEFORE the first UI/CSS edit, not after.',
    },
  ],
  [
    'reread-loop',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Do not re-read an unchanged file; for codebase orientation query graphify (graphify query/path/explain) instead of repeated reads.',
    },
  ],
  [
    'done-without-verification',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Before claiming done or committing, run verification-before-completion and show the actual command output.',
    },
  ],
  [
    'bash-grep-over-grep-tool',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
    },
  ],
  [
    'opus-on-mechanical',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: "- Set model:'sonnet'|'haiku' on research/implementation/mechanical subagent dispatches; reserve Opus for orchestration and hard reasoning.",
    },
  ],
  [
    'serial-agents-no-parallel',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Dispatch 2+ independent subagents in a single message (parallel), with narrow per-agent file ownership.',
    },
  ],
  [
    'sleep-poll',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- Never poll with sleep N then cat - use run_in_background or Monitor.',
    },
  ],
  [
    'backtest-result-without-skeptic',
    {
      file: 'CLAUDE.global.md',
      section: 'Learned guards',
      rule: '- In trading repos, no backtest/strategy result is kept or committed until backtest-skeptic validates it.',
    },
  ],
]);

// ---------------------------------------------------------------------------
// guardForGap(code) -> { file, section, rule } | null
// ---------------------------------------------------------------------------

export function guardForGap(code) {
  return TEMPLATES.get(code) ?? null;
}

// ---------------------------------------------------------------------------
// insertGuard(fileContent, section, rule) -> { content, changed }
//
// Pure + idempotent:
//   - If the exact `rule` line already exists anywhere in the content,
//     return { content, changed: false } unchanged.
//   - If `## <section>` heading is absent, append "\n## <section>\n" + rule.
//   - If present, append rule as a new line at the end of that section
//     (before the next ## heading or EOF).
// ---------------------------------------------------------------------------

export function insertGuard(fileContent, section, rule) {
  // Idempotency guard: if the exact rule text already exists anywhere, do nothing.
  // We check line-by-line so partial substring matches inside other lines don't trip it.
  const existingLines = fileContent.split('\n');
  if (existingLines.some((line) => line === rule)) {
    return { content: fileContent, changed: false };
  }

  const headingPattern = new RegExp(`^## ${escapeRegExp(section)}$`, 'm');

  if (!headingPattern.test(fileContent)) {
    // Section absent: append the heading + rule at the end.
    // Ensure we start on a new line; trim trailing whitespace from existing content first.
    const base = fileContent.trimEnd();
    const separator = base.length > 0 ? '\n' : '';
    const appended = `${base}${separator}\n## ${section}\n${rule}\n`;
    return { content: appended, changed: true };
  }

  // Section present: find the heading and locate the end of that section
  // (the next ## heading, or EOF).
  const lines = fileContent.split('\n');
  const headingRe = new RegExp(`^## ${escapeRegExp(section)}$`);
  const nextHeadingRe = /^## /;

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  // Find the end of the section: the line just before the next ## heading,
  // or the last non-empty line of the file if there is no next heading.
  let insertIdx = lines.length; // default: insert after last line
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) {
      // Insert before the blank line(s) that precede the next heading, or right before it.
      // Walk back past trailing blank lines to keep spacing clean.
      let insertBefore = i;
      while (insertBefore > headingIdx + 1 && lines[insertBefore - 1].trim() === '') {
        insertBefore--;
      }
      insertIdx = insertBefore;
      break;
    }
  }

  // If inserting at EOF, walk back past trailing blank lines.
  if (insertIdx === lines.length) {
    while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
  }

  const result = [
    ...lines.slice(0, insertIdx),
    rule,
    ...lines.slice(insertIdx),
  ].join('\n');

  return { content: result, changed: true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
