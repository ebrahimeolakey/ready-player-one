import { DRAFT_LIMITS } from "../core/prompt-limits.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {SecureStore} from '../core/secure-store.mjs';
import {ComposerStore} from '../desktop/services/composer.mjs';
const png={name:'recover.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII='};
test('composer first encrypted write interrupted before rename recovers durable text and attachments on restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rpo-composer-pending-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const key=randomBytes(32);
 const failedStorage=new SecureStore({dir,key,beforeCommit:()=>{throw Error('crash before rename');}}),first=new ComposerStore(failedStorage);
 assert.throws(()=>first.save({laneId:'lane-a',text:'不能丢失的草稿',images:[png],revision:0}),/crash before rename/);
 assert.equal(readdirSync(dir).filter(name=>name.endsWith('.pending')).length,1);
 const recovered=new ComposerStore(new SecureStore({dir,key}));
 assert.equal(recovered.read('lane-a').text,'不能丢失的草稿');
 assert.equal(recovered.read('lane-a').images[0].data,png.data);
});

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'rpo-composer-conflict-')),key=randomBytes(32);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const storage=new SecureStore({dir,key}),store=new ComposerStore(storage);
 return {dir,key,storage,store,restart:()=>new ComposerStore(new SecureStore({dir,key}))};
}
test('two editors opening an unchanged lane do not advance revision or create conflicts',t=>{
 const {store}=fixture(t),a=structuredClone(store.read('lane')),b=structuredClone(store.read('lane'));
 assert.equal(store.save({laneId:'lane',...a}).revision,0);
 assert.equal(store.save({laneId:'lane',...b}).revision,0);
 assert.equal(store.listConflicts('lane').length,0);
});
test('stale editor keeps text and images as an encrypted conflict across restart without overwriting the main draft',t=>{
 const {store,restart,storage}=fixture(t),a=store.read('lane'),b=store.read('lane');
 const main=store.save({laneId:'lane',...a,text:'窗口 A 的草稿',images:[png]});
 const conflict=store.save({laneId:'lane',...b,text:'窗口 B 的草稿',images:[png]});
 assert.ok(conflict.conflictId);assert.equal(conflict.text,main.text);assert.equal(conflict.revision,main.revision);
 const archived=store.listConflicts('lane')[0];assert.equal(archived.text,'窗口 B 的草稿');assert.equal(archived.images[0].data,png.data);
 assert.equal(storage.readJSON('composer.json').lane.conflicts[0].id,conflict.conflictId);
 const restored=restart();assert.equal(restored.read('lane').text,main.text);assert.deepEqual(restored.listConflicts('lane'),[archived]);
 assert.equal(restored.save({laneId:'lane',...b,text:'窗口 B 的草稿',images:[png]}).conflictId,conflict.conflictId);
 assert.equal(restored.listConflicts('lane').length,1);
});
test('explicit conflict merge preserves both drafts, deduplicates images and is idempotent after restart',t=>{
 const {store,restart}=fixture(t);store.save({laneId:'lane',text:'已保存',images:[png],revision:0});
 const conflict=store.save({laneId:'lane',text:'并排修改',images:[png],revision:0});
 const merged=store.restoreConflict({laneId:'lane',id:conflict.conflictId});
 assert.equal(merged.text,'已保存\n\n并排修改');assert.equal(merged.images.length,1);assert.equal(store.listConflicts('lane').length,0);
 assert.equal(merged.conflicts[0].text,'并排修改');assert.ok(merged.conflicts[0].resolvedAt);
 const reopened=restart();assert.deepEqual(reopened.restoreConflict({laneId:'lane',id:conflict.conflictId}),merged);
 const saved=reopened.save({laneId:'lane',text:'下一份草稿',images:[],revision:merged.revision});
 assert.equal(saved.conflicts[0].text,'并排修改');assert.equal(saved.conflicts[0].images[0].data,png.data);
});
test('oversized merge keeps the current draft and unresolved conflict intact on disk',t=>{
 const {store,restart}=fixture(t);store.save({laneId:'lane',text:'a'.repeat(DRAFT_LIMITS.codePoints / 2 + 1),images:[],revision:0});
 const archived=store.save({laneId:'lane',text:'b'.repeat(DRAFT_LIMITS.codePoints / 2 + 1),images:[png],revision:0});const before=store.read('lane');
 assert.throws(()=>store.restoreConflict({laneId:'lane',id:archived.conflictId}),/超过/);
 assert.deepEqual(store.read('lane'),before);assert.deepEqual(restart().read('lane'),before);assert.equal(store.listConflicts('lane').length,1);
});
test('restoring failed guidance retains unrelated conflict drafts and does not duplicate restored text',t=>{
 const {store}=fixture(t);store.save({laneId:'lane',text:'main',images:[],revision:0});
 const archived=store.save({laneId:'lane',text:'parallel',images:[png],revision:0});
 const once=store.restore({laneId:'lane',id:'guidance',text:'guidance',images:[png]});
 assert.equal(once.text,'main\n\nguidance');assert.equal(once.conflicts[0].id,archived.conflictId);
 assert.deepEqual(store.restore({laneId:'lane',id:'guidance',text:'guidance',images:[png]}),once);
});
