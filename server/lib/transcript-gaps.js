// Scan a Claude Code transcript (array of JSONL strings, or one newline-delimited
// string) for capability-usage gaps — cases where a tool/skill should have been
// used but wasn't. Returns [{ code, severity, message }].
// Pure function. Zero runtime deps. Conservative thresholds — only flag
// high-confidence misses so the signal stays trustworthy.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLines(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : String(input).split('\n');
  const parsed = [];
  for (const line of raw) {
    const s = String(line ?? '').trim();
    if (!s) continue;
    try {
      parsed.push(JSON.parse(s));
    } catch {
      // skip unparseable
    }
  }
  return parsed;
}

// Extract all tool_use blocks from an assistant message's content array.
// Returns [] if the line isn't an assistant message with tool_use content.
function toolUsesFromObj(obj) {
  if (!obj || obj.type !== 'assistant') return [];
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(c => c?.type === 'tool_use');
}

// Returns true if a tool_use block is a subagent dispatch (Agent or Task with
// input.subagent_type present).
function isSubagentDispatch(tu) {
  return (tu.name === 'Agent' || tu.name === 'Task') &&
    tu.input?.subagent_type != null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function scanTranscriptForGaps(lines, ctx = {}) {
  const objs = parseLines(lines);
  const rawLines = Array.isArray(lines)
    ? lines.map(l => String(l ?? ''))
    : String(lines ?? '').split('\n');

  const gaps = [];

  // -------------------------------------------------------------------------
  // bash-grep-over-grep-tool (info)
  // Count Bash tool_use whose command matches /(^|\||\s)grep\s/ but not
  // /git\s+grep/. Count Grep tool_use. Flag if bg>=5 && bg > gt*3.
  // -------------------------------------------------------------------------
  let bashGrepCount = 0;
  let grepToolCount = 0;

  for (const obj of objs) {
    for (const tu of toolUsesFromObj(obj)) {
      if (tu.name === 'Bash') {
        const cmd = String(tu.input?.command ?? '');
        if (/(^|\||\s)grep\s/.test(cmd) && !/git\s+grep/.test(cmd)) {
          bashGrepCount++;
        }
      } else if (tu.name === 'Grep') {
        grepToolCount++;
      }
    }
  }

  if (bashGrepCount >= 5 && bashGrepCount > grepToolCount * 3) {
    gaps.push({
      code: 'bash-grep-over-grep-tool',
      severity: 'info',
      message: `Bash grep used ${bashGrepCount}x vs Grep tool ${grepToolCount}x - prefer the Grep tool.`,
    });
  }

  // -------------------------------------------------------------------------
  // opus-on-mechanical (info)
  // Subagent dispatches where model is absent OR matches /opus/i.
  // Flag if count >= 5.
  // -------------------------------------------------------------------------
  let inheritedOpusCount = 0;

  for (const obj of objs) {
    for (const tu of toolUsesFromObj(obj)) {
      if (isSubagentDispatch(tu)) {
        const model = tu.input?.model;
        if (model == null || /opus/i.test(String(model))) {
          inheritedOpusCount++;
        }
      }
    }
  }

  if (inheritedOpusCount >= 5) {
    gaps.push({
      code: 'opus-on-mechanical',
      severity: 'info',
      message: `${inheritedOpusCount} subagent dispatches inherited Opus - set model sonnet/haiku for research/mechanical work.`,
    });
  }

  // -------------------------------------------------------------------------
  // serial-agents-no-parallel (info)
  // Total subagent dispatches >= 3 AND no single assistant message's content
  // array contains >= 2 tool_use blocks that are agent dispatches.
  // -------------------------------------------------------------------------
  let totalDispatches = 0;
  let hasParallelBatch = false;

  for (const obj of objs) {
    const tus = toolUsesFromObj(obj);
    const dispatches = tus.filter(isSubagentDispatch);
    totalDispatches += dispatches.length;
    if (dispatches.length >= 2) {
      hasParallelBatch = true;
    }
  }

  if (totalDispatches >= 3 && !hasParallelBatch) {
    gaps.push({
      code: 'serial-agents-no-parallel',
      severity: 'info',
      message: `All ${totalDispatches} subagent dispatches were serial - batch independent ones in one message.`,
    });
  }

  // -------------------------------------------------------------------------
  // sleep-poll (warn)
  // Any Bash command matches /sleep\s+\d/.
  // -------------------------------------------------------------------------
  let hasSleepPoll = false;

  for (const obj of objs) {
    for (const tu of toolUsesFromObj(obj)) {
      if (tu.name === 'Bash') {
        const cmd = String(tu.input?.command ?? '');
        if (/sleep\s+\d/.test(cmd)) {
          hasSleepPoll = true;
          break;
        }
      }
    }
    if (hasSleepPoll) break;
  }

  if (hasSleepPoll) {
    gaps.push({
      code: 'sleep-poll',
      severity: 'warn',
      message: 'sleep-poll detected - use run_in_background or Monitor.',
    });
  }

  // -------------------------------------------------------------------------
  // backtest-result-without-skeptic (warn)
  // Opt-in: applies only to projects the user lists in config `backtestProjects`
  // (passed as ctx.backtestProjects). Dormant when the list is empty, so the
  // generic install never fires this workflow-specific gap. Each entry is a
  // case-insensitive substring matched against the project name/path.
  // Fires when any line matches backtest-ish keywords AND no line contains
  // "backtest-skeptic".
  // -------------------------------------------------------------------------
  const projectStr = String(ctx.project ?? '').toLowerCase();
  const backtestProjects = Array.isArray(ctx.backtestProjects) ? ctx.backtestProjects : [];
  const isBacktestProject = backtestProjects.some(
    p => p && projectStr.includes(String(p).toLowerCase()),
  );
  if (isBacktestProject) {
    const backtestRe = /sortino|sharpe|results\.tsv|exp\d|train\.py|walk[- ]?forward/i;
    const hasBacktestSignal = rawLines.some(l => backtestRe.test(l));
    const hasSkeptic = rawLines.some(l => l.includes('backtest-skeptic'));

    if (hasBacktestSignal && !hasSkeptic) {
      gaps.push({
        code: 'backtest-result-without-skeptic',
        severity: 'warn',
        message: 'Backtest result without a backtest-skeptic pass.',
      });
    }
  }

  // -------------------------------------------------------------------------
  // reread-loop (info)
  // Same file read > 8 times in one session. This signal lives HERE (raw
  // Read tool_use file_path counts) rather than in gap-detect.js because the
  // extract-claude event shape does not emit op:'read' events — so the
  // event-shape detector is inert on real transcripts. The feeder dedups by
  // `code`, so the two never double-report.
  // -------------------------------------------------------------------------
  const readCounts = new Map();
  for (const obj of objs) {
    for (const tu of toolUsesFromObj(obj)) {
      if (tu.name === 'Read') {
        const fp = String(tu.input?.file_path ?? '');
        if (fp) readCounts.set(fp, (readCounts.get(fp) ?? 0) + 1);
      }
    }
  }
  let worstRead = null;
  for (const [fp, n] of readCounts) {
    if (!worstRead || n > worstRead.n) worstRead = { fp, n };
  }
  if (worstRead && worstRead.n > 8) {
    gaps.push({
      code: 'reread-loop',
      severity: 'info',
      message: `Re-read ${worstRead.fp} ${worstRead.n} times - read once or query graphify for orientation.`,
    });
  }

  return gaps;
}
