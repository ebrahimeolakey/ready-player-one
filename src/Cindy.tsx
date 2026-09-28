import { aiName } from "./ui";
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Check, ArrowRight } from 'lucide-react';
import { Modal, type Call } from './ui';
import { LocalSetup } from './LocalSetup';
import type { State } from './types';
import type { Project } from './project-types';

export type CindyAction = {draftId?:string;type:string;label:string;name?:string;role?:string;goal?:string;acceptance?:string;artifactPath?:string};
function reply(raw:string):{text:string;actions:CindyAction[]} {
  try {
    const data=JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]||raw);
    if(typeof data.text!=='string')throw Error();
    return {text:data.text.slice(0,12000),actions:(Array.isArray(data.actions)?data.actions:[]).filter((a:any)=>a&&['agent','task','invite','team','artifacts','discussion'].includes(a.type)&&typeof a.label==='string').slice(0,3).map((a:any)=>({type:a.type,label:a.label.slice(0,80),name:typeof a.name==='string'?a.name.slice(0,100):undefined,role:typeof a.role==='string'?a.role.slice(0,1000):undefined,goal:typeof a.goal==='string'?a.goal.slice(0,6000):undefined,acceptance:typeof a.acceptance==='string'?a.acceptance.slice(0,6000):undefined,artifactPath:typeof a.artifactPath==='string'&&/^[\w\u4e00-\u9fff .-]{1,100}$/.test(a.artifactPath)?a.artifactPath:undefined}))};
  }catch{return {text:raw,actions:[]};}
}
export function Cindy({state,project,call,close,onAction,onOpenSession}:{state:State;project:Project;call:Call;close:()=>void;onAction:(a:CindyAction)=>void;onOpenSession?:(id:string)=>void}) {
  const [input,setInput]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[setup,setSetup]=useState<CindyAction|null>(null);
  const key=useRef(crypto.randomUUID()),lastText=useRef(''),end=useRef<HTMLDivElement>(null);
  const record=state.collaboration?.onboarding?.find(r=>r.projectId===project.id&&r.userId===state.me?.id);
  const agents=state.collaboration?.agents.filter(a=>a.projectId===project.id&&!a.taskId)||[];
  const agent=agents.find(a=>a.id===record?.agentId);
  const lane=state.sessions.find(s=>s.id===agent?.sessionId)?.lanes.find(l=>l.id===agent?.sourceLaneId);
  const source=state.sessions.find(s=>s.id===agent?.sessionId);
  const privateChat=!!source?.privateUserIds;
  const running=!!lane&&['running','awaiting'].includes(lane.status);
  const owner=(state.me?.roles?.[project.teamId]||state.me?.role)==='owner';
  const own=agents.filter(a=>a.workerId===state.me?.id&&a.id!==agent?.id);
  const mapped=!!state.local.projectCheckouts?.[project.id];
  const tasks=state.collaboration?.tasks.filter(t=>t.projectId===project.id&&t.kind!=='planning')||[];
  const steps=[{label:'连接电脑',done:mapped&&state.local.online},{label:'认识 Cindy',done:!!agent},{label:'接入搭档',done:own.length>0},{label:'交出任务',done:tasks.some(t=>t.status==='running'||t.status==='review'||t.status==='accepted')},{label:'产物就绪',done:(state.collaboration?.artifactVersions||[]).some(v=>tasks.some(t=>t.id===v.taskId))}];
  const complete=steps.every(s=>s.done);
  const signature=record?.turns.map(t=>state.sessions.find(s=>s.id===t.sessionId)?.lanes.find(l=>l.id===t.laneId)?.entries.at(-1)?.text).join('');
  useEffect(()=>{end.current?.scrollIntoView({block:'nearest'});},[signature,record?.turns.length]);
  async function run(fn:()=>Promise<unknown>){if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const action=(a:CindyAction)=>{if(a.type==='agent'){setSetup(a);return;}onAction(a);};
  const connect=()=>setSetup({type:'agent',label:'连接 Cindy',name:'Cindy',role:'上手助手：帮助团队接入 Agent、分工、交出任务和查看产物'});
  const send=(text:string)=>void run(async()=>{
    if(lastText.current!==text){key.current=crypto.randomUUID();lastText.current=text;}
    await call('collab.onboarding.send',{projectId:project.id,text,requestKey:key.current});
    key.current=crypto.randomUUID();lastText.current='';setInput('');
  });
  if(setup)return <LocalSetup state={state} project={project} call={call} initial={setup} onClose={()=>setSetup(null)} onCreated={async a=>{
    if(setup.name==='Cindy')await call('collab.onboarding.attach',{projectId:project.id,agentId:a.id});
    setSetup(null);
  }}/>;
  return <Modal title={`${aiName("Cindy")} · 上手助手`} close={close} drawer><div className="cindy">
    <header><span className="cindy-avatar"><Sparkles size={26}/></span><div><h2>一起把团队搭起来</h2><p>{owner?'从一件你想完成的事开始。':'接入你的 Agent，和团队一起工作。'}</p></div></header>
    <div className="cindy-progress" aria-label="真实接入进度">{steps.map((s,i)=><span key={s.label} className={s.done?'done':''}>{s.done?<Check size={13}/>:i+1} {s.label}</span>)}</div>
    <div className="cindy-conversation" aria-live="polite">
      <article className="cindy-reply"><strong>{aiName("Cindy")}</strong><p>{agent?'你好，我是 Cindy。你可以告诉我项目目标，我会帮你配置合适的搭档，再交出第一项任务。':'先连接我的运行账号和模型。准备好后，我会用你的 AI 账号回答问题，带你把团队搭起来。'}</p>{!agent&&<small>这是接入说明，尚未调用 AI。</small>}</article>
      {!agent&&<button className="button primary" onClick={connect}>连接 Cindy <ArrowRight size={15}/></button>}
      {!agent&&agents.filter(a=>a.workerId===state.me?.id&&a.name==='Cindy').map(a=><button key={a.id} className="button" disabled={busy} onClick={()=>void run(()=>call('collab.onboarding.attach',{projectId:project.id,agentId:a.id}))}>继续使用已有 Cindy · {a.provider}</button>)}
      {record?.turns.map(t=>{
        const target=state.sessions.find(s=>s.id===t.sessionId)?.lanes.find(l=>l.id===t.laneId);
        const entries=target?.entries.filter(e=>e.runId===t.runId&&e.role==='assistant')||[];
        const active=target?.activeRunId===t.runId&&['running','awaiting'].includes(target.status);
        const parsed=reply(entries.map(e=>e.text).join('\n'));
        const actions=(record.drafts||[]).filter(d=>d.runId===t.runId).map(d=>({...d,draftId:d.id,label:d.agentId?d.label+' · 已接入':d.label}));
        return <div key={t.id}><article className="cindy-user"><strong>你</strong><p>{t.text}</p></article><article className="cindy-reply"><strong>{aiName("Cindy")}</strong><p>{active?'正在思考…':parsed.text||'这次没有收到回答。请打开会话查看原因，或重试。'}</p>{!active&&actions.length>0&&<div className="cindy-actions">{actions.map((a,i)=><button key={i} className="button" onClick={()=>action(a)}>{a.label}<ArrowRight size={13}/></button>)}</div>}</article></div>;
      })}
      {agent&&!record?.turns.length&&<div className="cindy-actions">{['帮我配置一个分工明确的 Agent 团队','同事如何带自己的 Agent 一起工作？','谁能看到我的文件和会话？'].map(text=><button key={text} disabled={busy||running} className="button" onClick={()=>send(text)}>{text}</button>)}</div>}
      {complete&&<p className="cindy-complete"><Check size={16}/>项目已产出第一份成果，随时可以回来找我。</p>}
      <div ref={end}/>
    </div>
    <div className="cindy-shortcuts"><button onClick={()=>action({type:'agent',label:'添加搭档'})}>添加 Agent</button>{owner&&<button onClick={()=>action({type:'invite',label:'邀请同事'})}>邀请同事</button>}<button onClick={()=>action({type:'task',label:'第一项任务'})}>交出任务</button><button onClick={()=>action({type:'artifacts',label:'查看产物'})}>查看产物</button></div>
    <form onSubmit={e=>{e.preventDefault();if(input.trim())send(input.trim());}}><textarea aria-label="问 Cindy" placeholder={agent?'告诉 Cindy，你想完成什么…':'先连接 Cindy 的 AI 账号'} disabled={!agent} value={input} maxLength={6000} onChange={e=>setInput(e.target.value)}/><button aria-label="发送给 Cindy" className="button primary" disabled={!agent||!mapped||busy||running||!input.trim()}><Send size={16}/></button></form>
    {running&&agent&&<button className="inline-link" disabled={busy} onClick={()=>void run(()=>call('lane.stop',{sessionId:agent.sessionId,laneId:agent.sourceLaneId}))}>停止本轮回答</button>}
    <footer><small>{agent?`${agent.provider==='claude'?'Claude Code':'Codex'} · ${lane?.configuration?.model||'默认模型'} · 本机运行`:'使用你自己的 Codex / Claude Code 账号'}</small><small>{privateChat?'此引导会话仅你可见。账号凭据留在本机。':'此会话与团队共享。账号凭据留在本机。'}</small>{agent?.sessionId&&onOpenSession&&<button className="inline-link" onClick={()=>{close();onOpenSession(agent.sessionId!);}}>打开完整会话 / 调整模型</button>}<button className="inline-link" disabled={busy} onClick={()=>void run(async()=>{await call('collab.onboarding.status',{projectId:project.id,dismissed:true});close();})}>{complete?'完成引导':'稍后继续'}</button></footer>
    {error&&<p role="alert" className="room-error">{error}</p>}
  </div></Modal>;
}
