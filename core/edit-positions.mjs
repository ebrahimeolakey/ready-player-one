const integer=v=>Number.isSafeInteger(v)&&v>=1&&v<=2000000;
export function validateEditPositions(args){
 if(!args||Object.keys(args).some(k=>!['workspaceId','sessionId','laneId','runId','sequence','positions'].includes(k)))throw Error('修改位置参数无效');
 if(!Number.isSafeInteger(args.sequence)||args.sequence<1||args.sequence>1000000||!Array.isArray(args.positions)||args.positions.length>32)throw Error('修改位置数量或序号无效');
 return args.positions.map(p=>{
  if(!p||Object.keys(p).some(k=>!['path','hash','startLine','endLine','phase','toolId','source'].includes(k))||typeof p.path!=='string'||!p.path||p.path.length>2048||p.path.includes('\\')||p.path.startsWith('/')||p.path.split('/').some(v=>!v||v==='.'||v==='..')||/[\x00-\x1f:]/.test(p.path)||!/^[a-f0-9]{64}$/.test(p.hash)||!integer(p.startLine)||!integer(p.endLine)||p.endLine<p.startLine||!['pending','completed'].includes(p.phase)||!['codex','claude'].includes(p.source)||typeof p.toolId!=='string'||!p.toolId||p.toolId.length>200)throw Error('修改位置内容无效');
  return {path:p.path,hash:p.hash,startLine:p.startLine,endLine:p.endLine,phase:p.phase,toolId:p.toolId,source:p.source};
 });
}
/** Read only the currently authorized snapshot, never a separate presence cache. */
export function visibleEditPositions(state,{workspaceId,path,hash},now=Date.now()){
 if(state?.local?.online!==true||!state.workspaces?.some(w=>w.id===workspaceId)||!hash)return [];
 const result=[];
 for(const session of state.sessions||[]){
  if(session.workspaceId!==workspaceId||session.status!=='active')continue;
  for(const lane of session.lanes||[]){
   const batch=lane.editPositions;
   if(!batch||!Number.isFinite(batch.expires)||batch.expires<=now||batch.runId!==lane.activeRunId||lane.stopRequested||lane.fencedRunId===batch.runId||lane.offlineSince)continue;
   let positions;try{positions=validateEditPositions({sequence:batch.sequence,positions:batch.positions});}catch{continue;}
   for(const p of positions){
    if(p.path!==path||p.hash!==hash||(p.phase==='pending'&&lane.status!=='running'))continue;
    result.push({...p,owner:lane.owner,ownerId:lane.ownerId,laneId:lane.id,sessionId:session.id,expires:batch.expires,runId:batch.runId,sequence:batch.sequence});
   }
  }
 }
 return result.slice(0,128);
}
