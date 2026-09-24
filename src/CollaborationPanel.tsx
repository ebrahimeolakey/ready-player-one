import {useState} from 'react';
import {Check, Plus, ArrowUp, LockKeyhole} from 'lucide-react';
import type {State,Session} from './types';
import type {Call} from './ui';
import {time} from './ui';
export const roleNames:Record<string,string>={owner:'管理员',editor:'编辑者',commenter:'评论者',viewer:'观看者'};
export function CollaborationPanel({state,session:s,call}:{state:State;session:Session;call:Call}) {
 const [plan,setPlan]=useState(''),[comment,setComment]=useState(''),[path,setPath]=useState('');
 const params={sessionId:s.id,workspaceId:s.workspaceId};
 const role=state.me?.roles?.[s.workspaceId]||(state.me?.host?'owner':'editor');
 const canEdit=['owner','editor'].includes(role),canComment=role!=='viewer';
 const members=state.members.filter(m=>!m.workspaceId||m.workspaceId===s.workspaceId);
 const own=s.lanes.find(l=>l.ownerId===state.me?.id);
 return <>
 <details className="rail-section" open><summary>计划 <span>{s.plan.filter(p=>p.done).length}/{s.plan.length}</span></summary>
 {s.plan.map(p=><div className={'plan-row '+(p.done?'completed':'')} key={p.id}>
  <button className="plan-item" disabled={!(canEdit||p.assigneeId===state.me?.id)} onClick={()=>call('plan.toggle',{...params,id:p.id})}><span className="checkbox">{p.done&&<Check size={11}/>}</span>{p.text}</button>
  <div className="plan-controls"><select aria-label={'负责人：'+p.text} disabled={!canEdit} value={p.assigneeId||''} onChange={e=>call(p.assigneeId&&p.status==='in-progress'?'plan.transfer':'plan.assign',{...params,id:p.id,assigneeId:e.target.value||null})}><option value="">未分配</option>{members.filter(m=>['owner','editor','commenter'].includes(m.role||'editor')).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select>
  <select aria-label={'状态：'+p.text} disabled={!(canEdit||p.assigneeId===state.me?.id)} value={p.status||(p.done?'done':'todo')} onChange={e=>call('plan.status',{...params,id:p.id,status:e.target.value})}>{Object.entries({todo:'待开始','in-progress':'进行中',blocked:'受阻',done:'完成'}).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
  {!p.assigneeId&&canComment&&<button onClick={()=>call('plan.claim',{...params,id:p.id})}>领取</button>}</div>
 {p.transferRequest&&['awaiting-release','awaiting-accept'].includes(p.transferRequest.status)&&<div className="plan-controls"><small>等待{p.transferRequest.status==='awaiting-release'?'当前负责人确认':'接收者确认'}</small>{[p.transferRequest.fromId,p.transferRequest.toId].includes(state.me?.id||'')&&<><button onClick={()=>call('plan.transfer.accept',{...params,id:p.id,transferId:p.transferRequest!.id})}>同意转交</button><button onClick={()=>call('plan.transfer.decline',{...params,id:p.id,transferId:p.transferRequest!.id})}>拒绝</button></>}</div>}
 </div>)}
 {canComment&&<form className="compact-input" onSubmit={async e=>{e.preventDefault();if(await call('plan.add',{...params,text:plan}))setPlan('');}}><input placeholder="添加计划…" aria-label="添加计划" value={plan} onChange={e=>setPlan(e.target.value)} required/><button title="添加计划" disabled={!plan.trim()}><Plus size={13}/></button></form>}
 </details>
 <details className="rail-section" open><summary>评论 <span>{s.comments.length}</span></summary><div className="comment-list">
 {s.comments.map(c=><article key={c.id} className={c.status==='resolved'?'resolved':''}><header><strong>{c.owner}</strong><time>{time(c.at)}</time></header>{c.anchor&&<small>{c.anchor}{c.stale?' · 代码已更新':''}</small>}<p>{c.text}</p>
 {canEdit&&<footer className="comment-actions"><button onClick={()=>call('comment.resolve',{...params,id:c.id,restore:c.status==='resolved'})}>{c.status==='resolved'?'重新打开':'解决'}</button>{!c.taskId&&<><button onClick={()=>call('comment.task',{...params,id:c.id})}>转为计划</button>{own&&<button onClick={()=>call('comment.task',{...params,id:c.id,laneId:own.id,mode:'read-only'})}>让 Agent 处理</button>}</>}</footer>}</article>)}
 </div>{canComment&&<form className="compact-input" onSubmit={async e=>{e.preventDefault();if(await call('comment.add',{...params,text:comment}))setComment('');}}><textarea rows={2} aria-label="评论" placeholder="评论…" value={comment} onChange={e=>setComment(e.target.value)} required/><button title="发送评论" disabled={!comment.trim()}><ArrowUp size={14}/></button></form>}</details>
 <details className="rail-section"><summary><LockKeyhole size={12}/> 文件占用</summary>
 {(state.locks||[]).filter(l=>l.sessionId===s.id).map(l=><div className="lock-row" key={l.id}><span>{l.path}<small>{l.owner}</small></span>{l.ownerId===state.me?.id&&<button onClick={()=>call('lock.release',{...params,laneId:l.laneId,id:l.id,path:l.path})}>释放</button>}</div>)}
 {canEdit&&own&&<form className="compact-input" onSubmit={async e=>{e.preventDefault();if(await call('lock.acquire',{...params,laneId:own.id,path}))setPath('');}}><input aria-label="要占用的文件路径" placeholder="文件路径…" value={path} onChange={e=>setPath(e.target.value)} required/><button title="占用文件"><Plus size={13}/></button></form>}<small className="small-note">供同事协调，未续期将自动释放。</small>
 </details></>;
}
