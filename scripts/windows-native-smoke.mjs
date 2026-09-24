// Run with Electron (not ELECTRON_RUN_AS_NODE) on an isolated Windows runner.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { TerminalService } from '../desktop/services/terminal.mjs';
import { ProviderCLIService } from '../desktop/services/provider-cli.mjs';
import { DEFAULT_GENERAL_SETTINGS } from '../core/general-settings.mjs';
import { SecureStore } from '../core/secure-store.mjs';
import { loadDesktopDataKey } from '../desktop/services/data-key.mjs';

assert.equal(process.platform, 'win32', 'This smoke test must run on native Windows');
assert.ok(process.env.RPO_DATA_DIR, 'An isolated data directory is required');
const artifacts = resolve('ci-evidence');
mkdirSync(artifacts, { recursive: true });
const evidence = { platform: process.platform, arch: process.arch, versions: process.versions, checks: [] };
const writeEvidence = () => writeFileSync(join(artifacts, 'windows-native.json'), JSON.stringify(evidence, null, 2));
let terminal, providerTerminal, providerFixtureDir, output = '', providerOutput = '';
const deadline = setTimeout(() => fail(Error('Windows desktop smoke timed out after 120 seconds')), 120000);
function fail(error) {
  evidence.error = error.stack || String(error);
  evidence.ptyOutput = output;
  evidence.providerCLIOutput = providerOutput;
  evidence.providerCLIProcesses = [...(providerTerminal?.terminals.values() || [])].map(record=>({pid:record.process.pid,exited:record.exited,exitCode:record.exitCode}));
  writeEvidence(); console.error(error);
  terminal?.closeAll(); providerTerminal?.closeAll();
  if (providerFixtureDir) try { rmSync(providerFixtureDir, {recursive:true,force:true,maxRetries:2,retryDelay:50}); } catch {}
  app.exit(1);
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
async function run() {
try {
  evidence.stage = 'import-desktop'; writeEvidence();
  // Import the actual app entry: safeStorage, local Hub, IPC, preload and React UI all start.
  await import('../desktop/main.mjs');
  evidence.stage = 'electron-ready'; writeEvidence();
  await app.whenReady();
  evidence.stage = 'renderer'; writeEvidence();
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

  evidence.stage = 'general-preferences'; writeEvidence();
  const invoke = (method, args = {}) => win.webContents.executeJavaScript(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
  const initialPreferences = await invoke('settings.general.get');
  const preferences = {...DEFAULT_GENERAL_SETTINGS,layout:'editor',conversationDensity:'compact',autoHideEmptyEditor:false,
    autoCheckUpdates:false,notificationsEnabled:false,completionSound:false,trayIcon:false};
  assert.deepEqual(await invoke('settings.general.save',{settings:preferences}),preferences);
  assert.deepEqual((await invoke('bootstrap')).local.generalSettings,preferences,'Actual main bootstrap must publish the saved preferences');
  const dataKey = loadDesktopDataKey({safeStorage,keyFile:join(process.env.RPO_DATA_DIR,'data-key.json'),dataDir:process.env.RPO_DATA_DIR});
  const settingsReader = new SecureStore({dir:process.env.RPO_DATA_DIR,key:dataKey});
  dataKey.fill(0);
  try {
    assert.deepEqual(settingsReader.readJSON('client.json').generalSettings,preferences,'A newly opened encrypted store must read the exact persisted preferences');
  } finally { settingsReader.key.fill(0); }
  const encryptedPreferences = readFileSync(join(process.env.RPO_DATA_DIR,'client.json.enc'));
  await assert.rejects(invoke('settings.general.save',{settings:{...preferences,trayIcon:'true'}}),/通用设置值无效/);
  assert.deepEqual(await invoke('settings.general.get'),preferences);
  assert.deepEqual(readFileSync(join(process.env.RPO_DATA_DIR,'client.json.enc')),encryptedPreferences,'Rejected preferences must leave encrypted disk data unchanged');
  // Only idle synthetic records: no vendor command, model request, terminal or OS notification.
  const fixtureWorkspace = await invoke('workspace.create',{name:'Windows 偏好 fixture'});
  const fixtureSession = await invoke('session.create',{workspaceId:fixtureWorkspace.id,title:'Windows 布局 fixture'});
  await invoke('lane.create',{workspaceId:fixtureWorkspace.id,sessionId:fixtureSession.id,provider:'codex'});
  await waitFor(()=>win.webContents.executeJavaScript(`!![...document.querySelectorAll('.mini-session')].find(button=>button.textContent===${JSON.stringify(fixtureSession.title)})`));
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.mini-session')].find(button=>button.textContent===${JSON.stringify(fixtureSession.title)}).click()`);
  await waitFor(()=>win.webContents.executeJavaScript(`!!document.querySelector('.studio.layout-editor:not(.empty-editor-hidden)') && !!document.querySelector('.agent-lane.density-compact')`));
  const editorLayout = await win.webContents.executeJavaScript(`({editor:document.querySelector('.editor-pane').getBoundingClientRect().height,dock:document.querySelector('.agent-dock').getBoundingClientRect().height})`);
  assert.ok(editorLayout.editor>editorLayout.dock,'Actual renderer CSS must allocate more height to the editor');
  await invoke('settings.general.save',{settings:{...preferences,layout:'agent',conversationDensity:'detailed',autoHideEmptyEditor:true}});
  await waitFor(()=>win.webContents.executeJavaScript(`!!document.querySelector('.studio.layout-agent.empty-editor-hidden') && !!document.querySelector('.agent-lane.density-detailed') && document.querySelector('.editor-pane').getBoundingClientRect().height===0`));
  evidence.generalPreferences = {saved:preferences,encryptedStoreReopened:true,rejectedWriteUnchanged:true,editorLayout,liveLayoutAndDensity:true,emptyEditorHidden:true,osNotificationsTriggered:false};
  writeFileSync(join(artifacts,'windows-general-preferences.png'),(await win.webContents.capturePage()).toPNG());
  // Restore initial settings while keeping OS side effects disabled for this isolated probe.
  await invoke('settings.general.save',{settings:{...initialPreferences,notificationsEnabled:false,completionSound:false,trayIcon:false}});
  evidence.checks.push('General preferences: actual main/preload get/save/bootstrap, safeStorage encrypted persistence, invalid-write rollback and live React layout/density/empty-editor CSS');

  evidence.stage = 'powershell-pty'; writeEvidence();
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

  evidence.stage = 'provider-cli-conpty'; writeEvidence();
  providerFixtureDir = mkdtempSync(join(process.env.RPO_DATA_DIR, 'provider-cli-'));
  const cliCwd = join(providerFixtureDir, '中文 空格 CLI');
  mkdirSync(cliCwd);
  const cliFixture = join(providerFixtureDir, '独立 CLI fixture.mjs');
  const reportPath = join(cliCwd, 'started.json'), inputPath = join(cliCwd, 'input.bin');
  // Electron's GUI executable is not a reliable console target under ConPTY even
  // with ELECTRON_RUN_AS_NODE. Use the real setup-node console binary, located
  // by executing a fixed metadata probe without a shell or interpolated command.
  const cliEnv = {...process.env}; delete cliEnv.ELECTRON_RUN_AS_NODE;
  const nodeProbe = JSON.parse(execFileSync('node.exe', ['-p', 'JSON.stringify({executable:process.execPath,version:process.version,electron:!!process.versions.electron})'], {
    env:cliEnv,encoding:'utf8',timeout:10000,windowsHide:true,
  }));
  assert.equal(nodeProbe.electron,false,'The CLI fixture must use real Node, not Electron GUI');
  assert.ok(isAbsolute(nodeProbe.executable));
  assert.equal(basename(nodeProbe.executable).toLowerCase(),'node.exe');
  const cliNode=realpathSync(nodeProbe.executable),pe=readFileSync(cliNode);
  assert.equal(pe.toString('ascii',0,2),'MZ');
  const peOffset=pe.readUInt32LE(0x3c);
  assert.equal(pe.readUInt32LE(peOffset),0x4550,'The Node fixture launcher must be a PE executable');
  const subsystem=pe.readUInt16LE(peOffset+24+68);
  assert.equal(subsystem,3,'The Node fixture launcher must use the Windows console subsystem');
  evidence.providerCLIRuntime={command:cliNode,version:nodeProbe.version,peSubsystem:subsystem};writeEvidence();
  // Only this synthetic Node peer runs here: no vendor CLI, account probe,
  // prompt, server, token or paid model is used by this check.
  writeFileSync(cliFixture, `
import {writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
process.stdin.setRawMode(true);process.stdin.resume();
const input=join(process.cwd(),'input.bin');
writeFileSync(input,Buffer.alloc(0));
writeFileSync(join(process.cwd(),'started.json'),JSON.stringify({
  argv:process.argv.slice(2),cwd:process.cwd(),pid:process.pid,
  stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY
}));
process.stdout.write('RPO_CLI_READY\\r\\n');
let received=Buffer.alloc(0);
process.stdin.on('data',data=>{
  appendFileSync(input,data);received=Buffer.concat([received,data]);
  if(received.includes(Buffer.from('RPO_EXIT')))process.exit(9);
});
`, 'utf8');
  const cliArgs = ['中文 参数', 'space name', 'double"quote', "single'quote", 'trailing\\', '& echo NOT_EXECUTED', '$(NOT_EXECUTED)'];
  const cliState = { identity:{audience:'windows-conpty-fixture'}, me:{id:'fixture-member',roles:{fixture:'editor'}}, sessions:[{
    id:'fixture-session',workspaceId:'fixture',lanes:[{id:'fixture-lane',ownerId:'fixture-member',provider:'codex'}]
  }] };
  const cliContext = {workspaceId:'fixture',sessionId:'fixture-session',laneId:'fixture-lane',cols:120,rows:30};
  providerTerminal = new TerminalService();
  providerTerminal.on('event', (_owner,event) => { if(event.type==='data')providerOutput += event.data; });
  let cliLaunches = 0;
  const providerCLI = new ProviderCLIService({
    terminals:providerTerminal,state:()=>cliState,root:()=>cliCwd,
    accounts:()=>[{id:'codex',authenticated:false,label:'Synthetic fixture — no vendor account'}],
    env:()=>({...cliEnv}),
    resolveCommand:async()=>{cliLaunches++;return {command:cliNode,args:[cliFixture,...cliArgs],resolvedCommand:cliNode,launcher:'synthetic-console-node'};}
  });
  const cliOwner = 402;
  const [cliOpened,cliDuplicate] = await Promise.all([providerCLI.open(cliOwner,cliContext),providerCLI.open(cliOwner,cliContext)]);
  assert.equal(cliOpened.id,cliDuplicate.id,'Concurrent Provider CLI opens must share one PTY');
  assert.equal(cliLaunches,1,'Duplicate opens must not start another CLI');
  const cliId=cliOpened.id;
  let report;
  await waitFor(()=>{
    const current=providerTerminal.read(cliOwner,{id:cliId});
    if(current.exited)throw Error(`Provider CLI fixture exited before readiness: ${current.exitCode}; output: ${clean(current.data)}`);
    try { report=JSON.parse(readFileSync(reportPath,'utf8'));return clean(providerOutput).includes('RPO_CLI_READY'); } catch { return false; }
  });
  assert.equal(report.stdinTTY,true);assert.equal(report.stdoutTTY,true);
  assert.deepEqual(report.argv,cliArgs,'Windows quoting must preserve the exact Unicode/space/quote/metacharacter argv');
  assert.equal(realpathSync(report.cwd),realpathSync(cliCwd));
  assert.equal(cliOpened.contextId,cliContext.laneId);
  assert.equal(cliOpened.cli.command,cliNode);
  await assert.rejects(providerCLI.open(cliOwner,{...cliContext,laneId:'not-owned'}),/本人/);
  assert.throws(()=>providerTerminal.input(cliOwner+1,{id:cliId,data:'RPO_EXIT'}),/无权/);
  evidence.checks.push('A8 Provider CLI: real Windows ConPTY, verified console node.exe fixture, exact Unicode/space/quote argv and canonical cwd, owner/lane fencing');

  providerTerminal.input(cliOwner,{id:cliId,data:'\x1b[Z'});
  await waitFor(()=>readFileSync(inputPath).length>=3);
  assert.equal(readFileSync(inputPath).toString('hex'),'1b5b5a','Shift+Tab must reach the CLI as raw ESC [ Z bytes');
  assert.equal((await providerCLI.open(cliOwner,cliContext)).id,cliId);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(cliLaunches,1);
  assert.equal(readFileSync(inputPath).toString('hex'),'1b5b5a','Reopening must never replay historical input');
  evidence.checks.push('A8 Provider CLI: Shift+Tab raw bytes, concurrent/repeated open idempotency and zero history replay');

  providerTerminal.input(cliOwner,{id:cliId,data:'RPO_EXIT'});
  await waitFor(()=>providerTerminal.read(cliOwner,{id:cliId}).exited);
  assert.equal(providerTerminal.read(cliOwner,{id:cliId}).exitCode,9);
  assert.equal((await providerCLI.open(cliOwner,cliContext)).id,cliId,'An exited CLI must not restart implicitly');
  assert.equal(cliLaunches,1);
  providerTerminal.close(cliOwner,{id:cliId});
  const freshCLI=await providerCLI.open(cliOwner,cliContext);
  await waitFor(()=>clean(providerTerminal.read(cliOwner,{id:freshCLI.id}).data).includes('RPO_CLI_READY'));
  const freshPid=JSON.parse(readFileSync(reportPath,'utf8')).pid;
  assert.ok(Number.isInteger(freshPid)&&freshPid>0&&freshPid!==process.pid);
  providerCLI.closeAll();
  // Only signal-probe the pid reported by our own temporary fixture.
  await waitFor(()=>{try{process.kill(freshPid,0);return false;}catch(error){return error.code==='ESRCH';}});
  assert.equal(providerTerminal.terminals.size,0);
  assert.equal(cliLaunches,2);
  evidence.checks.push('A8 Provider CLI: actual exit code, no implicit restart, explicit fresh launch and process/PTY cleanup');
  evidence.providerCLI={synthetic:true,modelCalls:0,launches:cliLaunches,argv:cliArgs,shiftTabHex:'1b5b5a',exitCode:9,cleanup:true};
  evidence.providerCLIOutput=clean(providerOutput);
  rmSync(providerFixtureDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});providerFixtureDir=null;
  evidence.completedAt = new Date().toISOString();
  writeEvidence();
  // Exercise the actual app before-quit async cleanup, not a synthetic app.exit success.
  app.once('will-quit', () => { clearTimeout(deadline); console.log('WINDOWS_NATIVE_SMOKE_OK'); });
  app.quit();
} catch (error) { fail(error); }

}
// Do not top-level-await app.whenReady: Electron waits for its ESM entry to finish before ready.
void run();
