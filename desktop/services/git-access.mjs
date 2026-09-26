const read = {status:[],branches:[],changes:[],diff:['path','staged']};
const write = {stage:['paths'],unstage:['paths'],commit:['message'],fetch:['remote'],pull:['remote','branch'],push:['remote'],createBranch:['name'],switchBranch:['name']};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512;
/** Authorize the IPC context before resolving a local path or invoking Git. */
export async function authorizeGit({method,args,client,online,currentClient}) {
 const name=method.startsWith('git.')?method.slice(4):'';
 const fields=Object.hasOwn(read,name)?read[name]:Object.hasOwn(write,name)?write[name]:null;
 if(!fields)throw Error('不支持的 Git 操作');
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['workspaceId','sessionId','laneId',...fields].includes(key))||!id(args.workspaceId)||!id(args.sessionId)||(args.laneId!==undefined&&!id(args.laneId)))throw Error('Git 上下文参数无效');
 if(!client||!online()||client.ws?.readyState!==1)throw Error('请先连接工作区');
 const state=await client.call('state');
 if(currentClient()!==client||!online()||client.ws?.readyState!==1)throw Error('协作连接已变化');
 const session=state.sessions?.find(s=>s.id===args.sessionId&&s.workspaceId===args.workspaceId);
 if(!session||!state.workspaces?.some(w=>w.id===args.workspaceId)||(state.me?.sessionId&&state.me.sessionId!==session.id))throw Error('会话不存在或无权访问');
 if(args.laneId&&!session.lanes.some(l=>l.id===args.laneId&&l.ownerId===state.me?.id))throw Error('只能操作本机 Agent 的工作目录');
 const role=state.me?.roles?.[args.workspaceId]||(state.me?.host?'owner':'viewer');
 if(Object.hasOwn(write,name)&&!['owner','editor'].includes(role))throw Error('Git 写操作需要 Editor 或 Owner 权限');
 return state;
}
