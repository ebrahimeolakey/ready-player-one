import { useEffect, useRef, useState } from 'react';
import type { Outcome, Session, State } from './types';
import type { Call } from './ui';

const names = { unknown: '仍不确定', succeeded: '已确认成功', failed: '已确认失败' };
function OutcomeCard({ outcome:o, canEdit, call }: {outcome:Outcome;canEdit:boolean;call:Call}) {
  const [status,setStatus]=useState<Outcome['status']>('unknown');
  const [evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState(false);
  // Keep a request ID through network retries, but not through form edits.
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [baseVersion,setBaseVersion]=useState(o.version);
  const [error,setError]=useState('');
  const acknowledged=useRef('');
  useEffect(()=>{
    // State broadcasts can acknowledge our exact mutation even when its RPC
    // response was lost. Do not turn that retry into a new audit entry.
    if(o.history.some(h=>h.requestId===requestId)){
      acknowledged.current=requestId;
      setEvidence('');setBaseVersion(o.version);setRequestId(crypto.randomUUID());setError('');
    }
  },[o.history,o.version,requestId]);
  const submit=async()=>{
    setBusy(true);setError('');
    try {
      const result=await call('outcome.resolve',{id:o.id,expectedVersion:baseVersion,requestId,status,evidence});
      if(result){setEvidence('');setBaseVersion(result.version);setRequestId(crypto.randomUUID());}
    } catch(e:any){if(acknowledged.current!==requestId)setError(e.message||'记录失败，请重试');}
    finally{setBusy(false);}
  };
  return <details className="approval-card">
    <summary>{o.status==='unknown'?'结果待确认':names[o.status]} · {o.owner}</summary>
    <p>{o.reason}</p>
    <details><summary>操作与证据</summary>
      <p>执行 {o.runId}<br/>启动尝试：{new Date(o.dispatchAt).toLocaleString()}</p>
      <pre style={{whiteSpace:'pre-wrap',maxHeight:160,overflow:'auto'}}>{o.prompt}</pre>
      <p>以下记录证明启动或许可投递尝试，不能单独证明操作成功。</p>
      {o.dispatches.map(d=><details key={d.approvalId}><summary>{d.action} · {new Date(d.at).toLocaleString()}</summary><p>审批 {d.approvalId}<br/>Provider 请求 {d.providerRequestId}<br/>{d.reviewer||'成员'} · {d.reviewedAt&&new Date(d.reviewedAt).toLocaleString()}</p><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{JSON.stringify(d.input,null,2)}</pre></details>)}
      {!!o.observations.length&&<details><summary>最近的工具事件</summary>{o.observations.map((v,i)=><div key={i}><p>{v.itemId} · {v.phase} · {new Date(v.at).toLocaleString()}</p><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{v.text}</pre></div>)}</details>}
      {o.lastOutput&&<details><summary>最近完整输出</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{o.lastOutput}</pre></details>}
    </details>
    {!!o.history.length&&<details><summary>确认记录（{o.history.length}）</summary>{o.history.map(h=><div key={h.version}><p>{h.owner} · {names[h.status]} · {new Date(h.at).toLocaleString()}</p><p style={{whiteSpace:'pre-wrap'}}>{h.evidence}</p></div>)}</details>}
    {canEdit&&<><select aria-label="确认结果" disabled={busy} value={status} onChange={e=>{setStatus(e.target.value as Outcome['status']);setRequestId(crypto.randomUUID());setBaseVersion(o.version);}}><option value="unknown">仍不确定</option><option value="succeeded">已确认成功</option><option value="failed">已确认失败</option></select>
      <textarea aria-label="结果证据" placeholder="填写检查结果、文件路径或记录链接" maxLength={4000} disabled={busy} value={evidence} onChange={e=>{setEvidence(e.target.value);setRequestId(crypto.randomUUID());}}/>
      {baseVersion!==o.version&&<p>其他成员已更新结果。查看确认记录后，<button className="button" disabled={busy} onClick={()=>{setBaseVersion(o.version);setRequestId(crypto.randomUUID());}}>使用最新版本</button></p>}
      {error&&<p role="alert">{error}</p>}
      <button className="button" disabled={busy||!evidence.trim()||baseVersion!==o.version} onClick={submit}>{busy?'记录中…':'记录结果'}</button>
    </>}
  </details>;
}
export function OutcomePanel({state,session,call}:{state:State;session:Session;call:Call}) {
  const role=state.me?.roles?.[session.workspaceId]||(state.me?.host?'owner':state.me?.role||'viewer');
  return <>{(state.outcomes||[]).filter(o=>o.sessionId===session.id).slice().reverse().map(o=><OutcomeCard key={o.id} outcome={o} canEdit={['owner','editor'].includes(role)} call={call}/>)}</>;
}
