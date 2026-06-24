// server/lib/runner-store.js
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = { enabled: false, maxConcurrent: 1, maxRuntimeMs: 1800000, maxRetries: 2, lastTarget: null, useWorktrees: false };

const dir = (stateDir) => path.join(stateDir, 'runner');
const configFile = (stateDir) => path.join(dir(stateDir), 'config.json');
const ledgerFile = (stateDir) => path.join(dir(stateDir), 'launched.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function loadConfig(stateDir) { return { ...DEFAULTS, ...readJson(configFile(stateDir), {}) }; }
export function saveConfig(stateDir, partial = {}) {
  const merged = { ...loadConfig(stateDir), ...partial };
  writeJson(configFile(stateDir), merged);
  return merged;
}
export function loadLedger(stateDir) { return readJson(ledgerFile(stateDir), {}); }
export function saveLedger(stateDir, ledger) { writeJson(ledgerFile(stateDir), ledger ?? {}); return ledger; }
export function writePrompt(stateDir, id, prompt) {
  const f = path.join(dir(stateDir), `${id}.prompt.md`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(prompt ?? ''));
  return path.resolve(f);
}
