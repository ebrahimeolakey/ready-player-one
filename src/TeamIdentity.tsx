import { useEffect, useState } from "react";
import { Github } from "lucide-react";
import type { Call } from "./ui";
type Job={id:string;status:string;message?:string;github?:{id:string;login:string}};
type Info={configured:boolean;github?:{id:string;login:string}|null;jobs?:Job[]};
export function TeamIdentity({call}:{call:Call}) {
  const [info,setInfo]=useState<Info|null>(null),[job,setJob]=useState<Job|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function load(){const result=await call("team.status");if(result){setInfo(result);const pending=result.jobs?.find((j:Job)=>j.status==="pending");if(pending)setJob(pending);}}
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(!job||job.status!=="pending")return;const timer=setInterval(()=>{void call("team.poll",{id:job.id}).then(result=>{if(result){setJob(result);if(result.status==="verified")void load();}}).catch(e=>setError(e.message));},1500);return()=>clearInterval(timer);},[job?.id,job?.status]);
  async function begin(){setBusy(true);setError("");try{const result=await call("team.begin");if(result)setJob(result);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <section className="rail-section">
    <strong><Github size={14}/> GitHub 团队身份</strong>
    {info===null?<small>正在检查…</small>:!info.configured?<small className="small-note">尚未配置团队登录服务。</small>:<>
      {info.github?<p>@{info.github.login} · 已绑定</p>:<p className="small-note">验证 GitHub 身份后，可使用用户名邀请。</p>}
      {job?.status==="pending"?<p role="status">等待浏览器完成 GitHub 授权…</p>:<button className="button" disabled={busy} onClick={begin}>{info.github?"重新验证":"使用 GitHub 验证"}</button>}
      {job?.message&&<p role="alert" className="small-note">{job.message}</p>}
    </>}
    {error&&<p role="alert" className="small-note">{error}</p>}
  </section>;
}
