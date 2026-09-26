import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';

test('same-page VS Code imports preserve dirty editor fields and invalid numeric drafts; own save/reset clears dirty state',{skip:process.platform==='linux'&&!process.env.DISPLAY,timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rpo-editor-import-draft-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=fileURLToPath(new URL('../',import.meta.url));
 const source=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{VSCodeImport}from ${JSON.stringify(join(root,'src/VSCodeImport.tsx'))};import{EditorSettings}from ${JSON.stringify(join(root,'src/EditorSettings.tsx'))};import{DEFAULT_EDITOR_SETTINGS}from ${JSON.stringify(join(root,'core/editor-settings.mjs'))};
 function App(){const[settings,setSettings]=useState({...DEFAULT_EDITOR_SETTINGS});const call=async(method,args)=>{const result=await window.bridge.invoke(method,args);if(method==='settings.vscode.apply'||method==='settings.editor.save')setSettings((await window.bridge.control({action:'state'})).editorSettings);return result;};return <><VSCodeImport kind='settings' call={call}/><EditorSettings settings={settings} call={call}/></>;}createRoot(document.getElementById('root')).render(<App/>);`;
 await build({stdin:{contents:source,loader:'tsx',resolveDir:root},outfile:join(dir,'ui.js'),bundle:true,format:'iife',platform:'browser',logLevel:'silent'});
 await writeFile(join(dir,'index.html'),'<html><head><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
 await writeFile(join(dir,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{invoke:(method,args)=>ipcRenderer.invoke('fixture',method,args),control:args=>ipcRenderer.invoke('control',args)});`);
 const verify=async()=>{
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const wait=async fn=>{const until=Date.now()+5000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI condition failed: '+fn.toString());};
  const button=(area,text)=>Array.from(document.querySelectorAll(area+' button')).find(b=>b.textContent.trim()===text);
  const font=()=>document.querySelector('.editor-settings input[type=number]');
  const write=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
  const importValue=async(value)=>{await window.bridge.control({action:'source',value});button('.vscode-import','从 VS Code 导入').click();await wait(()=>document.querySelector('.vscode-import-item input'));document.querySelector('.vscode-import-item input').click();await wait(()=>button('.vscode-import','导入 1 项'));button('.vscode-import','导入 1 项').click();await wait(()=>document.querySelector('.vscode-import [role=status]')?.textContent==='已导入 1 项');};
  await wait(()=>font()?.value==='12.5');write(font(),'18');await wait(()=>font().value==='18');
  await importValue({'editor.minimap.enabled':false});await wait(()=>document.querySelector('.editor-settings [role=status]')?.textContent.includes('保留未保存修改'));
  check(font().value==='18','unrelated import erased dirty font size');const minimap=Array.from(document.querySelectorAll('.editor-settings label')).find(el=>el.textContent==='代码缩略图').querySelector('input');check(!minimap.checked,'untouched minimap did not follow import');
  await importValue({'editor.fontSize':16});await wait(async()=>(await window.bridge.control({action:'state'})).editorSettings.fontSize===16);check(font().value==='18','import of dirty field silently discarded input');check(document.querySelector('.editor-settings [role=status]').textContent.includes('保留未保存修改'),'conflicting import has no explanation');
  write(font(),'');await wait(()=>font().value==='');await importValue({'editor.fontSize':20});check(font().value==='','invalid numeric draft was erased');
  write(font(),'14');await wait(()=>font().value==='14');button('.editor-settings','保存').click();await wait(()=>document.querySelector('.editor-settings [role=status]').textContent==='已保存');check((await window.bridge.control({action:'state'})).editorSettings.fontSize===14,'own save did not persist dirty field');
  await importValue({'editor.fontSize':22});await wait(()=>font().value==='22');
  const family=document.querySelector('.editor-settings input[list]');write(family,'Draft Font');write(font(),'');await wait(()=>family.value==='Draft Font'&&font().value==='');button('.editor-settings','恢复默认').click();await wait(()=>font().value==='12.5'&&family.value==='IBM Plex Mono');
  check((await window.bridge.control({action:'state'})).editorSettings.minimap===true,'reset failed to restore imported checkbox');await importValue({'editor.fontSize':24});await wait(()=>font().value==='24');return true;
 };
 await writeFile(join(dir,'runner.cjs'),`const{app,BrowserWindow,ipcMain}=require('electron');app.disableHardwareAcceleration();let win;app.whenReady().then(async()=>{const{VSCodeImportService}=await import(${JSON.stringify(pathToFileURL(join(root,'desktop/services/vscode-import.mjs')).href)});const{DEFAULT_EDITOR_SETTINGS,validateEditorSettings}=await import(${JSON.stringify(pathToFileURL(join(root,'core/editor-settings.mjs')).href)});const service=new VSCodeImportService({platform:'darwin'});let editorSettings={...DEFAULT_EDITOR_SETTINGS},source={};ipcMain.handle('control',(_e,a)=>{if(a.action==='source')source=a.value;return{editorSettings};});ipcMain.handle('fixture',(_e,method,args)=>{const current={editorSettings,keyboard:{}},scope='synthetic-draft-test';if(method==='settings.vscode.preview')return service.preview({settingsText:JSON.stringify(source),current,scope});if(method==='settings.vscode.apply'){const patch=service.apply({...args,current,scope});editorSettings=validateEditorSettings({...editorSettings,...patch.editorPatch});return{imported:args.selectedIds.length};}if(method==='settings.vscode.discard'){service.discard(args.planId);return true;}if(method==='settings.editor.save')return editorSettings=validateEditorSettings(args.settings);throw Error('unexpected method');});win=new BrowserWindow({show:false,width:1000,height:1100,webPreferences:{preload:${JSON.stringify(join(dir,'preload.cjs'))},backgroundThrottling:false}});await win.loadFile(${JSON.stringify(join(dir,'index.html'))});await win.webContents.executeJavaScript(${JSON.stringify('('+verify.toString()+')()')});service.dispose();console.log('EDITOR_IMPORT_DRAFT_PASS');win.destroy();app.exit(0);}).catch(error=>{console.error(error);if(win)win.destroy();app.exit(1);});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[join(dir,'runner.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Editor import draft timeout\n'+output));},25000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,output});});});assert.equal(result.code,0,result.output);assert.match(result.output,/EDITOR_IMPORT_DRAFT_PASS/);
});
