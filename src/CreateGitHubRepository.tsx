import {useEffect,useRef,useState} from 'react';
import type {Call} from './ui';
type Receipt={id:string;owner:string;name:string;visibility:'private'|'public';account:{id:number;login:string};status:string;message?:string;repo?:{fullName:string;url:string};at:string};
type Binding={bindingId:string;path:string;fullName:string;url:string;dirty:boolean;alreadyBound:boolean};
const labels:Record<string,string>={prepared:'待审阅',dispatching:'结果待核实',created:'创建已确认',observed:'已找到同名仓库',unknown:'结果待核实',conflict:'需人工核实',failed:'未完成'};
export function CreateGitHubRepository({call,workspaceId,onImported,onBack}:{call:Call;workspaceId?:string;onImported:(w:any)=>void;onBack:()=>void}){
 const callRef=useRef(call);callRef.current=call;
 const [owner,setOwner]=useState(''),[name,setName]=useState(''),[visibility,setVisibility]=useState(''),[receipt,setReceipt]=useState<Receipt|null>(null),[history,setHistory]=useState<Receipt[]>([]),[binding,setBinding]=useState<Binding|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{let active=true;void callRef.current('github.create.history').then(value=>{if(active)setHistory(value||[]);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const edit=()=>{setReceipt(null);setBinding(null);setMessage('');};
 const select=(value:Receipt)=>{setReceipt(value);setHistory(current=>[value,...current.filter(r=>r.id!==value.id)].slice(0,30));setOwner(value.owner);setName(value.name);setVisibility(value.visibility);setBinding(null);};
 const ready=receipt&&['created','observed'].includes(receipt.status)&&receipt.repo;
 return <div className="github-create">
  <button className="button" disabled={busy} onClick={onBack}>返回仓库列表</button>
  <div className="form-grid" style={{marginTop:16}}>
   <label>所属用户或组织<input aria-label="仓库所有者" autoCapitalize="none" value={owner} disabled={busy} placeholder="owner" onChange={e=>{setOwner(e.target.value);edit();}}/></label>
   <label>仓库名<input aria-label="新仓库名称" autoCapitalize="none" value={name} disabled={busy} placeholder="my-project" onChange={e=>{setName(e.target.value);edit();}}/></label>
   <label>可见范围<select aria-label="仓库可见范围" value={visibility} disabled={busy} onChange={e=>{setVisibility(e.target.value);edit();}}><option value="">请选择</option><option value="private">私有 · 仅授权成员</option><option value="public">公开 · 任何人可查看</option></select></label>
  </div>
  {!receipt&&<button className="button primary" disabled={busy||!owner||!name||!visibility} onClick={()=>void run(async()=>{const value=await call('github.create.preview',{owner,name,visibility});if(value)select(value);})}>审阅创建</button>}
  {receipt&&<div className="auth-status" style={{marginTop:12}}>
   <strong>{receipt.owner}/{receipt.name}</strong><p>@{receipt.account.login} · {receipt.visibility==='private'?'私有':'公开'} · {labels[receipt.status]||receipt.status}</p>
   {receipt.message&&<p role="status">{receipt.message}</p>}
   {receipt.status==='prepared'?<><p className="small-note">创建空仓库；本机文件尚未上传。</p><button className="button primary" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.create',{id:receipt.id});if(value)select(value);})}>确认创建{receipt.visibility==='private'?'私有':'公开'}仓库</button><button className="button" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.create.preview',{owner,name,visibility});if(value)select(value);})}>重新审阅</button></>:<button className="button" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.create.lookup',{id:receipt.id});if(value)select(value);})}>查询远端结果</button>}
   {ready&&<div className="inline-form" style={{marginTop:12}}>
    <button className="button" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.clone',{repo:receipt.repo!.fullName,workspaceId,creationId:receipt.id});if(value)onImported(value);})}>克隆到新目录</button>
    <button className="button" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.bind.preview',{id:receipt.id,workspaceId});if(value)setBinding(value);})}>绑定已有 Git 项目</button>
   </div>}
  </div>}
  {binding&&<div className="auth-status" style={{marginTop:12}}><strong>绑定 origin</strong><p>{binding.path}</p><p>{binding.url}</p><p className="small-note">{binding.alreadyBound?'已是此远端。':binding.dirty?'有未提交修改，保留全部本机内容。':'只添加远端，不提交或推送。'}</p><button className="button primary" disabled={busy} onClick={()=>void run(async()=>{const value=await call('github.bind.confirm',{bindingId:binding.bindingId});if(value){setBinding(null);setMessage('已绑定 origin；需要时在 Git 面板提交和推送。');}})}>确认绑定</button></div>}
  {error&&<p role="alert" className="error-text">{error}</p>}{message&&<p role="status">{message}</p>}{busy&&<p role="status">处理中…</p>}
  {history.length>0&&<details style={{marginTop:12}}><summary>最近创建记录</summary><div className="repo-list">{history.map(value=><button key={value.id} disabled={busy} onClick={()=>select(value)}><strong>{value.owner}/{value.name}</strong><span>{labels[value.status]||value.status}</span></button>)}</div></details>}
 </div>;
}
