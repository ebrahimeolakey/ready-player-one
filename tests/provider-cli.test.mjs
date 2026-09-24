import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,chmod,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {TerminalService} from '../desktop/services/terminal.mjs';
import {ProviderCLIService,resolveNativeCLI,displayCommand} from '../desktop/services/provider-cli.mjs';
const fixture=fileURLToPath(new URL('./fixtures/interactive-cli.mjs',import.meta.url));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('PTY condition timeout');}
const dead=pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
async function setup(t,{real=true}={}){
 const base=await mkdtemp(join(tmpdir(),'rpo-cli-')),cwd=join(base,"中文 空格 ' $(touch NOPE) ;");await mkdir(cwd);
 const state={identity:{audience:'hub-fixture'},me:{id:'me',roles:{w:'editor'}},sessions:[{id:'s',workspaceId:'w',lanes:[{id:'mine',ownerId:'me',provider:'codex'},{id:'other',ownerId:'other',provider:'claude'}]}]};
 const env={...process.env,RPO_HUB_TOKEN:'SYNTHETIC_PRIVATE',RPO_COORDINATION_BRIDGE_TOKEN:'SYNTHETIC_PRIVATE'};
 let root=cwd,calls=0,commandArgs=['space name','中文参数',"quote'\"",'$(touch NOPE); echo WRONG'];
 const terminals=new TerminalService();
 const service=new ProviderCLIService({terminals,state:()=>state,root:()=>root,accounts:()=>[{id:'codex',authenticated:true,label:'Fixture account'}],env:()=>env,
  resolveCommand:async()=>{calls++;return {command:process.execPath,args:[fixture,...commandArgs],resolvedCommand:process.execPath,launcher:'synthetic'};}});
 const args={workspaceId:'w',sessionId:'s',laneId:'mine'};
 t.after(async()=>{service.closeAll();terminals.closeAll();await rm(base,{recursive:true,force:true});});
 return {base,cwd,state,args,terminals,service,env,commandArgs,setRoot:r=>root=r,calls:()=>calls};
}
test('real CLI PTY preserves argv/cwd and raw Shift+Tab; duplicate open neither restarts nor replays input; exit cleans owner process',{skip:process.platform==='win32'},async t=>{
 const f=await setup(t);const {service,terminals,args,commandArgs,cwd}=f;
 const [opened,duplicate]=await Promise.all([service.open(1,args),service.open(1,args)]);assert.equal(opened.id,duplicate.id);assert.equal(f.calls(),1);
 const id=opened.id;await until(()=>terminals.read(1,{id}).data.includes('CLI_READY'));
 const first=terminals.read(1,{id}).data,frame=JSON.parse(first.match(/CLI_READY (.*)\r?\n/)[1]);
 assert.deepEqual(frame.argv,commandArgs);assert.equal(frame.cwd,await realpath(cwd));assert.equal(frame.tty,true);assert.equal(frame.hub,false);assert.equal(frame.bridge,false);
 assert.equal(f.env.RPO_HUB_TOKEN,'SYNTHETIC_PRIVATE');assert.equal(opened.cli.account,'Fixture account');assert.equal(opened.cli.cwd,frame.cwd);
 assert.match(opened.cli.displayCommand,/中文参数/);assert.throws(()=>terminals.input(2,{id,data:'denied'}),/无权/);
 terminals.input(1,{id,data:'\x1b[Z'});await until(()=>terminals.read(1,{id}).data.includes('INPUT_HEX 1b5b5a'));
 assert.equal((await service.open(1,args)).id,id);assert.equal(await readFile(join(cwd,'cli-input.log'),'utf8'),'\x1b[Z');
 await assert.rejects(service.open(1,{...args,laneId:'other'}),/本人/);await assert.rejects(service.open(1,{...args,workspaceId:'wrong'}),/无权/);
 f.state.me.roles.w='viewer';await assert.rejects(service.authorize(1,id),/Editor/);f.state.me.roles.w='editor';
 const other=join(f.base,'新目录');await mkdir(other);f.setRoot(other);await assert.rejects(service.authorize(1,id),/变化/);await assert.rejects(service.open(1,args),/变化/);f.setRoot(cwd);
 terminals.input(1,{id,data:'EXIT'});await until(()=>terminals.read(1,{id}).exited);assert.equal(terminals.read(1,{id}).exitCode,7);
 assert.equal((await service.open(1,args)).id,id,'exit never silently restarts on duplicate click');
 terminals.close(1,{id});const fresh=await service.open(1,args),pid=terminals.get(1,fresh.id).process.pid;service.closeAll();await until(()=>dead(pid));assert.equal(terminals.terminals.size,0);
});
test('native PATH resolver and npm Windows shim use verified package bin via Node argv, not shell text',async t=>{
 const base=await mkdtemp(join(tmpdir(),'rpo-cli-resolve-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const bin=join(base,'中文 bin');await mkdir(bin);
 const native=join(bin,'codex');await writeFile(native,'#!/bin/sh\nexit 0\n');await chmod(native,0o755);
 assert.equal((await resolveNativeCLI('codex',{PATH:bin},'darwin')).command,native);
 await assert.rejects(resolveNativeCLI('acp-hermes',{PATH:bin},'darwin'),/没有已验证/);
 const pkg=join(bin,'node_modules','@openai','codex');await mkdir(join(pkg,'bin'),{recursive:true});await writeFile(join(bin,'codex.cmd'),'MALICIOUS SHELL TEXT MUST NOT EXECUTE');await writeFile(join(bin,'node.exe'),'fixture');
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'bin/codex.js'}}));await writeFile(join(pkg,'bin','codex.js'),'// fixture');
 const resolved=await resolveNativeCLI('codex',{PATH:bin},'win32');assert.equal(resolved.command,join(bin,'node.exe'));assert.deepEqual(resolved.args,[await realpath(join(pkg,'bin','codex.js'))]);assert.equal(resolved.launcher,'npm-node');
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'../../outside.js'}}));await assert.rejects(resolveNativeCLI('codex',{PATH:bin},'win32'),/安全解析/);
 await writeFile(join(bin,'codex.exe'),'native');assert.equal((await resolveNativeCLI('codex',{PATH:bin},'win32')).command,join(bin,'codex.exe'));
 assert.match(displayCommand("/path/a'b",['x;bad']),/x;bad/);
});
test('context switches during command lookup cancel pending launch, and concurrent native work blocks CLI',async t=>{
 const f=await setup(t);let release;f.service.resolveCommand=()=>new Promise(r=>{release=r;});
 const opening=f.service.open(1,f.args);await until(()=>release);assert.equal(f.service.activeIn(await realpath(f.cwd)),true);
 f.service.closeAll();release({command:process.execPath,args:[fixture],resolvedCommand:process.execPath,launcher:'synthetic'});
 await assert.rejects(opening,/变化/);assert.equal(f.terminals.terminals.size,0);assert.equal(f.service.activeIn(await realpath(f.cwd)),false);
 f.service.isBusy=()=>true;await assert.rejects(f.service.open(1,f.args),/正在执行/);
});
test('closing the real provider PTY cleans its own descendant process',{skip:process.platform==='win32'},async t=>{
 const {service,terminals,args,cwd}=await setup(t),{id}=await service.open(1,args);
 await until(()=>terminals.read(1,{id}).data.includes('CLI_READY'));
 terminals.input(1,{id,data:'CHILD'});
 let child;
 await until(async()=>{try{child=Number(await readFile(join(cwd,'child.pid'),'utf8'));return child>0;}catch{return false;}});
 // This pid comes only from this test-created child's private temporary directory.
 t.after(()=>{if(!dead(child))try{process.kill(child,'SIGKILL');}catch{}});
 service.closeAll();await until(()=>dead(child));
});
test('rejected concurrent launch cannot clear another pending root reservation',async t=>{
 const f=await setup(t);let release;f.service.resolveCommand=()=>new Promise(r=>{release=r;});
 f.service.isBusy=root=>f.service.activeIn(root);
 const opening=f.service.open(1,f.args);await until(()=>release);
 f.state.sessions[0].lanes.push({id:'second',ownerId:'me',provider:'claude'});
 await assert.rejects(f.service.open(1,{...f.args,laneId:'second'}),/正在执行/);
 assert.equal(f.service.activeIn(await realpath(f.cwd)),true);
 f.service.closeAll();release({command:process.execPath,args:[fixture],resolvedCommand:process.execPath,launcher:'synthetic'});await assert.rejects(opening,/变化/);
 assert.equal(f.service.activeIn(await realpath(f.cwd)),false);
});
