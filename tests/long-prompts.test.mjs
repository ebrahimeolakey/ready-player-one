import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {PROMPT_LIMITS,DRAFT_LIMITS,SUMMARY_LIMIT,CONTEXT_LIMIT,promptStats,validatePrompt,summarizePrompt,providerPrompt} from '../core/prompt-limits.mjs';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
import {RunCoordinator} from '../core/run-coordinator.mjs';
import {SecureStore} from '../core/secure-store.mjs';
import {ComposerStore} from '../desktop/services/composer.mjs';
import {codexInput,claudeInput} from '../core/providers/input.mjs';
const png={name:'测试.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII='};
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await tick();}throw Error('condition timeout');}
const original=' \n'+ '中文😀'.repeat(18000)+'\napi_key=synthetic_secret_tail_123456789\n尾部要求保留 \t';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-long-prompt-')),hub=new Hub(join(dir,'hub'));await hub.listen();
 const client=new HubClient(),url=`ws://127.0.0.1:${hub.port}`,auth={token:hub.db.hostToken,secret:randomBytes(32).toString('hex'),name:'owner'};await client.connect(url,auth);
 const w=await client.call('workspace.create',{name:'long prompts'}),s=await client.call('session.create',{workspaceId:w.id,title:'任务'}),l=await client.call('lane.create',{sessionId:s.id,provider:'codex'});
 const coords=[],runtimes=[],key=randomBytes(32),storeDir=join(dir,'outbox');
 const make=()=>{const runtime={runs:new Map(),starts:[],steers:[],async start(o){this.starts.push(o);this.runs.set(o.runId,o);},async steer(id,text,images){this.steers.push({id,text,images});},async interrupt(id){this.runs.delete(id);},async close(){this.runs.clear();}};const coordinator=new RunCoordinator({runtime,client:()=>client,dir:storeDir,root:()=>dir,options:()=>({images:[png]}),steeringImages:()=>[png]});coordinator.attachStore(new SecureStore({dir:storeDir,key}));coords.push(coordinator);runtimes.push(runtime);return {coordinator,runtime};};
 t.after(async()=>{for(const c of coords)await c.close();client.close();await tick();await hub.close();await rm(dir,{recursive:true,force:true});});
 const args={sessionId:s.id,laneId:l.id};
 const request=async(prompt=original)=>{const a=await client.call('run.request',{...args,prompt,mode:'read-only'});await client.call('approval.decide',{id:a.id,allow:true});await until(()=>client.state.approvals.some(v=>v.id===a.id&&v.status==='approved'));return client.state.approvals.find(v=>v.id===a.id);};
 return {dir,hub,client,url,auth,w,s,l,args,make,request};
}
test('original limits count Unicode points and UTF-8, preserve whitespace, reject instead of truncate',()=>{
 for(const count of [19999,20000,20001,100000])for(const char of ['中','😀']){const value=char.repeat(count);assert.equal(validatePrompt(value),value);assert.equal(promptStats(value).codePoints,count);}
 assert.equal(promptStats('😀'.repeat(100000)).utf8Bytes,PROMPT_LIMITS.utf8Bytes);
 assert.equal(validatePrompt(original),original);
 assert.throws(()=>validatePrompt('😀'.repeat(100001)),/不会截断/);
 for(const invalid of ['\ud800','a\udc00','\ud800a'])assert.throws(()=>validatePrompt(invalid),/Unicode/);
 assert.throws(()=>validatePrompt(' \n\t'),/不能为空/);
 // JSON escaping worst case still fits the actual Hub's 2 MiB envelope.
 assert(Buffer.byteLength(JSON.stringify({method:'run.request',args:{prompt:'\u0001'.repeat(100000)}}))<2*1024*1024);
});
test('coordination summaries are explicit and bounded while Provider receives the complete original and stale warning',()=>{
 const summary=summarizePrompt(original);assert.equal(summary.text,Array.from(original).slice(0,SUMMARY_LIMIT).join(''));assert.equal(summary.truncated,true);assert.equal(summary.codePoints,promptStats(original).codePoints);assert.match(summary.display,/非任务原文/);
 const output=providerPrompt({title:'工作',lanes:[{entries:[{role:'assistant',text:'x'.repeat(25000)}]}]},[{title:'old',text:'旧事实',stale:true}],original);
 assert(output.endsWith(original));assert.match(output,/已过期：核对或更新前不可当作现行事实/);assert(promptStats(output.slice(0,-original.length)).codePoints<CONTEXT_LIMIT+150);
});
test('real WebSocket claim delivers full unredacted original and local images; encrypted restart never reruns it',async t=>{
 const {hub,client,args,make,request,url,auth,dir}=await fixture(t);const a=await request();assert(!a.prompt.includes('synthetic_secret_tail'));
 const first=make();await first.coordinator.start(a);assert.equal(first.runtime.starts.length,1);const sent=first.runtime.starts[0];assert(sent.prompt.endsWith(original));
 assert.equal(codexInput(sent.prompt,sent.images)[0].text,sent.prompt);assert.equal(claudeInput(sent.prompt,sent.images)[0].text,sent.prompt);assert.equal(claudeInput(sent.prompt,sent.images)[1].source.data,png.data);
 await until(()=>first.coordinator.records.get(a.id).pending.length===0);
 client.closed=true;client.ws.close();await until(()=>client.ws.readyState===3);
 sent.onEvent({type:'message',text:'离线输出',itemId:'offline'});assert.equal(first.coordinator.records.get(a.id).pending.length,1);
 await first.coordinator.close();const next=make();await client.connect(url,auth);await next.coordinator.process();await until(()=>next.coordinator.records.get(a.id).delivered&&next.coordinator.records.get(a.id).outcomeDelivered);
 assert.equal(next.runtime.starts.length,0);assert.equal(hub.db.approvals.find(v=>v.id===a.id).prompt,original);assert.equal(hub.db.outcomes.length,1);assert.match(hub.db.outcomes[0].prompt,/协调摘要：已截断/);
 assert.equal(hub.db.sessions[0].lanes[0].status,'interrupted');assert(!String(await readFile(join(dir,'hub','hub.json.enc'))).includes('synthetic_secret_tail'));
 assert.equal((await client.call('state')).sessions[0].lanes[0].entries.filter(v=>v.text==='离线输出').length,1);
});
test('queue, comment task and check preserve original separately from limited overlap coverage',async t=>{
 const {client,args,make,hub}=await fixture(t);
 const q=await client.call('run.queue',{...args,prompt:original,mode:'read-only'});assert.equal(q.prompt,original);
 const check=await client.call('coordination.check',{...args,prompt:original});assert.equal(check.promptSummary.truncated,true);assert.equal(check.promptSummary.codePoints,promptStats(original).codePoints);assert(promptStats(check.promptSummary.text).codePoints<=SUMMARY_LIMIT);
 const next=await client.call('run.queue.next',args);assert.equal(next.approval.prompt,original);await client.call('approval.decide',{id:next.approval.id,allow:true});const {coordinator,runtime}=make();await coordinator.start(next.approval);assert(runtime.starts[0].prompt.endsWith(original));
 runtime.runs.delete(next.approval.id);runtime.starts[0].onEnd({status:'done'});await until(()=>coordinator.records.get(next.approval.id).delivered);
 const comment=await client.call('comment.add',{sessionId:args.sessionId,text:'长任务'});const converted=await client.call('comment.task',{...args,id:comment.id,prompt:original});assert.equal(converted.approval.prompt,original);
 const count=hub.db.approvals.length;await assert.rejects(client.call('run.queue',{...args,prompt:'😀'.repeat(100001),mode:'read-only'}),/不会截断/);assert.equal(hub.db.approvals.length,count);
});
test('steer read retries a lost read ACK, then delivers exact text and images once despite lost delivery ACK',async t=>{
 const {client,args,make,request,hub}=await fixture(t);const a=await request('start');const {coordinator,runtime}=make();await coordinator.start(a);await until(()=>coordinator.records.get(a.id).pending.length===0);
 const call=client.call.bind(client);let readLost=false,ackLost=false,reads=0,acks=0;client.call=async(method,args)=>{const result=await call(method,args);if(method==='run.steer.read'){reads++;if(!readLost){readLost=true;throw Error('合成响应超时');}}if(method==='run.steer.ack'){acks++;if(!ackLost){ackLost=true;throw Error('合成响应超时');}}return result;};
 const instruction=await client.call('run.steer',{...args,runId:a.id,eventId:randomUUID(),text:original});await until(()=>client.state.sessions[0].lanes[0].steering?.length===1);
 assert(!client.state.sessions[0].lanes[0].steering[0].text.includes('synthetic_secret_tail'));
 await coordinator.process();assert.equal(runtime.steers.length,0);await coordinator.process();await until(()=>ackLost);await coordinator.process();await until(()=>coordinator.records.get(a.id).pending.length===0);
 assert.equal(runtime.steers.length,1);assert.equal(runtime.steers[0].text,original);assert.deepEqual(runtime.steers[0].images,[png]);assert.equal(reads,2);assert.equal(acks,2);assert.equal(hub.db.sessions[0].lanes[0].steering[0].status,'delivered');
 await assert.rejects(client.call('run.steer.read',{...args,runId:'other',id:instruction.id}),/已结束/);
});
test('failed guidance raw recovery and long image draft survive encrypted restart without duplicate merge',async t=>{
 const {client,args,make,request,dir,hub}=await fixture(t);const a=await request('start');const {coordinator}=make();await coordinator.start(a);
 const instruction=await client.call('run.steer',{...args,runId:a.id,text:original});await client.call('run.steer.ack',{...args,runId:a.id,id:instruction.id,status:'failed'});
 assert.throws(()=>hub.act({id:'different-owner',name:'other',host:true},'run.steer.read',{...args,runId:a.id,id:instruction.id,restore:true}),/自己的/);
 const raw=await client.call('run.steer.read',{...args,runId:a.id,id:instruction.id,restore:true});assert.equal(raw.text,original);
 const key=randomBytes(32),draftDir=join(dir,'drafts');let store=new ComposerStore(new SecureStore({dir:draftDir,key}));const draft='😀'.repeat(40000);store.save({laneId:args.laneId,text:draft,images:[png],revision:0});const restored=store.restore({laneId:args.laneId,id:instruction.id,text:raw.text,images:[png]});assert.equal(restored.text,draft+'\n\n'+original);
 store=new ComposerStore(new SecureStore({dir:draftDir,key}));assert.deepEqual(store.restore({laneId:args.laneId,id:instruction.id,text:raw.text,images:[png]}),restored);assert.equal(store.read(args.laneId).images.length,1);
 assert(!String(await readFile(join(draftDir,'composer.json.enc'))).includes('synthetic_secret_tail'));
 assert.throws(()=>store.save({laneId:args.laneId,text:'😀'.repeat(DRAFT_LIMITS.codePoints+1),images:[],revision:restored.revision}),/不会截断/);assert.equal(store.read(args.laneId).text,restored.text);
});
test('MCP and real loopback subtask bridge carry a >96 KiB Unicode prompt without truncation',async t=>{
 const {CoordinationBridge}=await import('../desktop/services/coordination-bridge.mjs');
 const {createCoordinationMcp,localSubtaskClient,coordinationTools}=await import('../core/mcp-coordination.mjs');
 const {client,args,w,make,request}=await fixture(t);const a=await request('parent');const {coordinator,runtime}=make();await coordinator.start(a);
 let captured;const bridge=new CoordinationBridge({client:()=>client,runtime,taskCoordination:{async spawnFromAgent(binding,input,validate){await validate();validatePrompt(input.prompt);captured=input;return {id:'synthetic-subtask'};}}});t.after(()=>bridge.close());
 const env=await bridge.issue({...args,runId:a.id,workspaceId:w.id});
 const dispatch=createCoordinationMcp({client,sessionId:args.sessionId,laneId:args.laneId,spawnSubtask:localSubtaskClient(env)});
 await dispatch({jsonrpc:'2.0',id:1,method:'initialize'});
 assert(Buffer.byteLength(original)>96*1024);
 const result=await dispatch({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'rpo_subtask_spawn',arguments:{requestId:randomUUID(),title:'长提示子任务',prompt:original}}});
 assert.equal(result.result.isError,false);assert.equal(captured.prompt,original);assert.equal(coordinationTools.find(v=>v.name==='rpo_subtask_spawn').inputSchema.properties.prompt.maxLength,PROMPT_LIMITS.codePoints);
 const checked=await dispatch({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'rpo_overlap_check',arguments:{prompt:original}}});assert.equal(JSON.parse(checked.result.content[0].text).promptSummary.truncated,true);
 const invalid=await dispatch({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'rpo_subtask_spawn',arguments:{requestId:randomUUID(),title:'invalid',prompt:'😀'.repeat(100001)}}});assert.equal(invalid.result.isError,true);assert.match(invalid.result.content[0].text,/不会截断/);assert.equal(captured.prompt,original);
});
test('a pause while raw guidance read is awaiting its response never dispatches guidance after close',async t=>{
 const {client,args,make,request}=await fixture(t);const a=await request('parent');const {coordinator,runtime}=make();await coordinator.start(a);await until(()=>coordinator.records.get(a.id).pending.length===0);
 await client.call('run.steer',{...args,runId:a.id,text:original});await until(()=>client.state.sessions[0].lanes[0].steering?.length===1);
 const call=client.call.bind(client);let release,readReady;const ready=new Promise(r=>{readReady=r;});client.call=async(method,args)=>{const result=await call(method,args);if(method==='run.steer.read'){readReady();await new Promise(r=>{release=r;});}return result;};
 const pending=coordinator.process();await ready;
 // A real process tree may take time to exit; keep its runtime record until close resolves.
 let finishClose;runtime.close=()=>new Promise(r=>{finishClose=()=>{runtime.runs.clear();r();};});const closing=coordinator.close();release();await pending;assert.equal(runtime.steers.length,0);finishClose();await closing;runtime.close=async()=>runtime.runs.clear();
});
