#!/usr/bin/env node
// Stop hook: scans the just-ended session transcript for capability gaps,
// upserts them into the learning store, files a backlog ticket for explicitly-
// deferred work, and refreshes graphify if code files changed.
//
// Stdin: Claude Code Stop-hook JSON { transcript_path, cwd, session_id, stop_hook_active }.
// Always exits 0 — must never block the stop.

// CLI entry guard — only run when invoked directly, not when imported by tests.
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import('node:fs').then(({ default: fs }) => {
    import('node:path').then(({ default: path }) => {
      import('node:os').then(({ default: os }) => {
        run(fs, path, os).catch(() => process.exit(0));
      });
    });
  });
}

async function run(fs, path, os) {
  // --- Read stdin ---
  let raw = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    process.stdin.on('data', d => { raw += d; });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  try {
    const inp = JSON.parse(raw || '{}');
    const transcriptPath = inp.transcript_path ?? null;
    const cwd = inp.cwd ?? process.cwd();
    const sessionId = inp.session_id ?? 'unknown';

    // Silently exit if no transcript
    if (!transcriptPath) { process.exit(0); }
    if (!fs.existsSync(transcriptPath)) { process.exit(0); }

    // --- Read the transcript ---
    let rawContent;
    try { rawContent = fs.readFileSync(transcriptPath, 'utf8'); }
    catch { process.exit(0); }

    const lines = rawContent.split('\n').filter(Boolean);

    // --- Extract events + skillsUsed via extract-claude ---
    // Dynamically import from sibling server/lib (relative to this hook's location).
    const hooksDir = path.dirname(fileURLToPath(import.meta.url));
    const serverLib = path.join(hooksDir, '..', 'server', 'lib');

    const { extractClaudeEvents } = await import(
      pathToFileURL(path.join(serverLib, 'extract-claude.js')).href
    );

    const events = [];
    const skillsUsed = [];
    for (const line of lines) {
      const evs = extractClaudeEvents(line, sessionId);
      for (const e of evs) {
        events.push(e);
        if (e.kind === 'skill' && e.label && !skillsUsed.includes(e.label)) {
          skillsUsed.push(e.label);
        }
      }
    }

    // --- Extract lastText: last assistant or user text block ---
    let lastText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (let j = obj.message.content.length - 1; j >= 0; j--) {
            const c = obj.message.content[j];
            if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
              lastText = c.text.trim();
              break;
            }
          }
        } else if (obj.type === 'user') {
          const content = obj.message?.content;
          if (typeof content === 'string' && content.trim()) {
            lastText = content.trim();
          } else if (Array.isArray(content)) {
            for (let j = content.length - 1; j >= 0; j--) {
              const c = content[j];
              if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
                lastText = c.text.trim();
                break;
              }
            }
          }
        }
        if (lastText) break;
      } catch { /* skip unparseable lines */ }
    }

    // --- Derive project from cwd basename ---
    const project = path.basename(cwd);

    // --- Load opt-in tunables from GLMPS's own config.json (gitignored; absent
    //     in a fresh/public install -> the workflow-specific gaps stay dormant). ---
    let backtestProjects = [];
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(hooksDir, '..', 'config.json'), 'utf8'));
      if (Array.isArray(cfg.backtestProjects)) backtestProjects = cfg.backtestProjects;
    } catch { /* no/invalid config -> empty list */ }

    // --- Run the pure core ---
    const { feedFromTranscript } = await import(
      pathToFileURL(path.join(serverLib, 'capability-feed-core.js')).href
    );
    const { gaps, ticket, codeChanged } = feedFromTranscript({ events, lines, skillsUsed, project, sessionId, lastText, backtestProjects });

    // --- Resolve stateDir via paths.js ---
    const { getPaths } = await import(
      pathToFileURL(path.join(serverLib, 'paths.js')).href
    );
    const P = getPaths();
    const stateDir = P.stateDir;

    // --- Upsert gaps into the learning store ---
    const learningStore = await import(
      pathToFileURL(path.join(serverLib, 'learning-store.js')).href
    );
    // Key the learning store by the canonical project slug, NOT the cwd basename:
    // basename ("glmps") throws away the path, so the same repo keys
    // differently from the live-server / synth writers (which see the raw path or
    // the projects slug) and applied gaps re-surface as fresh pending dupes.
    const projectKey = learningStore.normalizeProject(cwd);
    for (const gap of gaps) {
      try { learningStore.upsertGap(stateDir, gap, { project: projectKey, sessionId }); }
      catch { /* fail-open: never block stop */ }
    }

    // --- File a backlog ticket for deferred work ---
    if (ticket !== null) {
      try {
        const backlogStore = await import(
          pathToFileURL(path.join(serverLib, 'backlog-store.js')).href
        );
        backlogStore.addItemTo(stateDir, {
          project,
          title: ticket.title,
          prompt: ticket.prompt,
          source: ticket.source,
        });
      } catch { /* fail-open */ }
    }

    // --- Refresh graphify if code changed ---
    if (codeChanged) {
      try {
        // graphify-out/graph.json can live at cwd or cwd/server
        let graphRoot = null;
        for (const sub of ['', 'server']) {
          const candidate = path.join(cwd, sub, 'graphify-out', 'graph.json');
          if (fs.existsSync(candidate)) { graphRoot = path.join(cwd, sub); break; }
        }
        if (graphRoot) {
          const { spawn } = await import('node:child_process');
          const child = spawn('graphify', ['update', graphRoot], {
            detached: true,
            stdio: 'ignore',
            shell: true,
          });
          child.unref();
        }
      } catch { /* fail-open: graphify is best-effort */ }
    }

  } catch {
    // Top-level fail-open: a hook bug must never trap the user
  }

  process.exit(0);
}
