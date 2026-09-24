import {useEffect,useState} from 'react';
import {activityView,scheduleActivityExpiry} from '../core/activity-view.mjs';
import './mission-activity.css';
import { Files, Folder, FileQuestion, AlertCircle, Users } from 'lucide-react';
import type {State,Session} from './types';
export function MissionControl({state,sessions,onOpen}:{state:State;sessions:Session[];onOpen:(session:Session)=>void}){
 const [clock,setClock]=useState(0);
 const selected=new Set(sessions.map(s=>s.id));
 const active=state.sessions.filter(s=>s.status==='active'&&selected.has(s.id)&&(!state.me?.sessionId||state.me.sessionId===s.id));
 const activity=activityView(state,{sessionIds:active.map(s=>s.id),now:Date.now()});
 useEffect(()=>scheduleActivityExpiry(activity.nextExpiry,()=>setClock(value=>value+1)),[activity.nextExpiry,clock]);
 useEffect(()=>{const refresh=()=>setClock(value=>value+1);document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);return()=>{document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);};},[]);
 const fileSummary=[activity.counts.files?`${activity.counts.files} 文件`:'',activity.counts.directories?`${activity.counts.directories} 目录`:'',activity.counts.unknown?`${activity.counts.unknown} 未知范围`:''].filter(Boolean).join(' · ')||'0 文件';
 const sourceNames={declared:'任务范围',open:'打开',changed:'变更'};
 const kindNames={file:'文件',directory:'目录',unknown:'未知范围'};
 const attention=active.map(s=>{
  const approvals=state.approvals.filter(a=>a.sessionId===s.id&&a.status==='pending').length+(state.toolApprovals||[]).filter(a=>a.sessionId===s.id&&a.status==='pending').length;
  const conflict=state.local.sync?.[s.id]?.status==='conflict';
  const handoffs=((state as any).handoffs||[]).filter((h:any)=>h.sessionId===s.id&&['requested','ready'].includes(h.status)).length;
  const blocked=s.plan.filter(p=>p.status==='blocked').length;
  const runs=(state.local.runIssues||[]).filter(r=>r.sessionId===s.id).length;
  const limited=s.lanes.filter(l=>l.status==='needs_handoff').length;
  const unknown=(state.outcomes||[]).filter(o=>o.sessionId===s.id&&o.status==='unknown').length;
  const labels=[unknown?`${unknown} 项结果待确认`:'',limited?`${limited} 项限额待接管`:'',approvals?`${approvals} 项审批`:'',conflict?'代码冲突':'',handoffs?`${handoffs} 项接管`:'',blocked?`${blocked} 项受阻`:'',runs?'执行需检查':''].filter(Boolean);
  return {session:s,labels};
 }).filter(a=>a.labels.length);
 const running=active.flatMap(s=>s.lanes).filter(l=>l.status==='running');
 if(!active.length||(!running.length&&!activity.entries.length&&!attention.length))return null;
 return <div className="mission-control">
  {running.length>0&&<div className="mission-summary"><span><Users size={13}/>{running.length} 执行中</span></div>}
  {activity.entries.length>0&&<details className="mission-activity"><summary>{fileSummary}</summary><div className="mission-activity-list">{activity.entries.map(entry=><div className="mission-activity-row" key={entry.key}>
   <div className="mission-activity-path" title={`${entry.workspace} · ${entry.path} · ${kindNames[entry.kind]}`}>{entry.kind==='directory'?<Folder size={13}/>:entry.kind==='file'?<Files size={13}/>:<FileQuestion size={13}/>}<code>{entry.path}{entry.kind==='directory'?'/':''}</code><small>{entry.workspace}</small></div>
   <div className="mission-activity-sources">{entry.sources.map((source,index)=><button key={`${source.sessionId}:${source.laneId}:${source.source}:${index}`} title={`${source.sessionTitle} · ${source.owner} · ${sourceNames[source.source]} · ${kindNames[source.kind]}${source.legacy?'（旧通道，类型未确认）':''}`} onClick={()=>{const session=active.find(s=>s.id===source.sessionId);if(session)onOpen(session);}}><span>{source.sessionTitle}</span><span>{source.owner}</span><small>{sourceNames[source.source]}{source.legacy?' · 未确认':''}</small></button>)}</div>
  </div>)}</div></details>}
  {attention.map(({session,labels})=><button key={session.id} onClick={()=>onOpen(session)} className="mission-attention"><AlertCircle size={13}/><strong>{session.title}</strong><span>{labels.join(' · ')}</span></button>)}
 </div>;
}
