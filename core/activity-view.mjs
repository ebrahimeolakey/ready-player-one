const kinds = new Set(['file','directory','unknown']);
function pathKey(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\0\r\n]/.test(value)) return null;
  const path = value.replace(/\\/g,'/').replace(/\/$/,'');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(p => !p || p==='.' || p==='..')) return null;
  return path;
}
function scopes(value) { return Array.isArray(value) ? value.filter(v=>v && kinds.has(v.kind)) : []; }
function declaration(approvals, session, lane) {
  const records = approvals.filter(a=>a.workspaceId===session.workspaceId && a.sessionId===session.id && a.laneId===lane.id);
  // Hub approvals are newest-first. Never walk back to an old pending approval
  // after a newer one was finished/rejected. activeRunId still names the prior
  // turn while a fresh request awaits approval, so only running uses that field.
  const current = lane.status==='running' ? records.find(a=>a.id===lane.activeRunId && a.status==='claimed' && a.ownerId===lane.ownerId)
    : lane.status==='awaiting' && records[0]?.ownerId===lane.ownerId && ['pending','approved'].includes(records[0]?.status) ? records[0] : null;
  if (current) return {scopes:Array.isArray(current.fileScopes) ? scopes(current.fileScopes) : (current.files || []).map(path=>({path,kind:'unknown'})),approvalId:current.id,legacy:!Array.isArray(current.fileScopes)};
  if (['running','awaiting'].includes(lane.status) && !lane.activeRunId && !records.length) return {scopes:Array.isArray(lane.fileScopes) ? scopes(lane.fileScopes) : (lane.files || []).map(path=>({path,kind:'unknown'})),legacy:!Array.isArray(lane.fileScopes)};
  return {scopes:[]};
}
/** Read only the current authorized snapshot; selection IDs never supply data. */
export function activityView(snapshot, {sessionIds,now=Date.now()}={}) {
  if (!Number.isFinite(now)) throw Error('活动时钟无效');
  const selected=sessionIds ? new Set(sessionIds) : null;
  const workspaces=new Map((snapshot.workspaces || []).map(w=>[w.id,w]));
  const sessions=(snapshot.sessions || []).filter(s=>s.status==='active' && workspaces.has(s.workspaceId) && (!selected || selected.has(s.id)) && (!snapshot.me?.sessionId || snapshot.me.sessionId===s.id));
  const approvals=snapshot.approvals || [],rows=new Map();
  let nextExpiry=null;
  const add=(session,lane,scope,source,metadata={})=>{
    const path=pathKey(scope.path);if(!path || !kinds.has(scope.kind))return;
    const key=JSON.stringify([session.workspaceId,path]);
    let row=rows.get(key);
    if(!row){row={key,path,workspaceId:session.workspaceId,workspace:workspaces.get(session.workspaceId).name,kind:'unknown',sources:[]};rows.set(key,row);}
    if(row.sources.some(s=>s.sessionId===session.id&&s.laneId===lane.id&&s.source===source&&s.kind===scope.kind))return;
    row.sources.push({source,kind:scope.kind,sessionId:session.id,sessionTitle:session.title,laneId:lane.id,ownerId:lane.ownerId,owner:lane.owner,...metadata});
    if(metadata.expiresAt!==undefined)nextExpiry=nextExpiry===null?metadata.expiresAt:Math.min(nextExpiry,metadata.expiresAt);
  };
  for(const session of sessions)for(const lane of session.lanes || []){
    const declared=declaration(approvals,session,lane);
    for(const scope of declared.scopes)add(session,lane,scope,'declared',{legacy:Boolean(declared.legacy),...(declared.approvalId?{approvalId:declared.approvalId}:{})});
    const expires=lane.activity?.expires;
    if(Number.isFinite(expires)&&expires>now)for(const scope of scopes(lane.activity.fileScopes))add(session,lane,scope,'open',{expiresAt:expires});
    if(Number.isFinite(lane.changesExpires)&&lane.changesExpires>now)for(const file of lane.changedFiles || [])add(session,lane,{path:file.path,kind:'file'},'changed',{expiresAt:lane.changesExpires});
  }
  const entries=[...rows.values()].map(row=>{
    const known=new Set(row.sources.map(s=>s.kind).filter(kind=>kind!=='unknown'));
    row.kind=known.size===1?[...known][0]:'unknown';
    return row;
  }).sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId)||a.path.localeCompare(b.path));
  return {entries,counts:{files:entries.filter(e=>e.kind==='file').length,directories:entries.filter(e=>e.kind==='directory').length,unknown:entries.filter(e=>e.kind==='unknown').length},nextExpiry};
}
/** Recheck from wall-clock time when the nearest lease expires, even if no new
 * snapshot arrives. Timers are clamped and rechecked for early wake/clock shifts. */
export function scheduleActivityExpiry(expiresAt,onExpire,{now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  if(!Number.isFinite(expiresAt))return ()=>{};
  let timer,cancelled=false;
  const check=()=>{
    if(cancelled)return;
    const remaining=expiresAt-now();
    if(remaining<=0){onExpire();return;}
    timer=setTimer(check,Math.min(remaining,2147483647));
  };
  check();
  return ()=>{cancelled=true;if(timer!==undefined)clearTimer(timer);};
}
