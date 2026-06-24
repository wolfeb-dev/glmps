#!/usr/bin/env node
// hooks/capability-synth-tick.js
// SessionStart hook: fires the weekly capability synthesizer (detached) when
// >= 7 days have passed since the last run. Never blocks session start.
// Stdin: Claude Code SessionStart JSON.
// Always exits 0. Prints nothing.

import { fileURLToPath, pathToFileURL } from 'node:url';

// CLI entry guard — only run when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import('node:fs').then(({ default: fs }) => {
    import('node:path').then(({ default: path }) => {
      import('node:child_process').then(({ spawn }) => {
        run(fs, path, spawn).catch(() => process.exit(0));
      });
    });
  });
}

async function run(fs, path, spawn) {
  // Consume stdin (required by hook protocol; value not used here)
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  try {
    const hooksDir = path.dirname(fileURLToPath(import.meta.url));
    const serverLib = path.join(hooksDir, '..', 'server', 'lib');

    // pathToFileURL is required on Windows: bare D:\... paths are rejected by the ESM loader.
    const { getPaths } = await import(pathToFileURL(path.join(serverLib, 'paths.js')).href);
    const { dueForRun } = await import(pathToFileURL(path.join(serverLib, 'synth-core.js')).href);

    const P = getPaths();
    const watermarkFile = path.join(P.stateDir, 'learning', 'synth-watermark.json');

    // Read last run time from watermark
    let lastRunMs = null;
    try {
      const raw = fs.readFileSync(watermarkFile, 'utf-8');
      const obj = JSON.parse(raw);
      if (typeof obj.lastRunMs === 'number') lastRunMs = obj.lastRunMs;
    } catch {
      // No watermark yet — treat as never run
    }

    if (!dueForRun(lastRunMs, Date.now())) {
      process.exit(0);
    }

    // Spawn the synthesizer detached so it never delays session start.
    // The script owns writing the watermark; we do NOT write it here.
    const synthScript = path.join(hooksDir, '..', 'scripts', 'capability-synth.mjs');
    const child = spawn(process.execPath, [synthScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // fail-open: hook bugs must never trap the user
  }

  process.exit(0);
}
