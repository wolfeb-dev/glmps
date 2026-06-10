// server/lib/learning-apply.js
// Deterministic guard applier (injectable git + fs), idea-hand request building,
// companion request enqueueing, and result ingestion.
// Zero runtime dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { insertGuard } from './learning-templates.js';

// ---------------------------------------------------------------------------
// applyGuard({ assetsDir, file, section, rule, message, runGit, readFile, writeFile })
//   -> { commit, changed }
//
// Reads <assetsDir>/<file>, calls insertGuard, writes back if changed, then
// git-adds and git-commits via runGit.  Returns the HEAD sha regardless.
//
// Defaults:
//   readFile(absPath)        - node:fs readFileSync with utf-8
//   writeFile(absPath, data) - node:fs writeFileSync
//   runGit(args)             - spawnSync('git', ['-C', assetsDir, ...args]) stdout trimmed
// ---------------------------------------------------------------------------

export function applyGuard({
  assetsDir,
  file,
  section,
  rule,
  message,
  runGit,
  readFile,
  writeFile,
} = {}) {
  // Build defaults when not injected.
  const absPath = path.join(assetsDir, file);

  const _readFile = readFile ?? ((p) => {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return '';
      throw e;
    }
  });

  const _writeFile = writeFile ?? ((p, data) => fs.writeFileSync(p, data, 'utf-8'));

  const _runGit = runGit ?? ((args) => {
    const result = spawnSync('git', ['-C', assetsDir, ...args], { encoding: 'utf8' });
    // Surface git failures instead of silently marking a bad apply "applied":
    // a non-zero exit (not a repo, nothing staged, identity unset, hook reject)
    // must throw so the route marks the item failed with a real reason.
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
    return (result.stdout ?? '').trim();
  });

  // Read the current file content (treat missing as empty string).
  const current = _readFile(absPath);

  // Determine whether the rule needs to be inserted.
  const { content, changed } = insertGuard(current, section, rule);

  if (changed) {
    _writeFile(absPath, content);
    _runGit(['add', file]);
    _runGit(['commit', '-m', message]);
  }

  // Always return HEAD sha.
  const commit = _runGit(['rev-parse', 'HEAD']);
  return { commit, changed };
}

// ---------------------------------------------------------------------------
// buildIdeaApplyCommand(id, assetsDir, paths) -> string
//
// Builds a single-line `claude -p "..."` command instructing the headless
// hand to:
//   1. Read the request JSON at paths.requestPath.
//   2. Compose one concise guard line capturing its idea.
//   3. Append it under '## Learned guards' in <assetsDir>/CLAUDE.global.md.
//   4. git add + commit.
//   5. Write paths.resultPath as JSON { status:'applied', commit, ruleText }.
//
// Embedded double-quotes are escaped as \" so the command is shell-safe.
// ---------------------------------------------------------------------------

export function buildIdeaApplyCommand(id, assetsDir, paths) {
  // Keep the instruction text free of double-quotes: the companion runs this via
  // term.sendText in whatever shell the user's terminal uses (PowerShell on
  // Windows), where backslash-quote escaping is not portable.
  const instructions = [
    `You are applying a learning-loop idea (id: ${id}).`,
    `1. Read the request JSON at ${paths.requestPath}.`,
    `2. Compose ONE concise guard line (start it with a dash and a space) that captures the idea as a behavioral rule.`,
    `3. Append that rule under the Learned guards section (a markdown heading made of two hashes, a space, then Learned guards) of ${assetsDir}/CLAUDE.global.md, creating the section if absent.`,
    `4. Run: git -C ${assetsDir} add CLAUDE.global.md ; git -C ${assetsDir} commit -m learning-apply-${id}`,
    `5. Write ${paths.resultPath} as JSON with three fields: status set to applied, commit set to the new HEAD sha from git -C ${assetsDir} rev-parse HEAD, and ruleText set to the guard line you composed.`,
    `Do not ask questions. Complete all steps silently.`,
  ].join(' ');

  const escaped = instructions.replace(/"/g, '\\"'); // belt-and-suspenders; text above has none
  return `claude -p "${escaped}"`;
}

// ---------------------------------------------------------------------------
// enqueueIdeaApply({ requestsFile, command, cwd })
//
// Appends one JSONL record { type:'terminal', command, cwd } to requestsFile.
// Creates parent directories if they don't exist.
// ---------------------------------------------------------------------------

export function enqueueIdeaApply({ requestsFile, command, cwd }) {
  const dir = path.dirname(requestsFile);
  fs.mkdirSync(dir, { recursive: true });
  const record = JSON.stringify({ type: 'terminal', command, cwd });
  fs.appendFileSync(requestsFile, record + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// ingestResults(stateDir) -> [{ id, ...parsed }]
//
// Reads <stateDir>/learning/results/*.json, returns an array of parsed
// objects with `id` set to the filename without the .json extension.
// Deletes each file after reading.  Returns [] if the directory is absent.
// ---------------------------------------------------------------------------

export function ingestResults(stateDir) {
  const resultsDir = path.join(stateDir, 'learning', 'results');

  let entries;
  try {
    entries = fs.readdirSync(resultsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(resultsDir, entry);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // Skip malformed files but still delete them.
      fs.unlinkSync(filePath);
      continue;
    }
    const id = entry.slice(0, -'.json'.length);
    results.push({ id, ...parsed });
    fs.unlinkSync(filePath);
  }

  return results;
}
