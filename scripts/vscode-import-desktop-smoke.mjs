// Explicit --run opt-in. Real desktop/preload/IPC/encrypted storage, synthetic
// files and dialog selection result only; no real VS Code data or model calls.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rmdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const script=fileURLToPath(import.meta.url),root=dirname(dirname(script)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+20000;while(!await fn()){if(Date.now()>end)throw Error('Import desktop condition timed out');await sleep(50);}}
async function probe(){
 const {app,BrowserWindow,dialog}=await import('electron');const dir=process.env.RPO_DATA_DIR,evidenceDir=process.env.RPO_IMPORT_EVIDENCE_DIR,phase=process.env.RPO_IMPORT_SMOKE_PHASE;
 const evidence={phase,checks:[]};const fail=e=>{console.error(e);app.exit(1);};let choice={canceled:true,filePaths:[]},dialogs=0;
 dialog.showErrorBox=(title,message)=>fail(Error(title+': '+message));
 dialog.showOpenDialog=async(parent,options)=>{assert(parent instanceof BrowserWindow);assert.deepEqual(options.properties,['openFile']);assert.deepEqual(options.filters,[{name:'JSON / JSONC',extensions:['json','jsonc']}]);dialogs++;return choice;};
 const watchdog=setTimeout(()=>fail(Error('Import desktop smoke timed out')),35000);
 try{
  await import('../desktop/main.mjs');await app.whenReady();let win;
  await until(async()=>{win=BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('头号玩家'));return win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!window.rpo && !!document.querySelector(".app-shell")');});
  const invoke=(method,args={})=>win.webContents.executeJavaScript(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
  const select=kind=>{choice={canceled:false,filePaths:[join(dir,kind+'.jsonc')]};return invoke('settings.vscode.preview',{kind});};
  const apply=p=>invoke('settings.vscode.apply',{planId:p.planId,selectedIds:p.changes.map(c=>c.id)});
  const openImport=async kind=>{
   await win.webContents.executeJavaScript('document.querySelector(".profile").click()');
   await until(()=>win.webContents.executeJavaScript('!!document.querySelector(".settings-layout")'));
   await win.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-layout aside button')].find(b=>b.textContent===${JSON.stringify(kind==='settings'?'编辑器':'快捷键')}).click()`);
   await until(()=>win.webContents.executeJavaScript(`document.querySelector('.vscode-import>header .muted')?.textContent===${JSON.stringify(kind+'.json')}`));
   choice={canceled:false,filePaths:[join(dir,kind+'.jsonc')]};
   await win.webContents.executeJavaScript('document.querySelector(".vscode-import>header button").click()');
   await until(()=>win.webContents.executeJavaScript('!!document.querySelector(".vscode-import-preview")'));
   assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".vscode-import input:checked").length'),0);
   assert.equal(await win.webContents.executeJavaScript('document.querySelector(".vscode-import footer .primary").disabled'),true);
   await writeFile(join(evidenceDir,kind+'-preview.png'),(await win.webContents.capturePage()).toPNG());
  };
  const applyUI=async count=>{
   for(let i=0;i<count;i++)await win.webContents.executeJavaScript(`document.querySelectorAll('.vscode-import input[type=checkbox]')[${i}].click()`);
   assert.equal(await win.webContents.executeJavaScript('document.querySelector(".vscode-import footer .primary").disabled'),false);
   await win.webContents.executeJavaScript('document.querySelector(".vscode-import footer .primary").click()');
   await until(()=>win.webContents.executeJavaScript(`document.querySelector('.vscode-import [role=status]')?.textContent===${JSON.stringify('已导入 ')}+${count}+' 项'`));
  };
  if(phase==='save'){
   assert.equal(await invoke('settings.vscode.preview',{kind:'settings'}),null);assert.equal(dialogs,1);
   await assert.rejects(invoke('settings.vscode.preview',{kind:'settings',path:join(dir,'settings.jsonc')}),/参数无效/);assert.equal(dialogs,1);evidence.checks.push('native selection contract/cancel and renderer path rejection');
   let p=await select('settings');assert.equal(p.changes.length,2);assert(!JSON.stringify(p).includes('synthetic-secret'));assert.equal(p.unsupported.length,1);
   const before=await readFile(join(dir,'client.json.enc'));assert.equal((await invoke('settings.editor.get')).fontSize,12.5);await invoke('settings.vscode.discard',{planId:p.planId});await openImport('settings');await applyUI(2);
   assert.equal((await invoke('settings.editor.get')).fontSize,16);assert.equal((await invoke('bootstrap')).local.editorSettings.minimap,false);assert.notDeepEqual(await readFile(join(dir,'client.json.enc')),before);evidence.checks.push('real IPC preview has no side effect; selected import persists encrypted settings');
   p=await select('keybindings');await invoke('settings.vscode.discard',{planId:p.planId});await assert.rejects(apply(p),/预览已过期/);await openImport('keybindings');await applyUI(1);assert.equal((await invoke('bootstrap')).local.keyboard.saveFile,'Meta+Shift+KeyS');evidence.checks.push('keybinding import/discard and state broadcast');
   p=await select('settings');await invoke('settings.editor.save',{settings:{...(await invoke('settings.editor.get')),fontSize:17}});await assert.rejects(apply(p),/设置已被修改/);assert.equal((await invoke('settings.editor.get')).fontSize,17);evidence.checks.push('stale preview cannot overwrite a concurrent edit');
   p=await select('settings');const target=join(dir,'client.json.enc'),backup=join(dir,'saved-backup.enc');await rename(target,backup);await mkdir(target);
   try{await assert.rejects(apply(p),/导入保存失败/);assert.equal((await invoke('settings.editor.get')).fontSize,17);}finally{await rmdir(target);await rename(backup,target);}
   await assert.rejects(apply(p),/预览已过期/);evidence.checks.push('real filesystem commit failure restores memory and consumes plan');
   p=await select('settings');await apply(p);
  }else{
   assert.equal((await invoke('settings.editor.get')).fontSize,16);assert.equal((await invoke('bootstrap')).local.keyboard.saveFile,'Meta+Shift+KeyS');evidence.checks.push('both imported settings survive actual process restart');
  }
  await writeFile(join(evidenceDir,phase+'.evidence.json'),JSON.stringify(evidence));clearTimeout(watchdog);console.log('VSCODE_IMPORT_DESKTOP_PASS '+phase);app.quit();
 }catch(e){clearTimeout(watchdog);fail(e);}
}
async function driver(){
 assert(process.argv.includes('--run'),'Use --run to launch isolated desktop smoke');assert.equal(process.platform,'darwin','This bounded native smoke currently targets Mac');
 const {default:electron}=await import('electron');const evidenceDir=await mkdtemp(join(tmpdir(),'rpo-import-desktop-')),dir=join(evidenceDir,'isolated-data'),evidence=[];await mkdir(dir);
 try{
  await mkdir(join(dir,'bin'));for(const name of ['codex','claude','gh','cloudflared'])await writeFile(join(dir,'bin',name),'#!/bin/sh\nexit 1\n',{mode:0o700});
  await writeFile(join(dir,'settings.jsonc'),'{/* synthetic */"editor.fontSize":16,"editor.minimap.enabled":false,"unknown-api-key":"synthetic-secret",}');
  await writeFile(join(dir,'keybindings.jsonc'),'[{"key":"cmd+shift+s","command":"workbench.action.files.save"},]');
  const launch=join(dir,'launcher');await mkdir(launch);await writeFile(join(launch,'package.json'),JSON.stringify({name:'rpo-import-smoke',version:'0.0.0',type:'module',main:'entry.mjs'}));await writeFile(join(launch,'entry.mjs'),`import ${JSON.stringify(pathToFileURL(script).href)};`);
  for(const phase of ['save','restart']){
   const env={...process.env,RPO_DATA_DIR:dir,RPO_IMPORT_SMOKE_PHASE:phase,RPO_IMPORT_EVIDENCE_DIR:evidenceDir};for(const k of ['ELECTRON_RUN_AS_NODE','RPO_UPDATE_HEALTH_TICKET','RPO_IDENTITY_ISSUER','RPO_IDENTITY_PUBLIC_KEY_FILE','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])delete env[k];
   const child=spawn(electron,[launch],{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
   const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});clearTimeout(timer);await writeFile(join(evidenceDir,phase+'.log'),output);assert.equal(code,0,output);assert(output.includes('VSCODE_IMPORT_DESKTOP_PASS '+phase));evidence.push(JSON.parse(await readFile(join(evidenceDir,phase+'.evidence.json'))));
  }
  console.log(JSON.stringify({status:'passed',platform:process.platform,evidenceDir,evidence,dialogSelection:'injected synthetic result; no manual chooser UI claim',modelCalls:0,realVSCodeFilesRead:0,installedApplicationsModified:false}));
 }finally{await rm(dir,{recursive:true,force:true});}
}
if(process.versions.electron)void probe();else await driver();
