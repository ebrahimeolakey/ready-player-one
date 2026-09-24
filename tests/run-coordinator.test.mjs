import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
import {RunCoordinator} from '../core/run-coordinator.mjs';
const pause=()=>new Promise(r=>setTimeout(r,20));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await pause();}throw Error('condition timeout');}
async function setup(t,options=()=>({})){
 const dir=await mkdtemp(join(tmpdir(),'rpo-relay-')),hub=new Hub(join(dir,'hub'));await hub.listen();
 const client=new HubClient();const url=`ws://127.0.0.1:${hub.port}`,auth={token:hub.db.hostToken,secret:randomBytes(32).toString('hex'),name:'test'};await client.connect(url,auth);
 const w=await client.call('workspace.create',{name:'test',branch:'main'});const s=await client.call('session.create',{workspaceId:w.id,title:'relay'});const lane=await client.call('lane.create',{sessionId:s.id,provider:'codex'});
 const runtime={runs:new Map(),decisions:[],starts:0,async start(o){this.starts++;this.options=o;this.runs.set(o.runId,{});},respondApproval(runId,id,decision){this.decisions.push({runId,id,...decision});},async interrupt(runId){this.runs.delete(runId);},close(){this.runs.clear();}};
 const coordinator=new RunCoordinator({runtime,client:()=>client,root:()=>dir,dir:join(dir,'outbox'),options});
 client.on('state',()=>coordinator.process().catch(()=>{}));
 const request=await client.call('run.request',{sessionId:s.id,laneId:lane.id,prompt:'test',mode:'read-only',files:[]});await client.call('approval.decide',{id:request.id,allow:true});await until(()=>runtime.options);
 t.after(async()=>{coordinator.close();client.close();await pause();await hub.close();await rm(dir,{recursive:true,force:true});});
 // A provider starting does not imply its initial configuration has reached the Hub.
 // Establish the online baseline before tests disconnect and count subsequent offline events.
 await until(()=>hub.db.sessions.find(v=>v.id===s.id)?.lanes.find(v=>v.id===lane.id)?.runConfiguration?.runId===request.id && coordinator.records.get(request.id)?.pending.length===0);
 return {hub,client,url,auth,runtime,coordinator,s,lane,request};
}
test('durable relay streams ordered deltas and consumes one tool approval exactly once',async t=>{
 const {hub,client,runtime,lane,request}=await setup(t);
 runtime.options.onEvent({type:'session',sessionId:'native-1'});
 runtime.options.onEvent({type:'delta',role:'assistant',itemId:'text',text:'hello '});
 runtime.options.onEvent({type:'delta',role:'assistant',itemId:'text',text:'world'});
 runtime.options.onEvent({type:'approval',approvalId:'native-tool',request:{kind:'file',path:'test.txt'}});
 await until(()=>hub.db.toolApprovals.length===1);
 const approval=hub.db.toolApprovals[0];await client.call('tool.decide',{id:approval.id,allow:false});await until(()=>runtime.decisions.length===1);
 assert.equal(runtime.decisions[0].allow,false);assert.equal(hub.db.toolApprovals[0].status,'consumed');
 await client.call('state');await pause();assert.equal(runtime.decisions.length,1);
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done',message:'finished'});
 await until(()=>hub.db.sessions[0].lanes[0].status==='done');
 const stored=hub.db.sessions[0].lanes.find(l=>l.id===lane.id);assert.equal(stored.providerSessionId,'native-1');assert.equal(stored.entries.find(e=>e.role==='assistant').text,'hello world');
});
test('run configuration fixes sent options and durably relays deduplicated provider confirmation after reconnect',async t=>{
 const {hub,client,url,auth,runtime,coordinator,lane,request}=await setup(t,()=>({model:'alias',effort:'high'}));
 const shared=()=>hub.db.sessions[0].lanes.find(l=>l.id===lane.id);
 await until(()=>shared().runConfiguration?.requested.model==='alias');
 assert.equal(runtime.options.model,'alias');assert.equal(shared().runConfiguration.reported,undefined);
 await until(()=>coordinator.records.get(request.id).pending.length===0);
 client.closed=true;client.ws.close();await until(()=>client.ws.readyState===3);
 runtime.options.onEvent({type:'configuration',model:'resolved-model',effort:null});
 runtime.options.onEvent({type:'configuration',model:'resolved-model',effort:null});
 assert.equal(coordinator.records.get(request.id).pending.length,1);
 await client.connect(url,auth);await until(()=>shared().runConfiguration?.reported?.model==='resolved-model');
 assert.equal(shared().runConfiguration.requested.model,'alias');
 assert.equal(shared().runConfiguration.reported.sequence,1);assert.equal(shared().runConfiguration.reported.effort,null);
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done'});await until(()=>shared().status==='done');
});
test('provider continues offline and replays output without duplicate execution after reconnect',async t=>{
 const {hub,client,url,auth,runtime,coordinator,request}=await setup(t);
 client.closed=true;client.ws.close();await until(()=>client.ws.readyState===3);
 runtime.options.onEvent({type:'delta',role:'assistant',itemId:'text',text:'offline output'});
 assert(runtime.runs.has(request.id));assert.equal(coordinator.records.get(request.id).pending.length,1);
 await client.connect(url,auth);await until(()=>hub.db.sessions[0].lanes[0].entries.some(e=>e.text==='offline output'));
 assert.equal(runtime.options.runId,request.id);await until(()=>coordinator.records.get(request.id).pending.length===0);
 assert.equal(runtime.starts,1);assert.equal(hub.db.sessions[0].lanes[0].entries.filter(e=>e.text==='offline output').length,1);
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done'});await until(()=>hub.db.sessions[0].lanes[0].status==='done');
});

test('tool lifecycle replaces one record while reasoning remains separate',async t=>{
 const {hub,runtime,request}=await setup(t);
 runtime.options.onEvent({type:'tool',itemId:'call-1',phase:'started',item:{name:'read_file',path:'note.txt'}});
 runtime.options.onEvent({type:'delta',role:'reasoning',itemId:'reason-1',text:'Checking scope'});
 runtime.options.onEvent({type:'tool',itemId:'call-1',phase:'completed',item:{name:'read_file',path:'note.txt',output:'done'}});
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done'});
 await until(()=>hub.db.sessions[0].lanes[0].status==='done');
 const entries=hub.db.sessions[0].lanes[0].entries;
 const tools=entries.filter(e=>e.role==='tool');assert.equal(tools.length,1);
 assert.equal(JSON.parse(tools[0].text).phase,'completed');
 assert.equal(JSON.parse(tools[0].text).output,'done');
 assert.equal(entries.filter(e=>e.role==='reasoning').length,1);
 assert.equal(entries.find(e=>e.role==='reasoning').text,'Checking scope');
});

test('usage survives offline durable outbox, shares context separately, and precedes run completion',async t=>{
 const {codexUsage}=await import('../core/providers/usage.mjs');
 const {hub,client,url,auth,runtime,coordinator,request}=await setup(t);
 client.closed=true;client.ws.close();await until(()=>client.ws.readyState===3);
 const usageSnapshot=codexUsage({last:{totalTokens:100},total:{totalTokens:900},modelContextWindow:2000});
 runtime.options.onEvent({type:'usage',usageSnapshot});
 runtime.options.onEvent({type:'usage',usageSnapshot:{...usageSnapshot,context:{...usageSnapshot.context,usedTokens:40}}});
 // Invalid provider data is dropped before it can poison the durable queue.
 runtime.options.onEvent({type:'usage',usageSnapshot:{...usageSnapshot,context:{...usageSnapshot.context,usedTokens:-2}}});
 const r=coordinator.records.get(request.id);assert.equal(r.pending.length,2);assert.equal(r.usageSequence,2);
 const {readFile}=await import('node:fs/promises');const persisted=JSON.parse(await readFile(join(coordinator.dir,request.id+'.json'),'utf8'));
 assert.equal(persisted.pending[1].args.sequence,2);assert.equal(persisted.pending[1].args.usage.context.usedTokens,40);
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done'});
 assert.equal(r.pending.at(-1).method,'run.finish');
 await client.connect(url,auth);await until(()=>hub.db.sessions[0].lanes[0].status==='done');
 assert.equal(hub.db.sessions[0].lanes[0].usage.context.usedTokens,40);
 assert.equal(hub.db.sessions[0].lanes[0].usage.cumulative.totalTokens,900);
 assert.equal(hub.db.sessions[0].lanes[0].usage.sequence,2);
 assert.equal(runtime.starts,1);
});

test('a committed usage update with lost acknowledgement retries the same sequence without double counting',async t=>{
 const {codexUsage}=await import('../core/providers/usage.mjs');
 const {hub,client,runtime,coordinator,request}=await setup(t);
 const call=client.call.bind(client);let lost=false,updates=0;
 client.call=async(method,args)=>{const result=await call(method,args);if(method==='run.usage'){updates++;if(!lost){lost=true;throw Error('合成响应超时');}}return result;};
 runtime.options.onEvent({type:'usage',usageSnapshot:codexUsage({last:{totalTokens:7},total:{totalTokens:70}})});
 runtime.runs.delete(request.id);runtime.options.onEnd({status:'done'});
 await until(()=>coordinator.records.get(request.id).delivered);
 assert.equal(updates,2);assert.equal(hub.db.sessions[0].lanes[0].usage.sequence,1);
 assert.equal(hub.db.sessions[0].lanes[0].usage.cumulative.totalTokens,70);
 const r=coordinator.records.get(request.id);runtime.options.onEvent({type:'usage',usageSnapshot:codexUsage({last:{totalTokens:8}})});assert.equal(r.pending.length,0);
});
