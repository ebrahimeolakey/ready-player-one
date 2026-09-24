import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
import {RunCoordinator} from '../core/run-coordinator.mjs';
import {SecureStore} from '../core/secure-store.mjs';
const pause=()=>new Promise(r=>setTimeout(r,10));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await pause();}throw Error('condition timeout');}
function fakeRuntime(){return {runs:new Map(),started:[],decisions:[],steered:[],async steer(runId,text,images){this.steered.push({runId,text,images});},async start(options){this.started.push(options);this.runs.set(options.runId,options);},respondApproval(runId,id,decision){this.decisions.push({runId,id,decision});},async interrupt(id){this.runs.delete(id);},close(){this.runs.clear();}};}
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-claim-recovery-')),key=randomBytes(32);
 const env={dir,key,hub:new Hub(join(dir,'hub')),coordinators:[]};await env.hub.listen();
 env.client=new HubClient();env.auth={token:env.hub.db.hostToken,secret:randomBytes(32).toString('hex'),name:'review'};
 await env.client.connect(`ws://127.0.0.1:${env.hub.port}`,env.auth);
 const workspace=await env.client.call('workspace.create',{name:'Temporary review'});
 env.session=await env.client.call('session.create',{workspaceId:workspace.id,title:'Recovery'});
 env.lane=await env.client.call('lane.create',{sessionId:env.session.id,provider:'codex'});
 env.approval=await env.client.call('run.request',{sessionId:env.session.id,laneId:env.lane.id,prompt:'No real provider',mode:'read-only'});
 await env.client.call('approval.decide',{id:env.approval.id,allow:true});
 env.make=(name='outbox')=>{const runtime=fakeRuntime(),store=new SecureStore({dir:join(dir,name),key});const coordinator=new RunCoordinator({runtime,client:()=>env.client,dir:store.dir,root:()=>dir});coordinator.attachStore(store);env.coordinators.push(coordinator);return {runtime,store,coordinator};};
 t.after(async()=>{for(const c of env.coordinators)c.close();env.client.close();await pause();await env.hub.close();await rm(dir,{recursive:true,force:true});});return env;
}
test('run.claim committed but response lost retries same durable nonce and starts provider once',async t=>{
 const e=await setup(t),{runtime,store,coordinator}=e.make();let dropped=false;
 const call=e.client.call.bind(e.client);e.client.call=async(method,args)=>{const result=await call(method,args);if(method==='run.claim'&&!dropped){dropped=true;throw Error('协作服务响应超时');}return result;};
 await coordinator.start(e.approval);
 assert.equal(e.hub.db.approvals[0].status,'claimed');assert.equal(runtime.started.length,0);
 const prepared=store.readJSON(e.approval.id+'.json');assert.equal(prepared.phase,'prepared');assert.ok(prepared.claimKey);
 assert.deepEqual(await readdir(store.dir),[e.approval.id+'.json.enc']);
 assert.equal((await readFile(join(store.dir,e.approval.id+'.json.enc'),'utf8')).includes(prepared.claimKey),false);
 await until(()=>runtime.started.length===1);
 await coordinator.process();assert.equal(runtime.started.length,1);
 assert.equal(e.hub.db.sessions[0].lanes[0].entries.filter(v=>v.role==='user').length,1);
 assert.equal(store.readJSON(e.approval.id+'.json').claimKey,prepared.claimKey);
});
test('tool.claim committed but response lost returns the decision exactly once after retry',async t=>{
 const e=await setup(t),{runtime,coordinator}=e.make();await coordinator.start(e.approval);
 runtime.started[0].onEvent({type:'approval',approvalId:'provider-tool',request:{kind:'file',path:'example.txt'}});
 await until(()=>e.hub.db.toolApprovals.length===1);const approval=e.hub.db.toolApprovals[0];
 await e.client.call('tool.decide',{id:approval.id,allow:true});let dropped=false;
 const call=e.client.call.bind(e.client);e.client.call=async(method,args)=>{const result=await call(method,args);if(method==='tool.claim'&&!dropped){dropped=true;throw Error('协作服务响应超时');}return result;};
 await coordinator.process();assert.equal(approval.status,'consumed');assert.equal(runtime.decisions.length,0);
 await until(()=>runtime.decisions.length===1);assert.equal(runtime.decisions[0].decision.allow,true);
 await coordinator.process();assert.equal(runtime.decisions.length,1);
});
test('a second same-owner coordinator cannot replay another local process claim or finish it',async t=>{
 const e=await setup(t),first=e.make('first'),second=e.make('second');
 await Promise.all([first.coordinator.start(e.approval),second.coordinator.start(e.approval)]);
 assert.equal(first.runtime.started.length+second.runtime.started.length,1);
 assert.equal(e.hub.db.sessions[0].lanes[0].status,'running');
 const loser=first.runtime.started.length?second:first;assert.equal(loser.coordinator.issues.length,1);
});
test('encrypted outbox survives a new built-in Hub port and reports interruption without rerunning',async t=>{
 const e=await setup(t),first=e.make();await first.coordinator.start(e.approval);
 e.client.closed=true;e.client.ws.close();await until(()=>e.client.ws.readyState===3);
 first.runtime.started[0].onEvent({type:'message',role:'assistant',itemId:'finished-text',text:'recover this output'});
 const oldUrl=e.client.url;first.coordinator.close();await e.hub.close();e.hub=new Hub(join(e.dir,'hub'));await e.hub.listen();
 await e.client.connect(`ws://127.0.0.1:${e.hub.port}`,e.auth);
 assert.notEqual(e.client.url,oldUrl);
 const restarted=e.make();await restarted.coordinator.process();
 await until(()=>restarted.coordinator.records.get(e.approval.id).delivered);
 assert.equal(restarted.runtime.started.length,0);
 assert.equal(e.hub.db.sessions[0].lanes[0].status,'interrupted');
 assert.ok(e.hub.db.sessions[0].lanes[0].entries.some(v=>v.text==='recover this output'));
});
for(const reachedHub of [false,true])test(`restart prepared claim (Hub received: ${reachedHub}) settles interruption and never starts provider`,async t=>{
 const e=await setup(t),first=e.make();const call=e.client.call.bind(e.client);
 e.client.call=async(method,args)=>{if(method==='run.claim'){if(reachedHub)await call(method,args);throw Error('协作服务响应超时');}return call(method,args);};
 await first.coordinator.start(e.approval);assert.equal(first.runtime.started.length,0);first.coordinator.close();e.client.call=call;
 e.client.close();await until(()=>e.client.ws.readyState===3);await e.hub.close();e.hub=new Hub(join(e.dir,'hub'));await e.hub.listen();await e.client.connect(`ws://127.0.0.1:${e.hub.port}`,e.auth);
 const restarted=e.make();await restarted.coordinator.process();await until(()=>restarted.coordinator.records.get(e.approval.id).delivered);
 assert.equal(restarted.runtime.started.length,0);assert.equal(e.hub.db.sessions[0].lanes[0].status,'interrupted');
});
test('legacy scope never migrates implicitly; explicit host verifier authorizes each record',async t=>{
 const e=await setup(t),{store,coordinator}=e.make();
 const legacy={runId:e.approval.id,sessionId:e.session.id,laneId:e.lane.id,workspaceId:e.approval.workspaceId,scope:createHash('sha256').update('ws://127.0.0.1:9999\n'+e.auth.secret).digest('hex'),pending:[],ended:true};
 store.writeJSON(legacy.runId+'.json',legacy);coordinator.attachStore(store);await coordinator.process();assert.equal(coordinator.records.get(legacy.runId).scope,legacy.scope);
 assert.equal(coordinator.migrateLegacyLocalRecords({hubId:e.hub.identity.info.audience,secret:e.auth.secret,verify:()=>false}).migrated,0);
 assert.equal(coordinator.migrateLegacyLocalRecords({hubId:e.hub.identity.info.audience,secret:e.auth.secret,verify:r=>r.runId===e.approval.id}).migrated,1);
 assert.equal(store.readJSON(legacy.runId+'.json').scope,coordinator.scope(e.client));
});

test('encrypted prepared record interrupted before rename is recovered from authenticated pending file',async t=>{
 const e=await setup(t),{coordinator,store}=e.make();const record={runId:e.approval.id,sessionId:e.session.id,laneId:e.lane.id,workspaceId:e.approval.workspaceId,hubId:e.hub.identity.info.audience,scope:coordinator.scope(e.client),claimKey:'11111111-1111-4111-8111-111111111111',phase:'prepared',pending:[],ended:false};
 const failingStore=new SecureStore({dir:store.dir,key:e.key,beforeCommit:()=>{throw Error('simulate crash before rename');}});
 assert.throws(()=>failingStore.writeJSON(record.runId+'.json',record),/simulate crash/);
 assert.match((await readdir(store.dir))[0],/\.pending$/);
 coordinator.attachStore(store);assert.equal(coordinator.records.get(record.runId).claimKey,record.claimKey);
 await coordinator.process();await until(()=>coordinator.records.get(record.runId).delivered);assert.equal(e.hub.db.sessions[0].lanes[0].status,'interrupted');
});

test('lost steering acknowledgement retries only its outbox event, preserving local images exactly once',async t=>{
 const e=await setup(t),{runtime,coordinator}=e.make();await coordinator.start(e.approval);const images=[{name:'local.png',mimeType:'image/png',data:'local-only'}];coordinator.steeringImages=()=>images;
 const instruction=await e.client.call('run.steer',{sessionId:e.session.id,laneId:e.lane.id,runId:e.approval.id,text:'one instruction'});
 const call=e.client.call.bind(e.client);let dropped=false;
 e.client.call=async(method,args)=>{const result=await call(method,args);if(method==='run.steer.ack'&&!dropped){dropped=true;throw Error('协作服务响应超时');}return result;};
 await coordinator.process();await until(()=>dropped);await coordinator.process();
 await until(()=>!coordinator.records.get(e.approval.id).pending.length);
 assert.deepEqual(runtime.steered,[{runId:e.approval.id,text:'one instruction',images}]);
 assert.equal(e.hub.db.sessions[0].lanes[0].steering.find(v=>v.id===instruction.id).status,'delivered');
});
test('stale pending steering from an older run never reaches the current provider',async t=>{
 const e=await setup(t),{runtime,coordinator}=e.make();await coordinator.start(e.approval);
 e.client.state.sessions[0].lanes[0].steering=[{id:'old-instruction',runId:'previous-run',status:'pending',text:'stale'}];
 await coordinator.process();assert.equal(runtime.steered.length,0);
});

test('close pauses new approvals synchronously; only explicit resume permits starting again',async t=>{
 const e=await setup(t),{runtime,coordinator}=e.make();await coordinator.close();await coordinator.process();await coordinator.start(e.approval);assert.equal(runtime.started.length,0);
 await coordinator.resume();await until(()=>runtime.started.length===1);assert.equal(runtime.started.length,1);
});
