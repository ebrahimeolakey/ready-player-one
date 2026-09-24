import { GitBranch, AlertCircle, CheckCheck, Users } from 'lucide-react';
import type {State,Session} from './types';
export function MissionControl({state,sessions,onOpen}:{state:State;sessions:Session[];onOpen:(session:Session)=>void}){
 const active=sessions.filter(s=>s.status==='active');
 const attention=active.map(s=>{
  const approvals=state.approvals.filter(a=>a.sessionId===s.id&&a.status==='pending').length+(state.toolApprovals||[]).filter(a=>a.sessionId===s.id&&a.status==='pending').length;
  const conflict=state.local.sync?.[s.id]?.status==='conflict';
  const handoffs=((state as any).handoffs||[]).filter((h:any)=>h.sessionId===s.id&&['requested','ready'].includes(h.status)).length;
  const blocked=s.plan.filter(p=>p.status==='blocked').length;
  const runs=(state.local.runIssues||[]).filter(r=>r.sessionId===s.id).length;
  const labels=[approvals?`${approvals} 项审批`:'',conflict?'代码冲突':'',handoffs?`${handoffs} 项接管`:'',blocked?`${blocked} 项受阻`:'',runs?'执行需检查':''].filter(Boolean);
  return {session:s,labels};
 }).filter(a=>a.labels.length);
 const running=active.flatMap(s=>s.lanes).filter(l=>l.status==='running');
 const plans=active.flatMap(s=>s.plan),done=plans.filter(p=>p.done).length;
 if(!active.length)return null;
 return <div className="mission-control">
  <div className="mission-summary"><span><Users size={13}/>{running.length} 执行中</span><span><CheckCheck size={13}/>{done}/{plans.length} 已完成</span><span><GitBranch size={13}/>{new Set(running.flatMap(l=>l.files)).size} 活动文件</span></div>
  {attention.map(({session,labels})=><button key={session.id} onClick={()=>onOpen(session)} className="mission-attention"><AlertCircle size={13}/><strong>{session.title}</strong><span>{labels.join(' · ')}</span></button>)}
 </div>;
}
