import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink,realpath,stat}from'node:fs/promises';
import{join}from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';
import{AgentEditPositions}from'../desktop/services/agent-edit-positions.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,options={}){const root=await realpath(await mkdtemp(join(tmpdir(),'rpo-edit-positions-'))),batches=[],errors=[];const service=new AgentEditPositions({onPositions:b=>batches.push(b),onError:e=>errors.push(e.message),...options});t.after(async()=>{service.dispose();await rm(root,{recursive:true,force:true});});return{root,batches,errors,service,ctx:{root,workspaceId:'w',sessionId:'s',laneId:'l'},file:(path,content)=>writeFile(join(root,path),content)};}
const edit=(old_string='old',new_string='new',extra={})=>({runId:'r',provider:'claude',type:'tool',phase:'started',itemId:'t',item:{type:'tool_use',id:'t',name:'Edit',input:{file_path:'a.txt',old_string,new_string,...extra}}});
const result=(is_error=false,toolId='t')=>({runId:'r',provider:'claude',type:'tool',phase:'completed',itemId:toolId,item:{type:'tool_result',tool_use_id:toolId,is_error}});
const diff='--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n head\n-old\n+new\n tail\n';
const codex=(phase='started',status='inProgress',changes=[{path:'a.txt',kind:{type:'update'},diff}])=>({runId:'r',provider:'codex',type:'tool',phase,itemId:'t',item:{type:'fileChange',id:'t',status,changes}});

test('Claude Edit verifies old lines then exact completed file hash; duplicate and late start are inert',async t=>{
 const f=await fixture(t);await f.file('a.txt','head\nold\ntail\n');await f.service.observe(edit(),f.ctx);
 assert.deepEqual(f.batches[0],{runId:'r',sequence:1,positions:[{path:'a.txt',hash:sha('head\nold\ntail\n'),startLine:2,endLine:2,phase:'pending',toolId:'t',source:'claude'}]});
 await f.file('a.txt','head\nnew\ntail\n');await f.service.observe(result(),f.ctx);
 assert.equal(f.batches[1].positions[0].phase,'completed');assert.equal(f.batches[1].positions[0].hash,sha('head\nnew\ntail\n'));
 await f.service.observe(result(),f.ctx);await f.service.observe(edit(),f.ctx);assert.equal(f.batches.length,2);
 assert(!JSON.stringify(f.batches).includes('head'));assert(!JSON.stringify([...f.service.runs.get('r').tools.values()]).includes('old'));
});
test('Claude failure and unverified results retract pending positions without claiming execution',async t=>{
 for(const failure of ['tool-error','disk-mismatch','unknown']){const f=await fixture(t);await f.file('a.txt','old');await f.service.observe(edit(),f.ctx);const e=result(failure==='tool-error');if(failure==='unknown')e.item={type:'other'};await f.service.observe(e,f.ctx);assert.deepEqual(f.batches.at(-1).positions,[]);assert.equal(f.batches.at(-1).sequence,2);}
});
test('replace_all maps changed line counts; nonunique and missing old text have no invented ranges',async t=>{
 const f=await fixture(t);await f.file('a.txt','old\nx\nold\n');await f.service.observe(edit(),f.ctx);assert.equal(f.batches.length,0);
 await f.service.observe(edit('old','new\nextra',{replace_all:true}),f.ctx);assert.deepEqual(f.batches.at(-1).positions.map(p=>[p.startLine,p.endLine]),[[1,1],[3,3]]);
 await f.file('a.txt','new\nextra\nx\nnew\nextra\n');await f.service.observe(result(),f.ctx);assert.deepEqual(f.batches.at(-1).positions.map(p=>[p.startLine,p.endLine]),[[1,2],[4,5]]);
});
test('Write waits for completion and validates complete UTF8 content including Chinese new-file paths',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'中文 目录'));const path='中文 目录/新 文件.ts',content='const 文本 = "你好";\nexport {};\n',e=edit();e.item={type:'tool_use',id:'t',name:'Write',input:{file_path:join(f.root,path),content}};
 await f.service.observe(e,f.ctx);assert.equal(f.batches.length,0);await f.file(path,content);await f.service.observe(result(),f.ctx);
 assert.deepEqual(f.batches[0].positions[0],{path,hash:sha(content),startLine:1,endLine:2,phase:'completed',toolId:'t',source:'claude'});
});
test('Codex structured fileChange validates unified old/new hunks and authoritative completion status',async t=>{
 const f=await fixture(t);await f.file('a.txt','head\nold\ntail\n');await f.service.observe(codex(),f.ctx);assert.equal(f.batches[0].positions[0].startLine,2);assert.equal(f.batches[0].positions[0].phase,'pending');
 await f.file('a.txt','head\nnew\ntail\n');await f.service.observe(codex('completed','completed'),f.ctx);assert.equal(f.batches[1].positions[0].phase,'completed');
 const g=await fixture(t);await g.file('a.txt','head\nold\ntail\n');await g.service.observe(codex(),g.ctx);await g.service.observe(codex('completed','failed'),g.ctx);assert.deepEqual(g.batches.at(-1).positions,[]);
});
test('Codex moves use verified destination; new file no pending range, deletion no completed range',async t=>{
 const f=await fixture(t);await f.file('b.txt','head\nnew\ntail\n');await f.service.observe(codex('completed','completed',[{path:'a.txt',kind:{type:'update',move_path:'b.txt'},diff}]),f.ctx);assert.equal(f.batches[0].positions[0].path,'b.txt');
 const g=await fixture(t),add=[{path:'a.txt',kind:{type:'add'},diff:'@@ -0,0 +1,2 @@\n+one\n+two\n'}];await g.service.observe(codex('started','inProgress',add),g.ctx);assert.equal(g.batches.length,0);await g.file('a.txt','one\ntwo\n');await g.service.observe(codex('completed','completed',add),g.ctx);assert.deepEqual(g.batches[0].positions.map(p=>[p.startLine,p.endLine]),[[1,2]]);
 const h=await fixture(t);await h.file('a.txt','old\n');const del=[{path:'a.txt',kind:{type:'delete'},diff:'@@ -1 +0,0 @@\n-old\n'}];await h.service.observe(codex('started','inProgress',del),h.ctx);await rm(join(h.root,'a.txt'));await h.service.observe(codex('completed','completed',del),h.ctx);assert.deepEqual(h.batches.at(-1).positions,[]);
});
test('invalid/mismatched/unknown diff and shell-like events never infer locations',async t=>{
 for(const bad of ['not unified','@@ -1,9 +1,2 @@\n-old\n+new\n','@@ -2 +2 @@\n-old\n+new\n']){const f=await fixture(t);await f.file('a.txt','old');await f.service.observe(codex('started','inProgress',[{path:'a.txt',kind:{type:'update'},diff:bad}]),f.ctx);assert.equal(f.batches.length,0);}
 const f=await fixture(t);await f.file('a.txt','old');const e=edit();e.item.name='Bash';e.item.input={command:'echo new > a.txt'};await f.service.observe(e,f.ctx);assert.equal(f.batches.length,0);
});
test('root traversal, symlink file/parent, binary/invalid UTF8/oversized files are rejected',async t=>{
 const f=await fixture(t,{maxBytes:64});await f.file('a.txt','old');await symlink(join(f.root,'a.txt'),join(f.root,'link'));await mkdir(join(f.root,'real'));await f.file('real/a.txt','old');await symlink(join(f.root,'real'),join(f.root,'alias'));
 await f.file('binary',Buffer.from([0,1,2]));await f.file('invalid',Buffer.from([0xff]));await f.file('huge','x'.repeat(65));
 for(const path of ['../a.txt','a/../a.txt','/etc/passwd','link','alias/a.txt','binary','invalid','huge']){const e=edit('old','new',{file_path:path});e.itemId=e.item.id='t'+path;await f.service.observe(e,f.ctx);}assert.equal(f.batches.length,0);
});
test('queued event snapshots cannot mutate target; run context mismatch and disposed queues are fenced',async t=>{
 const f=await fixture(t);await f.file('a.txt','old');const e=edit(),pending=f.service.observe(e,f.ctx);e.item.input.file_path='../outside';await pending;assert.equal(f.batches[0].positions[0].path,'a.txt');
 await f.file('a.txt','new');await f.service.observe(result(),{...f.ctx,laneId:'other'});assert.equal(f.batches.length,1);
 const next=f.service.observe(result(),f.ctx);f.service.dispose();await next;assert.equal(f.batches.length,1);
});
test('finish clears pending, retains verified completed, fences late events and expires stored runs',async t=>{
 const f=await fixture(t,{retentionMs:5});await f.file('a.txt','old');await f.service.observe(edit(),f.ctx);await f.service.finish('r',f.ctx);assert.deepEqual(f.batches.at(-1).positions,[]);await f.service.observe(result(),f.ctx);assert.equal(f.batches.length,2);await new Promise(r=>setTimeout(r,15));assert.equal(f.service.runs.size,0);
 const g=await fixture(t);await g.file('a.txt','old');await g.service.observe(edit(),g.ctx);await g.file('a.txt','new');await g.service.observe(result(),g.ctx);await g.service.finish('r',g.ctx);assert.equal(g.batches.at(-1).positions[0].phase,'completed');
});
test('callback errors are isolated; sequences remain ordered and aggregate at most32 positions',async t=>{
 const received=[];const f=await fixture(t,{onPositions:async b=>{received.push(b);throw Error('subscriber failure');}});await f.file('a.txt','old');
 for(let n=0;n<35;n++){const e=edit();e.itemId=e.item.id='t'+n;await f.service.observe(e,f.ctx);}assert.equal(received.at(-1).positions.length,32);assert.deepEqual(received.map(b=>b.sequence),Array.from({length:35},(_,i)=>i+1));assert.equal(f.errors.length,35);
});
test('run and total queue limits are bounded; finish bypasses full observer queue to clear pending',async t=>{
 const f=await fixture(t,{maxRuns:1});await f.file('a.txt','old');const work=[];for(let n=0;n<80;n++){const e=edit();e.itemId=e.item.id='t'+n;work.push(f.service.observe(e,f.ctx));}assert(f.service.pending<=64);const end=f.service.finish('r',f.ctx);await Promise.all([...work,end]);assert.deepEqual(f.batches.at(-1).positions,[]);assert.equal(f.service.pending,0);const e=edit();e.runId='second';await f.service.observe(e,f.ctx);assert.equal(f.service.runs.size,1);
});
test('dispose during async notification fences queued work and finish cleanup',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),notifying=new Promise(r=>entered=r),received=[];
 const f=await fixture(t,{onPositions:async batch=>{received.push(batch);entered();await gate;}});await f.file('a.txt','old');const first=f.service.observe(edit(),f.ctx);await notifying;const second=f.service.observe(result(),f.ctx),last=f.service.finish('r',f.ctx);f.service.dispose();release();await Promise.all([first,second,last]);assert.equal(received.length,1);assert.equal(f.service.runs.size,0);assert.equal(f.service.pending,0);
});
test('filesystem-proven case aliases emit canonical relative paths without guessing on case-sensitive volumes',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'Directory'));await f.file('Directory/Case.txt','old');
 let alias;try{alias=await stat(join(f.root,'directory/case.txt'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const original=await stat(join(f.root,'Directory/Case.txt'));
 if(!alias||alias.ino!==original.ino||alias.dev!==original.dev){
   t.diagnostic('Case-sensitive volume detected: alias must remain unavailable; alias-success branch not exercised on this volume.');
   await f.service.observe(edit('old','new',{file_path:'directory/case.txt'}),f.ctx);assert.equal(f.batches.length,0);
   await mkdir(join(f.root,'directory'));await f.file('directory/case.txt','different');await f.service.observe(edit('old','new',{file_path:'directory/case.txt'}),f.ctx);assert.equal(f.batches.length,0);
   await f.service.observe(edit('old','new',{file_path:'Directory/Case.txt'}),f.ctx);assert.equal(f.batches[0].positions[0].path,'Directory/Case.txt');return;
 }
 t.diagnostic('Case-insensitive volume detected via identical dev/inode: canonical alias branch exercised on '+process.platform+'.');
 await f.service.observe(edit('old','new',{file_path:'directory/case.txt'}),f.ctx);assert.equal(f.batches[0].positions[0].path,'Directory/Case.txt');
 await f.file('Directory/Case.txt','new');await f.service.observe(result(),f.ctx);assert.equal(f.batches[1].positions[0].path,'Directory/Case.txt');assert.equal(f.batches[1].positions[0].phase,'completed');
});
test('case normalization never admits an external symlink or junction target',async t=>{
 const f=await fixture(t),outside=await fixture(t);await outside.file('Case.txt','old');await symlink(outside.root,join(f.root,'External'),process.platform==='win32'?'junction':'dir');
 await f.service.observe(edit('old','new',{file_path:'External/Case.txt'}),f.ctx);assert.equal(f.batches.length,0);
 await f.service.observe(edit('old','new',{file_path:'external/case.txt'}),f.ctx);assert.equal(f.batches.length,0);
});
