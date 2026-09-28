import {useEffect,useState} from 'react';
import {Github} from 'lucide-react';
import {Modal,type Call} from './ui';
import type {State} from './types';
import type {Project} from './project-types';
type Repo={fullName:string;defaultBranch:string;private:boolean};
export function ProjectGitHubTarget({state,project,call,inline=false}:{state:State;project:Project;call:Call;inline?:boolean}) {
 const [open,setOpen]=useState(false),[repository,setRepository]=useState(project.githubTarget?.repository||project.repository||''),[branch,setBranch]=useState(project.githubTarget?.baseBranch||project.branch||'main'),[prefix,setPrefix]=useState(project.githubTarget?.pathPrefix??project.subPath??''),[repos,setRepos]=useState<Repo[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const canEdit=project.driUserId===state.me?.id, account=state.local.accounts?.find(a=>a.id==='github');
 useEffect(()=>{setRepository(project.githubTarget?.repository||project.repository||'');setBranch(project.githubTarget?.baseBranch||project.branch||'main');setPrefix(project.githubTarget?.pathPrefix??project.subPath??'');setSaved(false);},[project.id,project.githubTargetRevision]);
 const run=async(f:()=>Promise<void>)=>{setBusy(true);setError('');try{await f();}catch(e){setError(String(e instanceof Error?e.message:e).replace(/^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/,''));}finally{setBusy(false);}};
 const form=<div className="github-target-form">
  <p>文件先在本机制作；负责人审批后，向这里创建 PR。</p>
  {!canEdit&&<small>由项目负责人设置；你可以查看提交目标。</small>}
  {canEdit&&<div className="room-actions"><button className="button" disabled={busy} onClick={()=>void run(async()=>{await call('accounts.refresh');setRepos(await call('github.repositories'));})}>{busy?'读取中…':'选择我的 GitHub 仓库'}</button>{!account?.authenticated&&<button className="button" disabled={busy} onClick={()=>void run(async()=>{await call('accounts.login',{id:'github'});})}>连接 GitHub</button>}</div>}
  {!!repos.length&&<label>可用仓库<select aria-label="PR 仓库列表" value={repos.some(r=>r.fullName===repository)?repository:''} disabled={busy||!canEdit} onChange={e=>{const r=repos.find(r=>r.fullName===e.target.value);if(r){setRepository(r.fullName);setBranch(r.defaultBranch);setSaved(false);}}}><option value="">选择仓库</option>{repos.map(r=><option key={r.fullName} value={r.fullName}>{r.fullName} · {r.private?'私有':'公开'}</option>)}</select></label>}
  <label>PR 仓库<input aria-label="PR 目标仓库" placeholder="owner/repo" value={repository} disabled={busy||!canEdit} onChange={e=>{setRepository(e.target.value);setSaved(false);}}/></label>
  <label>合并到分支<input aria-label="PR 目标分支" value={branch} disabled={busy||!canEdit} onChange={e=>{setBranch(e.target.value);setSaved(false);}}/></label>
  <label>仓库内目录（可选）<input aria-label="PR 目标目录" placeholder="例如 docs，留空放在仓库根目录" value={prefix} disabled={busy||!canEdit} onChange={e=>{setPrefix(e.target.value);setSaved(false);}}/></label>
  {canEdit&&<button className="button" disabled={busy||!repository.trim()||!branch.trim()} onClick={()=>void run(async()=>{await call('github.repository.details',{repository:repository.trim(),branch:branch.trim()});await call('collab.project.githubTarget',{projectId:project.id,repository:repository.trim(),baseBranch:branch.trim(),pathPrefix:prefix.trim(),revision:project.githubTargetRevision||0});setSaved(true);})}>{busy?'核对中…':'保存 PR 目标'}</button>}
  {saved&&<small role="status">PR 目标已保存</small>}
  {error&&<p className="room-error" role="alert">{error}</p>}
  <small>这里只保存目标，不上传文件、不改本机 Git、不自动合并。</small>
 </div>;
 return inline?<details className="project-github-target"><summary>PR 提交到哪里{project.githubTarget?` · ${project.githubTarget.repository}`:'（可稍后配置）'}</summary>{form}</details>:<><button className="button" onClick={()=>setOpen(true)}><Github size={15}/>PR 目标</button>{open&&<Modal title="项目 PR 目标" close={()=>setOpen(false)}>{form}</Modal>}</>;
}
