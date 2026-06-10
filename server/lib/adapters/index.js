// server/lib/adapters/index.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as claudeCode from './claude-code.js';
import * as antigravity from './antigravity.js';
import * as geminiCli from './gemini-cli.js';
import * as copilotChat from './copilot-chat.js';
import * as codexCli from './codex-cli.js';
import * as openclaw from './openclaw.js';
import * as hermes from './hermes.js';
import * as agyCli from './agy-cli.js';
import * as opencode from './opencode.js';
import * as cline from './cline.js';

export const adapters = [claudeCode, antigravity, geminiCli, copilotChat, codexCli, openclaw, hermes, agyCli, opencode, cline];

const HOME = os.homedir();
const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');

/**
 * Detect-only tools — no discover/extract, just presence detection.
 * Each entry: { id, displayName, dataDirs: string[] }
 */
const DETECT_ONLY = [
  {
    id: 'cursor',
    displayName: 'Cursor',
    dataDirs: [path.join(appData, 'Cursor'), path.join(HOME, '.cursor')],
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    dataDirs: [path.join(appData, 'Windsurf'), path.join(HOME, '.windsurf')],
  },
  {
    id: 'aider',
    displayName: 'Aider',
    dataDirs: [path.join(HOME, '.aider')],
  },
  {
    id: 'continue',
    displayName: 'Continue',
    dataDirs: [path.join(HOME, '.continue')],
  },
  {
    id: 'zed',
    displayName: 'Zed',
    dataDirs: [path.join(appData, 'Zed'), path.join(localAppData, 'Zed')],
  },
  {
    id: 'copilot-cli',
    displayName: 'GitHub Copilot CLI',
    dataDirs: [path.join(HOME, '.copilot')],
  },
];

function dirExists(d) {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

/**
 * Run detect() on every adapter and return a summary array.
 * Also includes detect-only entries (depth:'detect-only').
 * @param {object} P - getPaths() result
 * @returns {{ id, displayName, installed, dataDirs, depth }[]}
 */
export function detectAll(P) {
  const deep = adapters.map(a => {
    const { installed, dataDirs } = a.detect(P);
    return { id: a.id, displayName: a.displayName, installed, dataDirs, depth: 'deep' };
  });

  const detectOnly = DETECT_ONLY.map(entry => {
    const installed = entry.dataDirs.some(dirExists);
    return { id: entry.id, displayName: entry.displayName, installed, dataDirs: entry.dataDirs, depth: 'detect-only' };
  });

  return [...deep, ...detectOnly];
}
