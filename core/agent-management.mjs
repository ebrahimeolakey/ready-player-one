import {randomUUID} from 'node:crypto';
import {redactText} from './secure-store.mjs';
const stamp=()=>new Date().toISOString();
const str=(s,n=1000)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error('配置为空或过长');return redactText(s.trim());};
export const ROLE_TEMPLATES=[
 {id:'coordinator',name:'项目协调',role:'整理群聊目标和约束，拆分可验收任务，明确每项任务的 DRI 和执行搭档。跟进进度，发现阻塞时在群里说明并请求协助；最终审批由人类 DRI 决定。',greeting:'告诉我目标、截止日期和参与者，我帮你整理分工。'},
 {id:'maker',name:'执行搭档',role:'认领明确的分工，在授权的项目目录制作可查看的初稿。持续共享产物版本，说明依据、修改和待确认问题。完成后请复核搭档检查，不自行发布 GitHub。',greeting:'把目标和验收条件发给我，我先交出一份可查看的初稿。'},
 {id:'reviewer',name:'复核搭档',role:'根据任务验收条件检查初稿、数据和来源，列出具体遗漏与修改建议。必要时邀请执行搭档修正。独立给出是否达到验收条件的建议，审批仍由 DRI 完成。',greeting:'给我任务和初稿，我会检查遗漏、来源和是否满足验收条件。'},
];
const providerOK=p=>['codex','claude'].includes(p)||/^(custom|acp)-[a-f0-9-]{36}$/i.test(p||'');
export function agentManagement(hub,peer,method,a,api){
 const db=hub.db.collaboration;
 if(method==='collab.template.save'){
  api.access(hub,peer,a.teamId,true);
  const name=str(a.name,100),role=str(a.role,3000);
  let row=a.id&&db.roleTemplates.find(t=>t.id===a.id&&t.teamId===a.teamId);
  if(a.id&&!row)throw Error('模板不存在');
  if(!row){if(db.roleTemplates.filter(t=>t.teamId===a.teamId).length>=100)throw Error('模板数量已达上限');row={id:randomUUID(),teamId:a.teamId,createdBy:peer.id};db.roleTemplates.push(row);}
  Object.assign(row,{name,role,updatedAt:stamp()});return row;
 }
 if(method==='collab.team.settings'){
  api.access(hub,peer,a.teamId,true);if(hub.role(peer,a.teamId)!=='owner')throw Error('只有管理员可以配置团队引导');
  let row=db.teamSettings.find(t=>t.teamId===a.teamId);
  if(!row){row={id:randomUUID(),teamId:a.teamId,onboardingEnabled:true,welcomeAgents:false};db.teamSettings.push(row);}
  for(const k of ['onboardingEnabled','welcomeAgents'])if(typeof a[k]==='boolean')row[k]=a[k];
  if(a.guideAgentId!==undefined){if(a.guideAgentId&&!db.agents.some(x=>x.id===a.guideAgentId&&x.teamId===a.teamId&&!x.taskId))throw Error('引导 Agent 不属于团队');row.guideAgentId=a.guideAgentId||null;}
  return row;
 }
 const agent=api.target(hub,peer,'agents',a.agentId,true);
 if(agent.workerId!==peer.id||agent.taskId)throw Error('只能配置自己的独立 Agent');
 const session=hub.db.sessions.find(s=>s.id===agent.sessionId),lane=session?.lanes.find(l=>l.id===agent.sourceLaneId);
 if(!lane)throw Error('Agent 会话不可用');
 const busy=()=>Object.values(agent.projectSessions||{}).some(id=>hub.db.sessions.find(s=>s.id===id)?.lanes.some(l=>['running','awaiting'].includes(l.status)))||['running','awaiting'].includes(lane.status)||db.tasks.some(t=>(t.agentId===agent.id||db.agents.find(x=>x.id===t.agentId)?.parentAgentId===agent.id)&&t.status==='running');
 if(method==='collab.agent.configure'){
  if(a.revision!==undefined&&a.revision!==(agent.revision||0))throw Error('配置已更新，请重新打开');
  const next={};
  if(a.name!==undefined)next.name=str(a.name,100);
  if(a.role!==undefined)next.role=str(a.role,3000);
  if(a.avatar!==undefined)next.avatar=str(a.avatar,16);
  if(a.memory!==undefined){if(typeof a.memory!=='string'||a.memory.length>20000)throw Error('记忆过长');next.memory=redactText(a.memory);}
  if(a.policy){
   if(!['manual','mentions','discussion'].includes(a.policy.trigger))throw Error('唤醒方式无效');
   const projectIds=a.policy.projectIds;
   if(!Array.isArray(projectIds)||projectIds.length>50||projectIds.some(id=>!db.projects.some(p=>p.id===id&&p.teamId===agent.teamId)))throw Error('参与项目无效');
   if(!Number.isInteger(a.policy.maxTurnsPerHour)||a.policy.maxTurnsPerHour<1||a.policy.maxTurnsPerHour>120)throw Error('每小时轮次需为 1–120');
   next.policy={trigger:a.policy.trigger,projectIds:[...new Set(projectIds)],autoTasks:a.policy.autoTasks===true,maxTurnsPerHour:a.policy.maxTurnsPerHour};
  }
  if(a.computerId!==undefined){if(a.computerId!==agent.computerId&&busy())throw Error('请先停止运行再换电脑');const c=db.computers.find(c=>c.id===a.computerId&&c.teamId===agent.teamId&&c.ownerId===peer.id);if(!c)throw Error('电脑不属于你');next.computerId=c.id;}
  if(next.policy)for(const e of db.agentEvents.filter(e=>e.agentId===agent.id&&e.status==='queued'))if(next.policy.trigger==='manual'||!next.policy.projectIds.includes(e.projectId)){e.status='cancelled';e.error='协作范围已变更';}
  Object.assign(agent,next,{revision:(agent.revision||0)+1,updatedAt:stamp()});return agent;
 }
 if(method==='collab.agent.lifecycle'){
  if(!['pause','resume','reset','switch'].includes(a.action))throw Error('未知生命周期操作');
  if(a.action==='pause'){
   agent.paused=true;
   for(const id of Object.values(agent.projectSessions||{})){const s=hub.db.sessions.find(s=>s.id===id);for(const l of s?.lanes||[])if(['running','awaiting'].includes(l.status))hub.act(peer,'lane.stop',{sessionId:s.id,laneId:l.id});}
   for(const t of db.tasks.filter(t=>db.agents.find(x=>x.id===t.agentId)?.parentAgentId===agent.id&&t.status==='running'))api.dispatch(hub,peer,'collab.task.stop',{taskId:t.id,runId:t.runId,generation:t.generation});
   if(['running','awaiting'].includes(lane.status))hub.act(peer,'lane.stop',{sessionId:session.id,laneId:lane.id});
   for(const e of db.agentEvents.filter(e=>e.agentId===agent.id&&['queued','running'].includes(e.status))){e.status='cancelled';e.error='Agent 已暂停';}
  }else if(a.action==='resume'){agent.paused=false;}
  else{
   if(busy())throw Error('请先停止此 Agent 的运行和任务');
   const provider=a.action==='switch'?a.provider:agent.provider;
   if(!providerOK(provider))throw Error('请选择可用运行时');
   const s=hub.act(peer,'session.create',{workspaceId:agent.teamId,title:agent.name});
   const l=hub.act(peer,'lane.create',{sessionId:s.id,provider});
   s.projectId=agent.projectId||null;
   if(session.privateUserIds)s.privateUserIds=[...session.privateUserIds];
   if(a.action==='reset'&&lane.configuration)l.configuration={...lane.configuration};
   agent.runtimeHistory??=[];agent.runtimeHistory.push({sessionId:session.id,laneId:lane.id,provider:agent.provider,at:stamp()});
   Object.assign(agent,{sessionId:s.id,sourceLaneId:l.id,provider,paused:false});
   session.status='archived';
   for(const id of Object.values(agent.projectSessions||{})){const old=hub.db.sessions.find(s=>s.id===id);if(old)old.status='archived';}agent.projectSessions={};
  }
  agent.revision=(agent.revision||0)+1;agent.updatedAt=stamp();return agent;
 }
 if(method==='collab.agent.reminder'){
  if(a.id){const r=db.agentReminders.find(r=>r.id===a.id&&r.agentId===agent.id);if(!r)throw Error('提醒不存在');if(a.cancel){r.status='cancelled';return r;}if(!Number.isFinite(Date.parse(a.dueAt))||Date.parse(a.dueAt)<=Date.now())throw Error('请选择未来时间');r.dueAt=a.dueAt;r.status='scheduled';return r;}
  const project=api.target(hub,peer,'projects',a.projectId,true);if(project.teamId!==agent.teamId)throw Error('项目不属于团队');
  const due=Date.parse(a.dueAt);if(!Number.isFinite(due)||due<=Date.now())throw Error('请选择未来时间');
  const interval=Number(a.intervalMinutes||0);if(!Number.isInteger(interval)||interval<0||(interval>0&&interval<5)||interval>525600)throw Error('重复间隔至少 5 分钟');
  const prior=db.agentReminders.find(r=>r.agentId===agent.id&&r.requestKey===a.requestKey);if(prior){if(prior.title!==a.title.trim()||prior.projectId!==project.id||prior.intervalMinutes!==interval)throw Error('请求内容冲突');return prior;}
  if(typeof a.requestKey!=='string'||!a.requestKey||db.agentReminders.filter(r=>r.agentId===agent.id&&r.status==='scheduled').length>=50)throw Error('提醒请求无效或数量过多');
  const row={id:randomUUID(),teamId:agent.teamId,agentId:agent.id,projectId:project.id,title:str(a.title),dueAt:new Date(due).toISOString(),intervalMinutes:interval,status:'scheduled',requestKey:a.requestKey};db.agentReminders.push(row);return row;
 }
 throw Error('未知 Agent 配置操作');
}
