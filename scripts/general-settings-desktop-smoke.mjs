// Exercises the actual desktop entry, preload, React UI and encrypted settings.
// All data and failing account binaries live in an isolated temporary directory.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {DEFAULT_GENERAL_SETTINGS} from '../core/general-settings.mjs';
const script=fileURLToPath(import.meta.url),root=dirname(dirname(script));
const expected={...DEFAULT_GENERAL_SETTINGS,layout:'editor',conversationDensity:'compact',autoCheckUpdates:false,
  autoHideEmptyEditor:false,notificationsEnabled:false,notifyApprovals:false,notifyHandoffs:false,notifyUnknownOutcomes:false};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+20000;while(!await check()){if(Date.now()>deadline)throw Error('Desktop condition timed out');await sleep(30);}}

async function probe(){
  const {app,BrowserWindow,dialog}=await import('electron');
  const phase=process.env.RPO_GENERAL_SMOKE_PHASE,dir=process.env.RPO_DATA_DIR;
  const fail=error=>{console.error(error);app.exit(1);};
  dialog.showErrorBox=(title,message)=>fail(Error(title+': '+message));
  const watchdog=setTimeout(()=>fail(Error('Desktop smoke timed out')),35000);
  try{
    await import('../desktop/main.mjs');
    await app.whenReady();
    let win;
    await until(async()=>{win=BrowserWindow.getAllWindows().find(item=>item.getTitle().startsWith('头号玩家'));return win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!window.rpo && !!document.querySelector(".app-shell")');});
    const invoke=(method,args={})=>win.webContents.executeJavaScript(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
    if(phase==='save'){
      assert.deepEqual(await invoke('settings.general.get'),{...DEFAULT_GENERAL_SETTINGS});
      await win.webContents.executeJavaScript('document.querySelector(".profile").click()');
      await until(()=>win.webContents.executeJavaScript('!!document.querySelector(".general-settings")'));
      // Edit through React controls, then broadcast unchanged saved data. Drafts must survive.
      await win.webContents.executeJavaScript(`(()=>{
        const select=(label,value)=>{const row=[...document.querySelectorAll('.general-settings label')].find(row=>row.textContent.includes(label));const input=row.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('change',{bubbles:true}));};
        select('会话布局','editor');select('对话密度','compact');
      })()`);
      await invoke('settings.general.save',{settings:DEFAULT_GENERAL_SETTINGS});
      await sleep(80);
      assert.deepEqual(await win.webContents.executeJavaScript('[...document.querySelectorAll(".general-settings select")].map(item=>item.value)'),['editor','compact']);
      // Turn category switches off before their master so every control is exercised.
      for(const label of ['等待审批','任务接管','结果待确认','系统通知','隐藏空编辑器','启动时检查更新']){
        await win.webContents.executeJavaScript(`([...document.querySelectorAll('.general-settings label')].find(row=>row.textContent===${JSON.stringify(label)})).querySelector('input').click()`);
      }
      await win.webContents.executeJavaScript('document.querySelector(".general-settings form").requestSubmit()');
      await until(async()=>JSON.stringify(await invoke('settings.general.get'))===JSON.stringify(expected));
      const encryptedBefore=await readFile(join(dir,'client.json.enc'));
      await assert.rejects(invoke('settings.general.save',{settings:{trayIcon:'true'}}),/通用设置值无效/);
      assert.deepEqual(await readFile(join(dir,'client.json.enc')),encryptedBefore,'invalid input must not write settings');
      // A real filesystem write failure must restore the in-memory preference value.
      const target=join(dir,'client.json.enc'),backup=join(dir,'client.previous.enc');
      await rename(target,backup);await mkdir(target);
      try{await assert.rejects(invoke('settings.general.save',{settings:{...expected,autoCheckUpdates:true}}));assert.deepEqual(await invoke('settings.general.get'),expected);}
      finally{const{rmdir}=await import('node:fs/promises');await rmdir(target);await rename(backup,target);}
      await writeFile(join(dir,'general-settings.png'),(await win.webContents.capturePage()).toPNG());
    }else{
      assert.deepEqual(await invoke('settings.general.get'),expected,'encrypted settings must survive real process restart');
      assert.deepEqual((await invoke('bootstrap')).local.generalSettings,expected);
    }
    clearTimeout(watchdog);console.log('GENERAL_DESKTOP_PASS '+phase);app.quit();
  }catch(error){clearTimeout(watchdog);fail(error);}
}

async function driver(){
  const {default:electron}=await import('electron');
  const dir=await mkdtemp(join(tmpdir(),'rpo-general-desktop-'));
  await mkdir(join(dir,'bin'));
  assert.notEqual(process.platform,'win32','Synthetic shell binaries in this bounded smoke require macOS or Linux');
  for(const name of ['codex','claude','gh','cloudflared'])await writeFile(join(dir,'bin',name),'#!/bin/sh\nexit 1\n',{mode:0o700});
  const launcher=join(dir,'launcher');await mkdir(launcher);
  await writeFile(join(launcher,'package.json'),JSON.stringify({name:'rpo-general-smoke',version:'0.0.0',type:'module',main:'entry.mjs'}));
  await writeFile(join(launcher,'entry.mjs'),`import ${JSON.stringify(pathToFileURL(script).href)};\n`);
  for(const phase of ['save','restart']){
    const env={...process.env,RPO_DATA_DIR:dir,RPO_GENERAL_SMOKE_PHASE:phase};
    for(const key of ['ELECTRON_RUN_AS_NODE','RPO_UPDATE_HEALTH_TICKET','RPO_IDENTITY_ISSUER','RPO_IDENTITY_PUBLIC_KEY_FILE','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])delete env[key];
    const child=spawn(electron,[launcher],{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
    await writeFile(join(dir,phase+'.log'),output);
    assert.equal(code,0,output);assert.match(output,new RegExp('GENERAL_DESKTOP_PASS '+phase));
  }
  console.log(JSON.stringify({status:'passed',phases:2,directory:dir,modelCalls:0,installedApplicationsModified:false}));
}
if(process.versions.electron)void probe();else await driver();
