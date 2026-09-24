import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {localEnv,git} from '../../core/local.mjs';
import {redactText} from '../../core/secure-store.mjs';
const exec=promisify(execFile),FILE='github-repositories.json';
const cleanError=e=>redactText(String(e.stderr||e.message||e)).slice(0,1500);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
function input({owner,name,visibility}){
 if(typeof owner!=='string'||!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner))throw Error('请输入有效 GitHub 用户或组织名');
 if(typeof name!=='string'||!/^[a-z\d_.][a-z\d_.-]{0,99}$/i.test(name)||['.','..'].includes(name)||name.endsWith('.git'))throw Error('仓库名需为 1–100 个字母、数字、点、下划线或短横线');
 if(!['private','public'].includes(visibility))throw Error('请明确选择私有或公开');
 return {owner,name,visibility};
}
function repository(value,record){
 if(!value||!Number.isSafeInteger(value.id)||!same(value.full_name,`${record.owner}/${record.name}`)||value.private!==(record.visibility==='private'))throw Error('远端仓库的名称或可见范围与审阅内容不符，请到 GitHub 核实');
 return {id:value.id,fullName:value.full_name,url:`https://github.com/${value.full_name}`,cloneUrl:`https://github.com/${value.full_name}.git`,canPush:value.permissions?.push===true};
}
/** Remote mutation receipts are durable before POST; uncertain receipts are queried, never replayed. */
export class GithubRepositoryService {
 constructor({store,scope,withRepository=async(_root,action)=>action(),run=exec}){Object.assign(this,{store,scope,withRepository,run});this.queue=Promise.resolve();}
 exclusive(action){const execute=async()=>{try{return await action();}finally{delete this.apiToken;}};const pending=this.queue.then(execute,execute);this.queue=pending.catch(()=>{});return pending;}
 currentScope(){const scope=this.scope();if(typeof scope!=='string'||!scope)throw Error('尚未连接协作身份');return scope;}
 data(){const store=this.store();if(!store)throw Error('本机加密存储尚未就绪');store.recoverFile(FILE);return store.exists(FILE)?store.readJSON(FILE):{operations:[],bindings:[]};}
 write(data){this.store().writeJSON(FILE,data);}
 get(data,id){const record=data.operations.find(r=>r.id===id&&r.scope===this.currentScope());if(!record)throw Error('创建记录不属于当前协作身份');return record;}
 public(record){if(record.scope!==this.currentScope())throw Error('协作身份已切换');const {scope,...value}=record;return structuredClone(value);}
 async api(path,{method='GET',fields=[]}={}){
  try{const {stdout}=await this.run('gh',['api','--hostname','github.com','--method',method,path,...fields],{env:{...localEnv(),GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',...(this.apiToken?{GH_TOKEN:this.apiToken}:{})},timeout:30000,maxBuffer:2*1024*1024,windowsHide:true});return JSON.parse(stdout);}
  catch(e){const error=Error(`GitHub 请求失败：${cleanError(e)}`);error.status=Number(String(e.stderr||e.message).match(/HTTP\s+(\d{3})/i)?.[1])||null;throw error;}
 }
 async account(){let user;try{user=await this.api('user');}catch(e){throw Error('无法确认 GitHub 账号，请在账号设置登录或检查授权。'+e.message);}if(!Number.isSafeInteger(user?.id)||!user.login)throw Error('无法确认 GitHub 账号');return {id:user.id,login:user.login};}
 async verify(record){const account=await this.account();if(account.id!==record.account.id||!same(account.login,record.account.login))throw Error('GitHub 账号已切换，请切回审阅时的账号');if(record.scope!==this.currentScope())throw Error('协作身份已切换');
  if(!this.apiToken){
   let token;try{token=(await this.run('gh',['auth','token','--hostname','github.com','--user',account.login],{env:{...localEnv(),GH_PROMPT_DISABLED:'1'},timeout:10000,maxBuffer:16384,windowsHide:true})).stdout.trim();}catch{throw Error('无法锁定审阅账号的本机授权，请重新登录 GitHub');}
   if(!token||/[\s\0]/.test(token))throw Error('本机 GitHub 授权格式无效');this.apiToken=token;
   const pinned=await this.account();if(pinned.id!==record.account.id)throw Error('本机授权与审阅账号不符，请重新登录 GitHub');
  }
  return account;}
 async find(record){try{return repository(await this.api(`repos/${record.owner}/${record.name}`),record);}catch(e){if(e.status===404)return null;throw e;}}
 history(){return this.exclusive(async()=>{const scope=this.currentScope(),account=await this.account();if(scope!==this.currentScope())throw Error('协作身份已切换');return this.data().operations.filter(r=>r.scope===scope&&r.account.id===account.id).slice(-30).reverse().map(r=>this.public(r));});}
 preview(args){return this.exclusive(async()=>{
  const target=input(args),scope=this.currentScope(),account=await this.account();
  const owner=await this.api(`users/${target.owner}`);
  if(owner.type==='User'){if(!same(owner.login,account.login))throw Error('只能在当前 GitHub 用户或已加入的组织下创建仓库');}
  else if(owner.type==='Organization'){const membership=await this.api(`user/memberships/orgs/${target.owner}`);if(membership.state!=='active')throw Error('当前账号不是该组织的有效成员');}
  else throw Error('无法确认仓库所属用户或组织');
  if(scope!==this.currentScope())throw Error('协作身份已切换');
  const data=this.data(),existing=data.operations.find(r=>r.scope===scope&&r.account.id===account.id&&same(r.owner,target.owner)&&same(r.name,target.name));
  if(existing){if(existing.visibility!==target.visibility)throw Error('此名称已有创建记录且可见范围不同，请先核对原记录');if(existing.status==='prepared'){existing.at=new Date().toISOString();this.write(data);}return this.public(existing);}
  const record={id:randomUUID(),scope,...target,account,ownerType:owner.type,status:'prepared',at:new Date().toISOString()};
  if(await this.find(record))throw Error('仓库已存在，请使用现有仓库入口');
  if(data.operations.length>=1000)throw Error('本机创建记录已达上限，请先处理现有记录');
  data.operations.push(record);this.write(data);return this.public(record);
 });}
 create({id}){return this.exclusive(async()=>{
  const data=this.data(),record=this.get(data,id);await this.verify(record);
  if(record.status==='created')return this.public(record);
  if(record.status!=='prepared')return this.lookupRecord(data,record);
  if(Date.now()-Date.parse(record.at)>15*60*1000)throw Error('审阅已超过 15 分钟，请核对账号后重新审阅');
  const found=await this.find(record);
  if(found){record.repo=found;record.status='observed';record.message='仓库已存在；此请求尚未创建，请核实后选择本地操作';this.write(data);return this.public(record);}
  await this.verify(record);
  record.status='dispatching';record.dispatchedAt=new Date().toISOString();this.write(data);
  try{
   const value=await this.api(record.ownerType==='Organization'?`orgs/${record.owner}/repos`:'user/repos',{method:'POST',fields:['-f',`name=${record.name}`,'-F',`private=${record.visibility==='private'}`,'-F','auto_init=false']});
   record.repo=repository(value,record);record.creationConfirmed=true;record.status='created';record.message='GitHub 已确认创建';
  }catch(e){record.status='unknown';record.message='创建结果待核实；不会再次发送创建请求。'+e.message;}
  this.write(data);return this.public(record);
 });}
 async lookupRecord(data,record){
  try{const found=await this.find(record);if(found){if(record.repo&&record.repo.id!==found.id)throw Error('同名仓库已被替换，不能按原创建记录继续');record.repo=found;record.status=record.creationConfirmed?'created':'observed';record.message=record.status==='created'?'已核对原仓库':'查询发现同名仓库，不能据此确认本次创建成功；请核实后选择本地操作';}
   else{record.message='尚未查询到仓库；创建结果仍待核实，不会再次创建';record.status=record.creationConfirmed?'conflict':record.status==='prepared'?'prepared':'unknown';}
  }catch(e){record.message='查询未能确认：'+e.message;record.status=/名称或可见|已被替换/.test(e.message)?'conflict':'unknown';}
  this.write(data);return this.public(record);
 }
 lookup({id}){return this.exclusive(async()=>{const data=this.data(),record=this.get(data,id);await this.verify(record);return this.lookupRecord(data,record);});}
 async inspect(path){
  const root=await realpath(path),top=await realpath((await git(root,['rev-parse','--show-toplevel'])).trim());
  if(root!==top)throw Error('请选择 Git 仓库根目录，不是子目录');
  const gitDir=await realpath(resolve(root,(await git(root,['rev-parse','--git-dir'])).trim())),common=await realpath(resolve(root,(await git(root,['rev-parse','--git-common-dir'])).trim()));
  if(gitDir!==common)throw Error('独立工作树共享远端配置，请选择主仓库目录');
  let config='';try{config=await git(root,['config','--get-regexp','^remote\\.']);}catch(e){if(e.code!==1)throw e;}
  const remotes=(await git(root,['remote'])).trim().split('\n').filter(Boolean);
  let urls=[];if(remotes.includes('origin'))urls=(await git(root,['remote','get-url','--all','origin'])).trim().split('\n');
  let pushUrls=[];if(remotes.includes('origin'))pushUrls=(await git(root,['remote','get-url','--push','--all','origin'])).trim().split('\n');
  return {root,gitDir,config,urls,pushUrls,dirty:!!(await git(root,['status','--porcelain'])).trim(),fingerprint:createHash('sha256').update(JSON.stringify({root,gitDir,common,config})).digest('hex')};
 }
 checkOrigin(info,record){const expected=record.repo.cloneUrl;const matches=url=>url===expected||url===`git@github.com:${record.repo.fullName}.git`;if([...info.urls,...info.pushUrls].some(url=>!matches(url)))throw Error('已有不同 origin 或推送地址，请在 Git 设置中自行处理；不会覆盖');return info.urls.length>0;}
 previewBind({id,path}){return this.exclusive(async()=>{
  const data=this.data(),record=this.get(data,id);await this.verify(record);
  if(!['created','observed'].includes(record.status))throw Error('请先核实远端仓库');
  const repo=await this.find(record);if(!repo||repo.id!==record.repo.id||!repo.canPush)throw Error('仓库不存在、已改变或当前账号无写入权限');
  const info=await this.inspect(path),alreadyBound=this.checkOrigin(info,record);
  const binding={bindingId:randomUUID(),operationId:id,scope:record.scope,path:info.root,fingerprint:info.fingerprint,fullName:repo.fullName,url:repo.cloneUrl,dirty:info.dirty,alreadyBound,at:new Date().toISOString(),status:'prepared'};
  if(binding.scope!==this.currentScope())throw Error('协作身份已切换');
  data.bindings.push(binding);this.write(data);const {scope,fingerprint,...result}=binding;return result;
 });}
 bind({bindingId}){return this.exclusive(async()=>{
  const data=this.data(),binding=data.bindings.find(b=>b.bindingId===bindingId&&b.scope===this.currentScope());if(!binding)throw Error('绑定审阅不存在或身份已切换');
  const record=this.get(data,binding.operationId);await this.verify(record);
  const repo=await this.find(record);if(!repo||repo.id!==record.repo.id||!repo.canPush)throw Error('远端仓库已改变或缺少写入权限');
  return this.withRepository(binding.path,async()=>{
   const info=await this.inspect(binding.path),alreadyBound=this.checkOrigin(info,record);
   if(binding.scope!==this.currentScope())throw Error('协作身份已切换');
   if(alreadyBound){binding.status='bound';this.write(data);return {path:info.root,fullName:repo.fullName,bound:true};}
   if(binding.status!=='prepared')throw Error('上次绑定结果待核实；不会再次写入 Git 配置');
   if(info.fingerprint!==binding.fingerprint)throw Error('Git 远端配置已变化，请重新审阅');
   binding.status='dispatching';this.write(data);
   try{await git(info.root,['remote','add','origin',repo.cloneUrl]);binding.status='bound';this.write(data);return {path:info.root,fullName:repo.fullName,bound:true};}
   catch(e){binding.status='unknown';this.write(data);throw Error('绑定结果待核实，请查看 Git 远端配置；不会再次写入。'+cleanError(e));}
  });
 });}
}
