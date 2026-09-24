import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,copyFile,access,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'rpo-access-')),hub=new Hub(dir),port=await hub.listen();
 const clients=[];
 async function connect(token,secret=randomBytes(32).toString('hex')) {const c=new HubClient();clients.push(c);await c.connect(`ws://127.0.0.1:${port}`,{token,secret,name:'member-'+clients.length});return c;}
 const owner=await connect(hub.db.hostToken),w=await owner.call('workspace.create',{name:'删除测试',branch:'main'}),s=await owner.call('session.create',{workspaceId:w.id,title:'公开会话'}),other=await owner.call('session.create',{workspaceId:w.id,title:'hidden-session-marker'});
 const invite=(role,sessionId,workspaceId=w.id)=>owner.call('invite.create',{workspaceId,sessionId,role});
 t.after(async()=>{clients.forEach(c=>c.close());await hub.close();await rm(dir,{recursive:true,force:true});});
 return {dir,hub,owner,w,s,other,connect,invite};
}
test('Commenter returns only their own step with note and history, cancels consent transfer, then another member claims',async t=>{
 const {owner,w,s,invite,connect}=await setup(t),c=await connect((await invite('commenter',s.id)).token),v=await connect((await invite('viewer',s.id)).token),p=await owner.call('plan.add',{sessionId:s.id,text:'领取归还'});
 await c.call('plan.claim',{sessionId:s.id,id:p.id});
 await assert.rejects(v.call('plan.release',{sessionId:s.id,id:p.id,note:'x'}),/commenter/);
 await assert.rejects(owner.call('plan.release',{sessionId:s.id,id:p.id,note:'替别人归还'}),/当前负责人/);
 await c.call('plan.transfer',{sessionId:s.id,id:p.id,assigneeId:owner.state.me.id});
 await assert.rejects(c.call('plan.release',{sessionId:s.id,id:p.id,note:' '}),/内容/);
 const returned=await c.call('plan.release',{workspaceId:w.id,sessionId:s.id,id:p.id,note:'等待活动方案确定'});
 assert.equal(returned.assigneeId,null);assert.equal(returned.status,'todo');assert.equal(returned.transferRequest.status,'cancelled');assert.equal(returned.history.at(-1).note,'等待活动方案确定');assert.equal(returned.history.at(-1).previous.assigneeId,c.state.me.id);
 await assert.rejects(c.call('plan.release',{sessionId:s.id,id:p.id,note:'retry'}),/当前负责人/);
 assert.equal((await owner.call('plan.claim',{sessionId:s.id,id:p.id})).assigneeId,owner.state.me.id);
});
test('Editor session invitation cannot widen role, workspace, session, memories or ID-only resources',async t=>{
 const {hub,owner,w,s,other,invite,connect}=await setup(t),e=await connect((await invite('editor')).token);
 await assert.rejects(e.call('invite.create',{workspaceId:w.id,role:'editor'}),/owner/);
 await assert.rejects(e.call('invite.create',{workspaceId:w.id,sessionId:s.id,role:'owner'}),/Owner/);
 const token=await e.call('invite.create',{workspaceId:w.id,sessionId:s.id,role:'editor'}),guest=await connect(token.token);
 const memory=await owner.call('memory.add',{workspaceId:w.id,title:'hidden-memory-marker',text:'secret-memory-text'});
 const hiddenLane=await owner.call('lane.create',{sessionId:other.id,provider:'codex'}),hiddenApproval=await owner.call('run.request',{sessionId:other.id,laneId:hiddenLane.id,prompt:'hidden-prompt-marker',mode:'read-only',files:['a.js']});
 await owner.call('coordination.message',{sessionId:other.id,text:'hidden-message-marker'});
 await owner.call('lock.acquire',{workspaceId:w.id,sessionId:other.id,laneId:hiddenLane.id,path:'a.js'});
 const snapshot=await guest.call('state');
 assert.equal(snapshot.sessions.length,1);assert.equal(snapshot.me.sessionId,s.id);assert.equal(snapshot.memories.length,0);assert.equal(snapshot.approvals.length,0);assert.equal(hub.db.members.some(m=>m.id===snapshot.me.id),false);
 assert.doesNotMatch(JSON.stringify(snapshot),/hidden-|secret-memory/);
 for (const [method,args] of [['session.export',{sessionId:other.id}],['session.create',{workspaceId:w.id,title:'bypass'}],['memory.list',{workspaceId:w.id}],['memory.update',{id:memory.id,text:'bypass'}],['memory.history',{id:memory.id}],['approval.decide',{id:hiddenApproval.id,allow:true}],['run.claim',{id:hiddenApproval.id}],['invite.create',{workspaceId:w.id,role:'owner'}]]) await assert.rejects(guest.call(method,args),/范围|邀请/);
 const context=await guest.call('coordination.context',{sessionId:s.id});assert.deepEqual(context.memories,[]);assert.deepEqual(context.locks,[]);
 const own=await guest.call('lane.create',{sessionId:s.id,provider:'codex'}),ap=await guest.call('run.request',{sessionId:s.id,laneId:own.id,prompt:'a.js',files:['a.js'],mode:'read-only'});
 assert.doesNotMatch(JSON.stringify(ap),/hidden-/);assert.equal(ap.overlapDetails.length,0);
 await guest.call('approval.decide',{id:ap.id,allow:true});
 assert.deepEqual((await guest.call('run.claim',{id:ap.id})).memories,[]);
 const next=await guest.call('invite.create',{workspaceId:w.id,sessionId:s.id,role:'viewer'});assert.equal((await connect(next.token)).state.sessions.length,1);
});
test('session grant demotion is immediate, survives reconnect, and session revoke leaves another room connected',async t=>{
 const {owner,w,s,other,invite,connect}=await setup(t),e=await connect((await invite('editor')).token);
 const i=await e.call('invite.create',{workspaceId:w.id,sessionId:s.id,role:'editor'}),secret=randomBytes(32).toString('hex'),guest=await connect(i.token,secret),otherGuest=await connect((await invite('editor',other.id)).token);
 const lane=await guest.call('lane.create',{sessionId:s.id,provider:'codex'});
 await owner.call('member.role',{workspaceId:w.id,sessionId:s.id,memberId:guest.state.me.id,role:'viewer'});
 await assert.rejects(guest.call('run.request',{sessionId:s.id,laneId:lane.id,prompt:'no'}),/editor/);
 const reconnect=await connect(i.token,secret);assert.equal(reconnect.state.me.role,'viewer');
 await e.call('invite.revoke',{workspaceId:w.id,sessionId:s.id,id:i.id});
 await assert.rejects(connect(i.token,secret),/失效/);
 assert.equal((await otherGuest.call('state')).sessions[0].id,other.id);
 await assert.rejects(e.call('invite.revoke',{workspaceId:w.id,sessionId:other.id}),/自己创建/);
});
test('workspace deletion preview is owner-bound, stale and active-execution protected',async t=>{
 const {hub,owner,w,s,invite,connect}=await setup(t),editor=await connect((await invite('editor')).token),secondOwner=await connect((await invite('owner')).token);
 await assert.rejects(editor.call('workspace.delete.preview',{workspaceId:w.id}),/owner/);
 const preview=await owner.call('workspace.delete.preview',{workspaceId:w.id});
 await assert.rejects(secondOwner.call('workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:w.name}),/失效/);
 await assert.rejects(owner.call('workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:'wrong'}),/完整/);
 await owner.call('plan.add',{sessionId:s.id,text:'改变清单'});
 await assert.rejects(owner.call('workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:w.name}),/已变化/);
 const lane=await owner.call('lane.create',{sessionId:s.id,provider:'codex'}),ap=await owner.call('run.request',{sessionId:s.id,laneId:lane.id,prompt:'活动',mode:'read-only'});
 await owner.call('approval.decide',{id:ap.id,allow:true});await owner.call('run.claim',{id:ap.id});await owner.call('lane.stop',{sessionId:s.id,laneId:lane.id});
 const blocked=await owner.call('workspace.delete.preview',{workspaceId:w.id});assert.equal(blocked.blocked.length,1);
 await assert.rejects(owner.call('workspace.delete',{workspaceId:w.id,previewId:blocked.previewId,confirmation:w.name}),/结束确认/);
 assert.equal(hub.db.workspaces.some(v=>v.id===w.id),true);
});
test('deletion removes related encrypted transcripts, recovery copies and grants but preserves another workspace and project files',async t=>{
 const {hub,owner,w,s,dir,invite,connect}=await setup(t),w2=await owner.call('workspace.create',{name:'保留',branch:'main'}),s2=await owner.call('session.create',{workspaceId:w2.id,title:'留存'});
 const lane=await owner.call('lane.create',{sessionId:s.id,provider:'codex'}),keep=await owner.call('lane.create',{sessionId:s2.id,provider:'claude'}),i=await invite('viewer',s.id),guest=await connect(i.token);
 await owner.call('memory.add',{workspaceId:w.id,title:'删除',text:'删除'});await owner.call('lock.acquire',{workspaceId:w.id,sessionId:s.id,laneId:lane.id,path:'a.js'});
 hub.db.memoryHistory.push({workspaceId:w.id,memoryId:'m',text:'old'});hub.identity.challenges.set('challenge',{workspaceId:w.id,peerId:guest.state.me.id});hub.db.identities.push({peerId:guest.state.me.id,sessionHash:'ticket',github:{id:'1'}});
 const name=hub.logName(lane),file=hub.store.path(name),pending=file+'.00000000-0000-0000-0000-000000000000.pending';await copyFile(file,pending);await writeFile(hub.store.path(name,false),'legacy transcript');
 const keepBytes=await readFile(hub.store.path(hub.logName(keep)));
 const project=join(dir,'synthetic-project');await mkdir(join(project,'.git'),{recursive:true});await writeFile(join(project,'.git','HEAD'),'ref: refs/heads/main\n');await writeFile(join(project,'important.js'),'KEEP');
 const preview=await owner.call('workspace.delete.preview',{workspaceId:w.id});assert.equal(preview.counts.sessionMembers,1);assert.equal(preview.counts.memoryHistory,1);assert.ok(preview.transcripts.includes(name));
 const deleted=await owner.call('workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:w.name});assert.equal(deleted.deleted,true);
 for(const key of ['sessions','members','sessionMembers','memories','memoryHistory','approvals','invites','locks','messages','toolApprovals','handoffs','subtasks','outcomes','groupMessages','groupTasks'])assert.ok((hub.db[key] ?? []).every(v=>v.workspaceId!==w.id),key);
 for(const path of [file,pending,hub.store.path(name,false)])await assert.rejects(access(path),{code:'ENOENT'});
 assert.deepEqual(await readFile(hub.store.path(hub.logName(keep))),keepBytes);assert.equal(await readFile(join(project,'important.js'),'utf8'),'KEEP');assert.equal(await readFile(join(project,'.git','HEAD'),'utf8'),'ref: refs/heads/main\n');
 assert.equal(hub.identity.challenges.has('challenge'),false);assert.equal(hub.db.identities.some(v=>v.peerId===guest.state.me.id),false);await assert.rejects(connect(i.token),/失效/);
 assert.deepEqual((await owner.call('state')).workspaces.map(v=>v.id),[w2.id]);
});
test('a durable deletion journal resumes exact transcript cleanup after failure without recreating room data',async t=>{
 const {hub,owner,w,s,dir}=await setup(t),lane=await owner.call('lane.create',{sessionId:s.id,provider:'codex'}),preview=await owner.call('workspace.delete.preview',{workspaceId:w.id}),remove=hub.store.removeFile.bind(hub.store);
 hub.store.removeFile=()=>{throw Error('synthetic disk failure');};
 await assert.rejects(owner.call('workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:w.name}),/synthetic/);assert.equal(hub.db.workspaces.length,0);assert.equal(hub.db.workspaceDeletions.length,1);
 hub.store.removeFile=remove;await hub.close();const restarted=new Hub(dir);t.after(()=>restarted.close());
 assert.equal(restarted.db.workspaceDeletions.length,0);assert.equal(restarted.db.sessions.length,0);await assert.rejects(access(restarted.store.path(restarted.logName(lane))),{code:'ENOENT'});
});
test('same identity workspace and session grants stay distinct; removal cannot be bypassed by a fresh session invite',async t=>{
 const {hub,owner,w,s,invite,connect}=await setup(t),secret=randomBytes(32).toString('hex'),full=await connect((await invite('viewer')).token,secret),scoped=await connect((await invite('editor',s.id)).token,secret);
 assert.equal(full.state.me.id,scoped.state.me.id);assert.equal((await full.call('state')).me.role,'viewer');assert.equal((await scoped.call('state')).me.role,'editor');
 const p=await owner.call('plan.add',{sessionId:s.id,text:'双重授权'});assert.equal((await scoped.call('plan.claim',{sessionId:s.id,id:p.id})).assigneeId,scoped.state.me.id);
 await assert.rejects(full.call('lane.create',{sessionId:s.id,provider:'codex'}),/editor/);
 await owner.call('member.remove',{workspaceId:w.id,memberId:full.state.me.id});
 const fresh=await invite('editor',s.id);await assert.rejects(connect(fresh.token,secret),/已被移除/);
 assert.ok(hub.db.sessionMembers.filter(m=>m.id===full.state.me.id).every(m=>m.removed));
});
test('deleting one workspace retains a shared member identity ticket used in another workspace; preview expiration is enforced',async t=>{
 const {hub,owner,w,s,invite,connect}=await setup(t),w2=await owner.call('workspace.create',{name:'另一个',branch:'main'}),secret=randomBytes(32).toString('hex'),guest=await connect((await invite('viewer',s.id)).token,secret),guest2=await connect((await invite('viewer',undefined,w2.id)).token,secret);
 const identity={peerId:guest.state.me.id,sessionHash:'keep-ticket',expires:Date.now()+100000,github:{id:'77',login:'shared'}};hub.db.identities.push(identity);
 let p=await owner.call('workspace.delete.preview',{workspaceId:w.id});hub.deletionPreviews.get(p.previewId).expires=0;await assert.rejects(owner.call('workspace.delete',{workspaceId:w.id,previewId:p.previewId,confirmation:w.name}),/失效/);
 p=await owner.call('workspace.delete.preview',{workspaceId:w.id});await owner.call('workspace.delete',{workspaceId:w.id,previewId:p.previewId,confirmation:w.name});
 assert.deepEqual(hub.db.identities.find(v=>v.peerId===guest.state.me.id),identity);assert.equal((await guest2.call('state')).workspaces[0].id,w2.id);
 assert.deepEqual(await owner.call('workspace.delete.status',{workspaceId:w.id,previewId:p.previewId}),{deleted:true,workspaceId:w.id,previewId:p.previewId});
 assert.deepEqual(await guest2.call('workspace.delete.status',{workspaceId:w.id,previewId:p.previewId}),{deleted:false});
});
test('scoped Editor nested subtask creation persists live lane metadata without expanding context',async t=>{
 const {hub,s,invite,connect}=await setup(t),guest=await connect((await invite('editor',s.id)).token),parent=await guest.call('lane.create',{sessionId:s.id,provider:'codex'}),baseCommit='a'.repeat(40);
 const task=await guest.call('subtask.request',{sessionId:s.id,parentLaneId:parent.id,title:'child',prompt:'isolated task',baseCommit,requiredCheckIds:['explicit-check']});
 const child=await guest.call('subtask.claim',{id:task.id,baseCommit,worktreeReady:true,deferRun:true,claimKey:'12345678-1234-1234-1234-123456789012'});
 const live=hub.db.sessions.find(v=>v.id===s.id).lanes.find(v=>v.id===child.lane.id);
 assert.equal(live.parentLaneId,parent.id);assert.equal(live.subtaskId,task.id);assert.equal(live.baseCommit,baseCommit);
 assert.equal((await guest.call('state')).sessions[0].lanes.find(v=>v.id===live.id).subtaskId,task.id);
});

test('workspace deletion without optional group tables succeeds and does not create feature schema',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rpo-no-group-')),hub=new Hub(dir),owner={id:'local-owner',name:'Owner',host:true};
 t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
 delete hub.db.groupMessages;delete hub.db.groupTasks;
 const w=hub.act(owner,'workspace.create',{name:'可选功能未安装',branch:'main'}),other=hub.act(owner,'workspace.create',{name:'保留',branch:'main'});
 const session=hub.act(owner,'session.create',{workspaceId:w.id,title:'删除会话'}),lane=hub.act(owner,'lane.create',{sessionId:session.id,provider:'codex'});
 const log=hub.store.path(hub.logName(lane));await access(log);
 const preview=hub.act(owner,'workspace.delete.preview',{workspaceId:w.id});
 assert.equal(preview.counts.groupMessages,0);assert.equal(preview.counts.groupTasks,0);
 hub.act(owner,'workspace.delete',{workspaceId:w.id,previewId:preview.previewId,confirmation:w.name});
 await assert.rejects(access(log),{code:'ENOENT'});
 assert.deepEqual(hub.db.workspaces.map(v=>v.id),[other.id]);
 const saved=hub.store.readJSON('hub.json');assert.equal(Object.hasOwn(saved,'groupMessages'),false);assert.equal(Object.hasOwn(saved,'groupTasks'),false);
});
