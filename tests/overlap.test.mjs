import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./helpers/secure-hub.mjs";
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),"rpo-overlap-")),hub=new Hub(dir),host={id:"host",name:"Host",host:true};
  t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
  const w=hub.act(host,"workspace.create",{name:"Team",branch:"main"}),peers={};
  for(const name of ["Alice","Bob","Carol"]){peers[name]={id:name,name,workspaceId:w.id,host:false};hub.registerMember(peers[name],w.id,"editor");}
  const s=hub.act(host,"session.create",{workspaceId:w.id,title:"Shared work"});
  const call=(who,method,args={})=>hub.act(peers[who]||host,method,{workspaceId:w.id,sessionId:s.id,...args});
  const lanes=Object.fromEntries(Object.keys(peers).map(name=>[name,call(name,"lane.create",{provider:"codex"})]));
  const activity=(who,files,extra={})=>call(who,"coordination.activity",{laneId:lanes[who].id,branch:"main",fileScopes:files.map(path=>({path,kind:"file"})),...extra});
  const check=(who,files,extra={})=>call(who,"coordination.check",{laneId:lanes[who].id,prompt:"Independent task",fileScopes:files.map(path=>({path,kind:"file"})),...extra});
  return {hub,host,w,s,peers,call,lanes,activity,check};
}
test("different members get exact/directory evidence without sibling-prefix false positives and cross-branch paths warn about integration",async t=>{
  const {lanes,activity,check}=await setup(t);
  activity("Bob",["src/auth/token.ts"],{branch:"feature/token"});
  let result=check("Alice",[],{branch:"feature/login",fileScopes:[{path:"src/auth/",kind:"directory"}]});
  assert.equal(result.details.length,1);const warning=result.details[0];assert.equal(warning.owner,"Bob");assert.equal(warning.laneId,lanes.Bob.id);assert.equal(warning.kind,"overlapping");assert.equal(warning.branchRelation,"different");assert.match(warning.reason,/后续集成/);assert.equal(warning.evidence[0].other.source,"open");assert.equal(warning.evidence[0].current.kind,"directory");
  assert.equal(check("Alice",["src/authentication/token.ts"]).details.length,0);
  assert.equal(check("Alice",["src/auth"]).details.length,0); // Explicit file cannot own descendants.
  assert.equal(check("Alice",[],{files:["src/auth"]}).details.length,1); // Legacy ambiguous paths retain prefix compatibility.
});
test("live file changes and published diff replace stale file snapshots, expire, and never leak a different workspace",async t=>{
  const {hub,host,w,s,call,lanes,activity,check}=await setup(t);
  const first=activity("Bob",["src/old.ts"]);
  assert.equal(check("Alice",["src/old.ts"]).details.length,1);
  activity("Bob",["src/new.ts"]);assert.equal(check("Alice",["src/old.ts"]).details.length,0);assert.equal(check("Alice",["src/new.ts"]).details.length,1);
  lanes.Bob.activity.expires=Date.now()-1;assert.equal(check("Alice",["src/new.ts"]).details.length,0);
  call("Bob","diff.publish",{laneId:lanes.Bob.id,files:[{path:"src/changed.ts",status:"M"}],diff:"diff"});
  assert.equal(check("Alice",["src/changed.ts"]).details[0].evidence[0].other.source,"changed");
  lanes.Bob.changesExpires=Date.now()-1;assert.equal(check("Alice",["src/changed.ts"]).details.length,0);
  const privateWorkspace=hub.act(host,"workspace.create",{name:"Private",branch:"main"}),privateSession=hub.act(host,"session.create",{workspaceId:privateWorkspace.id,title:"PRIVATE SECRET"}),privateLane=hub.act(host,"lane.create",{sessionId:privateSession.id,provider:"codex"});
  hub.act(host,"coordination.activity",{sessionId:privateSession.id,laneId:privateLane.id,files:["src/private.ts"],branch:"main"});
  assert.equal(check("Alice",["src/private.ts"]).details.length,0);
  assert.equal(JSON.stringify(check("Alice",["src/private.ts"])).includes("PRIVATE"),false);
  assert.notEqual(privateWorkspace.id,w.id);assert.equal(first.expires>0,true);
});
test("planned paths and linked steps expose concrete ownership even when task wording differs; completed plans stop warning",async t=>{
  const {call,lanes,check}=await setup(t);
  const planned=call("Bob","plan.add",{text:"调整 src/login/token.ts 校验",assigneeId:"Bob"});call("Bob","plan.claim",{id:planned.id});
  let result=check("Alice",["src/login/token.ts"]);assert.equal(result.details.length,1);assert.equal(result.details[0].kind,"adjacent");assert.ok(result.details[0].planIds.includes(planned.id));assert.equal(result.details[0].evidence[0].type,"plan-path");
  const explicit=call("Bob","plan.add",{text:"整理边界条件",assigneeId:"Bob",fileScopes:[{path:"lib/session",kind:"directory"}]});call("Bob","plan.claim",{id:explicit.id});
  assert.equal(check("Alice",["lib/session/edge.mjs"]).details[0].evidence[0].other.planId,explicit.id);
  const linked=call("Alice","run.request",{laneId:lanes.Alice.id,prompt:"不同措辞",mode:"read-only",planIds:[explicit.id]});
  assert.ok(linked.overlapDetails.some(d=>d.evidence.some(e=>e.type==="plan-step")));
  call("Bob","plan.status",{id:planned.id,status:"done"});assert.equal(check("Carol",["src/login/token.ts"]).details.length,0);
});
test("task/plan keywords only produce labeled advisory adjacency on the same branch, not unrelated or other-branch work",async t=>{
  const {call,lanes,check}=await setup(t);
  call("Bob","run.request",{laneId:lanes.Bob.id,prompt:"rotate oauth refresh credentials",mode:"workspace-write",branch:"auth"});
  let result=check("Alice",[],{prompt:"document oauth refresh behavior",branch:"auth"});
  assert.equal(result.details[0].kind,"adjacent");assert.equal(result.details[0].confidence,"advisory");assert.equal(result.details[0].algorithm,"deterministic-v1");assert.match(result.details[0].reason,/规则匹配/);
  assert.equal(check("Alice",[],{prompt:"document oauth refresh behavior",branch:"other"}).details.length,0);
  assert.equal(check("Alice",[],{prompt:"implement tests update files",branch:"auth"}).details.length,0);
});
test("advisory locks expire and respect workspace isolation; a warning does not block a separately approved run",async t=>{
  const {hub,host,call,lanes,check}=await setup(t);
  const lock=call("Bob","lock.acquire",{laneId:lanes.Bob.id,path:"src/auth/",kind:"directory",ttlMs:1000}).lock;
  const result=check("Alice",["src/auth/token.ts"]);assert.equal(result.details.length,1);assert.equal(result.details[0].kind,"lock");assert.equal(result.details[0].advisory,true);assert.match(result.details[0].reason,/不能阻止/);
  assert.equal(check("Alice",["src/authentication.ts"]).details.length,0);
  const ap=call("Alice","run.request",{laneId:lanes.Alice.id,prompt:"intentional coordinated work",mode:"workspace-write",files:["src/auth/token.ts"]});call("Host","approval.decide",{id:ap.id,allow:true});call("Alice","run.claim",{id:ap.id});assert.equal(lanes.Alice.status,"running");
  lock.expires=Date.now()-1;assert.equal(check("Carol",["src/auth/another.ts"]).details.some(d=>d.kind==="lock"),false);
});
test("checks refresh at approval and claim, use the active run rather than an old claimed approval, and ignore archived sessions",async t=>{
  const {call,lanes,activity,s,check}=await setup(t);
  const ap=call("Alice","run.request",{laneId:lanes.Alice.id,prompt:"current",mode:"read-only",files:["src/current.ts"]});assert.equal(ap.overlapDetails.length,0);
  activity("Bob",["src/current.ts"]);call("Host","approval.decide",{id:ap.id,allow:true});assert.equal(ap.overlapDetails[0].owner,"Bob");
  lanes.Bob.activity.expires=Date.now()-1;call("Alice","run.claim",{id:ap.id});assert.equal(ap.overlapDetails.length,0);
  call("Alice","run.finish",{laneId:lanes.Alice.id,runId:ap.id,status:"done"});
  const next=call("Alice","run.request",{laneId:lanes.Alice.id,prompt:"new unrelated",mode:"read-only",files:["src/next.ts"]});call("Host","approval.decide",{id:next.id,allow:true});call("Alice","run.claim",{id:next.id});
  assert.equal(check("Bob",["src/current.ts"]).details.length,0);assert.equal(check("Bob",["src/next.ts"]).details.length,1);
  s.status="archived";assert.throws(()=>check("Bob",["src/next.ts"]),/归档/);
});
test("activity cannot be forged for another lane, viewed workspace, invalid paths or unrelated plans",async t=>{
  const {hub,host,w,call,peers,lanes,s}=await setup(t);
  assert.throws(()=>call("Alice","coordination.activity",{laneId:lanes.Bob.id,files:["src/auth.ts"]}),/自己的/);
  hub.db.members.find(m=>m.id==="Carol").role="viewer";
  assert.throws(()=>call("Carol","coordination.activity",{laneId:lanes.Carol.id}),/editor/);
  assert.throws(()=>call("Alice","coordination.activity",{laneId:lanes.Alice.id,files:["../escape.ts"]}),/路径/);
  assert.throws(()=>call("Alice","coordination.activity",{laneId:lanes.Alice.id,ttlMs:0}),/有效期/);
  assert.throws(()=>call("Alice","run.request",{laneId:lanes.Alice.id,mode:"read-only",prompt:"invalid",planIds:["other-session-plan"]}),/关联计划/);
  assert.throws(()=>call("Alice","coordination.check",{laneId:lanes.Alice.id,branch:"main\nforged"}),/分支/);
  assert.equal(lanes.Alice.status,"idle");assert.equal(lanes.Alice.activity,undefined);
});
test("queued work preserves explicit scopes and plan references and rechecks changed activity at submission",async t=>{
  const {call,lanes,activity}=await setup(t);
  const plan=call("Alice","plan.add",{text:"Queued scope",fileScopes:[{path:"packages/auth",kind:"directory"}]});
  const queued=call("Alice","run.queue",{laneId:lanes.Alice.id,prompt:"queued",mode:"workspace-write",branch:"feature/auth",files:["legacy/path"],fileScopes:[{path:"packages/auth",kind:"directory"}],planIds:[plan.id]});
  activity("Bob",["packages/auth/index.ts"],{branch:"feature/auth"});
  const next=call("Alice","run.queue.next",{laneId:lanes.Alice.id});
  assert.equal(next.queue.id,queued.id);assert.equal(next.approval.branch,"feature/auth");assert.deepEqual(next.approval.planIds,[plan.id]);assert.ok(next.approval.fileScopes.some(s=>s.path==="packages/auth"&&s.kind==="directory"));assert.ok(next.approval.files.includes("legacy/path"));assert.equal(next.approval.overlapDetails[0].owner,"Bob");
});
test("native MCP overlap tool uses its bound lane and cannot inject a different workspace",async t=>{
  const {hub,peers,s,lanes,activity}=await setup(t);
  activity("Bob",["src/token.ts"]);
  const {createCoordinationMcp}=await import("../core/mcp-coordination.mjs");
  const rpc=createCoordinationMcp({client:{call:async(method,args)=>hub.act(peers.Alice,method,args)},sessionId:s.id,laneId:lanes.Alice.id});
  await rpc({jsonrpc:"2.0",id:1,method:"initialize"});
  const result=await rpc({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"rpo_overlap_check",arguments:{fileScopes:[{path:"src/token.ts",kind:"file"}]}}});
  assert.equal(result.result.isError,false);assert.equal(JSON.parse(result.result.content[0].text).details[0].owner,"Bob");
  const injected=await rpc({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"rpo_overlap_check",arguments:{workspaceId:"foreign",laneId:lanes.Bob.id}}});assert.equal(injected.error.code,-32602);
});
test("workspace-wide checks identify another session and drop its archived activity and locks",async t=>{
  const {hub,peers,w,check}=await setup(t);
  const other=hub.act(peers.Bob,"session.create",{workspaceId:w.id,title:"Sibling session",description:"related workspace work"}),lane=hub.act(peers.Bob,"lane.create",{sessionId:other.id,provider:"claude"});
  hub.act(peers.Bob,"coordination.activity",{sessionId:other.id,laneId:lane.id,branch:"other-session",fileScopes:[{path:"src/shared.ts",kind:"file"}]});
  hub.act(peers.Bob,"lock.acquire",{workspaceId:w.id,sessionId:other.id,laneId:lane.id,path:"src/shared.ts",kind:"file"});
  const before=check("Alice",["src/shared.ts"],{branch:"main"});assert.equal(before.details.length,2);assert.ok(before.details.every(d=>d.sessionId===other.id&&d.sessionTitle==="Sibling session"));assert.ok(before.details.some(d=>d.branchRelation==="different"));
  hub.act(peers.Bob,"session.archive",{sessionId:other.id});assert.equal(check("Alice",["src/shared.ts"]).details.length,0);
});
