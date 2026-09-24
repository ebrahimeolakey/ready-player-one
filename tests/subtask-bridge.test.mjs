import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { Hub } from "./helpers/secure-hub.mjs";
import { HubClient } from "../core/client.mjs";
import { SecureStore } from "../core/secure-store.mjs";
import { createTaskCoordination } from "../desktop/services/task-coordination.mjs";
import { CoordinationBridge } from "../desktop/services/coordination-bridge.mjs";
import { localSubtaskClient } from "../core/mcp-coordination.mjs";
const exec = promisify(execFile);
const git = async(root,args)=>(await exec("git",args,{cwd:root})).stdout.trim();
const checkCommand = `"${process.execPath}" -e "require('node:fs').accessSync('child.txt')"`;
async function setup(t, mode="workspace-write") {
  const dir=await mkdtemp(join(tmpdir(),"rpo-spawn-bridge-")),root=join(dir,"repo");await mkdir(root);
  await git(root,["init","-b","main"]);await git(root,["config","user.name","Test"]);await git(root,["config","user.email","test@local"]);
  await writeFile(join(root,"base.txt"),"base\n");await git(root,["add","."]);await git(root,["commit","-m","base"]);
  const hub=new Hub(join(dir,"hub"));await hub.listen();const url=`ws://127.0.0.1:${hub.port}`;
  const admin=new HubClient(),client=new HubClient();await admin.connect(url,{token:hub.db.hostToken,secret:randomBytes(32).toString("hex"),name:"Admin"});
  const w=await admin.call("workspace.create",{name:"Tests"}),session=await admin.call("session.create",{workspaceId:w.id,title:"Parent"});
  const invite=await admin.call("invite.create",{workspaceId:w.id,role:"editor"});
  const auth={token:invite.token,secret:randomBytes(32).toString("hex"),name:"Executor"};await client.connect(url,auth);
  const lane=await client.call("lane.create",{sessionId:session.id,provider:"codex"});
  const approval=await client.call("run.request",{sessionId:session.id,laneId:lane.id,prompt:"parent",mode});
  await admin.call("approval.decide",{id:approval.id,allow:true});await client.call("run.claim",{id:approval.id});
  const runtime={runs:new Map([[approval.id,{}]]),interrupt:async()=>{throw Error("parent must not be interrupted");}};
  const config={paths:{[w.id]:root},sessionPaths:{},lanePaths:{}};
  const store=new SecureStore({dir:join(dir,"settings"),key:randomBytes(32)});
  let active=client;
  const localRoot=a=>config.lanePaths[a.laneId]||config.sessionPaths[a.sessionId]||config.paths[a.workspaceId];
  const api=createTaskCoordination({client:()=>active,runtime,localRoot,config,saveConfig:()=>store.writeJSON("client.json",config),dataDir:dir});
  const bridge=new CoordinationBridge({client:()=>active,runtime,taskCoordination:api});
  const env=await bridge.issue({workspaceId:w.id,sessionId:session.id,laneId:lane.id,runId:approval.id});
  const settings=()=>api.invoke("tasks.settings.save",{sessionId:session.id,enabled:true,checkCommands:[checkCommand]});
  t.after(async()=>{await bridge.close();client.close();admin.close();await hub.close();await rm(dir,{recursive:true,force:true});});
  return {dir,root,hub,client,admin,auth,url,w,session,lane,approval,runtime,config,api,bridge,env,settings,store,setClient:c=>{active=c;}};
}
async function mcp(t,f) {
  const proc=spawn(process.execPath,[resolve("core/mcp-coordination.mjs")],{env:{...process.env,...f.env,RPO_HUB_URL:f.url,RPO_HUB_TOKEN:f.auth.token,RPO_CLIENT_SECRET:f.auth.secret,RPO_SESSION_ID:f.session.id,RPO_LANE_ID:f.lane.id}});
  t.after(()=>proc.kill());
  let output="",index=0;const pending=new Map();proc.stdout.on("data",chunk=>output+=chunk);
  const lines=createInterface({input:proc.stdout});lines.on("line",line=>{const result=JSON.parse(line);pending.get(result.id)?.(result);});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++index,timer=setTimeout(()=>reject(Error("stdio timeout")),20000);pending.set(id,result=>{clearTimeout(timer);pending.delete(id);resolve(result);});proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
  await rpc("initialize",{});
  return {tool:args=>rpc("tools/call",{name:"rpo_subtask_spawn",arguments:args}),output:()=>output,close:async()=>{const done=new Promise(resolve=>proc.once("exit",resolve));proc.stdin.end();assert.equal(await done,0);}};
}

test("real stdio MCP creates one child worktree through lost request/claim/start responses; checks and integration remain explicit",async t=>{
  const f=await setup(t),native=await mcp(t,f),args={requestId:randomUUID(),title:"Child",prompt:"Create child result"};
  const unavailable=await native.tool(args);assert.equal(unavailable.result.isError,true);assert.match(unavailable.result.content[0].text,/Agent 子任务检查/);assert.equal(f.hub.db.subtasks.length,0);
  await f.settings();await writeFile(join(f.root,"draft.txt"),"parent dirty work\n");
  const head=await git(f.root,["rev-parse","HEAD"]),status=await git(f.root,["status","--porcelain"]);
  const call=f.client.call.bind(f.client),lost=new Set();
  f.client.call=async(method,params)=>{const result=await call(method,params);if(["subtask.request","subtask.claim","subtask.start"].includes(method)&&!lost.has(method)){lost.add(method);throw Error("synthetic lost response");}return result;};
  for(let i=0;i<3;i++) {
    const response=await native.tool(args);assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/synthetic lost response/);
    assert.equal(f.hub.db.subtasks.length,1);
    if(i===1){assert.equal(f.hub.db.subtasks[0].status,"prepared");assert.equal(f.hub.db.approvals.filter(a=>a.id!==f.approval.id).length,0);}
  }
  const response=await native.tool(args);assert.equal(response.result.isError,false,JSON.stringify(response));
  const result=JSON.parse(response.result.content[0].text),childRoot=f.config.lanePaths[result.laneId];
  assert.equal(result.status,"awaiting-approval");assert(childRoot);assert.notEqual(childRoot,f.root);
  assert.equal((await git(f.root,["worktree","list","--porcelain"])).split("\n").filter(line=>line.startsWith("worktree ")).length,2);
  assert.equal(await readFile(join(childRoot,"draft.txt"),"utf8"),"parent dirty work\n");
  assert.equal(await git(f.root,["rev-parse","HEAD"]),head);assert.equal(await git(f.root,["status","--porcelain"]),status);assert(f.runtime.runs.has(f.approval.id));
  assert.deepEqual(JSON.parse((await native.tool(args)).result.content[0].text),result);
  assert.equal((await native.tool({...args,title:"different"})).result.isError,true);
  assert.equal((await native.tool({...args,checkCommands:["echo bypass"]})).error.code,-32602);
  assert.equal(f.hub.db.subtasks.length,1);assert.equal(f.hub.db.approvals.filter(a=>a.id!==f.approval.id).length,1);
  assert.equal(f.store.readJSON("client.json").agentSubtaskRequests[Object.keys(f.config.agentSubtaskRequests)[0]].result.taskId,result.taskId);
  for(const secret of [f.env.RPO_COORDINATION_BRIDGE_TOKEN,f.auth.secret,f.auth.token])assert.equal(native.output().includes(secret),false);
  await f.admin.call("approval.decide",{id:result.approvalId,allow:true});await f.client.call("run.claim",{id:result.approvalId});
  await writeFile(join(childRoot,"wrong.txt"),"incomplete\n");await f.client.call("run.finish",{sessionId:f.session.id,laneId:result.laneId,runId:result.approvalId,status:"done"});
  await f.api.invoke("tasks.review",{id:result.taskId});const failed=await f.api.invoke("tasks.check",{id:result.taskId});assert.equal(failed.status,"failed");assert.equal(await git(f.root,["rev-parse","HEAD"]),head);
  await writeFile(join(childRoot,"child.txt"),"child result\n");const review=await f.api.invoke("tasks.review",{id:result.taskId});assert.match(review.diff,/child result/);
  const checked=await f.api.invoke("tasks.check",{id:result.taskId});assert.equal(checked.status,"checked");
  await assert.rejects(f.api.invoke("tasks.integrate",{id:result.taskId,candidateCommit:checked.candidateCommit}),/父 Agent/);
  await f.client.call("run.finish",{sessionId:f.session.id,laneId:f.lane.id,runId:f.approval.id,status:"done"});f.runtime.runs.delete(f.approval.id);
  assert.equal((await native.tool({...args,requestId:randomUUID()})).result.isError,true);
  await git(f.root,["add","draft.txt"]);await git(f.root,["commit","-m","confirm parent work"]);
  const integrated=await f.api.invoke("tasks.integrate",{id:result.taskId,candidateCommit:checked.candidateCommit});assert.equal(integrated.status,"integrated");
  const replay=await f.api.invoke("tasks.integrate",{id:result.taskId,candidateCommit:checked.candidateCommit});assert.equal(replay.alreadyIntegrated,true);assert.equal(await git(f.root,["rev-parse","HEAD"]),integrated.integrationCommit);
  await native.close();
});

test("loopback bridge rejects identity/command forgery, web origins, wrong tokens, readonly mode and revoked roles",async t=>{
  const f=await setup(t);await f.settings();const args={requestId:randomUUID(),title:"Child",prompt:"test"},spawn=localSubtaskClient(f.env);
  for(const extra of [{sessionId:"other"},{ownerId:"other"},{checkCommands:["echo bypass"]},{worktreeReady:true},{provider:"claude"}])await assert.rejects(spawn({...args,...extra}),/只接受/);
  const response=await fetch(f.env.RPO_COORDINATION_BRIDGE_URL,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${f.env.RPO_COORDINATION_BRIDGE_TOKEN}`,Origin:"https://untrusted.example"},body:JSON.stringify(args)});assert.equal(response.status,403);
  await assert.rejects(localSubtaskClient({...f.env,RPO_COORDINATION_BRIDGE_TOKEN:"a".repeat(64)})(args),/凭据无效/);
  await f.admin.call("member.role",{workspaceId:f.w.id,memberId:f.client.state.me.id,role:"viewer"});await assert.rejects(spawn(args),/Editor/);assert.equal(f.hub.db.subtasks.length,0);
  const readonly=await setup(t,"read-only");await readonly.settings();await assert.rejects(localSubtaskClient(readonly.env)(args),/只读执行/);assert.equal(readonly.hub.db.subtasks.length,0);
  assert.throws(()=>localSubtaskClient({...f.env,RPO_COORDINATION_BRIDGE_URL:"https://example.com/subtasks"}),/配置无效/);
});

test("concurrent retry shares one operation; changed connection or disabled checks cannot start another",async t=>{
  const f=await setup(t);await f.settings();const spawn=localSubtaskClient(f.env),args={requestId:randomUUID(),title:"Concurrent",prompt:"test"};
  const [a,b]=await Promise.all([spawn(args),spawn(args)]);assert.deepEqual(a,b);assert.equal(f.hub.db.subtasks.length,1);
  const task=f.hub.db.subtasks[0],nonce=Object.values(f.config.agentSubtaskRequests)[0].claimKey;
  await assert.rejects(f.client.call("subtask.start",{id:task.id,claimKey:randomUUID()}),/标识无效/);
  assert.equal((await f.client.call("subtask.start",{id:task.id,claimKey:nonce})).approval.id,a.approvalId);
  await f.api.invoke("tasks.settings.save",{sessionId:f.session.id,enabled:false});await assert.rejects(spawn({...args,requestId:randomUUID()}),/启用/);
  f.setClient(f.admin);await assert.rejects(spawn({...args,requestId:randomUUID()}),/连接已切换/);
  assert.equal(f.hub.db.subtasks.length,1);
});

test("role revoked after reservation leaves no child lane or runnable approval",async t=>{
  const f=await setup(t);await f.settings();const call=f.client.call.bind(f.client);let changed=false;
  f.client.call=async(method,args)=>{const result=await call(method,args);if(method==="subtask.request"&&!changed){changed=true;await f.admin.call("member.role",{workspaceId:f.w.id,memberId:f.client.state.me.id,role:"viewer"});}return result;};
  await assert.rejects(localSubtaskClient(f.env)({requestId:randomUUID(),title:"Revoked",prompt:"test"}),/Editor/);
  assert.equal(f.hub.db.subtasks.length,1);assert.equal(f.hub.db.subtasks[0].status,"requested");assert.equal(f.hub.db.sessions[0].lanes.length,1);assert.equal(f.hub.db.approvals.length,1);
});

test("manual creation also persists child lane mapping before any executable approval exists",async t=>{
  const f=await setup(t),call=f.client.call.bind(f.client);let checked=false;
  f.client.call=async(method,args)=>{
    if(method==="subtask.start"){
      const task=f.hub.db.subtasks.find(v=>v.id===args.id);
      assert.equal(task.status,"prepared");assert(f.config.lanePaths[task.laneId]);
      assert.equal(f.hub.db.approvals.some(a=>a.laneId===task.laneId),false);checked=true;
    }
    return call(method,args);
  };
  const result=await f.api.invoke("tasks.spawn",{sessionId:f.session.id,parentLaneId:f.lane.id,title:"Manual",prompt:"test",checkCommands:[checkCommand]});
  assert(checked);assert.equal(result.approval.status,"pending");assert.equal(f.hub.db.sessions[0].lanes.find(l=>l.id===f.lane.id).status,"running");
});

test("encrypted receipt survives a new bridge/service and project remapping cannot reuse the old request",async t=>{
  const f=await setup(t);await f.settings();const args={requestId:randomUUID(),title:"Durable",prompt:"test"};
  const first=await localSubtaskClient(f.env)(args);await f.bridge.close();
  const config=f.store.readJSON("client.json");
  const api=createTaskCoordination({client:()=>f.client,runtime:f.runtime,localRoot:a=>config.lanePaths[a.laneId]||config.sessionPaths[a.sessionId]||config.paths[a.workspaceId],config,saveConfig:()=>f.store.writeJSON("client.json",config),dataDir:f.dir});
  const bridge=new CoordinationBridge({client:()=>f.client,runtime:f.runtime,taskCoordination:api});t.after(()=>bridge.close());
  const env=await bridge.issue({workspaceId:f.w.id,sessionId:f.session.id,laneId:f.lane.id,runId:f.approval.id});
  assert.deepEqual(await localSubtaskClient(env)(args),first);assert.equal(f.hub.db.subtasks.length,1);
  const different=join(f.dir,"different");await git(f.dir,["clone",f.root,different]);config.paths[f.w.id]=different;
  await assert.rejects(localSubtaskClient(env)(args),/项目已改变/);assert.equal(f.hub.db.subtasks.length,1);
});
