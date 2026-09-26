// Two real Electron processes use the same isolated data directory, in sequence.
// windows-native-smoke launches this probe; it never opens a user's saved data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {app,BrowserWindow,dialog} from 'electron';
import {DEFAULT_GENERAL_SETTINGS} from '../core/general-settings.mjs';

const phase=process.env.RPO_WINDOWS_APPEARANCE_PHASE;
assert.ok(['save','restart'].includes(phase));
assert.ok(process.env.RPO_DATA_DIR);
assert.ok(process.env.RPO_WINDOWS_APPEARANCE_EVIDENCE);
const artifacts=resolve(process.env.RPO_WINDOWS_APPEARANCE_EVIDENCE);
mkdirSync(artifacts,{recursive:true});
const settings={...DEFAULT_GENERAL_SETTINGS,theme:'light',collaboratorColors:false,
  notificationsEnabled:false,completionSound:false,trayIcon:false,autoCheckUpdates:false};
const evidence={phase,platform:process.platform,modelCalls:0,settings};
const saveEvidence=()=>writeFileSync(join(artifacts,`appearance-${phase}.json`),JSON.stringify(evidence,null,2));
function fail(error){evidence.error=error.stack||String(error);saveEvidence();console.error(error);app.exit(1);}
const watchdog=setTimeout(()=>fail(Error('Appearance desktop probe exceeded 40 seconds')),40000);
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
dialog.showErrorBox=(title,message)=>fail(Error(`${title}: ${message}`));
const waitFor=async predicate=>{const until=Date.now()+15000;while(!await predicate()){if(Date.now()>until)throw Error('Appearance renderer did not reach expected state');await new Promise(r=>setTimeout(r,40));}};
async function probe(){
 try{
  await import('../desktop/main.mjs');await app.whenReady();
  let win;
  await waitFor(async()=>{win=BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('头号玩家'));return win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!window.rpo && !!document.querySelector(".app-shell .profile .avatar")');});
  const invoke=(method,args={})=>win.webContents.executeJavaScript(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
  const appearance=()=>win.webContents.executeJavaScript(`(()=>{const avatar=document.querySelector('.profile .avatar');return {theme:document.documentElement.dataset.theme,scheme:getComputedStyle(document.documentElement).colorScheme,avatar:getComputedStyle(avatar).backgroundColor,name:avatar.textContent};})()`);
  const apply=async value=>{assert.deepEqual(await invoke('settings.general.save',{settings:value}),value);await waitFor(async()=>(await appearance()).theme===value.theme);};
  if(phase==='save'){
   assert.deepEqual(await invoke('settings.general.get'),{...DEFAULT_GENERAL_SETTINGS});
   await waitFor(async()=>(await appearance()).theme==='dark');
   const dark=await appearance();assert.equal(dark.scheme,'dark');
   await apply({...settings,collaboratorColors:true});const light=await appearance();
   assert.equal(light.scheme,'light');assert.notEqual(light.avatar,dark.avatar,'Theme must change the actual avatar palette');
   await apply(settings);
   await waitFor(async()=>(await appearance()).avatar==='rgb(226, 229, 233)');
   evidence.dark=dark;evidence.light=light;evidence.monochrome=await appearance();
   assert.deepEqual((await invoke('bootstrap')).local.generalSettings,settings);
  }else{
   const previous=JSON.parse(readFileSync(join(artifacts,'appearance-save.json'),'utf8'));
   assert.equal(previous.passed,true);
   // Assert before any setting mutation: a new main process has read encrypted disk data.
   assert.deepEqual(await invoke('settings.general.get'),settings,'Theme and collaborator colors must survive actual process restart');
   assert.deepEqual((await invoke('bootstrap')).local.generalSettings,settings);
   await waitFor(async()=>{const v=await appearance();return v.theme==='light'&&v.avatar==='rgb(226, 229, 233)';});
   evidence.restored=await appearance();assert.equal(evidence.restored.scheme,'light');
   await apply({...settings,collaboratorColors:true});
   await waitFor(async()=>(await appearance()).avatar===previous.light.avatar);
   evidence.restoredColor=await appearance();
   await apply({...settings,theme:'dark',collaboratorColors:true});
   await waitFor(async()=>(await appearance()).avatar===previous.dark.avatar);
   evidence.restoredDark=await appearance();assert.equal(evidence.restoredDark.scheme,'dark');
   await apply(settings);
   await waitFor(async()=>(await appearance()).avatar==='rgb(226, 229, 233)');
  }
  // Let Chromium present the asserted style before taking the screenshot.
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(join(artifacts,`appearance-${phase}.png`),(await win.webContents.capturePage()).toPNG());
  evidence.passed=true;saveEvidence();
  app.once('will-quit',()=>{clearTimeout(watchdog);console.log('WINDOWS_APPEARANCE_PASS '+phase);});
  app.quit();
 }catch(error){fail(error);}
}
void probe();
