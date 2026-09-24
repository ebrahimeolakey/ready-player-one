// Self-contained update worker. Copied outside the application before replacement.
// Imports must remain Node builtins: the installed application's path may move.
import {createHash,randomBytes,timingSafeEqual,createHmac} from 'node:crypto';
import nodeFS from 'node:fs';
import {createRequire} from 'node:module';
// Electron's patched fs virtualizes app.asar metadata; digest physical bytes
// using its builtin original-fs, without toggling the global noAsar flag.
const physicalFS=process.versions.electron?createRequire(import.meta.url)('original-fs'):nodeFS;
const {createReadStream}=physicalFS;
const {lstat,realpath,readdir,readlink,readFile,rename,open}=physicalFS.promises;
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const HEALTH_PROTOCOL=1,DATA_EPOCH=1;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const absent=async p=>lstat(p).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;});
const inside=(base,path)=>{const rel=relative(base,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const mac=(secret,value)=>createHmac('sha256',secret).update(JSON.stringify(value)).digest('hex');
export async function bundleDigest(path){
 const root=await realpath(path);if(root!==resolve(path)||(await lstat(path)).isSymbolicLink())throw Error('应用路径不是固定真实目录');
 const hash=createHash('sha256');let count=0;
 async function walk(dir){for(const name of (await readdir(dir)).sort()){
  if(++count>100000)throw Error('应用文件数量超过上限');
  const file=join(dir,name),s=await lstat(file),key=relative(root,file);
  if(s.isSymbolicLink()){
   const target=await readlink(file);if(!inside(root,resolve(dirname(file),target))||!inside(root,await realpath(file)))throw Error('应用符号链接越界');
   hash.update(JSON.stringify(['link',key,target]));
  }else if(s.isDirectory()){hash.update(JSON.stringify(['dir',key,s.mode&0o777]));await walk(file);}
  else if(s.isFile()){
   hash.update(JSON.stringify(['file',key,s.mode&0o777,s.size]));for await(const bytes of createReadStream(file))hash.update(bytes);
   const after=await lstat(file);if(after.ino!==s.ino||after.size!==s.size||after.mtimeMs!==s.mtimeMs)throw Error('应用文件正在改变');
  }else throw Error('应用包含不支持的文件类型');
 }}
 await walk(root);return hash.digest('hex');
}
export async function bundleIdentity(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw Error('应用不是普通目录');return {dev:s.dev,ino:s.ino};}
const sameIdentity=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
export async function macContract(path){
 const plist=join(path,'Contents','Info.plist');
 const read=async key=>(await exec('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,plist],{timeout:10000,maxBuffer:100000})).stdout.trim();
 const [id,version,binary]=await Promise.all(['CFBundleIdentifier','CFBundleShortVersionString','CFBundleExecutable'].map(read));
 if(id!=='com.readyplayerone.desktop'||!version||!binary||binary==='.'||binary==='..'||/[\\/\0]/.test(binary))throw Error('应用身份无效');
 const [protocol,dataEpoch]=await Promise.all(['RPOUpdateHealthProtocol','RPODataCompatibilityEpoch'].map(key=>read(key).then(v=>/^\d+$/.test(v)?Number(v):null).catch(()=>null)));
 return {id,version,binary,protocol,dataEpoch};
}
export function validatePlan(plan){
 if(plan?.format!==1||!/^[-a-f0-9]{36}$/.test(plan.id)||plan.platform!=='darwin'||!hex(plan.token)||!hex(plan.oldDigest)||!hex(plan.newDigest)||!hex(plan.archiveDigest))throw Error('更新事务无效');
 for(const key of ['target','next','backup','failed','directory','dataDir'])if(typeof plan[key]!=='string'||!isAbsolute(plan[key])||resolve(plan[key])!==plan[key])throw Error('更新事务路径无效');
 const parent=dirname(plan.target);if(!plan.target.endsWith('.app')||plan.next!==join(parent,`.rpo-next-${plan.id}.app`)||plan.backup!==join(parent,`.rpo-backup-${plan.id}.app`)||plan.failed!==join(parent,`.rpo-failed-${plan.id}.app`))throw Error('更新事务范围无效');
 for(const app of [plan.target,plan.next,plan.backup,plan.failed])if(inside(app,plan.directory)||inside(plan.directory,app)||inside(app,plan.dataDir)||inside(plan.dataDir,app))throw Error('更新缓存/用户数据不能位于应用替换范围内');
 if(inside(plan.directory,plan.dataDir)||inside(plan.dataDir,plan.directory))throw Error('更新缓存和用户数据不能重叠');
 for(const identity of [plan.oldIdentity,plan.nextIdentity])if(!Number.isSafeInteger(identity?.dev)||!Number.isSafeInteger(identity?.ino)||identity.ino<1)throw Error('应用目录身份无效');
 if(!plan.relaunchEnv||Object.keys(plan.relaunchEnv).some(k=>!['RPO_IDENTITY_ISSUER','RPO_IDENTITY_PUBLIC_KEY_FILE'].includes(k)||typeof plan.relaunchEnv[k]!=='string'||plan.relaunchEnv[k].includes('\0')))throw Error('重启环境无效');
 for(const c of [plan.oldContract,plan.newContract])if(c?.id!=='com.readyplayerone.desktop'||c.protocol!==HEALTH_PROTOCOL||c.dataEpoch!==DATA_EPOCH||typeof c.version!=='string'||!c.version||typeof c.binary!=='string'||!c.binary||/[\\/\0]/.test(c.binary)||['.','..'].includes(c.binary))throw Error('缺少相同数据兼容代际的健康协议声明');
 if(!Number.isSafeInteger(plan.parentPid)||plan.parentPid<1||!Number.isInteger(plan.timeoutMs)||plan.timeoutMs<100||plan.timeoutMs>300000||!Number.isInteger(plan.stabilityMs)||plan.stabilityMs<0||plan.stabilityMs>=plan.timeoutMs)throw Error('更新等待参数无效');
 return plan;
}
async function exact(path,digest,identity){return (!identity||sameIdentity(await bundleIdentity(path),identity))&&(await bundleDigest(path))===digest;}
export async function writeJournal(plan,value){
 const path=join(plan.directory,'journal.json'),temp=join(plan.directory,`.journal-${randomBytes(8).toString('hex')}`);
 const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify({format:1,id:plan.id,target:plan.target,backup:plan.backup,failed:plan.failed,oldVersion:plan.oldContract.version,newVersion:plan.newContract.version,...value,at:new Date().toISOString()}));await f.sync();}finally{await f.close();}await rename(temp,path);
}
function defaultLaunch(plan,ticket,rollback=false){
 const env={...process.env,...plan.relaunchEnv,RPO_DATA_DIR:plan.dataDir};delete env.ELECTRON_RUN_AS_NODE;delete env.RPO_UPDATE_HEALTH_TICKET;
 if(ticket)env.RPO_UPDATE_HEALTH_TICKET=Buffer.from(JSON.stringify(ticket)).toString('base64url');
 return spawn(join(plan.target,'Contents','MacOS',(rollback?plan.oldContract:plan.newContract).binary),[],{env,detached:true,stdio:'ignore'});
}
async function spawnReady(child){await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',error=>{child.rpoSpawnFailed=true;no(error);});});return child;}
async function terminateOwnChild(child,timeout=8000){
 if(!child)return true;
 if(!Number.isSafeInteger(child.pid)||child.pid<1)return child.rpoSpawnFailed===true;
 let closed=child.exitCode!==null||child.signalCode!==null;
 const onExit=()=>{closed=true;};child.once('exit',onExit);
 const signal=kind=>{try{process.kill(-child.pid,kind);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
 try{
  signal('SIGTERM');const begin=Date.now();let forced=false;
  while(Date.now()-begin<timeout){
   let exists=true;try{process.kill(-child.pid,0);}catch(e){if(e.code==='ESRCH')exists=false;else if(e.code!=='EPERM')throw e;}
   if(closed&&!exists)return true;
   if(!forced&&Date.now()-begin>2000){forced=true;signal('SIGKILL');}
   await sleep(50);
  }
  return false;
 }finally{child.removeListener('exit',onExit);}
}
function ticketFor(plan,port){return {protocol:1,dataEpoch:DATA_EPOCH,id:plan.id,token:plan.token,url:`http://127.0.0.1:${port}`,target:plan.target,binary:plan.newContract.binary,version:plan.newContract.version,digest:plan.newDigest,dataDir:plan.dataDir,receiptPath:join(plan.directory,'journal.json'),deadline:Date.now()+plan.timeoutMs};}
async function healthServer(plan){
 let childPid=null,firstReadyAt=null,confirmed=false,accepting=true,challenge=randomBytes(32).toString('hex'),lastChallenge=null;
 const deadline=Date.now()+plan.timeoutMs,pending=new Set();
 const server=createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.headers.origin||req.headers.host!==`127.0.0.1:${server.address().port}`||!equal(req.headers.authorization,`Bearer ${plan.token}`))return send(403,{error:'更新健康确认身份无效'});
  if(req.method==='GET'&&req.url==='/challenge'){
   const value={id:plan.id,challenge,phase:firstReadyAt===null?'loaded':'stable',waitMs:firstReadyAt===null?0:Math.max(0,firstReadyAt+plan.stabilityMs-Date.now()),confirmed};
   return send(200,{...value,proof:mac(plan.token,value)});
  }
  if(req.method!=='POST'||req.url!=='/ready')return send(404,{});
  let done;const completion=new Promise(r=>{done=r;});pending.add(completion);
  try{
   if(!accepting||Date.now()>deadline)throw Error('健康确认窗口已结束');
   let data='',bytes=0;for await(const part of req){bytes+=part.length;if(bytes>8192)throw Error('确认过长');data+=part;}
   const packet=JSON.parse(data),value=packet.value;
   if(!equal(packet.proof,mac(plan.token,value))||value?.id!==plan.id||value.pid!==childPid||value.version!==plan.newContract.version||value.digest!==plan.newDigest||value.dataEpoch!==DATA_EPOCH||value.protocol!==1||value.target!==plan.target||value.execPath!==join(plan.target,'Contents','MacOS',plan.newContract.binary)||value.dataDir!==plan.dataDir||value.dataLoaded!==true||value.rendererReady!==true)throw Error('确认内容与此次更新不匹配');
   if(confirmed&&value.challenge===lastChallenge)return send(200,{status:'confirmed',attemptId:plan.id});
   if(value.challenge!==challenge)throw Error('健康挑战已过期');
   if(firstReadyAt===null){firstReadyAt=Date.now();challenge=randomBytes(32).toString('hex');return send(200,{status:'checking'});}
   if(Date.now()<firstReadyAt+plan.stabilityMs)return send(409,{error:'仍在观察启动状态'});
   if(!await exact(plan.target,plan.newDigest,plan.installedIdentity))throw Error('已安装应用内容已改变');
   if(!accepting||Date.now()>deadline)throw Error('健康确认窗口已结束');
   const receipt={id:plan.id,status:'confirmed',pid:childPid,target:plan.target,digest:plan.newDigest,version:plan.newContract.version,dataDir:plan.dataDir};
   await writeJournal(plan,{status:'confirmed',childPid,archiveDigest:plan.archiveDigest,newDigest:plan.newDigest,receipt,receiptProof:mac(plan.token,receipt)});
   lastChallenge=challenge;confirmed=true;
   send(200,{status:'confirmed',attemptId:plan.id});
  }catch{send(409,{error:'更新健康确认未通过'});}finally{pending.delete(completion);done();}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 return {ticket:ticketFor(plan,server.address().port),setPid(pid){childPid=pid;},get confirmed(){return confirmed;},close:async()=>{accepting=false;await new Promise(r=>{server.closeAllConnections();server.close(r);});await Promise.allSettled([...pending]);}};
}
export async function executeTransaction(input,{launch=defaultLaunch,waitForParent=true,stopChild=terminateOwnChild,lingerMs=3000}={}){
 const plan=validatePlan(input);
 if(await realpath(plan.directory)!==plan.directory||await realpath(plan.dataDir)!==plan.dataDir||await realpath(dirname(plan.target))!==dirname(plan.target))throw Error('更新目录已重定向');
 const lock=await open(join(plan.directory,'worker.lock'),'wx',0o600).catch(()=>{throw Error('更新事务已执行或已有工作进程；不会重复替换');});await lock.writeFile(String(process.pid));await lock.close();
 let child,server,oldMoved=false,installed=false;
 try{
  if(!await absent(join(plan.directory,'journal.json')))throw Error('更新事务已有结果，不会重复执行');
  await writeJournal(plan,{status:'waiting-for-exit'});
  if(waitForParent){
   const activationDeadline=Date.now()+30000;
   while(true){
    try{const activation=JSON.parse(await readFile(join(plan.directory,'activate.json'),'utf8'));if(activation.id!==plan.id||!equal(activation.proof,mac(plan.token,{id:plan.id,action:'install'})))throw Error('更新启动确认无效');break;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(Date.now()>activationDeadline)throw Error('原应用未确认工作进程就绪，更新已取消');await sleep(100);
   }
   const deadline=Date.now()+120000;while(true){try{process.kill(plan.parentPid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}if(Date.now()>deadline)throw Error('原应用未退出，更新已取消');await sleep(100);}
  }
  if(!await exact(plan.target,plan.oldDigest,plan.oldIdentity)||!await exact(plan.next,plan.newDigest,plan.nextIdentity))throw Error('应用路径或内容已改变，未执行替换');
  if(!await absent(plan.backup)||!await absent(plan.failed))throw Error('此次备份或失败包路径已被占用');
  await rename(plan.target,plan.backup);oldMoved=true;
  if(!await exact(plan.backup,plan.oldDigest,plan.oldIdentity))throw Error('备份内容与原应用不一致');
  await writeJournal(plan,{status:'backed-up'});
  if(!await absent(plan.target))throw Error('安装目标已被其他程序占用');
  await rename(plan.next,plan.target);installed=true;plan.installedIdentity=await bundleIdentity(plan.target);
  if(!await exact(plan.target,plan.newDigest,plan.nextIdentity))throw Error('新应用内容与准备版本不一致');
  await writeJournal(plan,{status:'starting',newDigest:plan.newDigest});
  server=await healthServer(plan);child=launch(plan,server.ticket);server.setPid(child.pid);await spawnReady(child);
  await writeJournal(plan,{status:'checking',childPid:child.pid,deadline:server.ticket.deadline,newDigest:plan.newDigest});
  while(!server.confirmed){if(child.exitCode!==null||child.signalCode!==null)throw Error('新版本在健康确认前退出');if(Date.now()>server.ticket.deadline)throw Error('新版本界面或数据未按时通过健康确认');await sleep(50);}
  // Leave the authenticated endpoint briefly available for idempotent retry of a lost final ACK.
  await sleep(lingerMs);await server.close();server=null;child.unref();return {status:'confirmed',attemptId:plan.id};
 }catch(error){
  if(server){await server.close();if(server.confirmed){child?.unref();server=null;return {status:'confirmed',attemptId:plan.id};}server=null;}
  const reason=String(error.message).slice(0,500);
  if(!oldMoved){await writeJournal(plan,{status:'cancelled',reason});return {status:'cancelled',reason};}
  let stopped=true;try{if(child)stopped=await stopChild(child);}catch{stopped=false;}
  if(!stopped){await writeJournal(plan,{status:'manual-recovery',reason:'无法确认此次新应用及其进程组退出；保留备份',detail:reason});return {status:'manual-recovery'};}
  try{
   if(!await exact(plan.backup,plan.oldDigest,plan.oldIdentity))throw Error('旧包备份已改变');
   if(installed){
    if(!await exact(plan.target,plan.newDigest,plan.installedIdentity))throw Error('目标已改变，不能覆盖后续修改');
    if(!await absent(plan.failed))throw Error('失败包保存路径已占用');
    await rename(plan.target,plan.failed);
    if(!await exact(plan.failed,plan.newDigest,plan.installedIdentity))throw Error('替换期间目标发生变化，需人工恢复');
   }
   if(!await absent(plan.target))throw Error('目标已被其他安装占用');
   await rename(plan.backup,plan.target);
   if(!await exact(plan.target,plan.oldDigest,plan.oldIdentity))throw Error('旧包恢复验证失败');
   await writeJournal(plan,{status:'rolled-back',reason});
   const previous=launch(plan,null,true);await spawnReady(previous);previous.unref();
   return {status:'rolled-back',attemptId:plan.id,reason};
  }catch(rollbackError){await writeJournal(plan,{status:'manual-recovery',reason:rollbackError.message,detail:reason});return {status:'manual-recovery'};}
 }finally{if(server)await server.close();}
}
// The plan digest is supplied separately at launch; a changed/tampered file never runs.
export async function workerMain(path,expectedDigest){
 const bytes=await readFile(path);if(!hex(expectedDigest)||createHash('sha256').update(bytes).digest('hex')!==expectedDigest)throw Error('更新计划已改变');
 const plan=JSON.parse(bytes);if(resolve(path)!==join(plan.directory,'plan.json'))throw Error('更新计划路径不匹配');
 return executeTransaction(plan);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))workerMain(process.argv[2],process.argv[3]).then(result=>{process.exitCode=['confirmed','rolled-back'].includes(result.status)?0:1;}).catch(()=>{process.exitCode=1;});
