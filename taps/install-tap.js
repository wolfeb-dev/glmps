// taps/install-tap.js — run once: `node taps/install-tap.js` (or `--uninstall` to revert)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { buildSettingsPatch } from './statusline-chain-lib.js';

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const stateDir = path.join(os.homedir(), '.glmps', 'state');
const delegateFile = path.join(stateDir, 'statusline-delegate.json');
const chainPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'statusline-chain.js');

const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
fs.mkdirSync(stateDir, { recursive: true });

if (process.argv.includes('--uninstall')) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(delegateFile, 'utf-8')).command; }
  catch {
    console.error('No delegate record found at', delegateFile);
    console.error('Manual recovery: restore from', settingsFile + '.mc-backup');
    process.exit(1);
  }
  if (prev) {
    settings.statusLine = { type: 'command', ...(settings.statusLine ?? {}), command: prev };
  } else {
    delete settings.statusLine; // there was no statusline before install
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  console.log(prev ? `Restored statusline: ${prev}` : 'Removed statusline (none existed before install).');
} else {
  const { patched, previousCommand } = buildSettingsPatch(settings, chainPath);
  if (previousCommand?.includes('statusline-chain.js')) {
    console.log('Already installed.'); process.exit(0);
  }
  fs.copyFileSync(settingsFile, settingsFile + '.mc-backup');
  fs.writeFileSync(delegateFile, JSON.stringify({ command: previousCommand }));
  fs.writeFileSync(settingsFile, JSON.stringify(patched, null, 2));
  console.log('Installed. Previous command saved:', previousCommand);
}
