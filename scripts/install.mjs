#!/usr/bin/env node
// scripts/install.mjs — one-command GLMPS installer.
//   node scripts/install.mjs              wire MC into Claude Code config
//   node scripts/install.mjs --uninstall  revert everything this installed
//
// Wires three things into the user's Claude Code config with absolute paths:
//   A) ensure repo-root config.json exists (copy from config.example.json)
//   B) statusline tap (mirrors taps/install-tap.js: backup + delegate record)
//   C) capability-reminder UserPromptSubmit hook (via buildHookPatch)
// Defensive throughout: never crashes on a missing optional file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { buildSettingsPatch } from '../taps/statusline-chain-lib.js';
import { buildHookPatch, removeHookPatch } from './install-lib.mjs';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);

const chainPath = path.join(repoRoot, 'taps', 'statusline-chain.js');
const hookPath = path.join(repoRoot, 'hooks', 'capability-reminder.js');
const hookCommand = `node "${hookPath}"`;
const HOOK_MARKER = 'capability-reminder.js';

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const stateDir = path.join(os.homedir(), '.glmps', 'state');
const delegateFile = path.join(stateDir, 'statusline-delegate.json');

const uninstall = process.argv.includes('--uninstall');

// --- helpers --------------------------------------------------------------

// Read settings.json, returning {} when it's absent or unparseable so a fresh
// machine installs cleanly instead of crashing.
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

// --- A) repo-root config.json --------------------------------------------

export function ensureConfig() {
  const configFile = path.join(repoRoot, 'config.json');
  const exampleFile = path.join(repoRoot, 'config.example.json');
  if (fs.existsSync(configFile)) {
    console.log('A) config.json: already exists, leaving as-is.');
    return;
  }
  if (!fs.existsSync(exampleFile)) {
    console.log('A) config.json: missing and no config.example.json to copy — skipped.');
    return;
  }
  fs.copyFileSync(exampleFile, configFile);
  console.log(`A) config.json: created from config.example.json.`);
}

// --- B) statusline tap (mirrors taps/install-tap.js) ----------------------

export function installStatusline() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    settings = {};
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const { patched, previousCommand } = buildSettingsPatch(settings, chainPath);
  if (previousCommand?.includes('statusline-chain.js')) {
    console.log('B) statusline tap: already installed.');
    return;
  }
  // Back up settings.json before the first write, like install-tap.js.
  if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, settingsFile + '.mc-backup');
  fs.writeFileSync(delegateFile, JSON.stringify({ command: previousCommand }));
  writeSettings(patched);
  console.log(`B) statusline tap: installed. Previous command saved: ${previousCommand}`);
}

function uninstallStatusline() {
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(delegateFile, 'utf-8')).command;
  } catch {
    console.log('B) statusline tap: no delegate record found — nothing to restore.');
    console.log(`   Manual recovery if needed: restore from ${settingsFile}.mc-backup`);
    return;
  }
  const settings = readSettings();
  if (prev) {
    settings.statusLine = { type: 'command', ...(settings.statusLine ?? {}), command: prev };
    writeSettings(settings);
    console.log(`B) statusline tap: restored previous command: ${prev}`);
  } else {
    delete settings.statusLine; // there was no statusline before install
    writeSettings(settings);
    console.log('B) statusline tap: removed (none existed before install).');
  }
}

// --- C) capability-reminder hook -----------------------------------------

export function installHook() {
  const settings = readSettings();
  const { patched, alreadyInstalled } = buildHookPatch(settings, hookCommand);
  if (alreadyInstalled) {
    console.log('C) capability-reminder hook: already installed.');
    return;
  }
  writeSettings(patched);
  console.log('C) capability-reminder hook: installed.');
}

function uninstallHook() {
  const settings = readSettings();
  const { patched, removed } = removeHookPatch(settings, HOOK_MARKER);
  if (!removed) {
    console.log('C) capability-reminder hook: not installed — nothing to remove.');
    return;
  }
  writeSettings(patched);
  console.log(`C) capability-reminder hook: removed (${removed}).`);
}

// --- run ------------------------------------------------------------------
// Guard: only execute when this file is run directly, not when imported.

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  if (uninstall) {
    console.log('GLMPS: uninstalling...');
    uninstallStatusline();
    uninstallHook();
    console.log('Done. (config.json left in place.)');
  } else {
    console.log(`GLMPS: installing (repo: ${repoRoot})...`);
    ensureConfig();
    installStatusline();
    installHook();
    console.log('Done. Run the dashboard with: node server/server.js');
  }
}
