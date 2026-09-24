import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { Hub } from "../core/hub.mjs";
import { SecureStore } from "../core/secure-store.mjs";
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-hub-security-")), key = randomBytes(32), store = new SecureStore({ dir, key });
  const hub = new Hub(dir, { store, ...options }), owner = { id: "host", name: "Host", host: true };
  const w = hub.act(owner, "workspace.create", { name: "Secure" }), s = hub.act(owner, "session.create", { workspaceId: w.id, title: "Secure session" });
  const act = (method, args = {}) => hub.act(owner, method, { sessionId: s.id, workspaceId: w.id, ...args });
  const lane = act("lane.create", { provider: "codex" });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, key, store, hub, owner, w, s, lane, act };
}
test("Hub requires encrypted store, never writes plaintext DB/transcripts, and preserves authentication keys", async t => {
  const { dir, key, store, hub, owner, lane, act } = await setup(t);
  assert.throws(() => new Hub(join(dir, "unsafe")), /必须注入/);
  const token = hub.db.hostToken;
  const invite = act("invite.create", { role: "viewer" });
  hub.entry(lane, "assistant", "Private internal conversation"); hub.save();
  assert.equal(existsSync(join(dir, "hub.json")), false); assert.equal(existsSync(join(dir, "transcripts", `${lane.id}.jsonl`)), false);
  const disk = await readFile(join(dir, "hub.json.enc"), "utf8"); assert.equal(disk.includes(token), false); assert.equal(disk.includes(invite.token), false); assert.equal(disk.includes("Private internal conversation"), false);
  assert.equal(store.readJSON("hub.json").hostToken, token);
  const restored = new Hub(dir, { store: new SecureStore({ dir, key }) });
  assert.equal(restored.db.hostToken, token);assert.equal(restored.db.invites[0].token, invite.token);
  assert.equal(JSON.stringify(hub.snapshot(owner)).includes(token), false);
  await restored.close();
});
test("legacy migration encrypts original data, scrubs visible cache/export and preserves hostToken", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rpo-hub-legacy-")), key = randomBytes(32), store = new SecureStore({ dir, key });
  const token = randomBytes(32).toString("hex"), secret = "sk-" + "A".repeat(32), laneId = randomUUID(), wsId = randomUUID(), sessionId = randomUUID();
  const entry = { id: randomUUID(), role: "assistant", text: `api_key=${secret}`, at: new Date().toISOString() };
  const db = { version:1,hostToken:token,invites:[],workspaces:[{id:wsId,name:"Legacy"}],sessions:[{id:sessionId,workspaceId:wsId,status:"active",lanes:[{id:laneId,entries:[entry],status:"done"}],plan:[],comments:[]}],memories:[],approvals:[] };
  await mkdir(join(dir,"transcripts"));await writeFile(join(dir,"hub.json"),JSON.stringify(db));await writeFile(join(dir,"hub.json.tmp"),JSON.stringify(db));await writeFile(join(dir,"transcripts",`${laneId}.jsonl`),JSON.stringify(entry)+"\n");
  const hub = new Hub(dir,{store});
  t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
  assert.equal(hub.db.hostToken,token);assert.equal(hub.db.sessions[0].lanes[0].entries[0].text.includes(secret),false);
  assert.equal(store.readJSONL(`transcripts/${laneId}.jsonl`)[0].text,entry.text); // lossless encrypted original
  assert.equal(existsSync(join(dir,"hub.json.tmp")),false);assert.equal(existsSync(join(dir,"hub.json.tmp.enc")),true);
  const exported=hub.act({id:"host",name:"Host",host:true},"session.export",{sessionId});assert.equal(JSON.stringify(exported).includes(secret),false);
});
test("complete accumulated stream is redacted before every broadcast and encrypted append, including split short token prefixes", async t => {
  const { hub, owner, act, lane, store }=await setup(t);
  const ap=act("run.request",{laneId:lane.id,prompt:"Explain",mode:"read-only"});act("approval.decide",{id:ap.id,allow:true});act("run.claim",{id:ap.id});
  const chunks=["Credential: sk-","ABCDEF","GHIJKLMNOPQRSTUVWXYZ"], key=chunks.join("").split(": ")[1];
  for(let i=0;i<chunks.length;i++) {
    act("run.entry",{laneId:lane.id,runId:ap.id,entryId:"stream",eventId:`e${i}`,role:"assistant",delta:true,text:chunks[i]});
    const visible=JSON.stringify(hub.snapshot(owner));assert.equal(visible.includes("ABCDEF"),false);assert.equal(visible.includes("sk-"),false);
  }
  act("run.entry",{laneId:lane.id,runId:ap.id,entryId:"stream",eventId:"final",role:"assistant",delta:false,text:chunks.join("")});
  assert.equal(lane.entries.find(e=>e.id==="stream").streaming,false);
  assert.equal(JSON.stringify(store.readJSONL(hub.logName(lane))).includes(key),false);
  assert.equal(hub.rawEntries.size,0);
});
test("retention only prunes ended transcript records and their DB cache, retaining active logs and other collaboration data",async t=>{
  const {hub,owner,act,lane,s,store}=await setup(t), old=new Date(Date.now()-90*86400000).toISOString();
  hub.entry(lane,"assistant","old ended",{at:old});hub.entry(lane,"assistant","new ended");
  const running=act("lane.create",{provider:"claude"});hub.entry(running,"assistant","old active",{at:old});
  const ap=act("run.request",{laneId:running.id,prompt:"Active",mode:"read-only"});act("approval.decide",{id:ap.id,allow:true});act("run.claim",{id:ap.id});
  act("plan.add",{text:"Keep plan"});act("comment.add",{text:"Keep comment"});act("memory.add",{title:"Keep",text:"Memory"});
  const result=act("storage.retention",{days:30});assert.ok(result.removedEntries>=1);
  assert.equal(lane.entries.some(e=>e.text==="old ended"),false);assert.equal(store.readJSONL(hub.logName(lane)).some(e=>e.text==="old ended"),false);
  assert.ok(running.entries.some(e=>e.text==="old active"));assert.ok(store.readJSONL(hub.logName(running)).some(e=>e.text==="old active"));
  assert.equal(s.plan.length,1);assert.equal(s.comments.length,1);assert.equal(hub.db.memories.length,1);
  assert.equal(hub.snapshot(owner).storage.retentionDays,30);
  assert.throws(()=>act("storage.retention",{days:0}),/保留期/);
});
test("wrong encryption key and damaged transcript fail closed without overwriting evidence",async t=>{
  const {dir,key,store,hub,lane}=await setup(t);hub.save();
  const before=await readFile(join(dir,"hub.json.enc"));
  assert.throws(()=>new Hub(dir,{store:new SecureStore({dir,key:randomBytes(32)})}),/无法读取/);
  assert.deepEqual(await readFile(join(dir,"hub.json.enc")),before);
  const path=join(dir,"transcripts",`${lane.id}.jsonl.enc`);const damaged=(await readFile(path,"utf8")).replace(/"tag":"[^"]+"/,'"tag":"AAAAAAAAAAAAAAAAAAAAAA=="');await writeFile(path,damaged);
  assert.throws(()=>new Hub(dir,{store:new SecureStore({dir,key})}));assert.equal(await readFile(path,"utf8"),damaged);
});
test("custom providers share only UUID and label and remain valid for child claims",async t=>{
  const {hub,owner,act,s,w}=await setup(t),provider=`custom-${randomUUID()}`;
  const parent=act("lane.create",{provider,providerLabel:"Team model"});
  assert.equal(parent.provider,provider);assert.equal(parent.providerLabel,"Team model");
  for(const bad of [{apiKey:"sk-secret"},{baseUrl:"https://example.test"},{headers:{Authorization:"Bearer secret"}}])assert.throws(()=>act("lane.create",{provider,providerLabel:"Test",...bad}),/不接收/);
  assert.throws(()=>act("lane.create",{provider:"custom-not-a-uuid"}),/未知智能体/);
  assert.throws(()=>act("lane.create",{provider,providerLabel:"sk-"+"A".repeat(20)}),/名称不能/);
  const task=act("subtask.request",{parentLaneId:parent.id,title:"Child",prompt:"Test",baseCommit:"a".repeat(40),requiredCheckIds:["tests"]});
  const claimed=act("subtask.claim",{id:task.id,baseCommit:task.baseCommit,worktreeReady:true});
  assert.equal(claimed.lane.provider,provider);assert.equal(claimed.lane.providerLabel,"Team model");
  assert.equal(JSON.stringify(hub.snapshot(owner)).includes("apiKey"),false);
});
test("standalone refuses absent external key and boots encrypted with a private external key",async t=>{
  const {spawn}=await import("node:child_process"),{resolve}=await import("node:path"),{chmod}=await import("node:fs/promises");
  const dir=await mkdtemp(join(tmpdir(),"rpo-standalone-security-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const run=(env)=>spawn(process.execPath,[resolve("core/standalone.mjs")],{env:{...process.env,...env},cwd:dir});
  const bad=run({RPO_HUB_DIR:join(dir,"missing"),RPO_DATA_KEY_FILE:""});let badLog="";bad.stderr.on("data",v=>badLog+=v);const badExit=await new Promise(r=>bad.once("exit",r));assert.notEqual(badExit,0);assert.match(badLog,/RPO_DATA_KEY_FILE/);assert.equal(existsSync(join(dir,"missing","hub.json")),false);
  const keys=join(dir,"keys"),data=join(dir,"data");await mkdir(keys,{mode:0o700});await chmod(keys,0o700);const key=randomBytes(32),keyFile=join(keys,"hub.key");await writeFile(keyFile,key.toString("hex"),{mode:0o600});await chmod(keyFile,0o600);
  const store=new SecureStore({dir:data,key}),hub=new Hub(data,{store});hub.act({id:"host",name:"Host",host:true},"workspace.create",{name:"Standalone"});await hub.close();
  const publicKeyFile=join(keys,"identity-public.pem"),publicKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"});await writeFile(publicKeyFile,publicKey);
  const incomplete=run({RPO_HUB_DIR:data,RPO_DATA_KEY_FILE:keyFile,RPO_IDENTITY_ISSUER:"https://identity.example.test",RPO_IDENTITY_PUBLIC_KEY_FILE:""});let incompleteLog="";incomplete.stderr.on("data",v=>incompleteLog+=v);assert.notEqual(await new Promise(r=>incomplete.once("exit",r)),0);assert.match(incompleteLog,/同时配置/);
  const child=run({RPO_HUB_DIR:data,RPO_DATA_KEY_FILE:keyFile,RPO_PORT:"0",RPO_SHARE:"0",RPO_IDENTITY_ISSUER:"https://identity.example.test",RPO_IDENTITY_PUBLIC_KEY_FILE:publicKeyFile});t.after(()=>child.kill());let output="",errors="";child.stderr.on("data",chunk=>errors+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("standalone startup timed out: "+errors)),10000);child.stdout.on("data",chunk=>{output+=chunk;if(output.includes("协作服务已启动")){clearTimeout(timer);resolve();}});child.once("exit",code=>{clearTimeout(timer);if(!output.includes("协作服务已启动"))reject(Error("early exit "+code+": "+errors));});});
  assert.equal(output.includes(key.toString("hex")),false);assert.equal(existsSync(join(data,"hub.json.enc")),true);assert.equal(existsSync(join(data,"hub.json")),false);
  const {HubClient}=await import("../core/client.mjs"),client=new HubClient(),port=output.match(/127\.0\.0\.1:(\d+)/)[1];
  try{const state=await client.connect(`ws://127.0.0.1:${port}`,{token:hub.db.hostToken,secret:randomBytes(32).toString("hex"),name:"Test"});assert.equal(state.identity.configured,true);assert.equal(state.identity.issuer,"https://identity.example.test");}finally{client.close();}
  const exited=new Promise(r=>child.once("exit",r));child.kill("SIGTERM");assert.equal(await exited,0);
});

test("coordination RPC context and persisted tool requests redact secrets like public snapshots",async t=>{
  const {hub,owner,act,lane}=await setup(t),secret="Bearer "+"Z".repeat(40);
  act("plan.add",{text:"Credential "+secret});act("memory.add",{title:"Context",text:secret});
  for(const result of [act("coordination.context"),hub.snapshot(owner)])assert.equal(JSON.stringify(result).includes("Z".repeat(40)),false);
  const ap=act("run.request",{laneId:lane.id,prompt:"Read",mode:"read-only"});act("approval.decide",{id:ap.id,allow:true});act("run.claim",{id:ap.id});
  const tool=act("tool.request",{laneId:lane.id,runId:ap.id,providerRequestId:"secret-input",action:"shell",input:{Authorization:secret,command:"echo "+secret}});
  assert.equal(JSON.stringify(tool).includes("Z".repeat(40)),false);
  assert.equal(JSON.stringify(hub.db.toolApprovals).includes("Z".repeat(40)),false);
});
test("ACP lanes require a UUID provider and expose only its public label including child lanes",async t=>{
  const {act}=await setup(t),provider=`acp-${randomUUID()}`;
  const lane=act("lane.create",{provider,providerLabel:"Team ACP"});assert.equal(lane.provider,provider);assert.equal(lane.providerLabel,"Team ACP");
  for(const invalid of ["acp", "acp-../provider", "acp-not-a-uuid",`acp-${randomUUID()}-suffix`])assert.throws(()=>act("lane.create",{provider:invalid}),/未知智能体/);
  assert.throws(()=>act("lane.create",{provider,token:"secret"}),/不接收/);
  const task=act("subtask.request",{parentLaneId:lane.id,title:"ACP child",prompt:"task",baseCommit:"c".repeat(40),requiredCheckIds:["test"]});
  const child=act("subtask.claim",{id:task.id,baseCommit:task.baseCommit,worktreeReady:true});assert.equal(child.lane.provider,provider);assert.equal(child.lane.providerLabel,"Team ACP");
});
