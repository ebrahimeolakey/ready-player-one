import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hub} from './helpers/secure-hub.mjs';
import {codexFailure} from '../core/providers/failure.mjs';
const quota=codexFailure({codexErrorInfo:'usageLimitExceeded'}), commit='a'.repeat(40);
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-quota-')),hub=new Hub(dir),owner={id:'owner',name:'owner',host:true};
 const w=hub.act(owner,'workspace.create',{name:'quota'}),s=hub.act(owner,'session.create',{workspaceId:w.id,title:'synthetic'});
 const peers={};for(const role of ['editor','viewer']){const p={id:role,name:role,host:false,workspaceId:w.id};hub.registerMember(p,w.id,role);peers[role]=p;}
 const act=(p,method,args={})=>hub.act(p,method,{sessionId:s.id,workspaceId:w.id,...args});
 const lane=act(peers.editor,'lane.create',{provider:'codex'}), target=act(owner,'lane.create',{provider:'claude'});
 const ap=act(peers.editor,'run.request',{laneId:lane.id,prompt:'synthetic',mode:'read-only'});act(owner,'approval.decide',{id:ap.id,allow:true});act(peers.editor,'run.claim',{id:ap.id});
 const finish=(args={})=>act(peers.editor,'run.finish',{laneId:lane.id,runId:ap.id,status:'error',failure:quota,...args});
 t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});return {hub,act,owner,peers,s,lane,target,ap,finish};
}
test('quota finish is owner/run/source fenced, idempotent, stores last confirmed snapshot and pauses queue',async t=>{
 const {act,owner,peers,s,lane,ap,finish}=await setup(t);
 act(peers.editor,'snapshot.publish',{laneId:lane.id,ref:`refs/rpo/snapshots/${s.id}/${peers.editor.id}`,commit});
 act(peers.editor,'run.queue',{laneId:lane.id,prompt:'next synthetic',mode:'read-only'});
 for(const p of [owner,peers.viewer])assert.throws(()=>act(p,'run.finish',{laneId:lane.id,runId:ap.id,status:'error',failure:quota}));
 assert.throws(()=>finish({runId:'stale'}));
 assert.throws(()=>finish({failure:{...quota,source:'claude'}}));
 assert.throws(()=>finish({failure:{...quota,kind:'authentication'}}));
 assert.throws(()=>finish({status:'done'}));assert.equal(lane.status,'running');
 finish();assert.equal(lane.status,'needs_handoff');assert.equal(ap.status,'finished');
 assert.equal(lane.handoffNeeded.lastConfirmedSnapshot.commit,commit);const preserved=structuredClone(lane.handoffNeeded);
 lane.snapshot={...lane.snapshot,commit:'b'.repeat(40)};
 finish({status:'done',failure:undefined});assert.deepEqual(lane.handoffNeeded,preserved);assert.equal(lane.status,'needs_handoff');
 assert.throws(()=>act(peers.editor,'run.queue.next',{laneId:lane.id}),/需要接管/);assert.equal(lane.queue[0].status,'queued');
 assert.throws(()=>act(peers.editor,'run.entry',{laneId:lane.id,runId:ap.id,role:'assistant',text:'late'}),/结束/);
 const next=act(peers.editor,'run.request',{laneId:lane.id,prompt:'explicit user retry',mode:'read-only'});act(owner,'approval.decide',{id:next.id,allow:true});act(peers.editor,'run.claim',{id:next.id});
 assert.equal(lane.handoffNeeded,undefined);assert.equal(lane.failure,undefined);assert.throws(()=>finish(),/标识/);
});
test('stopped run cannot be changed to quota state; ordinary errors and absent snapshots stay truthful',async t=>{
 const {act,peers,lane,ap,finish}=await setup(t);act(peers.editor,'lane.stop',{laneId:lane.id});assert.throws(()=>finish(),/撤销/);assert.equal(lane.handoffNeeded,undefined);
 const next=act(peers.editor,'run.request',{laneId:lane.id,prompt:'explicit retry',mode:'read-only'});
 // Approval is not granted: late result from old run still cannot mutate state.
 assert.notEqual(next.id,ap.id);assert.throws(()=>finish());
});
test('quota handoff remains single-winner and requires source acknowledgement, checkpoint sync and fresh approval',async t=>{
 const {hub,act,owner,peers,s,lane,target,ap,finish}=await setup(t);
 finish();assert.equal(lane.handoffNeeded.lastConfirmedSnapshot,null);
 const h=act(owner,'handoff.request',{laneId:lane.id,targetLaneId:target.id});
 const rival={id:'rival',name:'rival',host:false,workspaceId:s.workspaceId};hub.registerMember(rival,s.workspaceId,'editor');const rivalLane=act(rival,'lane.create',{provider:'codex'});
 assert.throws(()=>act(rival,'handoff.request',{laneId:lane.id,targetLaneId:rivalLane.id}),/已有待处理/);
 assert.throws(()=>act(peers.editor,'handoff.ack',{id:h.id,snapshotCommit:commit}),/快照/);
 act(peers.editor,'snapshot.publish',{laneId:lane.id,ref:`refs/rpo/snapshots/${s.id}/${peers.editor.id}`,commit});
 assert.throws(()=>act(owner,'handoff.ack',{id:h.id,snapshotCommit:commit}),/原执行者/);
 act(peers.editor,'handoff.ack',{id:h.id,snapshotCommit:commit});
 assert.throws(()=>act(peers.editor,'run.queue.next',{laneId:lane.id}),/需要接管/);
 assert.throws(()=>act(rival,'handoff.accept',{id:h.id,syncedCommit:commit}),/未准备好/);
 assert.throws(()=>act(owner,'handoff.accept',{id:h.id,syncedCommit:'b'.repeat(40)}),/同步/);
 target.providerSessionId='old-session';const accepted=act(owner,'handoff.accept',{id:h.id,syncedCommit:commit});
 assert.equal(accepted.approval.status,'pending');assert.equal(target.providerSessionId,undefined);assert.equal(target.status,'awaiting');
 assert.throws(()=>act(owner,'handoff.accept',{id:h.id,syncedCommit:commit}),/已经处理/);
 assert.throws(()=>act(peers.editor,'run.queue.next',{laneId:lane.id}),/需要接管/);
 // Delayed duplicate finish cannot undo the handoff fence or restart a run.
 finish();assert.equal(lane.status,'interrupted');assert.equal(h.status,'accepted');assert.equal(ap.status,'finished');
});
test('context/budget/auth errors and textual quota claims never produce an automatic handoff state',async t=>{
 for(const code of ['contextWindowExceeded','sessionBudgetExceeded','unauthorized',null]){
  const {lane,finish}=await setup(t);finish({failure:code?codexFailure({codexErrorInfo:code}):undefined,message:'quota exhausted 429'});
  assert.equal(lane.status,'error');assert.equal(lane.handoffNeeded,undefined);
 }
});
