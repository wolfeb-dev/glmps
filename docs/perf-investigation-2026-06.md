# Task-completion slowdown investigation (glmps-27)

Investigating the report that task completion has felt slower over the past
couple of weeks despite the added GLMPS layers. Data from
`~/.glmps/usage/*.ndjson` (Jun 8–28) plus direct timing of the hooks.

## TL;DR

The felt slowdown is consistent with **fixed per-turn / per-stop overhead added
by the capability/done-gate layers**, not with model or context growth. The
dominant cost is the **`npm test` Stop gate (~7.0 s on every stop while the
working tree is dirty)**. The recorded telemetry cannot confirm the magnitude
because it is cumulative-per-session, not per-turn — fixing that measurement gap
is itself a recommendation.

## What the recorded data does and doesn't show

The statusline tap records per-snapshot `durationMs`, `apiDurationMs`, `input`,
`ctxUsedPct`. **These are cumulative session totals, not per-turn deltas**, so
they can't isolate "how long a task took." Aggregated medians:

| Window | snaps | med input tok | med ctx% |
|---|---|---|---|
| Early (Jun 8–14) | 5352 | 264k | 26% |
| Recent (Jun 22–28) | 4558 | 192k | 19% |

Recent context is if anything *lower*, so **the data does not support a
context-bloat or model explanation** — and because it is cumulative it also
can't positively confirm the per-turn slowdown. That measurement blind spot is
finding #0.

## The measurable cause: fixed per-stop / per-turn hook overhead

Direct timing on this machine, in the GLMPS repo:

| Hook (event) | Cost | Frequency | Landed |
|---|---|---|---|
| **done-gate `npm test`** (Stop) | **~7,016 ms** | every Stop while tree is dirty | acceptance gate Jun 12 |
| capability-feed full-transcript read + detectors (Stop) | O(session length); grows in long sessions | every Stop | **Jun 22** |
| done-gate + scope-guard `git status` (Stop) | ~50 ms ×2 | every Stop | Jun 12 / Jun 22 |
| capability-reminder system-reminder inject (UserPromptSubmit) | tokens added to context | **every prompt** | Jun 8 |
| graphify PreToolUse tip inject | tokens added to context | **every Read/Grep/Glob/Bash** | — |
| SessionStart hooks ×3 | one-time | per session | — |

During active development the working tree is essentially always dirty, so the
agent pays **~7 seconds on basically every stop** just to re-run the full suite
through the done-gate. The capability-feed Stop hook (added **Jun 22**, matching
"the past couple weeks") adds a full-transcript read on top, which gets more
expensive the longer the session runs.

The per-prompt and per-tool reminder injections don't cost wall-clock directly
but steadily add tokens to the working context every turn (processed each call;
cache softens but does not eliminate it).

## Timeline correlation

`hooks/capability-feed.js` (the per-session feeder Stop hook) landed **2026-06-22
(a37d3b6)**; the acceptance/done-gate landed Jun 12 (6281799). The reported
slowdown window ("past couple weeks", reported ~Jun 27–28) lines up with the
capability-loop Stop hook going live.

## Recommended fixes (ranked by impact)

1. **Cache / skip the `npm test` Stop gate when nothing testable changed.**
   Hash `server/**` + `server/test/**` (and `hooks/**`); if unchanged since the
   last green run, skip re-running. Removes the ~7 s tax from the majority of
   stops (docs/web/config edits, repeated stops in one work session). Biggest
   single win. Keep the gate's safety: still run when testable files changed.
2. **Cap the capability-feed transcript read to a tail** (e.g. last N MB, reuse
   `backfillBytes`) instead of `readFileSync` of the whole file — turns an
   O(session-length) read into O(1) per stop.
3. **Run capability-feed asynchronously / non-blocking.** It does not gate the
   stop (only done-gate does), so it can run detached and never sit on the
   critical path.
4. **Rate-limit the reminders.** Fire `capability-reminder` once per session (or
   only when a relevant capability is actually detected), and emit the graphify
   PreToolUse tip at most once per session rather than on every read/grep. Cuts
   the steady per-turn token growth.
5. **Fix the measurement gap (finding #0).** Record per-turn duration deltas
   (snapshot-to-snapshot `apiDurationMs`/wall deltas) so "task completion speed"
   is directly answerable next time instead of inferred. A small addition to the
   statusline tap or a dashboard rollup.

Fixes 1–3 are the high-value, low-risk ones; each is a contained, testable
change to an existing hook.
