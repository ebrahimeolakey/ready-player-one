import {useState} from 'react';
import {RefreshCw, GitCompareArrows} from 'lucide-react';
import type {State, Session} from './types';
import type {Call} from './ui';
const labels:Record<string,string>={synced:'已同步',syncing:'同步中',conflict:'需要解决冲突',error:'同步暂停',waiting:'等待 Agent 完成'};
export function SyncPanel({state,session,call}:{state:State;session:Session;call:Call}) {
 const params={sessionId:session.id, workspaceId:session.workspaceId};
 const current=state.local.sync?.[session.id];
 const enabled=!!state.local.syncSessions?.[session.id];
 const [versions,setVersions]=useState<{path:string;base:string|null;ours:string|null;theirs:string|null}|null>(null);
 const [busy,setBusy]=useState(false);
 const act=async(fn:()=>Promise<any>)=>{setBusy(true);try{await fn();}finally{setBusy(false);}};
 return <div className="sync-panel">
  <div className="sync-toolbar"><GitCompareArrows size={14}/><strong>代码同步</strong>
   <label title="在独立工作树中，通过 origin 共享包含未提交变更的快照；遵循 .gitignore"><input type="checkbox" disabled={busy||!session.lanes.some(l=>l.ownerId===state.me?.id)} checked={enabled} onChange={e=>act(()=>call('sync.enable',{...params,enabled:e.target.checked}))}/>自动同步</label>
   <span className={current?.status==='error'?'warning':''}>{current?labels[current.status]||current.status:'未开启'}</span>
   <button title="立即同步" disabled={busy||!enabled} onClick={()=>act(()=>call('sync.now',params))}><RefreshCw size={14}/></button>
  </div>
  {current?.message&&<small className="warning">{current.message}</small>}
  {current?.files?.map(path=><button key={path} onClick={async()=>{const v=await call('sync.conflict',{...params,path});if(v)setVersions(v);}}>{path} · 查看两个版本</button>)}
  {versions&&<div className="conflict-review"><header><strong>{versions.path}</strong><button onClick={()=>setVersions(null)}>关闭</button></header>
    <div className="conflict-columns">{(['ours','theirs'] as const).map(choice=><section key={choice}><header>{choice==='ours'?'我的版本':'同事版本'}<button disabled={busy} onClick={()=>act(async()=>{const result=await call('sync.resolve',{...params,path:versions.path,choice});if(result)setVersions(null);})}>使用此版本</button></header><pre>{versions[choice]??'（文件已删除）'}</pre></section>)}</div>
    <button disabled={busy} onClick={()=>act(async()=>{const result=await call('sync.resolve',{...params,path:versions.path,choice:'edited'});if(result)setVersions(null);})}>已在编辑器合并，保存结果</button>
  </div>}
 </div>;
}
