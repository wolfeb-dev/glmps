#!/usr/bin/env node
// Stop hook: the "definition of done" gate. When the working tree is dirty, run the repo's
// frozen acceptance.md contract commands; block the stop (exit 2) while they fail so the agent
// keeps working instead of self-declaring done. Mirrors hooks/capability-reminder.js: all logic
// is in pure, tested functions; the CLI entry holds the I/O and always fails open on error.
//
// Stdin: Claude Code Stop-hook JSON { cwd, stop_hook_active, session_id }.
// Exit 0 = allow the stop; exit 2 + stderr = block and feed the reason back to the agent.

const BLOCK_CAP = 3;

// Parse the YAML-frontmatter `commands:` list out of an acceptance.md string. Zero-dep: read the
// block between the first two '---' fences, collect `- item` lines under a `commands:` key.
// Returns { commands: string[] } or null (no frontmatter / no commands / bad input).
export function parseAcceptance(md) {
  if (typeof md !== 'string') return null;
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = [];
  let inCommands = false;
  for (const line of m[1].split('\n')) {
    if (/^commands:\s*$/.test(line)) { inCommands = true; continue; }
    if (inCommands) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) { out.push(item[1]); continue; }
      if (/^\S/.test(line)) break; // a following top-level key ends the list
    }
  }
  return out.length ? { commands: out } : null;
}

// Pure decision. Called in two passes by the CLI: first without runResult (returns needsRun:true
// when the commands should run), then again with the populated runResult for the final verdict.
// `stop_hook_active === false` marks a fresh end-of-turn, which resets the consecutive-block count.
export function decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount, runResult }) {
  const count = stopHookActive ? (blockCount || 0) : 0; // fresh turn resets the cap counter
  if (!contract) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0 };
  if (skip) return { action: 'allow', reason: 'done-gate: skipped (bypassed)', needsRun: false, nextBlockCount: 0, skipped: true };
  if (!dirty) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0 };
  if (runResult === undefined) return { action: 'pending', needsRun: true, nextBlockCount: count };
  if (runResult.ok) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0, result: 'pass' };
  if (count < BLOCK_CAP) {
    const reason = `done-gate: blocked - \`${runResult.failedCommand}\` failed. Fix it before stopping.\n${runResult.tail || ''}`;
    return { action: 'block', reason, needsRun: false, nextBlockCount: count + 1, result: 'block' };
  }
  return {
    action: 'allow',
    reason: `done-gate: yielding after ${BLOCK_CAP} blocks; \`${runResult.failedCommand}\` still failing`,
    needsRun: false, nextBlockCount: 0, result: 'yield',
  };
}

// Pure: parse raw `git status --porcelain` text + cwd -> string[] of absolute paths.
// No fs/git/process — only string ops + path.join.
export function parsePorcelain(porcelainText, cwd) {
  if (typeof porcelainText !== 'string') return [];
  const paths = [];
  for (const line of porcelainText.split('\n')) {
    if (!line.trim()) continue;
    // porcelain v1: 2 status chars + 1 space, then path (or "old -> new" for renames)
    const rest = line.slice(3);
    const arrow = rest.lastIndexOf(' -> ');
    const rel = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim().replace(/^"|"$/g, '');
    if (rel) paths.push(path.join(cwd, rel));
  }
  return paths;
}

// --- CLI entry (I/O only; never imported by tests) ---

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideScopeGuard } from '../server/lib/scope-guard.js';
import { DEFAULT_ZONE_CONFIG, mergeProtectedRoots } from '../server/lib/zones.js';

function doneGateDir() {
  if (process.env.GLMPS_DONE_GATE_DIR) return process.env.GLMPS_DONE_GATE_DIR;
  const stateDir = process.env.GLMPS_STATE_DIR || path.join(os.homedir(), '.glmps');
  return path.join(stateDir, 'done-gate');
}
function readContract(cwd) {
  try { return parseAcceptance(fs.readFileSync(path.join(cwd, 'acceptance.md'), 'utf8')); }
  catch { return null; }
}
// Opt-in, config-driven prod roots: read prodRoots[] from the gitignored
// config.json at the repo root (one level above hooks/). Absent in a fresh or
// public install -> [] -> the scope-guard stays inert. Mirrors the
// backtestProjects pattern in hooks/capability-feed.js. Exported for tests.
export function readProdRoots(hooksDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(hooksDir, '..', 'config.json'), 'utf8'));
    return Array.isArray(cfg.prodRoots) ? cfg.prodRoots.filter(r => typeof r === 'string' && r) : [];
  } catch { return []; }
}
function skipPresent(cwd) {
  if ((process.env.GLMPS_DONE_GATE || '').toLowerCase() === 'off') return true;
  try { return fs.existsSync(path.join(cwd, 'done.skip')); } catch { return false; }
}
function isDirty(cwd) {
  try { return execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim().length > 0; }
  catch { return false; } // git missing / not a repo -> do not gate
}
// Return absolute paths of all changed files from git status. Fail-open to [].
function changedPaths(cwd) {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
    return parsePorcelain(out, cwd);
  } catch { return []; } // not a git repo or git unavailable
}
// A prod.allow file in cwd allows the scope-guard to be bypassed.
function prodAllowPresent(cwd) {
  try { return fs.existsSync(path.join(cwd, 'prod.allow')); } catch { return false; }
}
function readCount(dir, sid) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'counter.json'), 'utf8'))[sid] || 0; }
  catch { return 0; }
}
function writeCount(dir, sid, n) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'counter.json');
    let m = {}; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    m[sid] = n; fs.writeFileSync(f, JSON.stringify(m));
  } catch {}
}
function runCommands(commands, cwd) {
  for (const cmd of commands) {
    try { execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      const tail = `${e.stdout || ''}${e.stderr || ''}`.slice(-1500);
      return { ok: false, failedCommand: cmd, tail };
    }
  }
  return { ok: true };
}
function appendResult(dir, sid, result, failedCommand) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), result, failedCommand: failedCommand || null, sessionId: sid }) + '\n';
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), line);
  } catch {}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const inp = JSON.parse(raw || '{}');
      const cwd = inp.cwd || process.cwd();
      const sid = inp.session_id || 'unknown';
      const dir = doneGateDir();
      const contract = readContract(cwd);
      const skip = skipPresent(cwd);
      const dirty = isDirty(cwd);

      // --- Scope-guard: block the stop if protected-zone files were edited ---
      // Load zone config from GLMPS_ZONE_CONFIG env JSON; fall back to DEFAULT silently.
      let zoneConfig = DEFAULT_ZONE_CONFIG;
      try {
        if (process.env.GLMPS_ZONE_CONFIG) zoneConfig = JSON.parse(process.env.GLMPS_ZONE_CONFIG);
      } catch { /* bad JSON in env -> use default, never throw */ }
      // Fold opt-in, config-driven prod roots (e.g. the live trading install,
      // D:/glmps_prod) into protectedRoots so they trip the scope-guard at Stop.
      // Default empty -> inert on a fresh/public install.
      zoneConfig = mergeProtectedRoots(zoneConfig, readProdRoots(path.dirname(fileURLToPath(import.meta.url))));

      const override = skip || prodAllowPresent(cwd); // skip already covers done.skip + GLMPS_DONE_GATE=off
      const sg = decideScopeGuard({
        changedPaths: changedPaths(cwd),
        projectRoot: cwd,
        config: zoneConfig,
        override,
        contract,
      });
      if (sg.action === 'block') { process.stderr.write(sg.reason + '\n'); process.exit(2); }
      // --- end scope-guard ---

      const blockCount = readCount(dir, sid);
      const stopHookActive = !!inp.stop_hook_active;
      const d1 = decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount });
      if (d1.skipped) { appendResult(dir, sid, 'skipped'); process.exit(0); }
      if (!d1.needsRun) { process.exit(0); }
      const runResult = runCommands(contract.commands, cwd);
      const d2 = decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount, runResult });
      writeCount(dir, sid, d2.nextBlockCount);
      appendResult(dir, sid, d2.result, runResult.failedCommand);
      if (d2.action === 'block') { process.stderr.write(d2.reason + '\n'); process.exit(2); }
      process.exit(0);
    } catch { process.exit(0); } // fail open: a hook bug must never trap the user
  });
  process.stdin.on('error', () => process.exit(0));
}
