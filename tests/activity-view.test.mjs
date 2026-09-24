import test from 'node:test';
import assert from 'node:assert/strict';
import {activityView,scheduleActivityExpiry} from '../core/activity-view.mjs';
const lane=(id,extra={})=>({id,ownerId:'owner-'+id,owner:'成员'+id,status:'idle',files:[],...extra});
const session=(id,workspaceId,lanes,extra={})=>({id,workspaceId,title:'会话'+id,status:'active',lanes,...extra});
function state(sessions,approvals=[]) {return {workspaces:[{id:'w1',name:'项目一'},{id:'w2',name:'项目二'}],sessions,approvals,me:{role:'viewer'}};}
function approval(s,l,id,status,fileScopes) {return {id,workspaceId:s.workspaceId,sessionId:s.id,laneId:l.id,ownerId:l.ownerId,status,fileScopes};}
const file=path=>({path,kind:'file'}),directory=path=>({path,kind:'directory'});
test('one workspace/path aggregates two sessions and sources; another workspace remains a distinct entry',()=>{
 const a=lane('a',{status:'running',activeRunId:'run-a',activity:{fileScopes:[file('src/index.js')],expires:1500},changedFiles:[{path:'src/index.js'}],changesExpires:2000}),b=lane('b',{activity:{fileScopes:[file('src/index.js')],expires:1800}}),c=lane('c',{changedFiles:[{path:'src/index.js'}],changesExpires:1900});
 const s1=session('s1','w1',[a]),s2=session('s2','w1',[b]),s3=session('s3','w2',[c]);
 const result=activityView(state([s1,s2,s3],[approval(s1,a,'run-a','claimed',[file('src/index.js'),directory('src')])]),{now:1000});
 assert.deepEqual(result.counts,{files:2,directories:1,unknown:0});assert.equal(result.nextExpiry,1500);
 const same=result.entries.find(e=>e.workspaceId==='w1'&&e.path==='src/index.js');assert.equal(same.sources.length,4);assert.deepEqual(new Set(same.sources.map(s=>s.sessionId)),new Set(['s1','s2']));assert.deepEqual(new Set(same.sources.map(s=>s.source)),new Set(['declared','open','changed']));
 assert.equal(result.entries.find(e=>e.workspaceId==='w2').sources[0].owner,'成员c');
});
test('closing an opened file removes only open evidence; refreshed diff with no files removes changed evidence',()=>{
 const l=lane('a',{activity:{fileScopes:[file('a.js'),file('b.js')],expires:5000},changedFiles:[{path:'a.js'}],changesExpires:5000}),snapshot=state([session('s','w1',[l])]);
 assert.equal(activityView(snapshot,{now:1000}).entries.length,2);
 l.activity={fileScopes:[],expires:6000};let result=activityView(snapshot,{now:1001});assert.deepEqual(result.entries.map(e=>e.path),['a.js']);assert.deepEqual(result.entries[0].sources.map(s=>s.source),['changed']);
 l.changedFiles=[];result=activityView(snapshot,{now:1002});assert.equal(result.entries.length,0);assert.equal(result.nextExpiry,null);
});
test('timer expires sources without any new snapshot and schedules the next boundary; cancellation and early wake are safe',()=>{
 let now=1000,id=0;const pending=new Map(),clock={now:()=>now,setTimer:(fn,delay)=>{pending.set(++id,{fn,delay});return id;},clearTimer:key=>pending.delete(key)};
 const snapshot=state([session('s','w1',[lane('a',{activity:{fileScopes:[file('open.js')],expires:1500},changedFiles:[{path:'changed.js'}],changesExpires:2000})])]);
 let result=activityView(snapshot,{now}),notifications=0,stop;
 const render=()=>{notifications++;result=activityView(snapshot,{now});stop=scheduleActivityExpiry(result.nextExpiry,render,clock);};
 stop=scheduleActivityExpiry(result.nextExpiry,render,clock);
 const wake=()=>{const [key,task]=pending.entries().next().value;pending.delete(key);task.fn();};
 now=1200;wake();assert.equal(notifications,0);assert.equal([...pending.values()][0].delay,300);
 now=1500;wake();assert.equal(notifications,1);assert.deepEqual(result.entries.map(e=>e.path),['changed.js']);assert.equal(result.nextExpiry,2000);
 now=2000;wake();assert.equal(notifications,2);assert.equal(result.entries.length,0);assert.equal(pending.size,0);
 stop();const cancel=scheduleActivityExpiry(3000,()=>assert.fail('cancelled timer fired'),clock);cancel();assert.equal(pending.size,0);
 assert.equal(snapshot.sessions[0].lanes[0].activity.fileScopes.length,1); // No snapshot mutation or second broadcast.
});
test('expired, non-finite leases and archived sessions vanish, while a current declared directory does not count as a file',()=>{
 const l=lane('a',{status:'awaiting',activity:{fileScopes:[file('expired.js')],expires:1000},changedFiles:[{path:'invalid.js'}],changesExpires:Infinity}),s=session('s','w1',[l]),archived=session('old','w1',[lane('b',{activity:{fileScopes:[file('secret.js')],expires:9000}})],{status:'archived'});
 const snapshot=state([s,archived],[approval(s,l,'pending','pending',[directory('src')])]);
 const result=activityView(snapshot,{now:1000});assert.deepEqual(result.counts,{files:0,directories:1,unknown:0});assert.equal(result.nextExpiry,null);assert.equal(result.entries[0].sources[0].source,'declared');
 l.activity.expires=NaN;l.changesExpires='9000';assert.equal(activityView(snapshot,{now:1000}).entries.length,1);
});
test('current running and awaiting declarations never fall back to stale pending approvals or last-turn lane.files',()=>{
 const l=lane('a',{status:'running',activeRunId:'current',files:['obsolete.js']}),s=session('s','w1',[l]),snapshot=state([s],[approval(s,l,'old-pending','pending',[file('stale.js')]),approval(s,l,'current','claimed',[file('current.js')])]);
 assert.deepEqual(activityView(snapshot).entries.map(e=>e.path),['current.js']);
 l.status='awaiting';snapshot.approvals=[approval(s,l,'newest','rejected',[file('denied.js')]),approval(s,l,'old-pending','pending',[file('stale.js')])];assert.equal(activityView(snapshot).entries.length,0);
 snapshot.approvals.unshift(approval(s,l,'new-request','approved',[directory('next')]));assert.deepEqual(activityView(snapshot).entries.map(e=>e.path),['next']);
 snapshot.approvals[0].fileScopes=[];assert.equal(activityView(snapshot).entries.length,0);
 l.status='done';assert.equal(activityView(snapshot).entries.length,0);
 l.status='running';l.activeRunId='missing';assert.equal(activityView(snapshot).entries.length,0);
});
test('Viewer uses only the authorized current snapshot; stale selected IDs and broader supplied metadata grant no visibility',()=>{
 const allowed=session('one','w1',[lane('a',{activity:{fileScopes:[file('visible.js')],expires:3000}})]),hidden=session('other','w1',[lane('b',{activity:{fileScopes:[file('hidden.js')],expires:3000}})]),snapshot=state([allowed]);
 assert.deepEqual(activityView(snapshot,{sessionIds:[allowed.id,hidden.id],now:1000}).entries.map(e=>e.path),['visible.js']);
 snapshot.sessions=[];assert.equal(activityView(snapshot,{sessionIds:[allowed.id],now:1000}).entries.length,0);
 snapshot.sessions=[allowed,hidden];snapshot.me.sessionId='one';assert.deepEqual(activityView(snapshot,{now:1000}).entries.map(e=>e.path),['visible.js']);
 snapshot.workspaces=[];assert.equal(activityView(snapshot,{now:1000}).entries.length,0);
});
test('legacy declarations remain unknown and conflicting file/directory evidence is not inflated into a file count',()=>{
 const l=lane('old',{status:'running',files:['legacy','legacy','src/../escape','/absolute','x\\y']}),s=session('s','w1',[l]),snapshot=state([s]);
 let result=activityView(snapshot,{now:1000});assert.deepEqual(result.counts,{files:0,directories:0,unknown:2});assert.ok(result.entries.every(e=>e.sources[0].legacy));
 l.activity={fileScopes:[directory('legacy'),file('legacy')],expires:2000};result=activityView(snapshot,{now:1000});assert.equal(result.entries.find(e=>e.path==='legacy').kind,'unknown');assert.deepEqual(result.counts,{files:0,directories:0,unknown:2});
});
test('real Hub Viewer session invitation aggregates only shared activity and expires locally without a second broadcast',async t=>{
 const [{mkdtemp,rm},{join},{tmpdir},{randomBytes},{Hub},{HubClient}]=await Promise.all([import('node:fs/promises'),import('node:path'),import('node:os'),import('node:crypto'),import('./helpers/secure-hub.mjs'),import('../core/client.mjs')]);
 const dir=await mkdtemp(join(tmpdir(),'rpo-activity-')),hub=new Hub(dir),port=await hub.listen(),owner=new HubClient(),viewer=new HubClient();
 t.after(async()=>{owner.close();viewer.close();await hub.close();await rm(dir,{recursive:true,force:true});});
 const connect=(client,token)=>client.connect(`ws://127.0.0.1:${port}`,{token,secret:randomBytes(32).toString('hex'),name:'member'});
 await connect(owner,hub.db.hostToken);
 const w=await owner.call('workspace.create',{name:'实际项目',branch:'main'}),s=await owner.call('session.create',{workspaceId:w.id,title:'可见'}),other=await owner.call('session.create',{workspaceId:w.id,title:'不可见'});
 const l=await owner.call('lane.create',{sessionId:s.id,provider:'codex'}),hidden=await owner.call('lane.create',{sessionId:other.id,provider:'claude'});
 await owner.call('coordination.activity',{sessionId:s.id,laneId:l.id,fileScopes:[file('open.js')],ttlMs:1000});
 await owner.call('coordination.activity',{sessionId:other.id,laneId:hidden.id,fileScopes:[file('hidden.js')],ttlMs:300000});
 const invite=await owner.call('invite.create',{workspaceId:w.id,sessionId:s.id,role:'viewer'});await connect(viewer,invite.token);
 const snapshot=await viewer.call('state'),expires=snapshot.sessions[0].lanes[0].activity.expires;
 assert.equal(snapshot.me.role,'viewer');assert.deepEqual(activityView(snapshot,{now:expires-1}).entries.map(e=>e.path),['open.js']);
 assert.equal(activityView(snapshot,{now:expires}).entries.length,0);
 await assert.rejects(viewer.call('coordination.activity',{sessionId:s.id,laneId:l.id,fileScopes:[file('fake.js')]}),/editor/);
});
