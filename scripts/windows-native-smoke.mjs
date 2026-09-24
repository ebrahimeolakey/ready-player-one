// Run with Electron (not ELECTRON_RUN_AS_NODE) on an isolated Windows runner.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { TerminalService } from '../desktop/services/terminal.mjs';

assert.equal(process.platform, 'win32', 'This smoke test must run on native Windows');
assert.ok(process.env.RPO_DATA_DIR, 'An isolated data directory is required');
const artifacts = resolve('ci-evidence');
mkdirSync(artifacts, { recursive: true });
const evidence = { platform: process.platform, arch: process.arch, versions: process.versions, checks: [] };
const writeEvidence = () => writeFileSync(join(artifacts, 'windows-native.json'), JSON.stringify(evidence, null, 2));
let terminal, output = ''; 
const deadline = setTimeout(() => fail(Error('Windows desktop smoke timed out after 120 seconds')), 120000);
function fail(error) {
  evidence.error = error.stack || String(error);
  evidence.ptyOutput = output;
  writeEvidence(); console.error(error);
  terminal?.closeAll(); app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
dialog.showErrorBox = (title, message) => fail(Error(`${title}: ${message}`));
const waitFor = async (predicate, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > until) throw Error('Timed out waiting for Windows runtime evidence');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const clean = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
try {
  // Import the actual app entry: safeStorage, local Hub, IPC, preload and React UI all start.
  await import('../desktop/main.mjs');
  await app.whenReady();
  let win;
  await waitFor(async () => {
    win = BrowserWindow.getAllWindows().find(window => window.getTitle().startsWith('头号玩家'));
    if (!win || win.webContents.isLoading()) return false;
    return win.webContents.executeJavaScript('!!document.querySelector("#root")?.children.length').catch(() => false);
  }, 45000);
  const renderer = await win.webContents.executeJavaScript('({text:document.body.innerText, buttons:document.querySelectorAll("button").length, node:typeof process, bridge:typeof window.rpo})');
  assert.ok(renderer.buttons > 3, 'The real React application must render interactive controls');
  assert.match(renderer.text, /头号玩家|工作区|项目|会话/);
  assert.equal(renderer.node, 'undefined', 'Renderer must not expose Node');
  assert.equal(renderer.bridge, 'object', 'Real preload IPC bridge must be available');
  evidence.renderer = renderer;
  evidence.checks.push('actual desktop entry, local Hub, encrypted settings and React render');
  writeFileSync(join(artifacts, 'windows-desktop.png'), (await win.webContents.capturePage()).toPNG());

  terminal = new TerminalService();
  let exit;
  terminal.on('event', (_owner, event) => {
    if (event.type === 'data') output += event.data;
    if (event.type === 'exit') exit = event;
  });
  const owner = 401;
  const { id } = await terminal.open(owner, { cwd: process.env.RPO_DATA_DIR, cols: 100, rows: 28 });
  assert.throws(() => terminal.input(owner + 1, { id, data: 'exit\r' }), /无权/);
  // Split strings prevent echoed command input from falsely satisfying output checks.
  terminal.input(owner, { id, data: "Write-Output ('RPO_' + 'PTY_OK'); Write-Output ('RPO_TTY_' + (-not [Console]::IsInputRedirected))\r" });
  await waitFor(() => clean(output).includes('RPO_PTY_OK') && clean(output).includes('RPO_TTY_True'));
  terminal.resize(owner, { id, cols: 109, rows: 37 });
  terminal.input(owner, { id, data: "Write-Output ('RPO_SIZE_' + $Host.UI.RawUI.WindowSize.Width + '_' + $Host.UI.RawUI.WindowSize.Height)\r" });
  await waitFor(() => clean(output).includes('RPO_SIZE_109_37'));
  terminal.input(owner, { id, data: 'Start-Sleep -Seconds 30\r' });
  await new Promise(resolve => setTimeout(resolve, 800));
  terminal.input(owner, { id, data: '\x03' });
  await new Promise(resolve => setTimeout(resolve, 200));
  terminal.input(owner, { id, data: "Write-Output ('RPO_' + 'INTERRUPTED')\r" });
  await waitFor(() => clean(output).includes('RPO_INTERRUPTED'));
  terminal.input(owner, { id, data: 'exit 7\r' });
  await waitFor(() => exit);
  assert.equal(exit.exitCode, 7);
  assert.equal(terminal.read(owner, { id }).exited, true);
  terminal.close(owner, { id });
  const second = await terminal.open(owner, { cwd: process.env.RPO_DATA_DIR });
  const pid = terminal.get(owner, second.id).process.pid;
  terminal.closeOwner(owner);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  assert.equal(terminal.terminals.size, 0);
  evidence.checks.push('Electron ABI loads native node-pty, real PowerShell input/output, console TTY, resize, Ctrl-C, exit code and owner process cleanup');
  evidence.ptyOutput = clean(output);
  evidence.completedAt = new Date().toISOString();
  writeEvidence();
  // Exercise the actual app before-quit async cleanup, not a synthetic app.exit success.
  app.once('will-quit', () => { clearTimeout(deadline); console.log('WINDOWS_NATIVE_SMOKE_OK'); });
  app.quit();
} catch (error) { fail(error); }
