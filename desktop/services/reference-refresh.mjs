import { realpath } from 'node:fs/promises';
import { checkReferences } from './references.mjs';

/** A successful local mutation remains successful if evidence refresh fails. */
export class ReferenceRefreshService {
  constructor({client,onIssue=()=>{}}){Object.assign(this,{client,onIssue});}
  async refresh({root,workspaceId,sessionId,reason='代码更新',paths,expectedClient,isCurrent=()=>true}) {
    const c=this.client();
    if(expectedClient&&expectedClient!==c)return {checked:0,skipped:true};
    if(!c||c.ws?.readyState!==1){const error='协作连接已断开，引用检查未上报';this.onIssue({workspaceId,sessionId,message:error});return {checked:0,error};}
    try {
      if(!isCurrent())throw Error('项目已改变，引用检查未上报');
      const canonical=await realpath(root),state=await c.call('state');
      if(c!==this.client()||!isCurrent())throw Error('协作连接已切换');
      const session=state.sessions.find(s=>s.id===sessionId&&s.workspaceId===workspaceId);
      if(sessionId&&!session)throw Error('会话已不可访问');
      const role=state.me.roles?.[workspaceId]||(state.me.host?'owner':'viewer');
      if(!['owner','editor'].includes(role))return {checked:0,skipped:true};
      const memories=state.memories.filter(m=>m.workspaceId===workspaceId&&!m.retired);
      const comments=session?.comments.filter(c=>c.location)||[];
      const wanted=new Set([...memories.flatMap(m=>(m.files||[]).map(f=>f.path)),...comments.map(c=>c.location.path)]);
      if(paths){const changed=new Set(paths);for(const path of wanted)if(!changed.has(path))wanted.delete(path);}
      const all=[...wanted];let checked=0;
      for(let i=0;i<all.length;i+=100){
        const files=await checkReferences(canonical,{references:all.slice(i,i+100).map(path=>({path}))});
        if(c!==this.client()||!isCurrent()||await realpath(root)!==canonical)throw Error('项目或连接已改变，引用检查未上报');
        const common={workspaceId,sessionId,files,automatic:true,reason};
        const targetMemories=memories.filter(m=>m.files?.some(f=>files.some(v=>v.path===f.path)));
        if(targetMemories.length)await c.call('memory.check',{...common,expectedVersions:Object.fromEntries(targetMemories.map(m=>[m.id,m.version||0]))});
        const targetComments=comments.filter(x=>files.some(v=>v.path===x.location.path));
        if(targetComments.length)await c.call('comment.check',{...common,expectedVersions:Object.fromEntries(targetComments.map(x=>[x.id,x.version||0]))});
        checked+=files.length;
      }
      this.onIssue({workspaceId,sessionId,message:null});return {checked};
    }catch(error){this.onIssue({workspaceId,sessionId,message:error.message});return {checked:0,error:error.message};}
  }
}
