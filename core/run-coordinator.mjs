import { providerPrompt } from "./prompt-limits.mjs";
import { redactText } from "./secure-store.mjs";
import { validateUsage } from "./providers/usage.mjs";
import { publicConfiguration } from "./providers/configuration.mjs";
import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
/** Durable, idempotent event delivery between local provider processes and a reconnecting Hub. */
export class RunCoordinator {
 constructor({runtime,client,dir,root,options=()=>({}),onChange=()=>{},onFinish=()=>{},steeringImages=()=>[],onProviderEvent=()=>{},onProviderFinish=()=>{} }) {
  Object.assign(this,{runtime,client,dir,root,options,onChange,onFinish,steeringImages,onProviderEvent,onProviderFinish});
  this.records=new Map();this.claimed=new Set();this.prepared=new Map();this.flushing=new Set();this.decisions=new Set();this.deciding=new Set();this.steering=new Set();this.epoch=0;this.paused=false;
  mkdirSync(dir,{recursive:true,mode:0o700});
  for(const name of readdirSync(dir).filter(v=>/^[a-f0-9-]+\.json$/.test(v))) {
   try {const r=JSON.parse(readFileSync(join(dir,name),'utf8'));if(r.runId&&r.pending){delete r.outcomeSending;this.records.set(r.runId,r);}}catch{}
  }
 }
 attachStore(store) {
  if(this.runtime.runs.size)throw Error('不能在执行中切换持久化存储');
  this.store=store;this.records.clear();
  const names=[...new Set(readdirSync(this.dir).map(v=>v.match(/^([a-f0-9-]+\.json)(?:\.enc(?:\.[a-f0-9-]+\.pending)?)?$/)?.[1]).filter(Boolean))];
  for(const name of names){const r=store.readJSON(name);if(!r.runId||!Array.isArray(r.pending))throw Error('本机执行记录损坏');delete r.outcomeSending;this.records.set(r.runId,r);}
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
 reportOutcome(r, reason) {
  if (!r.dispatchAt || r.outcome) return;
  r.outcome = {sessionId:r.sessionId,laneId:r.laneId,runId:r.runId,claimKey:r.claimKey,
   dispatchAt:r.dispatchAt,dispatches:structuredClone(r.dispatches||[]),observations:structuredClone(r.observations||[]),
   lastOutput:r.lastOutput?.trim()?r.lastOutput:null,reason:redactText(String(reason)).slice(0,2000).trim()||'执行结果未确认'};
  this.save(r);void this.flushOutcome(r);
 }
 async flushOutcome(r) {
  const c=this.client();
  if(!r.outcome||r.outcomeDelivered||r.outcomeBlocked||r.outcomeSending||!c||c.ws?.readyState!==1||r.scope!==this.scope(c))return;
  r.outcomeSending=true;
  try {await c.call('outcome.report',r.outcome);r.outcomeDelivered=true;}
  catch(e){if(c.ws?.readyState===1&&!/断开|未连接|超时/.test(e.message))r.outcomeBlocked=e.message;else this.retry();}
  finally{delete r.outcomeSending;this.save(r);}
 }
 observe(r,e) {
  // Only complete logical messages enter this shared evidence summary.
  // Streaming deltas may interleave tool items or split credentials; the normal
  // transcript pipeline retains them, but they cannot safely be summarized here.
  if(e.type==='message'&&e.text)r.lastOutput=redactText(e.text).replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]*/g,'[凭据已隐藏]').slice(0,8000);
  if(e.type==='tool') {
   r.observations??=[];
   r.observations.push({itemId:String(e.itemId||'unidentified').slice(0,500),phase:String(e.phase||'observed').slice(0,100),text:redactText(JSON.stringify(e.item||{})).slice(0,8000),at:new Date().toISOString()});
   r.observations=r.observations.slice(-50);
  }
  // Transcript events are durable in enqueue. Preserve these bounded summaries
  // in that same write, avoiding an additional disk write per streamed token.
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
   // Claim RPC is owner-only and returns the preserved original. Shared state is redacted.
   const prompt=providerPrompt(data.session,data.memories,data.approval.prompt);
   const options=await this.options(approval);
   if(c!==this.client()||epoch!==this.epoch)throw Error('协作连接已切换，尚未开始本机执行');
   const latest=c.state?.sessions.find(s=>s.id===approval.sessionId)?.lanes.find(l=>l.id===approval.laneId);
   if(latest?.stopRequested||latest?.fencedRunId===r.runId)throw Error('执行已撤销');
   r.phase='starting';r.dispatchAt=new Date().toISOString();this.save(r);
   this.enqueue(r,'run.configuration',{phase:'requested',...publicConfiguration(options)});
   const runRoot=this.root(approval),positionContext={workspaceId:r.workspaceId,sessionId:r.sessionId,laneId:r.laneId,root:runRoot,connection:c};
   await this.runtime.start({runId:r.runId,provider:approval.provider,cwd:runRoot,prompt,mode:approval.mode,sessionId:lane.providerSessionId,...options,
    onEvent:e=>{
     if(c===this.client()&&epoch===this.epoch){try{void Promise.resolve(this.onProviderEvent(e,positionContext)).catch(()=>{});}catch{}}
     this.observe(r,e);
     if(e.type==='configuration'&&!r.ended){
      let configuration;try{configuration=publicConfiguration(e);}catch{return;}
      const key=JSON.stringify(configuration);
      if(r.reportedConfigurationKey!==key){r.reportedConfigurationKey=key;r.configurationSequence=(r.configurationSequence||0)+1;this.enqueue(r,'run.configuration',{phase:'reported',sequence:r.configurationSequence,...configuration});}
     }
     if(e.type==='usage'&&e.usageSnapshot&&!r.ended){
      let usage;try {usage=validateUsage(e.usageSnapshot);}catch{return;}
      r.usageSequence=(r.usageSequence||0)+1;this.enqueue(r,'run.usage',{sequence:r.usageSequence,usage});
     }
     if(e.type==='session')this.enqueue(r,'run.session',{providerSessionId:e.sessionId});
     if(e.type==='delta'&&e.text)this.enqueue(r,'run.entry',{eventId:randomUUID(),entryId:`${r.runId}:${e.itemId||'output'}`,delta:true,role:e.role||'assistant',text:e.text});
     if(e.type==='message'&&e.text)this.enqueue(r,'run.entry',{eventId:randomUUID(),entryId:`${r.runId}:${e.itemId||randomUUID()}`,delta:false,role:e.role||'assistant',text:e.text});
     if(e.type==='tool')this.enqueue(r,'run.entry',{eventId:randomUUID(),entryId:`${r.runId}:${e.itemId||randomUUID()}:tool`,delta:false,role:'tool',text:JSON.stringify({...e.item,phase:e.phase}).slice(0,24000)});
     if(e.type==='error')this.enqueue(r,'run.entry',{eventId:randomUUID(),role:'system',text:e.text||'执行错误'});
     if(e.type==='approval')this.enqueue(r,'tool.request',{providerRequestId:e.approvalId,action:e.request.tool||e.request.kind||'工具操作',input:e.request});
    },
    onEnd:result=>{if(c===this.client()&&epoch===this.epoch){try{void Promise.resolve(this.onProviderFinish(r.runId,positionContext,result)).catch(()=>{});}catch{}}r.ended=true;if(result.status!=='done')this.reportOutcome?.(r,result.message||'执行中断');this.enqueue(r,'run.finish',{status:result.status,message:result.message||'执行结束',...(result.failure?{failure:result.failure}:{})});this.onFinish({...result,sessionId:r.sessionId});},
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
   this.reportOutcome(r,'应用重启，未取得本次执行的完整结果。启动与许可记录只证明投递尝试，不证明外部操作成功。');
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
  for(const r of this.records.values())if(r.scope===this.scope(c)){
   if(r.phase==='starting'&&!r.ended&&!this.runtime.runs.has(r.runId)&&!this.claimed.has(r.runId))this.reportOutcome(r,'本机执行已停止，结果尚未确认。');
   void this.flushOutcome(r);
  }
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
    let original;
    try { original=await c.call('run.steer.read',{sessionId:session.id,laneId:lane.id,runId,id:instruction.id}); }
    catch(e){ this.steering.delete(instruction.id); if(/断开|未连接|超时/.test(e.message))this.retry(); continue; }
    const latestLane=c.state?.sessions.find(s=>s.id===session.id)?.lanes.find(l=>l.id===lane.id);
    if(this.paused||c!==this.client()||!this.runtime.runs.has(runId)||latestLane?.activeRunId!==runId||latestLane?.stopRequested||latestLane?.fencedRunId===runId){this.steering.delete(instruction.id);continue;}
    try {await this.runtime.steer(runId,original.text,this.steeringImages(instruction.id));}catch(e){status='failed';message='指导投递结果未确认，请检查 Agent 记录；未自动重发。'+e.message;}
    this.enqueue(record,'run.steer.ack',{id:instruction.id,status,message});
   }
   if((!lane.handoffNeeded||lane.handoffNeeded.runId!==lane.activeRunId)&&!['running','awaiting','needs_handoff'].includes(lane.status)&&lane.queue?.some(q=>q.status==='queued'))await c.call('run.queue.next',{sessionId:session.id,laneId:lane.id}).catch(()=>{});
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
    // Persist before dispatch: a crash or a lost provider acknowledgement must
    // never cause the same permission to be sent a second time.
    if(r.dispatchedApprovals?.includes(a.id)){this.decisions.add(a.id);continue;}
    r.dispatchedApprovals??=[];r.dispatchedApprovals.push(a.id);
    if(decision.allowed){r.dispatches??=[];r.dispatches.push({approvalId:a.id,at:new Date().toISOString()});r.dispatches=r.dispatches.slice(-100);}
    this.save(r);this.decisions.add(a.id);
    try{await this.runtime.respondApproval(a.runId,a.providerRequestId,{allow:decision.allowed,answers:decision.answers,content:decision.content});}
    catch(error){this.reportOutcome(r,'工具许可投递结果未确认：'+error.message);throw error;}
   }catch(error){if(/断开|未连接|超时/.test(error.message)&&c===this.client()&&c.ws?.readyState===1)this.retry();}finally{this.deciding.delete(a.id);}
  }
  for(const a of state.approvals)if(a.ownerId===state.me.id&&a.status==='approved')void this.start(a);
 }
 get issues(){return [...this.records.values()].filter(r=>r.blocked||r.outcomeBlocked).map(r=>({runId:r.runId,sessionId:r.sessionId,message:r.blocked||r.outcomeBlocked}));}
 resume(){this.paused=false;return this.process();}
 close(){this.paused=true;this.epoch++;this.prepared.clear();clearTimeout(this.retryTimer);this.retryTimer=null;return this.runtime.close();}
}
