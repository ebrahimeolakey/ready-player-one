import {createServer} from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
const digest=s=>createHash('sha256').update(s).digest('hex');
// An external runtime receives a revocable capability for ONE owned Agent,
// never the user's Hub token or general application RPC access.
export class ExternalAgentBridge{
 constructor({client,config,save,computerId,onChange=()=>{}}){Object.assign(this,{client,config,save,computerId,onChange});this.pending=new Map();this.claims=new Map();this.lastSeen=new Map();}
 scope(){const c=this.client();return c?.state?.identity?.audience+':'+c?.state?.me?.id;}
 agent(id){const c=this.client(),a=c?.state?.collaboration?.agents.find(a=>a.id===id&&!a.taskId&&a.workerId===c.state.me.id);if(!a)throw Error('只能连接自己的独立 Agent');return a;}
 enabled(id){return !!this.config.externalAgents?.[this.scope()+':'+id]?.enabled;}
 async listen(){if(this.server)return;this.server=createServer((req,res)=>void this.handle(req,res));this.server.requestTimeout=10000;await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.config.externalAgentPort||0,'127.0.0.1',resolve);});this.port=this.server.address().port;this.config.externalAgentPort=this.port;this.save();}
 async issue(agentId){this.agent(agentId);await this.listen();const code=randomBytes(8).toString('hex');this.pending.set(digest(code),{agentId,scope:this.scope(),expires:Date.now()+300000});return {url:`http://127.0.0.1:${this.port}`,code,expiresAt:new Date(Date.now()+300000).toISOString()};}
 revoke(agentId){this.agent(agentId);const key=this.scope()+':'+agentId;delete this.config.externalAgents?.[key];for(const [k,v]of this.pending)if(v.agentId===agentId)this.pending.delete(k);this.save();return true;}
 status(agentId){this.agent(agentId);return {enabled:this.enabled(agentId),connected:Date.now()-(this.lastSeen.get(this.scope()+':'+agentId)||0)<20000};}
 async handle(req,res){
  const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  try{
   if(req.method!=='POST'||req.headers.origin||req.headers.host!==`127.0.0.1:${this.port}`||req.headers['content-type']!=='application/json')return reply(403,{error:'接入请求无效'});
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>150000){reply(413,{error:'请求过大'});req.destroy();return;}chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString());
   if(req.url==='/pair'){
    const key=digest(String(body.code)),pending=this.pending.get(key);if(!pending||pending.expires<Date.now()||pending.scope!==this.scope())throw Error('接入码已失效');
    const a=this.agent(pending.agentId),c=this.client();
    const busy=c.state.sessions.some(s=>s.lanes.some(l=>(l.id===a.sourceLaneId||s.agentIdentityId===a.id||c.state.collaboration.agents.some(x=>x.parentAgentId===a.id&&x.sourceLaneId===l.id))&&['running','awaiting'].includes(l.status)));
    if(busy)throw Error('请先停止此 Agent 的运行');
    const token=randomBytes(32).toString('hex');this.config.externalAgents??={};this.config.externalAgents[pending.scope+':'+a.id]={enabled:true,hash:digest(token),agentId:a.id};this.pending.delete(key);this.save();this.onChange();return reply(200,{token,agentId:a.id,name:a.name,url:`http://127.0.0.1:${this.port}`});
   }
   const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!token)throw Error('接入凭据无效');
   const row=Object.entries(this.config.externalAgents||{}).find(([k,v])=>k.startsWith(this.scope()+':')&&v.enabled&&v.hash===digest(token));if(!row)throw Error('接入已撤销');
   const a=this.agent(row[1].agentId),c=this.client();if(a.paused)throw Error('Agent 已暂停');
   if(a.computerId&&a.computerId!==this.computerId())throw Error('Agent 已转移到另一台电脑');
   this.lastSeen.set(row[0],Date.now());
   const owns=ap=>{const s=c.state.sessions.find(s=>s.id===ap.sessionId),ta=c.state.collaboration.agents.find(x=>x.taskId&&x.sourceLaneId===ap.laneId);return ap.ownerId===c.state.me.id&&(ap.laneId===a.sourceLaneId||s?.agentIdentityId===a.id||ta?.parentAgentId===a.id);};
   if(req.url==='/next'){
    const approval=c.state.approvals.find(ap=>owns(ap)&&ap.status==='approved');if(!approval)return reply(200,{work:null});
    const claimKey=randomUUID();const data=await c.call('run.claim',{id:approval.id,claimKey,computerId:this.computerId()});this.claims.set(approval.id,{agentId:a.id,sessionId:approval.sessionId,laneId:approval.laneId});
    return reply(200,{work:{runId:approval.id,sessionId:approval.sessionId,laneId:approval.laneId,prompt:data.approval.prompt,projectContext:data.approval.projectContext,role:a.role,mode:approval.mode}});
   }
   const claim=this.claims.get(body.runId),ap=c.state.approvals.find(x=>x.id===body.runId);
   if(!claim||claim.agentId!==a.id||!ap||!owns(ap))throw Error('此执行不属于当前外接 Agent，或需要重新开始');
   const args={sessionId:claim.sessionId,laneId:claim.laneId,runId:body.runId};
   if(req.url==='/reply'){
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>60000)throw Error('回复为空或过长');
    await c.call('run.entry',{...args,eventId:'external-'+body.runId,entryId:'external-'+body.runId,role:'assistant',text:body.text});
    await c.call('run.finish',{...args,status:'done'});this.claims.delete(body.runId);return reply(200,{sent:true});
   }
   if(req.url==='/context')return reply(200,await c.call('collab.session.context',{sessionId:claim.sessionId}));
   if(req.url==='/contribute')return reply(200,await c.call('collab.task.contribute',{sessionId:claim.sessionId,laneId:claim.laneId,agentId:body.agentId,goal:body.goal,acceptance:body.acceptance,requestKey:body.requestKey}));
   throw Error('未知接入操作');
  }catch(e){reply(400,{error:String(e.message).slice(0,500)});}
 }
 async close(){this.pending.clear();this.claims.clear();if(this.server){this.server.closeAllConnections();await new Promise(r=>this.server.close(r));this.server=null;}}
}
