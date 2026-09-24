import { DRAFT_LIMITS } from "../core/prompt-limits.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SecureStore} from '../core/secure-store.mjs';
import {DraftStore} from '../desktop/services/drafts.mjs';
import {ComposerStore} from '../desktop/services/composer.mjs';
const png={name:'test.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII='};
test('encrypted composer restores unsent guidance and images once across restart, preserving another draft',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rpo-composer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const key=randomBytes(32),storage=new SecureStore({dir,key}),legacy=new DraftStore(storage);legacy.set('rpo-prompt-a','已有草稿');let store=new ComposerStore(storage,legacy);
 let value=store.read('a');assert.equal(value.text,'已有草稿');value=store.save({laneId:'a',...value,images:[png]});value=store.restore({laneId:'a',id:'guidance1',text:'未送达指令',images:[png]});assert.equal(value.text,'已有草稿\n\n未送达指令');assert.equal(value.images.length,1);
 const bytes=readFileSync(join(dir,'composer.json.enc'),'utf8');assert(!bytes.includes('未送达'));assert(!bytes.includes(png.data));
 store=new ComposerStore(new SecureStore({dir,key}),legacy);assert.deepEqual(store.restore({laneId:'a',id:'guidance1',text:'未送达指令',images:[png]}),value);assert.equal(store.read('b').text,'');
 const conflict=store.save({laneId:'a',text:'stale overwrite',images:[],revision:0});assert.ok(conflict.conflictId);assert.equal(store.read('a').text,value.text);assert.equal(store.listConflicts('a')[0].text,'stale overwrite');
});
test('failed recovery leaves attachments and receipt intact, so guidance remains recoverable',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rpo-composer-limit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ComposerStore(new SecureStore({dir,key:randomBytes(32)}));const before=store.save({laneId:'a',text:'x'.repeat(DRAFT_LIMITS.codePoints),images:[png],revision:0});assert.throws(()=>store.restore({laneId:'a',id:'g',text:'more',images:[]}),/超过/);assert.deepEqual(store.read('a'),before);assert.throws(()=>store.save({laneId:'a',text:'okay',images:[{name:'bad',data:'abcd'}],revision:before.revision}));assert.deepEqual(store.read('a'),before);
});
