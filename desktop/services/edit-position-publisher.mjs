import {AgentEditPositions} from './agent-edit-positions.mjs';
/** Best-effort metadata only; never replay a location after a room change. */
export class EditPositionPublisher{
 constructor({client,isCurrent=()=>true}){this.client=client;this.isCurrent=isCurrent;this.reset();}
 reset(){this.collector?.dispose();this.bindings=new Map();const bindings=this.bindings;this.collector=new AgentEditPositions({onPositions:async(batch,context)=>{
  const c=bindings.get(batch.runId);if(bindings!==this.bindings||!c||c!==this.client()||c.ws?.readyState!==1||!this.isCurrent(context))return;
  const session=c.state?.sessions.find(s=>s.id===context.sessionId&&s.workspaceId===context.workspaceId),lane=session?.lanes.find(l=>l.id===context.laneId&&l.ownerId===c.state.me.id);
  if(!lane||lane.activeRunId!==batch.runId||lane.stopRequested||lane.fencedRunId===batch.runId)return;
  await c.call('run.editPositions',{workspaceId:context.workspaceId,sessionId:context.sessionId,laneId:context.laneId,...batch});
 }});}
 observe(event,{connection,...context}){if(event.type!=='tool'||connection!==this.client()||connection?.ws?.readyState!==1)return;if(!this.bindings.has(event.runId)&&this.bindings.size>=64)this.bindings.delete(this.bindings.keys().next().value);this.bindings.set(event.runId,connection);return this.collector.observe(event,context);}
 async finish(runId,{connection,...context}){const bindings=this.bindings;if(bindings.get(runId)!==connection)return;try{await this.collector.finish(runId,context);}finally{bindings.delete(runId);}}
 dispose(){this.collector.dispose();this.bindings.clear();}
}
