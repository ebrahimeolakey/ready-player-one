import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebuggerService } from "../desktop/services/debugger.mjs";
const fixtureScript = `function add(value) {
  let total = value + 1;
  total += 2;
  return total;
}
const result = add(4);
console.log("RESULT", result);
`;
async function fixture(t, script = fixtureScript, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "rpo-debug-test-"));
  await writeFile(join(root, "entry.cjs"), script);
  const service = new DebuggerService({ resolveContext: (_owner,args) => ({root,contextId: args.contextId || "workspace"}), ...options });
  t.after(async () => { await service.closeAll(); await rm(root, {recursive:true,force:true}); });
  const invoke = (method,args={}) => service.invoke("window-1", method,args);
  return { root, service, invoke };
}
async function waitFor(invoke, id, predicate, timeout = 10000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { const state=await invoke("debug.read",{id});if(predicate(state))return state;await new Promise(r=>setTimeout(r,20)); }
  throw Error("Debugger state timed out: "+JSON.stringify(await invoke("debug.read",{id})));
}
test("real Node breakpoint, frames, variables and stepping reflect actual execution and normal exit",async t=>{
  const {service,invoke,root}=await fixture(t);
  const started=await invoke("debug.start",{path:"entry.cjs",breakpoints:[{path:"entry.cjs",line:3}]});
  assert.equal(started.status,"paused");assert.equal(service.isBusy(root),true);assert.equal(JSON.stringify(started).includes("ws://"),false);
  await invoke("debug.action",{id:started.id,action:"resume"});
  let paused=await waitFor(invoke,started.id,s=>s.status==="paused"&&s.frames[0]?.line===3);
  assert.equal(paused.frames[0].name,"add");assert.equal(paused.frames[0].path,"entry.cjs");assert.ok(paused.frames.length>1);
  let locals=await invoke("debug.variables",{id:started.id,pauseId:paused.pauseId,frameId:paused.frames[0].id});
  const value=(data,name)=>data.scopes.flatMap(s=>s.values).find(v=>v.name===name)?.value;
  assert.equal(value(locals,"value"),"4");assert.equal(value(locals,"total"),"5");
  await invoke("debug.action",{id:started.id,action:"stepOver"});
  const next=await waitFor(invoke,started.id,s=>s.status==="paused"&&s.frames[0]?.line===4);
  locals=await invoke("debug.variables",{id:started.id,pauseId:next.pauseId,frameId:next.frames[0].id});assert.equal(value(locals,"total"),"7");
  await assert.rejects(invoke("debug.variables",{id:started.id,pauseId:paused.pauseId,frameId:paused.frames[0].id}),/暂停位置/);
  await invoke("debug.action",{id:started.id,action:"stepOut"});
  paused=await waitFor(invoke,started.id,s=>s.status==="paused"&&s.frames[0]?.name!=="add");
  assert.ok(paused.frames[0]);
  await invoke("debug.action",{id:started.id,action:"resume"});
  const ended=await waitFor(invoke,started.id,s=>s.status==="exited");assert.equal(ended.exitCode,0);assert.match(ended.output,/RESULT 7/);
  await waitFor(invoke,started.id,()=>!service.isBusy(root));
});
test("entry and breakpoint paths are constrained; wrong owner/context and evaluation commands are rejected",async t=>{
  const {service,invoke,root}=await fixture(t);
  const outside=await mkdtemp(join(tmpdir(),"rpo-debug-outside-"));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,"outside.cjs"),"throw Error('must not run')");
  await symlink(join(outside,"outside.cjs"),join(root,"escape.cjs"));await writeFile(join(root,"wrong.txt"),"x");
  for(const path of ["../outside.cjs",join(root,"entry.cjs"),"escape.cjs","wrong.txt"]) await assert.rejects(invoke("debug.start",{path}));
  const files=await invoke("debug.files");assert.deepEqual(files.files,["entry.cjs"]);
  assert.equal((await invoke("debug.source",{path:"entry.cjs"})).text,fixtureScript);
  const started=await invoke("debug.start",{path:"entry.cjs"});
  await assert.rejects(service.invoke("window-2","debug.read",{id:started.id}),/无权访问/);
  await assert.rejects(invoke("debug.read",{id:started.id,contextId:"other"}),/无权访问/);
  await assert.rejects(invoke("debug.action",{id:started.id,action:"evaluate",expression:"process.exit()"}),/不支持/);
  await assert.rejects(invoke("debug.breakpoint.set",{id:started.id,path:"escape.cjs",line:1}),/超出/);
  await assert.rejects(invoke("debug.breakpoint.set",{id:started.id,path:"entry.cjs",line:0}),/行号/);
  const withBreakpoint=await invoke("debug.breakpoint.set",{id:started.id,path:"entry.cjs",line:3});assert.equal(withBreakpoint.breakpoints.length,1);
  const removed=await invoke("debug.breakpoint.remove",{id:started.id,breakpointId:withBreakpoint.breakpoints[0].id});assert.equal(removed.breakpoints.length,0);
  await invoke("debug.stop",{id:started.id});assert.equal(service.isBusy(root),false);
});
test("pause and stop terminate real process tree, owner closure blocks new sessions",async t=>{
  const {root,service,invoke}=await fixture(t,`const {spawn} = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync('child.pid', String(child.pid));
setInterval(() => { let x = 1; x++; }, 20);
`);
  const started=await invoke("debug.start",{path:"entry.cjs"});await invoke("debug.action",{id:started.id,action:"resume"});
  let pid;for(let n=0;n<100;n++){try{pid=Number(await readFile(join(root,"child.pid"),"utf8"));break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(pid);
  await invoke("debug.action",{id:started.id,action:"pause"});await waitFor(invoke,started.id,s=>s.status==="paused");
  const parentPid=service.records.get(started.id).process.pid;
  await service.closeOwner("window-1");assert.equal(service.isBusy(root),false);
  assert.throws(()=>process.kill(parentPid,0));assert.throws(()=>process.kill(pid,0));
  await assert.rejects(invoke("debug.start",{path:"entry.cjs"}),/关闭/);
});
test("explicit start runs no NODE_OPTIONS preload and respects injected beforeStart gate",async t=>{
  let deny=true;const {root,invoke}=await fixture(t,fixtureScript,{beforeStart:()=>{if(deny)throw Error("Agent 正在运行");},env:{...process.env,NODE_OPTIONS:"--require=./malicious.cjs"}});
  await writeFile(join(root,"malicious.cjs"),"require('node:fs').writeFileSync('preloaded','bad')");
  await assert.rejects(invoke("debug.start",{path:"entry.cjs"}),/Agent/);deny=false;
  const started=await invoke("debug.start",{path:"entry.cjs"});assert.equal(started.status,"paused");
  await assert.rejects(readFile(join(root,"preloaded")),{code:"ENOENT"});
  await invoke("debug.stop",{id:started.id});
});
test("stepInto reaches a real function and uncaught exceptions pause before nonzero exit",async t=>{
  const {invoke}=await fixture(t,`function fail(value) {
  throw new Error("debug-fixture-" + value);
}
fail(9);
`);
  const started=await invoke("debug.start",{path:"entry.cjs",breakpoints:[{line:4}]});
  let paused=started;
  if(paused.frames[0]?.line!==4){await invoke("debug.action",{id:started.id,action:"resume"});paused=await waitFor(invoke,started.id,s=>s.status==="paused"&&s.frames[0]?.line===4);}
  await invoke("debug.action",{id:started.id,action:"stepInto"});
  paused=await waitFor(invoke,started.id,s=>s.status==="paused"&&s.frames[0]?.name==="fail");assert.equal(paused.frames[0].line,2);
  await invoke("debug.action",{id:started.id,action:"resume"});
  await waitFor(invoke,started.id,s=>s.status==="paused"&&s.reason==="exception");
  await invoke("debug.action",{id:started.id,action:"resume"});
  const ended=await waitFor(invoke,started.id,s=>s.status==="exited");assert.equal(ended.exitCode,1);assert.match(ended.output,/debug-fixture-9/);
});
test("pending start reserves workspace, owner close before spawn does not leave a child",async t=>{
  let release;const gate=new Promise(r=>release=r);
  const {invoke,root,service}=await fixture(t,fixtureScript,{beforeStart:()=>gate});
  const start=invoke("debug.start",{path:"entry.cjs"});
  while(!service.isBusy(root))await new Promise(r=>setTimeout(r,5));
  await assert.rejects(service.invoke("window-2","debug.start",{path:"entry.cjs"}),/启动|调试进程/);
  await service.closeAll();release();await assert.rejects(start,/关闭/);
  assert.equal(service.isBusy(root),false);assert.equal(service.records.size,0);
});

test('macOS zombie-only process group is EPERM until reaped; debugger must wait for ESRCH', {skip:process.platform!=='darwin',timeout:10000},async t=>{
  const {spawn,execFileSync}=await import('node:child_process');
  const {once}=await import('node:events');
  // Only these two test-created processes receive signals. The helper is held
  // before its child exits, making the kernel's unreaped-zombie state observable.
  const helper=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.on('exit',()=>process.exit(0));`],{stdio:['ignore','pipe','pipe']});
  const helperExit=once(helper,'exit');let pid;
  const service=new DebuggerService({resolveContext:()=>null});
  try {
    pid=Number(String((await once(helper.stdout,'data'))[0]).trim());assert.ok(Number.isSafeInteger(pid)&&pid>1);
    const state=target=>{try{return execFileSync('/bin/ps',['-o','stat=','-p',String(target)],{encoding:'utf8'}).trim();}catch{return '';}};
    const until=async check=>{const deadline=Date.now()+2000;while(!check()){if(Date.now()>=deadline)throw Error('fixture process state timed out');await new Promise(r=>setTimeout(r,10));}};
    process.kill(helper.pid,'SIGSTOP');await until(()=>state(helper.pid).startsWith('T'));
    process.kill(pid,'SIGKILL');await until(()=>state(pid).startsWith('Z'));
    assert.throws(()=>process.kill(-pid,0),{code:'EPERM'});
    const record={process:{pid},processExited:true,treeStopped:false};let completed=false;
    const waiting=service.waitTree(record).then(()=>{completed=true;});
    await new Promise(r=>setTimeout(r,60));assert.equal(completed,false);assert.equal(record.treeStopped,false);
    process.kill(helper.pid,'SIGCONT');await helperExit;await waiting;
    assert.equal(record.treeStopped,true);assert.throws(()=>process.kill(-pid,0),{code:'ESRCH'});
  } finally {
    if(helper.exitCode===null&&helper.signalCode===null){try{process.kill(helper.pid,'SIGCONT');}catch{}helper.kill('SIGKILL');await helperExit;}
    if(pid)try{process.kill(pid,'SIGKILL');}catch{}
  }
});

test('persistent EPERM fails closed at deadline; unknown/live group never releases workspace',async t=>{
  const {realpathSync}=await import('node:fs');
  const service=new DebuggerService({resolveContext:()=>null});
  const root=realpathSync('.'),record={root,process:{pid:999999},processExited:true,treeStopped:false};service.records.set('fixture',record);
  const denied=Object.assign(Error('synthetic EPERM'),{code:'EPERM'});let calls=0;
  t.mock.method(process,'kill',(pid,signal)=>{assert.equal(pid,-999999);assert.equal(signal,0);calls++;throw denied;});
  let time=0;t.mock.method(Date,'now',()=>{const result=time;time+=5001;return result;});
  await assert.rejects(service.waitTree(record),error=>/尚未确认退出/.test(error.message)&&error.cause===denied);
  assert.equal(calls,1);assert.equal(record.treeStopped,false);assert.equal(service.isBusy(root),true);
});
