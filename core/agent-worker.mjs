import {agentToolOptions} from './agent-tools.mjs';
// Standalone local worker. No Electron UI, model fixtures, or hosted credentials.
import {readFileSync,mkdirSync,statSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {HubClient} from './client.mjs';
import {ProviderRuntime} from './providers/runtime.mjs';
import {RunCoordinator} from './run-coordinator.mjs';
import {SecureStore} from './secure-store.mjs';
import {localEnv} from './local.mjs';
import {withinProject,verifyProjectCheckout,publishProjectArtifact} from '../desktop/services/project-artifacts.mjs';
import {ProjectArtifactSync} from '../desktop/services/project-artifact-sync.mjs';
export async function startAgentWorker(config,{onState=()=>{}}={}){
 const url=new URL(config.url);
 if(!['wss:','ws:'].includes(url.protocol)||(url.protocol==='ws:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('远程服务须使用 WSS');
 if(!config.auth?.secret||!config.auth?.token||!config.computerId||!config.teamId)throw Error('电脑配置不完整');
 const dir=resolve(config.dataDir);mkdirSync(dir,{recursive:true,mode:0o700});
 const key=createHash('sha256').update('rpo-worker-store-v1\0'+config.auth.secret).digest();
 const store=new SecureStore({dir:join(dir,'outbox'),key});key.fill(0);
 const client=new HubClient(),runtime=new ProviderRuntime({env:localEnv()});
 const agentFor=a=>{const s=client.state.sessions.find(s=>s.id===a.sessionId),t=client.state.collaboration.tasks.find(t=>t.sessionId===a.sessionId&&t.laneId===a.laneId),ta=client.state.collaboration.agents.find(x=>x.id===t?.agentId);return client.state.collaboration.agents.find(x=>!x.taskId&&x.workerId===client.state.me.id&&(x.id===s?.agentIdentityId||x.sessionId===s?.id||x.id===ta?.parentAgentId));};
 const root=a=>{const s=client.state.sessions.find(s=>s.id===a.sessionId);if(!s||!s.lanes.some(l=>l.id===a.laneId&&l.ownerId===client.state.me.id))throw Error('只能运行自己的会话');if(s.agentIdentityId){const path=join(dir,'agents',s.agentIdentityId);mkdirSync(path,{recursive:true,mode:0o700});return path;}const p=client.state.collaboration.projects.find(p=>p.id===s.projectId);if(!p||!config.projectRoots?.[p.id])throw Error('项目尚未映射到此电脑');return withinProject(config.projectRoots[p.id],p.subPath);};
 const coordinator=new RunCoordinator({runtime,client:()=>client,computerId:()=>config.computerId,acceptApproval:a=>a.computerId===config.computerId,dir:join(dir,'outbox'),root,
  options:async a=>{const s=client.state.sessions.find(s=>s.id===a.sessionId),l=s.lanes.find(l=>l.id===a.laneId);if(!['codex','claude'].includes(l.provider))throw Error('独立 worker 目前运行 Codex / Claude Code');if(a.projectId)await verifyProjectCheckout(config.projectRoots[a.projectId],a.projectBinding);const extra=agentToolOptions(config.agentTools?.[agentFor(a)?.id],l.provider);const mcp={command:process.execPath,args:[fileURLToPath(new URL('./mcp-coordination.mjs',import.meta.url))],env:{ELECTRON_RUN_AS_NODE:'1',RPO_HUB_URL:client.url,RPO_HUB_TOKEN:client.auth.token,RPO_CLIENT_SECRET:client.auth.secret,RPO_CLIENT_NAME:config.name||'电脑服务',RPO_SESSION_ID:a.sessionId,RPO_LANE_ID:a.laneId,...(client.auth.identitySession?{RPO_IDENTITY_SESSION:client.auth.identitySession}:{})}};return {...l.configuration,env:extra.env,codexConfig:{...extra.codexConfig,'mcp_servers.rpo':mcp},mcpServers:{...extra.mcpServers,rpo:mcp},readOnlyMcpTools:['mcp__rpo__rpo_context','mcp__rpo__rpo_project_context'],privateInstructions:agentFor(a)?.memory||''};},
  onProviderFinish:async(runId,c,result)=>{if(result.status==='done'){const task=client.state.collaboration.tasks.find(t=>t.runId===runId);if(task)try{await publishProjectArtifact(client,task,c.root);}catch(e){onState({artifactError:e.message});}}},
 });
 coordinator.attachStore(store);
 let stopped=false,busy=false;
 const tick=async()=>{if(stopped||busy||client.ws?.readyState!==1||!client.state)return;busy=true;try{await client.call('collab.computer.heartbeat',{teamId:config.teamId,id:config.computerId,name:config.name||'独立执行电脑',providers:config.providers||['codex','claude']});await client.call('collab.agent.poll',{teamId:config.teamId,computerId:config.computerId});await coordinator.process();onState({online:true});}catch(e){onState({error:e.message});}finally{busy=false;}};
 client.on('state',()=>{void coordinator.process().catch(e=>onState({error:e.message}));});
 await client.connect(url.href,config.auth);await coordinator.resume();
 const sync=new ProjectArtifactSync({client:()=>client,root});
 const timer=setInterval(()=>void tick(),2000);await tick();
 return {client,runtime,coordinator,stop:async()=>{stopped=true;clearInterval(timer);sync.dispose();await coordinator.close();client.close();store.destroy();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const path=process.argv[process.argv.indexOf('--config')+1];
 if(!process.argv.includes('--config')||!path)throw Error('用法：node core/agent-worker.mjs --config /path/computer.json');
 if(process.platform!=='win32'&&(statSync(path).mode&0o077))throw Error('连接文件必须仅本人可读：chmod 600 computer.json');
 const config=JSON.parse(readFileSync(path,'utf8'));
 const worker=await startAgentWorker(config,{onState:s=>{if(s.error)process.stderr.write('Worker: '+s.error+'\n');}});
 console.log('头号玩家电脑服务已连接；按 Ctrl+C 停止。');
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void worker.stop().then(()=>process.exit(0)));
}
