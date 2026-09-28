import { ArtifactReleaseService } from './artifact-release.mjs';
import { redactText } from '../../core/secure-store.mjs';
const refPath = (r, branch) => `repos/${r.repository}/git/ref/heads/${encodeURIComponent(branch)}`;
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const shaValid = s => /^[a-f0-9]{40}$/.test(s || '');

// Every remote mutation is recorded before dispatch. An uncertain operation is
// inspected, never automatically retried or merged into the target branch.
export class ArtifactPullRequestService extends ArtifactReleaseService {
  async prepare(record, source) {
    const base = await this.api(refPath(record, record.branch));
    if (!shaValid(base.object?.sha) || base.object?.type !== 'commit') throw Error('目标分支尚无可用提交，请先在 GitHub 初始化仓库');
    Object.assign(record, {kind:'pull_request', headBranch:`rpo/artifact-${record.id}`, baseSha:base.object.sha, projectTarget:source.project.githubTarget || null});
    if (record.previousSha === record.expectedSha) throw Error('目标分支已包含这份获批内容，无需创建 PR');
  }
  async approved(r) {
    const source = await this.source(r.versionId);
    if (source.version.hash !== r.hash || JSON.stringify(source.version.approval) !== JSON.stringify(r.approval)) throw Error('审批已改变，请重新审阅');
    if (JSON.stringify(source.project.githubTarget || null) !== JSON.stringify(r.projectTarget)) throw Error('项目 PR 目标已改变，请重新预览');
    if (r.scope !== this.currentScope()) throw Error('协作身份已切换');
    return source;
  }
  async fence(r) { await this.verify(r); await this.repositoryCheck(r); return this.approved(r); }
  validPull(r, pr, headSha) {
    return Number.isSafeInteger(pr?.number) && pr.number > 0 &&
      pr.head?.ref === r.headBranch && pr.base?.ref === r.branch &&
      pr.head?.repo?.id === r.repositoryId && pr.base?.repo?.id === r.repositoryId &&
      same(pr.head.repo.full_name,r.repository) && same(pr.base.repo.full_name,r.repository) &&
      pr.head.sha === headSha;
  }
  publish({id}) { return this.exclusive(async()=>{
    const data=this.data(),r=this.get(data,id);
    if(r.kind!=='pull_request')throw Error('这是旧版直接提交记录，请重新预览以创建 PR');
    const source=await this.fence(r);
    if(r.status!=='prepared')return this.public(r);
    if(Date.now()-Date.parse(r.at)>15*60*1000)throw Error('发布预览已过期，请重新预览');
    const base=await this.api(refPath(r,r.branch)),old=await this.remote(r);
    if(base.object?.sha!==r.baseSha || (old?.sha||null)!==r.previousSha)throw Error('目标分支已改变，请重新预览；没有覆盖远端修改');
    await this.approved(r);
    const dispatch = phase => {r.phase=phase;r.status='dispatching';this.write(data);};
    try {
      dispatch('create-branch');
      const branch=await this.api(`repos/${r.repository}/git/refs`,{method:'POST',body:{ref:`refs/heads/${r.headBranch}`,sha:r.baseSha}});
      if(branch.ref!==`refs/heads/${r.headBranch}` || branch.object?.sha!==r.baseSha)throw Error('PR 分支回执不匹配');
      r.branchCreated=true;this.write(data);
      await this.fence(r);
      const head=await this.api(refPath(r,r.headBranch)),file=await this.remote({...r,branch:r.headBranch});
      if(head.object?.sha!==r.baseSha || (file?.sha||null)!==r.previousSha)throw Error('PR 分支已被修改，已停止提交');
      await this.approved(r);
      dispatch('commit-approved-file');
      const result=await this.api(`repos/${r.repository}/contents/${r.path.split('/').map(encodeURIComponent).join('/')}`,{method:'PUT',body:{message:`Approved artifact v${r.number} [rpo:${r.id}]`,content:source.bytes.toString('base64'),branch:r.headBranch,...(r.previousSha?{sha:r.previousSha}:{})}});
      if(result.content?.sha!==r.expectedSha || !shaValid(result.commit?.sha))throw Error('产物提交回执不匹配');
      r.commit=result.commit.sha;this.write(data);
      await this.fence(r);
      const committed=await this.api(refPath(r,r.headBranch));
      if(committed.object?.sha!==r.commit)throw Error('PR 分支已被修改，已停止创建 PR');
      await this.approved(r);
      dispatch('create-pr');
      const pr=await this.api(`repos/${r.repository}/pulls`,{method:'POST',body:{title:`Approved artifact v${r.number}: ${r.path}`.slice(0,240),head:r.headBranch,base:r.branch,body:`DRI-approved artifact snapshot.\n\nVersion: ${r.number}\nSHA256: ${r.hash}\nOperation: ${r.id}\n\nOnly this approved file version is included. Merge requires human review.`}});
      if(!this.validPull(r,pr,r.commit))throw Error('PR 回执不匹配');
      Object.assign(r,{status:'published',prNumber:pr.number,url:`https://github.com/${r.repository}/pull/${pr.number}`,message:'PR 已创建，尚未合并'});
    } catch(e) {r.status='unknown';r.message='结果待核实，不会自动重发。'+redactText(e.message);}
    this.write(data);return this.public(r);
  });}
  lookup({id}) {
    const existing=this.get(this.data(),id);
    if(existing.kind!=='pull_request')return super.lookup({id});
    return this.exclusive(async()=>{
      const data=this.data(),r=this.get(data,id);await this.fence(r);
      if(!['dispatching','unknown'].includes(r.status))return this.public(r);
      try {
        const head=await this.api(refPath(r,r.headBranch));
        const file=await this.remote({...r,branch:r.headBranch});
        if(!shaValid(head.object?.sha) || file?.sha!==r.expectedSha || (r.commit && head.object.sha!==r.commit))throw Error('PR 分支内容尚未确认或已被改动');
        const commit=await this.api(`repos/${r.repository}/git/commits/${head.object.sha}`);
        if(!commit.message?.includes(`[rpo:${r.id}]`))throw Error('无法确认此提交属于本次发布');
        const pulls=await this.api(`repos/${r.repository}/pulls?state=all&head=${encodeURIComponent(r.repository.split('/')[0]+':'+r.headBranch)}&base=${encodeURIComponent(r.branch)}`);
        const matches=Array.isArray(pulls)?pulls.filter(pr=>this.validPull(r,pr,head.object.sha)):[];
        if(matches.length!==1)throw Error('产物分支已存在，但未确认唯一 PR；不会重复创建，可在 GitHub 检查');
        await this.approved(r);
        Object.assign(r,{status:'published',commit:head.object.sha,prNumber:matches[0].number,url:`https://github.com/${r.repository}/pull/${matches[0].number}`,message:'已核实 PR；合并状态请在 GitHub 查看'});
      }catch(e){r.message='结果待核实，不会自动重发。'+redactText(e.message);}
      this.write(data);return this.public(r);
    });
  }
}
