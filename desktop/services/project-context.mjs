import {realpath,stat} from 'node:fs/promises';
import {GitService} from './git.mjs';
export function repositoryIdentity(remote){
 const value=String(remote||'').trim();
 const ssh=/^(?:[^@\s]+@)?([^:\/\s]+):(.+)$/.exec(value);
 let host='',path='',display='';
 try{const url=new URL(value);if(['https:','http:','ssh:','git:'].includes(url.protocol)){host=url.hostname;path=url.pathname;url.username='';url.password='';url.search='';url.hash='';display=url.toString();}}
 catch{if(ssh){host=ssh[1];path=ssh[2];display=host+':'+path;}else display=value.replace(/[?#].*$/,'');}
 path=path.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');
 const github=host.toLowerCase()==='github.com'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path);
 return {remote:display,repository:github?path:null,repositoryUrl:github?'https://github.com/'+path:null};
}
export async function projectContext(path,{git=new GitService()}={}){
 const root=await realpath(path);if(!(await stat(root)).isDirectory())throw Error('项目目录不存在');
 const result={root,gitRoot:null,branch:null,commit:null,detached:false,isWorktree:false,...repositoryIdentity('')};
 let top;try{top=(await git.command(root,['rev-parse','--show-toplevel'])).stdout.trim();}catch{return result;}
 const read=async args=>(await git.command(root,args,{allowExit:[1,128]})).stdout.trim();
 const [branch,commit,remote,gitDir,commonDir]=await Promise.all([read(['symbolic-ref','--quiet','--short','HEAD']),read(['rev-parse','--verify','HEAD']),read(['config','--get','remote.origin.url']),read(['rev-parse','--absolute-git-dir']),read(['rev-parse','--path-format=absolute','--git-common-dir'])]);
 return {...result,gitRoot:top,branch:branch||null,commit:commit||null,detached:!branch&&!!commit,isWorktree:!!commonDir&&gitDir!==commonDir,...repositoryIdentity(remote)};
}
