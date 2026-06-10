import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const requestsFile = path.join(os.homedir(), '.glmps', 'requests', 'resume.jsonl');

function cfg<T>(key: string): T { return vscode.workspace.getConfiguration('missionControl').get(key) as T; }

function healthy(port: number): Promise<boolean> {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      x => { x.resume(); res(x.statusCode === 200); });
    r.on('error', () => res(false));
    r.on('timeout', () => { r.destroy(); res(false); });
  });
}

async function ensureServer(): Promise<boolean> {
  const port = cfg<number>('port');
  if (await healthy(port)) return true;
  const serverPath = cfg<string>('serverPath');
  try {
    spawn(process.execPath, [serverPath], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* fall through to health re-check */ }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await healthy(port)) return true;
  }
  vscode.window.showWarningMessage('GLMPS server did not start — check missionControl.serverPath.');
  return false;
}

function drainRequests(): void {
  let lines: string[] = [];
  try { lines = fs.readFileSync(requestsFile, 'utf-8').split('\n').filter(Boolean); } catch { return; }
  if (!lines.length) return;
  try { fs.writeFileSync(requestsFile, ''); } catch { return; } // claim them
  for (const line of lines) {
    let req: any; try { req = JSON.parse(line); } catch { continue; }
    if (!req) continue;

    // New-terminal launcher: run an explicit command (or none) in a fresh terminal.
    if (req.type === 'terminal' || (typeof req.command === 'string' && !req.sessionId)) {
      const cmd = typeof req.command === 'string' ? req.command : '';
      const cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : undefined;
      const opts: vscode.TerminalOptions = {
        name: cmd ? `mc: ${cmd.split(' ')[0]}` : 'mc terminal',
        cwd,
      };
      if ((req.location ?? 'editor') === 'editor' && 'Editor' in vscode.TerminalLocation) {
        (opts as any).location = vscode.TerminalLocation.Editor;
      }
      const term = vscode.window.createTerminal(opts);
      term.show();
      if (cmd) term.sendText(cmd);
      continue;
    }

    // Resume an existing session.
    if (typeof req.sessionId !== 'string' || req.location === 'workspace') continue;
    const sid = req.sessionId.replace(/[^a-zA-Z0-9-]/g, '');
    if (!sid) continue;
    const opts: vscode.TerminalOptions = {
      name: `claude resume ${sid.slice(0, 8)}`,
      cwd: typeof req.cwd === 'string' && req.cwd ? req.cwd : undefined,
    };
    if (req.location === 'editor' && 'Editor' in vscode.TerminalLocation) {
      (opts as any).location = vscode.TerminalLocation.Editor;
    }
    const term = vscode.window.createTerminal(opts);
    term.show();
    term.sendText(`claude --resume ${sid}`);
  }
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.text = '$(radio-tower) GLMPS';
  item.tooltip = 'Open the GLMPS dashboard';
  item.command = 'missionControl.open';
  item.show();
  ctx.subscriptions.push(item,
    vscode.commands.registerCommand('missionControl.open', async () => {
      await ensureServer();
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${cfg<number>('port')}`));
    }));
  if (cfg<boolean>('autoStart')) { void ensureServer(); }
  drainRequests(); // anything queued while Antigravity was closed
  try {
    fs.mkdirSync(path.dirname(requestsFile), { recursive: true });
    const watcher = fs.watch(path.dirname(requestsFile), () => drainRequests());
    ctx.subscriptions.push({ dispose: () => watcher.close() });
  } catch { /* requests dir unavailable; command + status bar still work */ }
}

export function deactivate(): void {}
