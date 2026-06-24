#!/usr/bin/env node
// UserPromptSubmit hook: inject targeted "this capability applies" reminders.
// Runs on every prompt; prints nothing unless a rule matches (keeps noise low).
// Stdin: JSON with a `prompt` field. Stdout: short reminder block added to context.
// Never throws and always exits 0 — must not block prompts.

const RULES = [
  {
    re: /\b(css|stylesheet|styling|style the|layout|colou?rs?|palette|theme|ui|ux|front-?end|design|dashboard|component|wireframe|mockup|spacing|typography|responsive|webpage|web page)\b|\.(css|html|tsx?|jsx?|vue|svelte)\b/i,
    msg: 'UI / design work → use the frontend-design skill (applies to restyles, not just new builds).',
  },
  {
    re: /\b(bug|broken|fails?|failing|errors?|crash(?:ing|ed)?|stack ?trace|unexpected|not working|does ?n.?t work|regression|flaky)\b/i,
    msg: 'Debugging → use systematic-debugging before proposing a fix.',
  },
  {
    re: /\b(new feature|implement|build (?:a|an|the|out)|add (?:a|an|support|the ability)|scaffold|from scratch|create (?:a|an) (?:feature|component|page|tool|system))\b/i,
    msg: 'Non-trivial feature → brainstorm, then writing-plans, before coding.',
  },
  {
    re: /\b(each of|all of the|multiple (?:files|services|projects|repos)|several (?:files|services|projects)|in parallel|fan ?out|across (?:all|the) )\b/i,
    msg: 'Independent multi-part work → consider dispatching parallel subagents.',
  },
  {
    re: /\b(backtest|sortino|sharpe|walk[- ]?forward|out[- ]?of[- ]?sample|equity curve|win ?rate|drawdown)\b/i,
    msg: 'Trading/backtest result -> validate with backtest-skeptic before trusting or committing.',
  },
  {
    re: /\.cs\b|ninjascript|ninjatrader|\b(indicator|strategy)\b/i,
    msg: 'NinjaScript change -> headlessly compile via test_ninjascript_compile.py before claiming it compiles.',
  },
  {
    re: /\b(how does|where is|architecture|refresh yourself|understand the|trace the|what calls|data ?flow|code ?base)\b/i,
    msg: 'Codebase-orientation question -> query graphify (graphify query/path/explain) before re-reading files.',
  },
  {
    re: /\b(is it done|are we done|good to go|ship it|works now|is it working|ready to commit|all set)\b/i,
    msg: 'Before claiming done -> run verification-before-completion with real command output.',
  },
];

export function capabilityReminders(prompt) {
  if (typeof prompt !== 'string') return [];
  const out = [];
  for (const r of RULES) if (r.re.test(prompt)) out.push(r.msg);
  return out.slice(0, 3);
}

// CLI entry — only when run directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    let prompt = '';
    try { prompt = JSON.parse(raw).prompt ?? ''; } catch {}
    const rem = capabilityReminders(prompt);
    if (rem.length) {
      process.stdout.write(
        'Capability check (consider before acting):\n' +
        rem.map(r => '- ' + r).join('\n') + '\n',
      );
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
