import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ArtifactPullRequestService} from '../desktop/services/artifact-pull-request.mjs';
const BASE='a'.repeat(40),COMMIT='b'.repeat(40),OTHER='c'.repeat(40);
const blob=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
function fixture(){
 let saved,allowed=true,account=1,scope='team:dri',privateRepo=true,head=null,file=null,pull=null,base=BASE,failAt='',afterWrite=()=>{};
 const writes=[],bytes=Buffer.from('approved snapshot'),hash=createHash('sha256').update(bytes).digest('hex');
 const source={version:{number:1,hash,content:bytes.toString(),approval:{by:'dri',hash}},project:{repository:'old/code',branch:'dev',githubTarget:{repository:'team/output',baseBranch:'main',pathPrefix:'drafts'}},path:'result.md'};
 const repo={id:5,full_name:'team/output'};
 const opts={store:()=>({recoverFile(){},exists:()=>!!saved,readJSON:()=>structuredClone(saved),writeJSON:(_,v)=>saved=structuredClone(v)}),scope:()=>scope,resolve:async()=>{if(!allowed)throw Error('DRI revoked');return structuredClone(source);},run:async()=>({stdout:'fixture-token'}),request:async(path,o={})=>{
  const r=saved?.operations.at(-1);
  if(o.body){assert.equal(r.status,'dispatching');writes.push({path,...o});}
  if(path==='user')return {id:account,login:'dri'};
  if(path==='repos/team/output')return {...repo,private:privateRepo,permissions:{push:true}};
  if(path.includes('/branches/'))return {name:'main'};
  if(path.includes('/git/ref/heads/'))return {object:{type:'commit',sha:decodeURIComponent(path).endsWith('/main')?base:head}};
  if(path.endsWith('/git/refs')){if(failAt==='branch')throw Error('timeout');head=o.body.sha;afterWrite('branch');return {ref:o.body.ref,object:{sha:head}};}
  if(path.includes('/contents/')){
   if(o.body){assert.equal(o.method,'PUT');assert.notEqual(o.body.branch,'main');assert.deepEqual(Buffer.from(o.body.content,'base64'),bytes);if(failAt==='commit')throw Error('timeout');file={type:'file',sha:blob(bytes)};head=COMMIT;afterWrite('commit');return {content:file,commit:{sha:COMMIT}};}
   if(path.endsWith('ref=main')||!file)throw Object.assign(Error('missing'),{status:404});return file;
  }
  if(path.endsWith('/pulls')){assert.equal(o.method,'POST');pull={number:42,head:{ref:r.headBranch,sha:head,repo},base:{ref:r.branch,repo}};if(failAt==='pr')throw Error('response lost');return pull;}
  if(path.includes('/pulls?'))return pull?[pull]:[];
  if(path.includes('/git/commits/'))return {message:`Approved artifact [rpo:${r.id}]`};
  throw Error('Unexpected '+path);
 }};
 return {service:new ArtifactPullRequestService(opts),source,writes,restore:()=>new ArtifactPullRequestService(opts),setFail:v=>failAt=v,setBase:v=>base=v,setHead:v=>head=v,setAllowed:v=>allowed=v,setAccount:v=>account=v,setPrivate:v=>privateRepo=v,setScope:v=>scope=v,afterWrite:f=>afterWrite=f,base:()=>base,pull:()=>pull};
}
test('PR uses configured output repo, approved bytes, new branch, and never writes or merges main',async()=>{
 const f=fixture(),r=await f.service.preview({versionId:'v1'});
 assert.equal(r.repository,'team/output');assert.equal(r.branch,'main');assert.equal(r.path,'drafts/result.md');assert.equal(f.writes.length,0);
 const done=await f.service.publish({id:r.id});assert.equal(done.status,'published');assert.equal(done.url,'https://github.com/team/output/pull/42');assert.equal(f.base(),BASE);
 assert.equal(f.writes.length,3);assert.deepEqual(f.writes.map(x=>x.method),['POST','PUT','POST']);
 await f.restore().publish({id:r.id});assert.equal(f.writes.length,3);
});
test('changed target, account, visibility, approval, scope or base prevents all mutations',async()=>{
 for(const change of ['target','account','visibility','approval','scope','base']){
  const f=fixture(),r=await f.service.preview({versionId:'v1'});
  if(change==='target')f.source.project.githubTarget.pathPrefix='elsewhere';if(change==='account')f.setAccount(2);if(change==='visibility')f.setPrivate(false);if(change==='approval')f.setAllowed(false);if(change==='scope')f.setScope('other');if(change==='base')f.setBase(OTHER);
  await assert.rejects(f.service.publish({id:r.id}));assert.equal(f.writes.length,0,change);
 }
});
test('lost PR response is reconciled without repeated branch, commit or PR writes after restart',async()=>{
 const f=fixture(),r=await f.service.preview({versionId:'v1'});f.setFail('pr');
 assert.equal((await f.service.publish({id:r.id})).status,'unknown');
 await f.restore().publish({id:r.id});assert.equal(f.writes.length,3);
 assert.equal((await f.restore().lookup({id:r.id})).status,'published');assert.equal(f.writes.length,3);
});
test('partial branch/commit errors remain unknown and are never reported as a PR or replayed',async()=>{
 for(const phase of ['branch','commit']){const f=fixture(),r=await f.service.preview({versionId:'v1'});f.setFail(phase);
 assert.equal((await f.service.publish({id:r.id})).status,'unknown');const count=f.writes.length;
 await f.restore().publish({id:r.id});const result=await f.restore().lookup({id:r.id});assert.equal(result.status,'unknown');assert.equal(result.url,undefined);assert.equal(f.writes.length,count);}
});
test('revoked approval between branch creation and file commit prevents the next write',async()=>{
 const f=fixture(),r=await f.service.preview({versionId:'v1'});f.afterWrite(phase=>{if(phase==='branch')f.setAllowed(false);});
 assert.equal((await f.service.publish({id:r.id})).status,'unknown');assert.equal(f.writes.length,1);
});
test('lookup will not accept a PR whose head has changed since our approved commit',async()=>{
 const f=fixture(),r=await f.service.preview({versionId:'v1'});f.setFail('pr');await f.service.publish({id:r.id});f.setHead(OTHER);
 assert.equal((await f.service.lookup({id:r.id})).status,'unknown');
});
