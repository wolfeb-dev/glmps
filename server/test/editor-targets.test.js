import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as et from '../lib/editor-targets.js';

test('resolveTarget order: item.target > lastTarget > running > native fallback', () => {
  assert.equal(et.resolveTarget({ item: { target: 'cursor' }, lastTarget: 'vscode', running: ['windsurf'] }), 'cursor');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: 'vscode', running: ['windsurf'] }), 'vscode');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: null, running: ['windsurf'] }), 'windsurf');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: null, running: [] }), 'native-terminal');
});

test('resolveTarget ignores unknown ids', () => {
  assert.equal(et.resolveTarget({ item: { target: 'emacs' }, lastTarget: 'bogus', running: [] }), 'native-terminal');
});

test('seededCommand embeds the prompt-file path in a shell-safe instruction', () => {
  const c = et.seededCommand('claude', 'C:/Users/x/.glmps/runner/glmps-1.prompt.md');
  assert.match(c, /^claude "/);
  assert.match(c, /glmps-1\.prompt\.md/);
  assert.ok(!c.includes('\n'));                       // single line
  assert.equal((c.match(/"/g) || []).length, 2);      // exactly one quoted arg, no nested quotes
});

test('taskInstruction names the file and carries no quotes/newlines', () => {
  const i = et.taskInstruction('/x/glmps-1.prompt.md');
  assert.match(i, /glmps-1\.prompt\.md$/);
  assert.ok(!i.includes('"') && !i.includes('\n'));
});

test('nativeTerminalRecipe is platform-specific and includes cwd', () => {
  const win = et.nativeTerminalRecipe({ platform: 'win32', seededCmd: 'node seed -- claude', cwd: 'C:/repo' });
  assert.equal(win.options.cwd, 'C:/repo');
  assert.ok(Array.isArray(win.args));
  const mac = et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'node seed -- claude', cwd: '/repo' });
  assert.equal(mac.file, 'osascript');
  const lin = et.nativeTerminalRecipe({ platform: 'linux', seededCmd: 'node seed -- claude', cwd: '/repo' });
  assert.equal(lin.options.cwd, '/repo');
});

test('launchTargetFor downgrades a companion-less editor target to native-terminal (glmps-12)', () => {
  // VS Code family ships no companion yet (glmps-10) -> fall back so the session still opens.
  assert.equal(et.launchTargetFor('cursor', { agAlive: false, antigravityCommand: null }), 'native-terminal');
  assert.equal(et.launchTargetFor('vscode', {}), 'native-terminal');
  assert.equal(et.launchTargetFor('windsurf', { agAlive: true }), 'native-terminal'); // agAlive is Antigravity, not Windsurf
  // Antigravity is companion-backed when it is live OR we can launch it.
  assert.equal(et.launchTargetFor('antigravity', { agAlive: true, antigravityCommand: null }), 'antigravity');
  assert.equal(et.launchTargetFor('antigravity', { agAlive: false, antigravityCommand: 'antigravity' }), 'antigravity');
  // Antigravity with no live companion and no way to launch it -> fall back too.
  assert.equal(et.launchTargetFor('antigravity', { agAlive: false, antigravityCommand: null }), 'native-terminal');
  // native-terminal always passes through.
  assert.equal(et.launchTargetFor('native-terminal', {}), 'native-terminal');
});

test('companionRecord seeds an editor terminal request', () => {
  const r = et.companionRecord({ targetId: 'cursor', seededCmd: 'node seed -- claude', cwd: '/repo', now: 5 });
  assert.deepEqual(r, { type: 'terminal', target: 'cursor', command: 'node seed -- claude', cwd: '/repo', location: 'editor', ts: 5 });
});
