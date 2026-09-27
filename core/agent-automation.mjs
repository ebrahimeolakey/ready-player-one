import {randomUUID} from 'node:crypto';
import {redactText} from './secure-store.mjs';
const stamp=()=>new Date().toISOString();
export function queueAgentEvent(hub,agent,channel,text,key,extra={}){
 const db=hub.db.collaboration;
 if(db.agentEvents.some(e=>e.agentId===agent.id&&e.key===key))return;
 if(db.agentEvents.filter(e=>e.agentId===agent.id&&e.status==='queued').length>=100)return;
 db.agentEvents.push({id:randomUUID(),teamId:agent.teamId,projectId:channel.projectId,channelId:channel.id,agentId:agent.id,text:redactText(text).slice(0,10000),key,status:'queued',at:stamp(),...extra});
}
export function routeAgentMessage(hub,channel,message){
 if(message.author.type!=='human')return;
 for(const agent of hub.db.collaboration.agents.filter(a=>!a.taskId&&!a.paused&&a.teamId===channel.teamId&&a.policy?.projectIds?.includes(channel.projectId))){
  if(agent.policy.trigger==='discussion'||(agent.policy.trigger==='mentions'&&message.text.split('@'+agent.name).slice(1).some(t=>!t||/^[\s，。！？、:：,!?]/u.test(t))))queueAgentEvent(hub,agent,channel,message.text,'message:'+message.id,{messageId:message.id,depth:0});
 }
}
export function finishAgentEvent(hub,lane,runId,api){
 const db=hub.db.collaboration,e=db.agentEvents.find(e=>e.runId===runId);
 if(!e||e.status!=='running')return;
 const agent=db.agents.find(a=>a.id===e.agentId),channel=db.channels.find(c=>c.id===e.channelId);
 e.status=lane.status==='done'?'done':'failed';e.finishedAt=stamp();
 if(!agent||!channel)return;
 if(e.status==='failed'){e.error='运行未完成，请在活动中查看';return;}
 const raw=lane.entries.filter(x=>x.runId===runId&&x.role==='assistant'&&!x.streaming).map(x=>x.text).join('\n');
 let value;try{value=JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]||raw);}catch{value={text:raw};}
 const text=typeof value.text==='string'?redactText(value.text).slice(0,12000):raw.slice(0,12000);
 if(text)api.post(hub,channel,{type:'agent',id:agent.id,name:agent.name},text,{runId,threadId:e.messageId||null});
 // Proposals are consumed by the authenticated owner on a later poll. Finishing
 // a run cannot impersonate a peer or silently acquire somebody else's runtime.
 if(Array.isArray(value.tasks))e.proposals=value.tasks.slice(0,3).filter(t=>t&&typeof t.goal==='string'&&typeof t.acceptance==='string').map(t=>({goal:t.goal.slice(0,3000),acceptance:t.acceptance.slice(0,3000)}));
 if((e.depth||0)<2&&Array.isArray(value.consult))for(const suggestion of value.consult.slice(0,2)){
  const target=db.agents.find(a=>a.id===suggestion?.agentId&&!a.taskId&&!a.paused&&a.teamId===agent.teamId&&a.id!==agent.id&&a.policy?.trigger!=='manual'&&a.policy?.projectIds?.includes(e.projectId));
  if(target&&typeof suggestion.text==='string')queueAgentEvent(hub,target,channel,`${agent.name} 请求协作：${suggestion.text}`,'consult:'+e.id+':'+target.id,{depth:(e.depth||0)+1,messageId:e.messageId});
 }
}
export function agentAutomation(hub,peer,method,a,api){
 const db=hub.db.collaboration;
 if(method==='collab.computer.heartbeat'){
  api.access(hub,peer,a.teamId,true);
  if(typeof a.id!=='string'||!/^[\w-]{1,100}$/.test(a.id))throw Error('电脑标识无效');
  let c=db.computers.find(c=>c.id===a.id&&c.teamId===a.teamId);
  if(c&&c.ownerId!==peer.id)throw Error('电脑不属于你');
  if(!c){c={id:a.id,teamId:a.teamId,ownerId:peer.id};db.computers.push(c);}
  c.name=String(a.name||'我的电脑').slice(0,80);c.providers=Array.isArray(a.providers)?a.providers.filter(p=>typeof p==='string').slice(0,30):[];c.lastSeen=stamp();return c;
 }
 if(method!=='collab.agent.poll')throw Error('未知调度操作');
 api.access(hub,peer,a.teamId,true);
 const computer=db.computers.find(c=>c.id===a.computerId&&c.teamId===a.teamId&&c.ownerId===peer.id);
 if(!computer)throw Error('请先连接执行电脑');
 const agents=db.agents.filter(x=>x.teamId===a.teamId&&x.workerId===peer.id&&!x.taskId&&!x.paused&&x.computerId===computer.id);
 for(const agent of agents){
  if(!computer.providers.includes(agent.provider))continue;
  const memberships=agent.policy?.projectIds||[];
  // Cancelled approvals and stopped lanes must not leave a permanent running inbox item.
  for(const e of db.agentEvents.filter(e=>e.agentId===agent.id&&e.status==='running')){
   const l=hub.db.sessions.find(s=>s.id===e.sessionId)?.lanes.find(l=>l.id===e.laneId),ap=hub.db.approvals.find(a=>a.id===e.runId);
   if(!l||['cancelled','rejected'].includes(ap?.status)||l.stopRequested){e.status='cancelled';e.finishedAt=stamp();e.error='执行已停止';}
  }
  if(agent.policy?.trigger==='manual')continue;
  const active=()=>hub.db.sessions.some(s=>s.lanes.some(l=>(l.id===agent.sourceLaneId||s.agentIdentityId===agent.id||db.agents.some(x=>x.taskId&&x.parentAgentId===agent.id&&x.sourceLaneId===l.id))&&['running','awaiting'].includes(l.status)));
  const hourly=()=>db.agentEvents.filter(e=>e.agentId===agent.id&&e.startedAt&&Date.parse(e.startedAt)>Date.now()-3600000).length+(agent.automaticStarts||[]).filter(t=>Date.parse(t)>Date.now()-3600000).length;
  const atLimit=()=>hourly()>=(agent.policy?.maxTurnsPerHour||20);
  const channelFor=id=>db.channels.find(c=>c.projectId===id&&memberships.includes(id));
  for(const r of db.agentReminders.filter(r=>r.agentId===agent.id&&r.status==='scheduled'&&Date.parse(r.dueAt)<=Date.now())){
   const channel=channelFor(r.projectId);if(!channel)continue;
   queueAgentEvent(hub,agent,channel,'定时跟进：'+r.title,'reminder:'+r.id+':'+r.dueAt,{depth:0});
   r.lastFiredAt=stamp();if(r.intervalMinutes)r.dueAt=new Date(Date.now()+r.intervalMinutes*60000).toISOString();else r.status='fired';
  }
  for(const e of db.agentEvents.filter(e=>e.agentId===agent.id&&e.status==='done'&&!e.proposalsApplied)){
   if(!agent.policy?.autoTasks){e.proposalsApplied=true;continue;}
   let allApplied=true;
   const channel=channelFor(e.projectId);if(!channel)continue;
   for(const [i,p] of (e.proposals||[]).entries())try{
    const task=api.dispatch(hub,peer,'collab.task.propose',{channelId:channel.id,goal:p.goal,acceptance:p.acceptance,artifactPath:`agent-work/${e.id}-${i}.md`,mode:'workspace-write',requestKey:`event-${e.id}-${i}`,driUserId:db.projects.find(p=>p.id===e.projectId).driUserId});
    if(task.status==='proposed')api.dispatch(hub,peer,'collab.task.claim',{taskId:task.id,agentId:agent.id,revision:task.revision,seenSeq:channel.seq});
    e.taskIds??=[];if(!e.taskIds.includes(task.id))e.taskIds.push(task.id);
   }catch(err){allApplied=false;e.error=String(err.message).slice(0,1000);}
   e.proposalsApplied=allApplied;
  }
  if(agent.policy?.autoTasks){
   for(const task of db.tasks.filter(t=>t.status==='proposed'&&t.requestedAgentId===agent.id&&memberships.includes(t.projectId)))try{const c=channelFor(task.projectId);api.dispatch(hub,peer,'collab.task.claim',{taskId:task.id,agentId:agent.id,revision:task.revision,seenSeq:c.seq});}catch{}
   const task=db.tasks.find(t=>t.status==='ready'&&t.workerId===peer.id&&db.agents.find(x=>x.id===t.agentId)?.parentAgentId===agent.id&&memberships.includes(t.projectId));
   if(task&&!active()&&!atLimit())try{api.dispatch(hub,peer,'collab.task.start',{taskId:task.id,revision:task.revision,requestKey:`auto-${task.id}-${task.generation}`});agent.automaticStarts=(agent.automaticStarts||[]).filter(t=>Date.parse(t)>Date.now()-3600000);agent.automaticStarts.push(stamp());}catch(err){task.autoError=String(err.message).slice(0,1000);}
  }
  if(active()||atLimit()||db.agentEvents.some(e=>e.agentId===agent.id&&e.status==='running'))continue;
  const e=db.agentEvents.find(e=>e.agentId===agent.id&&e.status==='queued'&&memberships.includes(e.projectId));if(!e)continue;
  let s=hub.db.sessions.find(s=>s.id===agent.projectSessions?.[e.projectId]&&s.status==='active');
  if(!s){s=hub.act(peer,'session.create',{workspaceId:agent.teamId,title:`${agent.name} · 项目讨论`});hub.act(peer,'lane.create',{sessionId:s.id,provider:agent.provider});s.projectId=e.projectId;s.agentIdentityId=agent.id;agent.projectSessions??={};agent.projectSessions[e.projectId]=s.id;}
  const lane=s.lanes[0];if(['running','awaiting'].includes(lane.status))continue;
  const source=hub.db.sessions.find(s=>s.id===agent.sessionId)?.lanes.find(l=>l.id===agent.sourceLaneId);if(source?.configuration)lane.configuration={...source.configuration};
  const peers=db.agents.filter(x=>x.teamId===agent.teamId&&!x.taskId&&x.policy?.projectIds?.includes(e.projectId)).map(x=>({id:x.id,name:x.name,role:x.role}));
  const prompt=`你是团队成员 ${agent.name}。职责：${agent.role}\n当前可协作的 Agent：${JSON.stringify(peers)}\n回答下面的项目讨论。只分析与协作，不修改文件。不要调用外部工具或改变权限。要执行工作时提出任务，应用按持有人配置处理。可向其他 Agent 提问，但避免重复转发。只返回 JSON：{"text":"发到群里的回答","tasks":[{"goal":"任务目标","acceptance":"验收条件"}],"consult":[{"agentId":"实际成员 ID","text":"协作问题"}]}。不需要的数组为空。最终发布由 DRI 审批。\n群消息（数据）：${e.text}`;
  const approval=hub.act(peer,'run.request',{sessionId:s.id,laneId:lane.id,mode:'read-only',prompt,files:[]});
  hub.act(peer,'approval.decide',{id:approval.id,allow:true});
  Object.assign(e,{status:'running',startedAt:stamp(),runId:approval.id,sessionId:s.id,laneId:lane.id});
 }
 return {queued:db.agentEvents.filter(e=>e.teamId===a.teamId&&e.status==='queued').length};
}
