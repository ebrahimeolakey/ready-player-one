import { createHash } from 'node:crypto';
import { subtaskConnectionKey } from './subtask-agent.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// No project file APIs here. Only confirmed, scope-bound application recovery
// records are removed. UUID-only drafts remain because their origin is unknown.
export function createWorkspaceLifecycle({client,coordinator,runtime,store,config,saveConfig,runImages,saveRunImages,isBusy=()=>false,lockRoots=()=>()=>{},localReceipt}) {
 const previews=new Map();
 const journalName='workspace-cleanup.json';
 const journals=()=>store().exists(journalName)?store().readJSON(journalName):[];
 const saveJournal=items=>store().writeJSON(journalName,items);
 const records=(scope,workspaceId)=>[...coordinator.records.values()].filter(r=>r.scope===scope&&r.workspaceId===workspaceId);
 function inspect(c,workspaceId) {
  const scope=coordinator.scope(c), selected=records(scope,workspaceId);
  const sessions=c.state.sessions.filter(s=>s.workspaceId===workspaceId),laneIds=sessions.flatMap(s=>s.lanes.map(l=>l.id)),sessionIds=sessions.map(s=>s.id);
  const connectionKey=subtaskConnectionKey(c),ownerId=c.state.me.id;
  const requestKeys=Object.entries(config.agentSubtaskRequests||{}).filter(([,r])=>r.binding?.connectionKey===connectionKey&&r.binding?.ownerId===ownerId&&r.binding?.workspaceId===workspaceId).map(([k])=>k);
  const settingsKey=digest([connectionKey,ownerId,workspaceId]);
  const busy=selected.filter(r=>!r.ended||r.pending?.length||r.outcome&&!r.outcomeDelivered||runtime.runs.has(r.runId)||coordinator.claimed.has(r.runId)||coordinator.flushing.has(r.runId));
  const roots=[config.paths?.[workspaceId],...sessionIds.map(id=>config.sessionPaths?.[id]),...laneIds.map(id=>config.lanePaths?.[id])].filter(Boolean);
  if(roots.some(isBusy))busy.push({runId:'local-project-busy'});
  return {scope,ownerId,workspaceId,runIds:selected.map(r=>r.runId),laneIds,sessionIds,requestKeys,settingsKey,roots,busy:busy.map(r=>r.runId),files:selected.map(r=>`outbox/${r.runId}.json.enc`)};
 }
 function clean(journal) {
  const selected=records(journal.scope,journal.workspaceId);
  for(const r of selected)if(journal.runIds.includes(r.runId)) {
   if(runtime.runs.has(r.runId)||!r.ended||r.pending?.length||r.outcome&&!r.outcomeDelivered||coordinator.claimed.has(r.runId)||coordinator.flushing.has(r.runId))throw Error('本机恢复记录仍在处理，清理已暂停');
   coordinator.store.removeFile(r.runId+'.json');coordinator.records.delete(r.runId);
  }
  for(const id of journal.runIds)runImages.delete(id);saveRunImages();
  for(const key of journal.requestKeys)delete config.agentSubtaskRequests?.[key];
  delete config.agentSubtaskSettings?.[journal.settingsKey];
  // Path/settings maps are intentionally retained too: their legacy UUID-only
  // keys do not carry a trusted Hub/identity scope. They contain no project data.
  saveConfig();
 }
 async function recover() {
  const c=client();if(!c)return;
  const scope=coordinator.scope(c);
  for(const journal of journals().filter(j=>j.scope===scope)) {
   if(!journal.confirmed) {
    const receipt=localReceipt?.(journal)||await c.call('workspace.delete.status',{workspaceId:journal.workspaceId,previewId:journal.previewId}).catch(()=>null);
    if(!receipt?.deleted)continue;
    journal.confirmed=true;saveJournal(journals().map(j=>j.previewId===journal.previewId?journal:j));
   }
   clean(journal);saveJournal(journals().filter(j=>j.previewId!==journal.previewId));
  }
 }
 return {recover,async invoke(method,a) {
  const c=client();if(!c)throw Error('尚未连接协作空间');
  if(method==='workspace.delete.preview') {
   await recover();
   const state=await c.call('state');if(c!==client())throw Error('协作连接已切换');c.state=state;
   const local=inspect(c,a.workspaceId),remote=await c.call(method,a);
   if(c!==client())throw Error('协作连接已切换');
   previews.set(remote.previewId,{...local,previewId:remote.previewId,connection:c});
   return {...remote,local:{files:local.files,blocked:local.busy,retained:['输入/文件草稿与项目路径映射（旧记录没有 Hub 身份索引）']}};
  }
  if(method!=='workspace.delete')throw Error('未知工作区操作');
  const before=previews.get(a.previewId);
  if(!before||before.connection!==c||before.scope!==coordinator.scope(c)||before.workspaceId!==a.workspaceId)throw Error('本机删除预览已失效');
  const current=inspect(c,a.workspaceId);
  if(current.busy.length)throw Error('本机仍有执行、未投递结果或项目操作，请结束后重试');
  if(digest(current)!==digest(Object.fromEntries(Object.entries(before).filter(([k])=>!['previewId','connection'].includes(k)))))throw Error('本机恢复记录已变化，请重新预览');
  if(!coordinator.store&&current.runIds.length)throw Error('本机恢复记录未接入安全存储');
  const unlock=lockRoots(current.roots);
  const wasPaused=coordinator.paused;coordinator.paused=true;
  const journal={...current,previewId:a.previewId,confirmed:false};
  try {
   saveJournal([...journals().filter(j=>j.previewId!==a.previewId),journal]);
   const result=await c.call(method,a);
   journal.confirmed=true;saveJournal(journals().map(j=>j.previewId===a.previewId?journal:j));
   // Cleanup uses captured exact scope, even if the successful delete disconnects
   // this remote client. It never adopts a replacement client's identity.
   clean(journal);saveJournal(journals().filter(j=>j.previewId!==a.previewId));
   previews.delete(a.previewId);return result;
  } finally {unlock();coordinator.paused=wasPaused;if(!wasPaused&&c===client())coordinator.retry();}
 }};
}
