import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
import {RunCoordinator} from '../core/run-coordinator.mjs';
import {SecureStore} from '../core/secure-store.mjs';
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await tick();}throw Error('condition timeout');}
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-outcomes-')),hub=new Hub(join(dir,'hub'));
 const owner={id:'owner',name:'owner',host:true},w=hub.act(owner,'workspace.create',{name:'Outcomes'});
 const session=hub.act(owner,'session.create',{workspaceId:w.id,title:'Outcome test'});
 const lane=hub.act(owner,'lane.create',{sessionId:session.id,provider:'codex'});
 const run=hub.act(owner,'run.request',{sessionId:session.id,laneId:lane.id,prompt:'Synthetic action',mode:'workspace-write'});
 hub.act(owner,'approval.decide',{id:run.id,allow:true});const claimKey=randomUUID();hub.act(owner,'run.claim',{id:run.id,claimKey});
 const args={sessionId:session.id,laneId:lane.id,runId:run.id,claimKey,dispatchAt:new Date().toISOString(),dispatches:[],observations:[],reason:'Process stopped'};
 t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
 return {dir,hub,owner,w,session,lane,run,args};
}
test('historical report is idempotent, owner-bound, and cannot revive a fenced/replaced run',async t=>{
 const e=await setup(t);e.lane.fencedRunId=e.run.id;e.lane.activeRunId='new-run';e.lane.status='running';
 assert.throws(()=>e.hub.act(e.owner,'outcome.report',{...e.args,claimKey:randomUUID()}),/领取凭证/);
 const outcome=e.hub.act(e.owner,'outcome.report',e.args);
 assert.equal(e.hub.act(e.owner,'outcome.report',{...e.args,reason:'overwrite'}),outcome);
 assert.equal(e.hub.db.outcomes.length,1);assert.equal(outcome.reason,'Process stopped');
 assert.equal(e.lane.activeRunId,'new-run');assert.equal(e.lane.status,'running');assert.equal(e.lane.fencedRunId,e.run.id);
 const other={id:'other',name:'other',workspaceId:e.w.id,host:false};e.hub.registerMember(other,e.w.id,'editor');
 assert.throws(()=>e.hub.act(other,'outcome.report',e.args),/自己的/);
});
test('whitespace-only optional output cannot block unknown outcome reporting',async t=>{
 const e=await setup(t);const o=e.hub.act(e.owner,'outcome.report',{...e.args,lastOutput:'\n  \t'});
 assert.equal(o.lastOutput,null);assert.equal(o.status,'unknown');
});
test('resolution requires editor, evidence, expected version; retries deduplicate and history only appends',async t=>{
 const e=await setup(t),o=e.hub.act(e.owner,'outcome.report',e.args);
 const editor={id:'editor',name:'editor',workspaceId:e.w.id,host:false},viewer={...editor,id:'viewer'};
 e.hub.registerMember(editor,e.w.id,'editor');e.hub.registerMember(viewer,e.w.id,'viewer');
 const a={id:o.id,requestId:randomUUID(),expectedVersion:0,status:'succeeded',evidence:'Verified local file checksum.'};
 assert.throws(()=>e.hub.act(viewer,'outcome.resolve',a),/editor 权限/);
 assert.throws(()=>e.hub.act(editor,'outcome.resolve',{...a,evidence:''}),/证据/);
 e.hub.act(editor,'outcome.resolve',a);e.hub.act(editor,'outcome.resolve',a);
 assert.equal(o.version,1);assert.equal(o.history.length,1);
 assert.throws(()=>e.hub.act(e.owner,'outcome.resolve',{...a,requestId:randomUUID(),status:'failed'}),/其他成员/);
 assert.throws(()=>e.hub.act(editor,'outcome.resolve',{...a,evidence:'change'}),/不能更改/);
 e.hub.act(e.owner,'outcome.resolve',{...a,requestId:randomUUID(),expectedVersion:1,status:'unknown',evidence:'Conflicting receipt; investigate.'});
 assert.equal(o.history.length,2);assert.equal(o.history[0].status,'succeeded');assert.equal(o.status,'unknown');
 assert.equal(e.lane.status,'running');assert.equal(e.hub.db.approvals.length,1);
 const another=e.hub.act(e.owner,'workspace.create',{name:'Other'}),outsider={id:'outsider',name:'outsider',host:false,workspaceId:another.id};e.hub.registerMember(outsider,another.id,'editor');
 assert.deepEqual(e.hub.snapshot(outsider).outcomes,[]);
 assert.throws(()=>e.hub.act(outsider,'outcome.resolve',{...a,workspaceId:another.id,requestId:randomUUID(),expectedVersion:2}),/访问权限/);
 e.hub.broadcast();const persisted=e.hub.store.readJSON('hub.json').outcomes[0];assert.equal(persisted.history.length,2);assert.equal(JSON.stringify(persisted).includes(e.args.claimKey),false);
});
test('tool evidence derives from matching consumed approval; forged input is not trusted',async t=>{
 const e=await setup(t),a=e.hub.act(e.owner,'tool.request',{...e.args,providerRequestId:'file-1',action:'write',input:{path:'test.txt',apiKey:'private-value'}});
 e.hub.act(e.owner,'tool.decide',{id:a.id,allow:true});e.hub.act(e.owner,'tool.claim',{id:a.id,claimKey:randomUUID()});
 assert.throws(()=>e.hub.act(e.owner,'outcome.report',{...e.args,dispatches:[{approvalId:randomUUID(),at:e.args.dispatchAt}]}),/对应/);
 const o=e.hub.act(e.owner,'outcome.report',{...e.args,dispatches:[{approvalId:a.id,at:e.args.dispatchAt,action:'forged',input:'forged'}]});
 assert.equal(o.dispatches[0].action,'write');assert.equal(o.dispatches[0].providerRequestId,'file-1');assert.equal(JSON.stringify(o).includes('private-value'),false);
});
test('split credentials remain redacted in output evidence and report payload is immutable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rpo-outcome-redact-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const coordinator=new RunCoordinator({runtime:{runs:new Map()},client:()=>null,dir});
 const r={runId:randomUUID(),dispatchAt:new Date().toISOString(),dispatches:[],observations:[],pending:[]};
 coordinator.observe(r,{type:'delta',itemId:'a',text:'api_key=demo_secret_'});
 coordinator.observe(r,{type:'delta',itemId:'b',text:'other tool progress'});
 coordinator.observe(r,{type:'delta',itemId:'a',text:'UNREDACTED_SUFFIX'});
 assert.equal(String(r.lastOutput).includes('UNREDACTED_SUFFIX'),false);
 coordinator.reportOutcome(r,'interrupted');
 r.observations.push({text:'future'});r.dispatches.push({approvalId:'future'});
 assert.equal(r.outcome.observations.length,0);assert.equal(r.outcome.dispatches.length,0);
 assert.equal(JSON.stringify(r.outcome).includes('UNREDACTED_SUFFIX'),false);
 coordinator.observe(r,{type:'message',itemId:'b',text:'final public output'});
 assert.equal(r.lastOutput,'final public output');
});
test('real local side effect with lost provider acknowledgement is never resent, including after encrypted recovery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rpo-outcome-recovery-')),hub=new Hub(join(dir,'hub')),key=randomBytes(32);await hub.listen();
 const c=new HubClient();await c.connect(`ws://127.0.0.1:${hub.port}`,{token:hub.db.hostToken,secret:randomBytes(32).toString('hex'),name:'tester'});
 const w=await c.call('workspace.create',{name:'Synthetic'}),s=await c.call('session.create',{workspaceId:w.id,title:'Counter'}),l=await c.call('lane.create',{sessionId:s.id,provider:'codex'});
 const a=await c.call('run.request',{sessionId:s.id,laneId:l.id,prompt:'Increment fixture once',mode:'workspace-write'});await c.call('approval.decide',{id:a.id,allow:true});
 const counter=join(dir,'counter.txt');await writeFile(counter,'0');let starts=0,decisions=0;
 const runtimes=[],coordinators=[];
 const make=()=>{const runtime={runs:new Map(),async start(opts){starts++;this.runs.set(opts.runId,opts);},async respondApproval(){decisions++;await writeFile(counter,String(Number(await readFile(counter,'utf8'))+1));throw Error('响应超时');},async interrupt(id){this.runs.delete(id);},close(){this.runs.clear();}};runtimes.push(runtime);const store=new SecureStore({dir:join(dir,'outbox'),key});const coordinator=new RunCoordinator({runtime,client:()=>c,dir:store.dir,root:()=>dir});coordinator.attachStore(store);coordinators.push(coordinator);return {runtime,coordinator,store};};
 t.after(async()=>{for(const x of coordinators)x.close();c.close();await tick();await hub.close();await rm(dir,{recursive:true,force:true});});
 const first=make();await first.coordinator.start(a);await until(()=>!first.coordinator.records.get(a.id).pending.length);
 first.runtime.runs.get(a.id).onEvent({type:'approval',approvalId:'increment',request:{kind:'command',command:'increment fixture'}});
 await until(()=>hub.db.toolApprovals.length===1);const tool=hub.db.toolApprovals[0];await c.call('tool.decide',{id:tool.id,allow:true});
 const original=c.call.bind(c);let dropped=false;c.call=async(method,args)=>{const result=await original(method,args);if(method==='outcome.report'&&!dropped){dropped=true;throw Error('响应超时');}return result;};
 await first.coordinator.process();await until(()=>hub.db.outcomes.length===1);await first.coordinator.process();
 assert.equal(await readFile(counter,'utf8'),'1');assert.equal(decisions,1);
 assert.equal(hub.db.outcomes[0].dispatches[0].approvalId,tool.id);assert.equal(hub.db.outcomes[0].dispatches[0].providerRequestId,'increment');
 first.coordinator.close();const next=make();await next.coordinator.process();await until(()=>next.coordinator.records.get(a.id).outcomeDelivered&&next.coordinator.records.get(a.id).delivered);
 assert.equal(starts,1);assert.equal(decisions,1);assert.equal(await readFile(counter,'utf8'),'1');assert.equal(hub.db.outcomes.length,1);
 assert.equal(next.store.readJSON(a.id+'.json').outcomeDelivered,true);
});
