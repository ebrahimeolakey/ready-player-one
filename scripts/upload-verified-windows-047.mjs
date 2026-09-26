// One-release transfer, intentionally without configurable repository/run/release/hash.
// No dependencies, rebuild, publication, overwrite of an uploaded asset, or POST retry.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TARGET=Object.freeze({
  repository:'ebrahimeolakey/ready-player-one',runId:36227388246,
  releaseId:397176130,tag:'v0.4.7-beta.1',head:'a372a68db340f6e4c36fba03ac16bf3d70cb0180',
  files:Object.freeze([
    Object.freeze({name:'Ready-Player-One-0.4.7-beta.1-windows-x64-setup.exe',size:104956121,sha256:'710a7044f6e7b5a18129272766faf279a8e780d2cb4d7e33a1e4fca392b9560b'}),
    Object.freeze({name:'Ready-Player-One-0.4.7-beta.1-windows-x64.zip',size:147985439,sha256:'b014736c16158ef38fd8f91a044577765d7a8e1bb80cb638d51d3ee6201384aa'}),
  ]),
});
export async function verifyFiles(directory){
  const root=await realpath(directory);
  assert.deepEqual((await readdir(root)).sort(),TARGET.files.map(f=>f.name).sort(),'Artifact must contain exactly the two fixed Windows files');
  const files=[];
  for(const expected of TARGET.files){
    const path=join(root,expected.name),stat=await lstat(path);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Artifact entry must be a regular file');
    assert.equal(stat.size,expected.size,'Artifact size mismatch: '+expected.name);
    const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
    assert.equal(hash.digest('hex'),expected.sha256,'Artifact SHA256 mismatch: '+expected.name);
    files.push({...expected,path,digest:'sha256:'+expected.sha256});
  }
  return files;
}
export function validateRun(run){
  assert.equal(run.id,TARGET.runId);assert.equal(run.repository?.full_name,TARGET.repository);
  assert.equal(run.head_sha,TARGET.head);assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
  assert.equal(run.name,'Windows native verification');
}
export function validateRelease(release){
  assert.equal(release.id,TARGET.releaseId);assert.equal(release.draft,true,'Target must remain a draft');
  assert.equal(release.tag_name,TARGET.tag);assert.equal(release.target_commitish,TARGET.head);
  assert.ok(Array.isArray(release.assets));
  return release;
}
function assetFor(release,name){
  const matches=release.assets.filter(a=>a.name===name);
  assert.ok(matches.length<=1,'Duplicate asset names require manual review');return matches[0];
}
export function validateUploaded(asset,expected){
  assert.ok(asset,'Expected remote asset is missing');assert.equal(asset.name,expected.name);
  assert.equal(asset.state,'uploaded');assert.equal(asset.size,expected.size);
  assert.equal(asset.digest,'sha256:'+expected.sha256,'Uploaded digest mismatch; existing asset will not be replaced');
  assert.ok(Number.isSafeInteger(asset.id)&&asset.id>0);return asset;
}
function requester(token){
  return async(url,{method='GET',file}={})=>{
    const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
    if(file){headers['Content-Type']='application/octet-stream';headers['Content-Length']=String(file.size);}
    const response=await fetch(url,{method,headers,...(file?{body:createReadStream(file.path),duplex:'half'}:{}),signal:AbortSignal.timeout(file?600000:60000)});
    if(!response.ok)throw Error(`GitHub ${method} failed with HTTP ${response.status}`);
    return response.status===204?null:await response.json();
  };
}
/** Injected request is only for local dry-run tests. CLI always uses official HTTPS. */
export async function transfer(directory,request){
  const files=await verifyFiles(directory);
  const api=`https://api.github.com/repos/${TARGET.repository}`;
  validateRun(await request(`${api}/actions/runs/${TARGET.runId}`));
  const getRelease=async()=>validateRelease(await request(`${api}/releases/${TARGET.releaseId}`));
  for(const file of files){
    let existing=assetFor(await getRelease(),file.name);
    if(existing?.state==='uploaded'){validateUploaded(existing,file);console.log(JSON.stringify({name:file.name,status:'verified-existing',id:existing.id}));continue;}
    if(existing){
      // A previous uncertain transfer may leave this exact owned filename as starter.
      assert.equal(existing.state,'starter','Only a same-name incomplete starter may be removed');
      assert.ok(Number.isSafeInteger(existing.id)&&existing.id>0);
      await request(`${api}/releases/assets/${existing.id}`,{method:'DELETE'});
      assert.equal(assetFor(await getRelease(),file.name),undefined,'Asset changed during cleanup; refusing upload');
    }
    console.log(JSON.stringify({name:file.name,status:'uploading'}));
    try{
      await request(`https://uploads.github.com/repos/${TARGET.repository}/releases/${TARGET.releaseId}/assets?name=${encodeURIComponent(file.name)}`,{method:'POST',file});
    }catch{
      // An ACK can be lost after the server committed. Never blindly POST twice.
      existing=assetFor(await getRelease(),file.name);
      if(existing?.state!=='uploaded')throw Error(`Upload outcome unresolved for ${file.name}; inspect draft or rerun this guarded workflow. No POST was repeated.`);
      validateUploaded(existing,file);
    }
    existing=validateUploaded(assetFor(await getRelease(),file.name),file);
    console.log(JSON.stringify({name:file.name,status:'verified-uploaded',id:existing.id,size:existing.size,digest:existing.digest}));
  }
  const final=await getRelease();
  return {releaseId:TARGET.releaseId,draft:final.draft,head:TARGET.head,assets:files.map(file=>{
    const a=validateUploaded(assetFor(final,file.name),file);return {id:a.id,name:a.name,size:a.size,digest:a.digest};
  })};
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===2&&args[0]==='--verify-only'){
    const files=await verifyFiles(args[1]);console.log(JSON.stringify(files.map(({path,...file})=>file),null,2));return;
  }
  assert.equal(args.length,1,'Expected only the downloaded artifact directory');
  assert.equal(process.env.GITHUB_ACTIONS,'true','Upload is only allowed inside GitHub Actions');
  assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch','Explicit manual workflow dispatch required');
  assert.equal(process.env.GITHUB_REPOSITORY,TARGET.repository);
  assert.ok(process.env.GH_TOKEN,'GitHub Actions token is required');
  console.log(JSON.stringify(await transfer(args[0],requester(process.env.GH_TOKEN)),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(error=>{console.error(error.message);process.exitCode=1;});
