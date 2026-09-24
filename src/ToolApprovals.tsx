import {useState} from 'react';
import type {State,Session} from './types';
import type {Call} from './ui';
export function ToolApprovals({state,session,call}:{state:State;session:Session;call:Call}) {
 const [answers,setAnswers]=useState<Record<string,string>>({});
 const role=state.me?.roles?.[session.workspaceId]||(state.me?.host?'owner':'editor');
 const canDecide=['owner','editor'].includes(role);
 return <>{(state.toolApprovals||[]).filter(a=>a.sessionId===session.id&&a.status==='pending').map(a=><article className="approval-card" key={a.id}>
  <strong>{a.owner} · {a.action}</strong><details><summary>查看具体操作</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:200,overflow:'auto'}}>{JSON.stringify(a.input,null,2)}</pre></details>
  {(a.input?.questions||[]).map((q:any)=><label key={q.id}>{q.question||q.header}<input value={answers[`${a.id}:${q.id}`]||''} onChange={e=>setAnswers({...answers,[`${a.id}:${q.id}`]:e.target.value})}/></label>)}
  {canDecide&&<footer><button className="button" onClick={()=>call('tool.decide',{id:a.id,allow:false})}>拒绝</button><button className="button primary" onClick={()=>call('tool.decide',{id:a.id,allow:true,...(a.action==='question'?{answers:Object.fromEntries((a.input?.questions||[]).map((q:any)=>[q.id,{answers:[answers[`${a.id}:${q.id}`]||'']}]))}:{})})}>允许这一次</button></footer>}
 </article>)}</>;
}
