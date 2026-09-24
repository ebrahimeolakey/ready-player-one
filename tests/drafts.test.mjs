import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SecureStore} from '../core/secure-store.mjs';
import {DraftStore} from '../desktop/services/drafts.mjs';
test('drafts survive restart encrypted and isolate lane keys, invalid writes preserve old data',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rpo-drafts-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const key=randomBytes(32),store=new SecureStore({dir,key}),drafts=new DraftStore(store);
 drafts.set('rpo-prompt-laneA','只在本机保存的草稿');drafts.set('rpo-prompt-laneB','another');
 assert(!readFileSync(join(dir,'drafts.json.enc'),'utf8').includes('只在本机'));
 const restored=new DraftStore(new SecureStore({dir,key}));assert.equal(restored.read('rpo-prompt-laneA'),'只在本机保存的草稿');
 assert.throws(()=>restored.set('__proto__','bad'));assert.throws(()=>restored.set('rpo-file-a','x'.repeat(6*1024*1024+1)));
 restored.remove('rpo-prompt-laneA');assert.equal(restored.read('rpo-prompt-laneA'),null);assert.equal(restored.read('rpo-prompt-laneB'),'another');
});
