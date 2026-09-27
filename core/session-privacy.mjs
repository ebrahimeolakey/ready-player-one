export const canReadSession=(session,peer)=>!session?.privateUserIds||session.privateUserIds.includes(peer.id);
export function privateResult(hub,peer,value){
 if(!value||typeof value!=='object'||!hub.db.sessions.some(s=>s.privateUserIds&&!canReadSession(s,peer)))return value;
 if(Array.isArray(value))return value.filter(v=>!v?.sessionId||canReadSession(hub.db.sessions.find(s=>s.id===v.sessionId),peer)).map(v=>privateResult(hub,peer,v));
 const out={};for(const [key,v] of Object.entries(value))out[key]=privateResult(hub,peer,v);
 if(Array.isArray(out.overlapDetails))out.overlaps=[...new Set(out.overlapDetails.map(d=>`${d.sessionTitle||'文件锁'} / ${d.owner}`))];
 return out;
}
