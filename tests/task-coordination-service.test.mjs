import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hub } from "./helpers/secure-hub.mjs";
import { createTaskCoordination } from "../desktop/services/task-coordination.mjs";
const exec = promisify(execFile);
const git = async (root,args)=>(await exec("git",args,{cwd:root})).stdout.trim();
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),"rpo-task-service-")),root=join(dir,"repo");await mkdir(root);
  await git(root,["init","-b","main"]);await git(root,["config","user.name","Test"]);await git(root,["config","user.email","test@local"]);
  await writeFile(join(root,"base.txt"),"base\n");await git(root,["add","."]);await git(root,["commit","-m","base"]);
  const hub=new Hub(join(dir,"hub")),owner={id:"host",name:"Host",host:true};
  const workspace=hub.act(owner,"workspace.create",{name:"Tests"}),session=hub.act(owner,"session.create",{workspaceId:workspace.id,title:"Task"});
  t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
  function service(peer,path,label) {
    const config={paths:{[workspace.id]:path},sessionPaths:{},lanePaths:{}};
    let saves=0;
    const runtime={runs:new Map(),interrupt:async runId=>{runtime.runs.delete(runId);const lane=session.lanes.find(l=>l.activeRunId===runId);if(lane)hub.act(peer,"run.finish",{sessionId:session.id,laneId:lane.id,runId,status:"interrupted"});}};
    const client={call:async(method,args)=>hub.act(peer,method,args || {})};
    const localRoot=a=>config.lanePaths[a.laneId]||config.sessionPaths[a.sessionId]||config.paths[a.workspaceId];
    const api=createTaskCoordination({client:()=>client,runtime,localRoot,config,saveConfig:()=>saves++,dataDir:join(dir,label)});
    return{api,config,runtime,localRoot,saves:()=>saves};
  }
  return{dir,root,hub,owner,workspace,session,service};
}
function start(hub,peer,session,lane) {
  const ap=hub.act(peer,"run.request",{sessionId:session.id,laneId:lane.id,prompt:"Work",mode:"workspace-write"});
  hub.act(peer,"approval.decide",{id:ap.id,allow:true});hub.act(peer,"run.claim",{id:ap.id});return ap;
}
test("desktop task service snapshots running parent's dirty code without moving it, then reviews/checks/integrates child",async t=>{
  const {root,hub,owner,workspace,session,service}=await setup(t),parent=hub.act(owner,"lane.create",{sessionId:session.id,provider:"codex"}),local=service(owner,root,"desktop");
  const running=start(hub,owner,session,parent);local.runtime.runs.set(running.id,{});
  const before=await git(root,["rev-parse","HEAD"]);await writeFile(join(root,"draft.txt"),"parent unsaved work\n");
  const task=await local.api.invoke("tasks.spawn",{sessionId:session.id,parentLaneId:parent.id,title:"Child",prompt:"Write child.txt",checkCommands:["git diff --check","test -f child.txt"]});
  assert.equal(await git(root,["rev-parse","HEAD"]),before);assert.equal(parent.status,"running");assert.ok(local.runtime.runs.has(running.id));
  assert.equal(local.config.sessionPaths[session.id],undefined);assert.equal(local.config.lanePaths[task.lane.id],task.worktree);
  assert.equal(await readFile(join(task.worktree,"draft.txt"),"utf8"),"parent unsaved work\n");
  hub.act(owner,"approval.decide",{id:task.approval.id,allow:true});hub.act(owner,"run.claim",{id:task.approval.id});
  await writeFile(join(task.worktree,"child.txt"),"child result\n");hub.act(owner,"run.finish",{sessionId:session.id,laneId:task.lane.id,runId:task.approval.id,status:"done"});
  const review=await local.api.invoke("tasks.review",{id:task.task.id});assert.match(review.diff,/child result/);
  const checked=await local.api.invoke("tasks.check",{id:task.task.id});assert.equal(checked.status,"checked");
  assert.equal((await local.api.invoke("tasks.review",{id:task.task.id})).status,"checked");
  await assert.rejects(local.api.invoke("tasks.integrate",{id:task.task.id,candidateCommit:checked.candidateCommit}),/父 Agent/);
  await local.runtime.interrupt(running.id);
  await assert.rejects(local.api.invoke("tasks.integrate",{id:task.task.id,candidateCommit:checked.candidateCommit}),/未提交/);
  await git(root,["add","draft.txt"]);await git(root,["commit","-m","confirm parent draft"]);
  const integrated=await local.api.invoke("tasks.integrate",{id:task.task.id,candidateCommit:checked.candidateCommit});
  assert.equal(integrated.status,"integrated");assert.equal(hub.db.subtasks[0].status,"integrated");
  assert.equal(await readFile(join(root,"child.txt"),"utf8"),"child result\n");assert.equal(parent.status,"interrupted");
  const replay=await local.api.invoke("tasks.integrate",{id:task.task.id,candidateCommit:checked.candidateCommit});assert.equal(replay.alreadyIntegrated,true);
  assert.ok(local.saves()>0);
});
test("desktop handoff stops source first, preserves dirty source in snapshot, syncs second clone and starts fresh account session",async t=>{
  const {dir,root,hub,owner,workspace,session,service}=await setup(t),remote=join(dir,"remote.git");
  await git(dir,["init","--bare",remote]);await git(root,["remote","add","origin",remote]);await git(root,["push","origin","main"]);
  const receiverRoot=join(dir,"receiver");await git(dir,["clone","-b","main",remote,receiverRoot]);
  const sourcePeer={id:"source-member",name:"Source",host:false,workspaceId:workspace.id};hub.registerMember(sourcePeer,workspace.id,"editor");
  const source=hub.act(sourcePeer,"lane.create",{sessionId:session.id,provider:"codex"}),target=hub.act(owner,"lane.create",{sessionId:session.id,provider:"claude"});target.providerSessionId="old-provider-session";
  const from=service(sourcePeer,root,"source-desktop"),to=service(owner,receiverRoot,"target-desktop"),run=start(hub,sourcePeer,session,source);from.runtime.runs.set(run.id,{});
  await writeFile(join(root,"draft.txt"),"must survive handoff\n");
  const request=hub.act(owner,"handoff.request",{sessionId:session.id,laneId:source.id,targetLaneId:target.id});
  const prepared=await from.api.invoke("handoff.prepare",{id:request.id});
  assert.equal(prepared.status,"ready");assert.equal(from.runtime.runs.has(run.id),false);assert.equal(source.status,"interrupted");
  assert.equal(await readFile(join(root,"draft.txt"),"utf8"),"must survive handoff\n");assert.match(await git(root,["status","--porcelain"]),/draft.txt/);
  const received=await to.api.invoke("handoff.receive",{id:request.id});
  assert.equal(received.status,"accepted");assert.equal(received.approval.ownerId,owner.id);assert.equal(received.approval.status,"pending");assert.equal(target.providerSessionId,undefined);
  assert.equal(await readFile(join(to.config.sessionPaths[session.id],"draft.txt"),"utf8"),"must survive handoff\n");
});
test("desktop task service rejects viewer mutation and missing explicit check commands before creating resources",async t=>{
  const {root,hub,owner,workspace,session,service}=await setup(t),lane=hub.act(owner,"lane.create",{sessionId:session.id,provider:"codex"}),local=service(owner,root,"desktop");
  await assert.rejects(local.api.invoke("tasks.spawn",{sessionId:session.id,parentLaneId:lane.id,title:"No checks",prompt:"test",checkCommands:[]}),/明确输入/);
  assert.equal(hub.db.subtasks.length,0);
  const viewer={id:"viewer",name:"Viewer",host:false,workspaceId:workspace.id};hub.registerMember(viewer,workspace.id,"viewer");
  const guest=service(viewer,root,"viewer-desktop");await assert.rejects(guest.api.invoke("tasks.spawn",{sessionId:session.id}),/Editor/);
});
