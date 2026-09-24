import {useState} from 'react';
import type {Call} from './ui';
const labels:Record<string,string>={sessions:'会话',members:'工作区成员',sessionMembers:'会话成员',memories:'共享记忆',memoryHistory:'记忆修订',approvals:'执行审批',outcomes:'执行结果',toolApprovals:'工具审批',handoffs:'接管',subtasks:'子任务',locks:'文件占用',messages:'协作消息',groupMessages:'群聊消息',groupTasks:'群聊任务',invites:'邀请'};
export function WorkspaceDeletion({workspaceId,call,onDeleted}:{workspaceId:string;call:Call;onDeleted:()=>void}) {
 const [preview,setPreview]=useState<any>(null),[confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);try{setPreview(await call('workspace.delete.preview',{workspaceId}));setConfirmation('');}finally{setBusy(false);}}
 return <details className="help-details"><summary>删除工作区</summary>
 {!preview?<button className="text-button danger" disabled={busy} onClick={load}>查看删除范围</button>:<>
 <p>删除「{preview.name}」的共享房间数据。</p>
 <ul>{Object.entries(preview.counts).filter(([,n])=>Number(n)>0).map(([k,n])=><li key={k}>{labels[k]||k}：{String(n)}</li>)}</ul>
 <details><summary>会话与本机记录</summary>{preview.sessions.map((s:any)=><p key={s.id}>{s.title}</p>)}<pre style={{whiteSpace:'pre-wrap'}}>{[...preview.transcripts,...(preview.local?.files||[])].join('\n')||'无转录或恢复记录'}</pre></details>
 <p className="small-note">保留项目和 Git 文件、Provider 历史、外部导出、其他成员本机副本，以及无身份索引的草稿和路径映射。</p>
 {(preview.blocked.length>0||preview.local?.blocked?.length>0)?<p className="warning">仍有执行、审批或结果待处理，结束后重新预览。</p>:<input className="full" aria-label="确认删除的工作区名称" placeholder={`输入 ${preview.name}`} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/>}
 <div className="menu-actions"><button className="button" disabled={busy} onClick={load}>刷新范围</button><button className="button danger" disabled={busy||confirmation!==preview.name||preview.blocked.length>0||preview.local?.blocked?.length>0} onClick={async()=>{setBusy(true);try{const result=await call('workspace.delete',{workspaceId,previewId:preview.previewId,confirmation});if(result?.deleted){setPreview(null);onDeleted();}}finally{setBusy(false);}}}>确认删除</button></div>
 </>}</details>;
}
