import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {SecureStore} from '../core/secure-store.mjs';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
import {RunCoordinator} from '../core/run-coordinator.mjs';
import {createWorkspaceLifecycle} from '../desktop/services/workspace-lifecycle.mjs';
import {subtaskConnectionKey} from '../desktop/services/subtask-agent.mjs';
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'rpo-cleanup-')),hub=new Hub(join(dir,'hub')),port=await hub.listen(),client=new HubClient();
 await client.connect(`ws://127.0.0.1:${port}`,{token:hub.db.hostToken,secret:randomBytes(32).toString('hex'),name:'owner'});
 const w=await client.call('workspace.create',{name:'删除',branch:'main'}),s=await client.call('session.create',{workspaceId:w.id,title:'s'}),lane=await client.call('lane.create',{sessionId:s.id,provider:'codex'});
 const runtime={runs:new Map(),close:async()=>{}},coordinator=new RunCoordinator({runtime,client:()=>client,dir:join(dir,'outbox'),root:()=>dir});coordinator.paused=true;
 coordinator.attachStore(new SecureStore({dir:join(dir,'outbox'),key:randomBytes(32)}));
 const settings=new SecureStore({dir:join(dir,'settings'),key:randomBytes(32)}),scope=coordinator.scope(client),id=randomUUID(),other=randomUUID();
 for(const [runId,recordScope]of[[id,scope],[other,'another-hub-identity']]){const r={runId,scope:recordScope,workspaceId:w.id,sessionId:s.id,laneId:lane.id,ended:true,pending:[]};coordinator.records.set(runId,r);coordinator.save(r);}
 const connectionKey=subtaskConnectionKey(client),ownerId=client.state.me.id,settingsKey=createHash('sha256').update(JSON.stringify([connectionKey,ownerId,w.id])).digest('hex');
 const config={paths:{[w.id]:dir},laneOptions:{[lane.id]:{model:'keep'}},agentSubtaskSettings:{[settingsKey]:{enabled:true},other:{enabled:true}},agentSubtaskRequests:{mine:{binding:{connectionKey,ownerId,workspaceId:w.id}},other:{binding:{connectionKey:'other',ownerId,workspaceId:w.id}}}};
 settings.writeJSON('drafts.json',{['rpo-prompt-'+lane.id]:'retain-draft'});
 const images=new Map([[id,['my image']],[other,['other image']]]);let current=client,failImages=false,locked=false;
 const service=createWorkspaceLifecycle({client:()=>current,coordinator,runtime,store:()=>settings,config,saveConfig:()=>settings.writeJSON('client.json',config),runImages:images,saveRunImages:()=>{if(failImages)throw Error('image-write-failure');settings.writeJSON('run-images.json',Object.fromEntries(images));},lockRoots:()=>{locked=true;return()=>{locked=false;}},localReceipt:j=>hub.db.workspaceDeletionReceipts?.some(r=>r.previewId===j.previewId)?{deleted:true}:null});
 t.after(async()=>{client.close();await coordinator.close();await hub.close();await rm(dir,{recursive:true,force:true});});
 return {service,client,hub,w,lane,coordinator,runtime,settings,config,id,other,images,settingsKey,setCurrent:c=>{current=c;},failImages:v=>{failImages=v;},isLocked:()=>locked};
}
test('local deletion cleans only ended records for the current Hub identity and keeps unscoped drafts/maps',async t=>{
 const f=await fixture(t),p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id});assert.deepEqual(p.local.files,[`outbox/${f.id}.json.enc`]);
 await f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name});
 assert.equal(f.coordinator.records.has(f.id),false);assert.equal(f.coordinator.records.has(f.other),true);assert.equal(f.images.has(f.id),false);assert.equal(f.images.has(f.other),true);
 await assert.rejects(access(f.coordinator.store.path(f.id+'.json')),{code:'ENOENT'});await access(f.coordinator.store.path(f.other+'.json'));
 assert.equal(f.config.agentSubtaskRequests.mine,undefined);assert.ok(f.config.agentSubtaskRequests.other);assert.equal(f.config.agentSubtaskSettings[f.settingsKey],undefined);assert.ok(f.config.agentSubtaskSettings.other);
 assert.ok(f.config.paths[f.w.id]);assert.equal(f.config.laneOptions[f.lane.id].model,'keep');assert.equal(f.settings.readJSON('drafts.json')['rpo-prompt-'+f.lane.id],'retain-draft');assert.equal(f.isLocked(),false);
});
test('active native process, unsettled outcomes and changed identity block before shared deletion',async t=>{
 const f=await fixture(t),r=f.coordinator.records.get(f.id);
 r.outcome={status:'unknown'};let p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id});assert.deepEqual(p.local.blocked,[f.id]);
 await assert.rejects(f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name}),/未投递/);delete r.outcome;
 p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id});f.runtime.runs.set(f.id,{});await assert.rejects(f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name}),/仍有执行/);f.runtime.runs.clear();
 p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id});f.setCurrent({...f.client,auth:{...f.client.auth,secret:'another-secret'}});await assert.rejects(f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name}),/失效/);
 assert.equal(f.hub.db.workspaces.length,1);assert.equal(f.coordinator.records.size,2);
});
test('committed shared deletion and partially cleaned local journal resume idempotently after storage failure',async t=>{
 const f=await fixture(t),p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id});f.failImages(true);
 await assert.rejects(f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name}),/image-write-failure/);
 assert.equal(f.hub.db.workspaces.length,0);assert.equal(f.settings.readJSON('workspace-cleanup.json')[0].confirmed,true);assert.equal(f.isLocked(),false);
 f.failImages(false);await f.service.recover();await f.service.recover();assert.deepEqual(f.settings.readJSON('workspace-cleanup.json'),[]);assert.equal(f.coordinator.records.has(f.other),true);
});
test('lost shared-deletion response is reconciled from an owner-bound commit receipt',async t=>{
 const f=await fixture(t),p=await f.service.invoke('workspace.delete.preview',{workspaceId:f.w.id}),call=f.client.call.bind(f.client);f.client.call=async(method,args)=>{const result=await call(method,args);if(method==='workspace.delete')throw Error('lost delete response');return result;};
 await assert.rejects(f.service.invoke('workspace.delete',{workspaceId:f.w.id,previewId:p.previewId,confirmation:f.w.name}),/lost delete response/);assert.equal(f.coordinator.records.has(f.id),true);assert.equal(f.settings.readJSON('workspace-cleanup.json')[0].confirmed,false);
 await f.service.recover();assert.equal(f.coordinator.records.has(f.id),false);assert.equal(f.coordinator.records.has(f.other),true);
});
