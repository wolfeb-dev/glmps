# GLMPS — project instructions

A local dashboard that shows, live and per session, what every Claude Code / Antigravity / CLI agent session is doing (skills, agents, memory, CLAUDE.md, git, file edits) — with history, search, in-dashboard editing, and resume. It is also a **lab for catching our own capability misuse**: when the agent fails to reach for the right skill / subagent / hook, this project should make that visible and, over time, prevent it.

## Capability-first working rule
Before starting any substantive task here, pause and scan what's available — skills, agents, hooks, MCP tools — and use what fits. Don't default to "just do it" when a skill exists for it. Concretely:
- UI / styling / layout / aesthetics → `frontend-design` skill (this is the miss this project was built to catch).
- New feature / behavior change → `brainstorming` before implementing; `writing-plans` then `subagent-driven-development` to execute.
- Bug / failing test / unexpected behavior → `systematic-debugging` before proposing fixes.
- 2+ independent workstreams → dispatch subagents in parallel.
- When delegating to subagents, tell them which skill to use rather than hand-speccing everything.
If you notice (or the user points out) that a capability should have been used and wasn't, treat that as a defect worth fixing — both in the moment and, where possible, by adding a guard (CLAUDE.md note, hook, or a dashboard signal) so it's caught automatically next time.

## Run & verify
- Test: `npm test` (Node built-in runner, `node --test`, zero deps). Keep it green; run it before claiming anything is done.
- Run the dashboard: `node server/server.js` → http://127.0.0.1:8123 (binds localhost only).
- The server serves `web/` from disk per request — **web/ changes are live on refresh, no restart**. Only `server/**` and `taps/**` changes need a restart (kill the PID listening on 8123, relaunch in the background).
- After server/lib changes, restart and curl `/api/state` (and `/api/state?session=<id>`) to verify against real data.

## Architecture
- `server/` — zero-dependency Node 18+ ESM watcher + HTTP + SSE. Tails session sources, classifies events, serves the dashboard. Capture is adapter-based under `server/lib/adapters/` (one module per tool: detect/discover/extract). Add a new tool by adding an adapter, not by editing the core loop.
- `web/` — vanilla JS + CSS dashboard, **no build step**.
- `taps/` — statusline chain tap (records per-session model/ctx/cost, then delegates to the prior statusline command).
- `companion/` — Antigravity extension (auto-start server, resume-into-Antigravity).
- Shared event shape across all extractors/UI: `{ kind, lane, label, path, tool, ts, sessionId }` (+ optional `op`, `change`, `model`). Keep new fields optional so existing consumers don't break.

## Conventions
- **Zero runtime dependencies.** Dev-only deps are allowed in `companion/` (esbuild/vsce). Don't add runtime deps to server/ or web/.
- **TDD** with `node:test` for every server lib change. Tests live in `server/test/`.
- **XSS discipline (non-negotiable):** all user/file-derived data (paths, labels, diffs, commit messages) goes through `textContent` / `createElement`. Never `innerHTML` with data; `innerHTML = ''` to clear is the only allowed use.
- **Design system:** the house palette/aesthetic is realized in `web/styles.css` (the house design tokens). Spacing uses the `--sp-1..4` scale. Do UI work via the `frontend-design` skill.
- Tests are isolated via env-overridable paths (`GLMPS_*` env vars in `server/lib/paths.js`); never read the user's real `~/.claude` / `~/.gemini` in tests.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
