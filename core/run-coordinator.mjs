import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
/** Durable, idempotent event delivery between local provider processes and a reconnecting Hub. */
export class RunCoordinator {
 constructor({runtime,client,dir,root,options=()=>({}),onChange=()=>{},onFinish=()=>{},steeringImages=()=>[] }) {
  Object.assign(this,{runtime,client,dir,root,options,onChange,onFinish,steeringImages});
  this.records=new Map();this.claimed=new Set();this.prepared=new Map();this.flushing=new Set();this.decisions=new Set();this.deciding=new Set();this.steering=new Set();this.epoch=0;this.paused=false;
  mkdirSync(dir,{recursive:true,mode:0o700});
  for(const name of readdirSync(dir).filter(v=>/^[a-f0-9-]+\.json$/.test(v))) {
   try {const r=JSON.parse(readFileSync(join(dir,name),'utf8'));if(r.runId&&r.pending)this.records.set(r.runId,r);}catch{}
  }
 }
 attachStore(store) {
  if(this.runtime.runs.size)throw Error('不能在执行中切换持久化存储');
  this.store=store;this.records.clear();
  const names=[...new Set(readdirSync(this.dir).map(v=>v.match(/^([a-f0-9-]+\.json)(?:\.enc(?:\.[a-f0-9-]+\.pending)?)?$/)?.[1]).filter(Boolean))];
  for(const name of names){const r=store.readJSON(name);if(!r.runId||!Array.isArray(r.pending))throw Error('本机执行记录损坏');this.records.set(r.runId,r);}
 }
 hubId(c) {return typeof c.state?.identity?.audience==='string'&&c.state.identity.audience ? c.state.identity.audience : undefined;}
 scope(c) {return createHash('sha256').update((this.hubId(c) ? 'hub:'+this.hubId(c) : c.url)+'\n'+c.auth.secret).digest('hex');}
 retry() {
  if(this.retryTimer||this.paused)return;
  this.retryTimer=setTimeout(()=>{this.retryTimer=null;void this.process().catch(()=>{});},1000);
  this.retryTimer.unref?.();
 }
 // Explicitly invoked by the desktop host after checking its OWN database. Never
 // infer a legacy record's identity from an untrusted remote server's claims.
 migrateLegacyLocalRecords({hubId,secret,verify}) {
  if(typeof hubId!=='string'||!hubId||typeof secret!=='string'||!secret||typeof verify!=='function')throw Error('旧记录迁移需要本机 Hub 身份及逐条校验');
  if(this.runtime.runs.size)throw Error('不能在执行中迁移记录');
  let migrated=0;
  for(const r of this.records.values()) {
   if(r.hubId||verify(structuredClone(r))!==true)continue;
   r.hubId=hubId;r.scope=this.scope({auth:{secret},state:{identity:{audience:hubId}}});this.save(r);migrated++;
  }
  return {migrated};
 }
 save(r) {if(this.store){this.store.writeJSON(r.runId+'.json',r);this.onChange();return;}const path=join(this.dir,r.runId+'.json');writeFileSync(path+'.tmp',JSON.stringify(r),{mode:0o600});renameSync(path+'.tmp',path);this.onChange();}
 enqueue(r,method,args) {
  r.pending.push({method,args:{sessionId:r.sessionId,laneId:r.laneId,runId:r.runId,...args}});this.save(r);void this.flush(r);
 }
 async flush(r) {
  const c=this.client();if(!c||c.ws?.readyState!==1||this.flushing.has(r.runId)||r.blocked||r.scope!==this.scope(c)||!r.pending.length)return;
  this.flushing.add(r.runId);
  try {
   if(r.pending[0]?.method!=='run.finish')await c.call('run.reconcile',{sessionId:r.sessionId,laneId:r.laneId,runId:r.runId});
   while(r.pending.length&&c===this.client()&&c.ws?.readyState===1) {
    const e=r.pending[0];await c.call(e.method,e.args);r.pending.shift();this.save(r);
    if(e.method==='run.finish'){r.delivered=true;this.save(r);break;}
    await new Promise(resolve=>setTimeout(resolve,30));
   }
  } catch(e) {
   if(c.ws?.readyState===1&&!/断开|未连接|超时/.test(e.message)) {
    r.blocked=e.message;this.save(r);
    if(this.runtime.runs.has(r.runId))await this.runtime.interrupt(r.runId);
   }
  } finally {this.flushing.delete(r.runId);if(r.pending.length&&!r.blocked&&c===this.client()&&c.ws?.readyState===1)this.retry();}
 }
 async start(approval) {
  if(this.paused)return;
  const c=this.client(),epoch=this.epoch;
  let r=this.records.get(approval.id);
  if(this.claimed.has(approval.id)||(r&&(!this.prepared.has(approval.id)||r.ended||r.blocked||r.phase!=='prepared')))return;
  this.claimed.add(approval.id);
  try {
   if(!r){
    r={runId:approval.id,sessionId:approval.sessionId,laneId:approval.laneId,workspaceId:approval.workspaceId,hubId:this.hubId(c),scope:this.scope(c),claimKey:randomUUID(),phase:'prepared',pending:[],ended:false};
    this.records.set(r.runId,r);this.save(r);this.prepared.set(r.runId,approval);
   }
   const data=await c.call('run.claim',{id:approval.id,claimKey:r.claimKey});
   r.phase='claimed';this.save(r);this.prepared.delete(r.runId);
   const lane=data.session.lanes.find(l=>l.id===approval.laneId);
   const recent=data.session.lanes.flatMap(l=>l.entries.filter(e=>['user','assistant'].includes(e.role)).slice(-12).map(e=>`[${l.owner}] ${e.text}`)).join('\n').slice(-30000);
   const prompt=`共享任务：${data.session.title}\n计划：${data.session.plan.map(p=>`${p.done?'[x]':'[ ]'} ${p.text}`).join('\n')}\n团队记忆：${data.memories.map(m=>`${m.title}: ${m.text}`).join('\n')}\n协作上下文：\n${recent}\n\n当前用户要求：${approval.prompt}`;
   const options=await this.options(approval);
   if(c!==this.client()||epoch!==this.epoch)throw Error('协作连接已切换，尚未开始本机执行');
   const latest=c.state?.sessions.find(s=>s.id===approval.sessionId)?.lanes.find(l=>l.id===approval.laneId);
   if(latest?.stopRequested||latest?.fencedRunId===r.runId)throw Error('执行已撤销');
   r.phase='starting';this.save(r);
   await this.runtime.start({runId:r.runId,provider:approval.provider,cwd:this.root(approval),prompt,mode:approval.mode,sessionId:lane.providerSessionId,...options,
    onEvent:e=>{
     if(e.type==='session')this.enqueue(r,'run.session',{providerSessionId:e.sessionId});
     if(e.type==='delta'&&e.text)this.enqueue(r,'run.entry',{eventId:randomUUID(),entryId:`${r.runId}:${e.itemId||'output'}`,delta:true,role:e.role||'assistant',text:e.text});
     if(e.type==='message'&&e.text)this.enqueue(r,'run.entry',{eventId:randomUUID(),entryId:`${r.runId}:${e.itemId||randomUUID()}`,delta:false,role:e.role||'assistant',text:e.text});
     if(e.type==='tool')this.enqueue(r,'run.entry',{eventId:randomUUID(),role:'tool',text:JSON.stringify(e.item).slice(0,24000)});
     if(e.type==='error')this.enqueue(r,'run.entry',{eventId:randomUUID(),role:'system',text:e.text||'执行错误'});
     if(e.type==='approval')this.enqueue(r,'tool.request',{providerRequestId:e.approvalId,action:e.request.tool||e.request.kind||'工具操作',input:e.request});
    },
    onEnd:result=>{r.ended=true;this.enqueue(r,'run.finish',{status:result.status,message:result.message||'执行结束'});this.onFinish({...result,sessionId:r.sessionId});},
   });
  } catch(e) {
   if(r?.phase==='prepared'){
    if(c.ws?.readyState!==1||/断开|未连接|超时/.test(e.message)){if(c===this.client()&&epoch===this.epoch)this.retry();}
    else {r.ended=true;r.blocked=e.message;this.prepared.delete(r.runId);this.save(r);}
   }else if(r&&!r.ended){r.ended=true;this.enqueue(r,'run.finish',{status:'error',message:e.message});}
  } finally {
   this.claimed.delete(approval.id);
  }
 }
 async recover(r,c) {
  this.claimed.add(r.runId);
  try {
   // A prepared claim may have reached the Hub just before the application died.
   // The persisted nonce can settle that claim, but never launches the provider.
   if(r.phase==='prepared')await c.call('run.claim',{id:r.runId,claimKey:r.claimKey});
   r.ended=true;this.enqueue(r,'run.finish',{status:'interrupted',message:'应用重启，执行结果可能不完整；请检查记录后继续，不会自动重跑。'});
  }catch(e){
   if(c.ws?.readyState!==1||/断开|未连接|超时/.test(e.message))this.retry();
   else {r.blocked=e.message;this.save(r);}
  }finally{this.claimed.delete(r.runId);}
 }
 async process() {
  if(this.paused)return;
  const c=this.client();if(!c?.state||c.ws?.readyState!==1)return;
  const state=c.state;
  for(const r of this.records.values())if(r.scope===this.scope(c)&&!r.blocked){
   // If the application restarted, do not repeat an unknown external action.
   if(!r.ended&&!this.runtime.runs.has(r.runId)&&!this.claimed.has(r.runId)) {
    if(this.prepared.has(r.runId))void this.start(this.prepared.get(r.runId));
    else await this.recover(r,c);
   }
   void this.flush(r);
  }
  for(const session of state.sessions)for(const lane of session.lanes.filter(l=>l.ownerId===state.me.id)) {
   const runId=lane.activeRunId;
   if(lane.stopRequested&&this.runtime.runs.has(runId))await this.runtime.interrupt(runId);
   for(const instruction of lane.steering||[])if(instruction.status==='pending'&&instruction.runId===runId&&this.runtime.runs.has(runId)&&!this.steering.has(instruction.id)) {
    const record=this.records.get(runId);if(!record)continue;
    this.steering.add(instruction.id);
    let status='delivered',message='';
    try {await this.runtime.steer(runId,instruction.text,this.steeringImages(instruction.id));}catch(e){status='failed';message='指导投递结果未确认，请检查 Agent 记录；未自动重发。'+e.message;}
    this.enqueue(record,'run.steer.ack',{id:instruction.id,status,message});
   }
   if(!['running','awaiting'].includes(lane.status)&&lane.queue?.some(q=>q.status==='queued'))await c.call('run.queue.next',{sessionId:session.id,laneId:lane.id}).catch(()=>{});
  }
  for(const a of state.toolApprovals||[])if(a.ownerId===state.me.id&&['approved','rejected','consumed'].includes(a.status)&&!this.decisions.has(a.id)&&!this.deciding.has(a.id)&&this.runtime.runs.has(a.runId)) {
   this.deciding.add(a.id);
   try {
    const r=this.records.get(a.runId);
    if(!r)continue;
    if(!r.claimKey){r.claimKey=randomUUID();this.save(r);}
    const claimKey=createHash('sha256').update(r.claimKey+'\n'+a.id).digest('hex');
    const decision=await c.call('tool.claim',{id:a.id,claimKey});
    if(c!==this.client()||!this.runtime.runs.has(a.runId))continue;
    await this.runtime.respondApproval(a.runId,a.providerRequestId,{allow:decision.allowed,answers:decision.answers,content:decision.content});
    this.decisions.add(a.id);
   }catch(error){if(/断开|未连接|超时/.test(error.message)&&c===this.client()&&c.ws?.readyState===1)this.retry();}finally{this.deciding.delete(a.id);}
  }
  for(const a of state.approvals)if(a.ownerId===state.me.id&&a.status==='approved')void this.start(a);
 }
 get issues(){return [...this.records.values()].filter(r=>r.blocked).map(r=>({runId:r.runId,sessionId:r.sessionId,message:r.blocked}));}
 resume(){this.paused=false;return this.process();}
 close(){this.paused=true;this.epoch++;this.prepared.clear();clearTimeout(this.retryTimer);this.retryTimer=null;return this.runtime.close();}
}
