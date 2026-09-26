import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {VSCodeImportController,readSelectedImportFile} from '../desktop/services/vscode-import-controller.mjs';
import {SecureStore} from '../core/secure-store.mjs';
const selected=preview=>preview.changes.map(c=>c.id);
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-import-controller-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={name:'synthetic',editorSettings:{fontSize:12},keyboard:{},unrelated:{preserve:true}};
 let fail=false,writes=0,choice,scope='local-synthetic',pickerCalls=0;
 const store=new SecureStore({dir:join(dir,'encrypted'),key:randomBytes(32),beforeCommit:()=>{if(fail)throw Error('synthetic disk failure');}});
 store.writeJSON('client.json',config);t.after(()=>store.destroy());
 const controller=new VSCodeImportController({platform:'darwin',getConfig:()=>config,getScope:()=>scope,
  selectFile:async()=>{pickerCalls++;return typeof choice==='function'?choice():choice;},persist:()=>{writes++;store.writeJSON('client.json',config);}});t.after(()=>controller.dispose());
 const path=join(dir,'中文 with spaces.jsonc');await writeFile(path,'{/* only selected fields */"editor.fontSize":17,"editor.minimap.enabled":false,}');choice={canceled:false,filePaths:[path]};
 return {dir,config,controller,store,path,get writes(){return writes;},get pickerCalls(){return pickerCalls;},set failure(v){fail=v;},set choice(v){choice=v;},set scope(v){scope=v;}};
}
test('native selection reads only chosen synthetic UTF8 file; explicit apply commits encrypted settings once',async t=>{
 const f=await fixture(t),before=await readFile(f.store.path('client.json'));
 const preview=await f.controller.preview({kind:'settings'});assert.equal(preview.kind,'settings');assert.equal(f.writes,0);assert.equal(f.config.editorSettings.fontSize,12);assert.deepEqual(await readFile(f.store.path('client.json')),before);
 assert.deepEqual(f.controller.apply({planId:preview.planId,selectedIds:selected(preview)}),{imported:2});assert.equal(f.writes,1);assert.equal(f.config.editorSettings.fontSize,17);assert.equal(f.store.readJSON('client.json').editorSettings.fontSize,17);assert.deepEqual(f.config.unrelated,{preserve:true});
 const raw=await readFile(f.store.path('client.json'),'utf8');assert.ok(!raw.includes('fontSize'));assert.ok(raw.includes('ciphertext'));
});
test('failed encrypted commit restores original object references and disk bytes; consumed preview cannot retry blindly',async t=>{
 const f=await fixture(t),old=f.config.editorSettings,bytes=await readFile(f.store.path('client.json'));const preview=await f.controller.preview({kind:'settings'});f.failure=true;
 assert.throws(()=>f.controller.apply({planId:preview.planId,selectedIds:selected(preview)}),{code:'IMPORT_SAVE_FAILED'});assert.equal(f.config.editorSettings,old);assert.deepEqual(await readFile(f.store.path('client.json')),bytes);assert.equal(f.writes,1);
 assert.throws(()=>f.controller.apply({planId:preview.planId,selectedIds:selected(preview)}),{code:'IMPORT_PLAN_EXPIRED'});assert.equal(f.writes,1);
});
test('rollback removes settings properties which were absent before import',async t=>{
 const f=await fixture(t);delete f.config.keyboard;await writeFile(f.path,'[{"key":"cmd+shift+s","command":"workbench.action.files.save"}]');const preview=await f.controller.preview({kind:'keybindings'});f.failure=true;
 assert.throws(()=>f.controller.apply({planId:preview.planId,selectedIds:selected(preview)}),{code:'IMPORT_SAVE_FAILED'});assert.equal(Object.hasOwn(f.config,'keyboard'),false);
});
test('renderer cannot supply arbitrary file paths/text/scope/current or bypass native cancellation',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.controller.preview({kind:'settings',path:f.path}),{code:'IMPORT_ARGUMENTS'});assert.equal(f.pickerCalls,0);
 f.choice={canceled:true,filePaths:[f.path]};assert.equal(await f.controller.preview({kind:'settings'}),null);assert.equal(f.writes,0);
 f.choice={canceled:false,filePaths:[f.path,f.path]};await assert.rejects(()=>f.controller.preview({kind:'settings'}),{code:'IMPORT_FILE_SELECTION'});
 await assert.rejects(()=>f.controller.preview({kind:'unknown'}),{code:'IMPORT_KIND'});
});
test('regular file, bounded bytes and strict UTF8 constraints precede JSONC parsing',async t=>{
 const f=await fixture(t);await assert.rejects(()=>readSelectedImportFile(f.dir),{code:'IMPORT_FILE_TYPE'});
 await writeFile(f.path,Buffer.alloc(256*1024+1));await assert.rejects(()=>readSelectedImportFile(f.path),{code:'IMPORT_TOO_LARGE'});
 await writeFile(f.path,Buffer.from([0xff,0xfe,0x00,0x00]));await assert.rejects(()=>readSelectedImportFile(f.path),{code:'IMPORT_FILE_ENCODING'});
 await assert.rejects(()=>readSelectedImportFile(join(f.dir,'missing-secret-name')),(e)=>e.code==='IMPORT_FILE_READ'&&!e.message.includes('secret-name'));
 if(process.platform!=='win32'){const link=join(f.dir,'link.json');await symlink(f.path,link);await assert.rejects(()=>readSelectedImportFile(link),{code:'IMPORT_FILE_TYPE'});}
});
test('selection is single-flight and pending dialog result is fenced by scope and disposal',async t=>{
 const f=await fixture(t);let release;f.choice=()=>new Promise(resolve=>{release=resolve;});const first=f.controller.preview({kind:'settings'});
 await assert.rejects(()=>f.controller.preview({kind:'settings'}),{code:'IMPORT_BUSY'});f.scope='different-local-data';release({canceled:false,filePaths:[f.path]});await assert.rejects(()=>first,{code:'IMPORT_SCOPE_CHANGED'});
 const second=f.controller.preview({kind:'settings'});f.controller.dispose();release({canceled:false,filePaths:[f.path]});await assert.rejects(()=>second,{code:'IMPORT_CLOSED'});assert.equal(f.writes,0);
});
test('current settings changes while preview is open prevent an import overwriting newer edits',async t=>{
 const f=await fixture(t);const preview=await f.controller.preview({kind:'settings'});f.config.keyboard={saveFile:'Meta+Shift+KeyS'};
 assert.throws(()=>f.controller.apply({planId:preview.planId,selectedIds:selected(preview)}),{code:'IMPORT_PLAN_STALE'});assert.equal(f.writes,0);assert.equal(f.config.editorSettings.fontSize,12);
});
test('discard and empty selection never write; unexpected apply arguments are rejected',async t=>{
 const f=await fixture(t);let p=await f.controller.preview({kind:'settings'});
 assert.throws(()=>f.controller.apply({planId:p.planId,selectedIds:selected(p),current:{}}),{code:'IMPORT_ARGUMENTS'});assert.equal(f.controller.discard({planId:p.planId}),true);
 assert.throws(()=>f.controller.apply({planId:p.planId,selectedIds:selected(p)}),{code:'IMPORT_PLAN_EXPIRED'});
 p=await f.controller.preview({kind:'settings'});assert.deepEqual(f.controller.apply({planId:p.planId,selectedIds:[]}),{imported:0});assert.equal(f.writes,0);
});
