import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderRuntime} from '../core/providers/runtime.mjs';
import {JsonLineProcess} from '../core/providers/transport.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await pause(10);}throw Error('condition timeout');}
test('runtime keeps the repository busy until a SIGTERM-ignoring descendant actually exits',{skip:process.platform==='win32'},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rpo-provider-exit-')),fixture=join(dir,'cli.cjs'),writes=join(dir,'writes');
 await writeFile(fixture,`
 const fs=require('node:fs');
 if(process.argv[2]==='child'){
   process.on('SIGTERM',()=>{});
   fs.appendFileSync(${JSON.stringify(writes)},'started\\n');
   setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'tick\\n'),25);
   setTimeout(()=>process.exit(),7000);
 }else{
   require('node:child_process').spawn(process.execPath,[__filename,'child'],{stdio:'ignore'});
   process.on('SIGTERM',()=>process.exit());
   const rl=require('node:readline').createInterface({input:process.stdin});
   rl.on('line',line=>{const m=JSON.parse(line);if(m.id){let result={};if(m.method==='thread/start')result={thread:{id:'thread'}};if(m.method==='turn/start')result={turn:{id:'turn'}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});
   setTimeout(()=>process.exit(),7000);
 }
 `);
 let transport,ended=0;
 const runtime=new ProviderRuntime({transportFactory:(_command,_args,options)=>(transport=new JsonLineProcess(process.execPath,[fixture],options))});
 t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
 await runtime.start({runId:'native',provider:'codex',cwd:dir,prompt:'local fake protocol only',onEnd:()=>ended++});
 await until(()=>readFile(writes,'utf8').then(()=>true,()=>false));
 const stopping=runtime.interrupt('native');await until(()=>transport.closed);
 // The direct CLI has exited, but its child intentionally ignores TERM.
 assert.equal(runtime.runs.has('native'),true);assert.equal(ended,0);
 const before=await readFile(writes,'utf8');await pause(80);assert.ok((await readFile(writes,'utf8')).length>before.length);
 await stopping;assert.equal(runtime.runs.size,0);assert.equal(ended,1);
 const after=await readFile(writes,'utf8');await pause(100);assert.equal(await readFile(writes,'utf8'),after);
});

test('custom provider waits for approved workspace command cleanup before releasing its run',{skip:process.platform==='win32'},async t=>{
 const {registerOpenAICompatible}=await import('../core/providers/openai-compatible.mjs');
 const {createWorkspaceTools}=await import('../core/providers/workspace-tools.mjs');
 const dir=await mkdtemp(join(tmpdir(),'rpo-custom-exit-')),fixture=join(dir,'command.cjs'),writes=join(dir,'writes');
 await writeFile(fixture,`require('node:fs').writeFileSync(${JSON.stringify(writes)},'started');setInterval(()=>{},1000);setTimeout(()=>process.exit(),7000);`);
 let release,exited;const cleanup=new Promise(r=>release=r),exit=new Promise(r=>exited=r);let ends=0;
 const original=createWorkspaceTools().find(t=>t.name==='run_command');
 const tool={...original,execute:async(...args)=>{const result=await original.execute(...args);exited(result);await cleanup;return result;}};
 const runtime=new ProviderRuntime();
 t.after(async()=>{release();await runtime.close();await rm(dir,{recursive:true,force:true});});
 const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
 registerOpenAICompatible(runtime,'fake',{baseUrl:'http://127.0.0.1:1/v1',model:'no-api',tools:[tool],fetch:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'command',function:{name:'run_command',arguments:JSON.stringify({command:`${quote(process.execPath)} ${quote(fixture)}`})}}]}}]})+'\n\ndata: [DONE]\n\n')});
 await runtime.start({runId:'custom',provider:'fake',cwd:dir,prompt:'fixture',mode:'workspace-write',onApproval:()=>true,onEnd:()=>ends++});
 await until(()=>readFile(writes,'utf8').then(()=>true,()=>false));
 const closed=runtime.close();assert.equal((await exit).aborted,true);assert.equal(runtime.runs.has('custom'),true);assert.equal(ends,0);
 release();await closed;assert.equal(runtime.runs.size,0);assert.equal(ends,1);
});
