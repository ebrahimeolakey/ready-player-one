import {useState} from 'react';
import type {State} from './types';
import type {Call} from './ui';
export function TeamConfiguration({state,teamId,call}:{state:State;teamId:string;call:Call}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const settings=state.collaboration?.teamSettings?.find(s=>s.teamId===teamId);
 const owner=state.me?.roles?.[teamId]==='owner';
 async function run(f:()=>Promise<unknown>){setBusy(true);setError('');try{await f();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 return <details className="team-configuration"><summary>电脑与团队设置</summary><div className="room-form">
 {(state.collaboration?.computers||[]).filter(c=>c.teamId===teamId).map(c=><div key={c.id} className="agent-event"><span>{c.name}<small>{c.online?'在线':'离线'} · {c.providers.join(' / ')||'尚未登录 AI'}</small></span></div>)}
 <label><input type="checkbox" checked={state.local.agentService?.enabled||false} disabled={busy} onChange={e=>void run(()=>call('computer.service.configure',{enabled:e.target.checked}))}/>关闭窗口后继续运行</label><small>菜单中「退出」会停止服务；电脑关机后，本机 Agent 不会继续执行。</small>
 <button className="button" disabled={busy} onClick={()=>void run(()=>call('computer.worker.export',{teamId}))}>配置独立执行服务</button><small>导出给本机后台服务使用的连接文件，包含登录凭据。其他同事应在自己的电脑接入。</small>
 {owner&&<><label><input type="checkbox" disabled={busy} checked={settings?.welcomeAgents===true} onChange={e=>void run(()=>call('collab.team.settings',{teamId,welcomeAgents:e.target.checked}))}/>新 Agent 加入时在群里通知</label><label><input type="checkbox" disabled={busy} checked={settings?.onboardingEnabled!==false} onChange={e=>void run(()=>call('collab.team.settings',{teamId,onboardingEnabled:e.target.checked}))}/>新成员显示 8 步引导</label><label>引导助手<select value={settings?.guideAgentId||''} disabled={busy} onChange={e=>void run(()=>call('collab.team.settings',{teamId,guideAgentId:e.target.value}))}><option value="">Cindy（每人使用自己的账号）</option>{state.collaboration?.agents.filter(a=>a.teamId===teamId&&!a.taskId).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><small>采用所选助手的职责，新成员仍使用自己的账号和独立引导会话。</small></>}
 {state.local.agentService?.error&&<p role="status" className="room-error">电脑服务：{state.local.agentService.error}</p>}
 {error&&<p role="alert" className="room-error">{error}</p>}
 </div></details>;
}
