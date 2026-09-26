import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import WebSocket from 'ws';
const executable=resolve(process.argv[2]||'release/mac-arm64/头号玩家.app/Contents/MacOS/头号玩家');
const dir=await mkdtemp(join(tmpdir(),'rpo-project-packaged-'));await mkdir(join(dir,'bin'));
for(const name of ['codex','claude','gh','cloudflared'])await writeFile(join(dir,'bin',name),'#!/bin/sh\nexit 1\n',{mode:0o700});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ids;
for(const phase of ['create','restart']){
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...process.env,RPO_DATA_DIR:dir};for(const k of ['ELECTRON_RUN_AS_NODE','RPO_UPDATE_HEALTH_TICKET','RPO_IDENTITY_ISSUER','RPO_IDENTITY_PUBLIC_KEY_FILE','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])delete env[k];
 const child=spawn(executable,[`--remote-debugging-port=${port}`],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let ws;
 try {
  const deadline=Date.now()+30000;let target;
  while(Date.now()<deadline&&!target){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.includes('dist/index.html'));}catch{}if(!target)await sleep(100);}
  assert.ok(target,'packaged renderer available');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});let seq=0;const pending=new Map();ws.on('message',b=>{const v=JSON.parse(b);if(pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timed out'));},15000);pending.set(id,v=>{clearTimeout(timer);if(v.error)reject(Error(JSON.stringify(v.error)));else resolve(v.result);});ws.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const invoke=(method,args={})=>js(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
  while(!await js('!!document.querySelector(".app-shell")')){if(Date.now()>deadline)throw Error('renderer timed out');await sleep(100);}
  if(phase==='create'){
   await invoke('settings.general.save',{settings:{autoCheckUpdates:false}});
   const team=await invoke('workspace.create',{name:'打包验证'}),project=await invoke('collab.project.create',{teamId:team.id,name:'持久项目',requestKey:'package-project'});let s=await invoke('bootstrap'),channel=s.collaboration.channels.find(c=>c.projectId===project.id);
   await invoke('collab.message.send',{channelId:channel.id,text:'关闭后群聊仍在',requestKey:'package-message'});ids={team:team.id,project:project.id,channel:channel.id};
  }else{
   const state=await invoke('bootstrap');assert.equal(state.collaboration.projects.find(p=>p.id===ids.project).name,'持久项目');assert.equal(state.collaboration.channelMessages.find(m=>m.channelId===ids.channel).text,'关闭后群聊仍在');
  }
  await js('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent==="项目群").click()');await sleep(200);assert.equal(await js('!!document.querySelector(".project-room")'),true);
  const shot=await rpc('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,phase+'.png'),Buffer.from(shot.data,'base64'));
 }finally{ws?.close();child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000).then(()=>child.kill('SIGKILL'))]);await writeFile(join(dir,phase+'.log'),log);}
}
const evidence={passed:true,actualPackagedExecutable:true,architecture:process.arch,phases:2,modelCalls:0,installedApplicationModified:false,firstLaunchQuarantineTested:false};await writeFile(join(dir,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({directory:dir,...evidence}));
