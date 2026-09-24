import {createHmac,timingSafeEqual} from 'node:crypto';
import {realpath,readFile} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {bundleDigest} from './update-health-worker.mjs';
const mac=(token,value)=>createHmac('sha256',token).update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function takeUpdateHealthTicket(env=process.env){
 const encoded=env.RPO_UPDATE_HEALTH_TICKET;delete env.RPO_UPDATE_HEALTH_TICKET;
 if(!encoded)return null;
 try{
  if(typeof encoded!=='string'||encoded.length>16000)throw Error();
  const t=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')),url=new URL(t.url);
  if(t.protocol!==1||t.dataEpoch!==1||!/^[-a-f0-9]{36}$/.test(t.id)||!/^[a-f0-9]{64}$/.test(t.token)||!/^[a-f0-9]{64}$/.test(t.digest)||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!Number.isSafeInteger(t.deadline)||t.deadline<Date.now()||t.deadline>Date.now()+300000)throw Error();
  if(!isAbsolute(t.target)||resolve(t.target)!==t.target||!t.target.endsWith('.app')||!isAbsolute(t.dataDir)||resolve(t.dataDir)!==t.dataDir||typeof t.receiptPath!=='string'||!isAbsolute(t.receiptPath)||resolve(t.receiptPath)!==t.receiptPath||!t.receiptPath.endsWith('/journal.json')||typeof t.version!=='string'||typeof t.binary!=='string'||/[\\/\0]/.test(t.binary)||['.','..',''].includes(t.binary))throw Error();
  return Object.freeze(t);
 }catch{throw Error('更新健康确认凭据无效或已过期，请检查更新备份');}
}
export async function confirmUpdateHealth({ticket,version,execPath,dataDir,verifyReady,onState=()=>{}}){
 if(!ticket)return {status:'not-required'};
 onState({status:'checking'});
 try{
  if(version!==ticket.version||await realpath(execPath)!==join(ticket.target,'Contents','MacOS',ticket.binary)||await realpath(dataDir)!==ticket.dataDir||await bundleDigest(ticket.target)!==ticket.digest)throw Error('启动版本、目录或应用内容与更新不一致');
  let digest= ticket.digest;
  while(Date.now()<ticket.deadline){
   if(await verifyReady()!==true){await wait(250);continue;}
   // A signed durable receipt also handles a lost final acknowledgement after
   // the worker has already exited. It never substitutes for this app's ready check.
   try{const {receipt,receiptProof}=JSON.parse(await readFile(ticket.receiptPath,'utf8'));const expected={id:ticket.id,status:'confirmed',pid:process.pid,target:ticket.target,digest:ticket.digest,version:ticket.version,dataDir:ticket.dataDir};if(JSON.stringify(receipt)===JSON.stringify(expected)&&same(receiptProof,mac(ticket.token,receipt))){onState({status:'confirmed'});return {status:'confirmed',attemptId:ticket.id};}}catch{}
   const timeout=Math.min(5000,ticket.deadline-Date.now());if(timeout<=0)break;
   try{
    const response=await fetch(ticket.url+'/challenge',{headers:{Authorization:`Bearer ${ticket.token}`},signal:AbortSignal.timeout(timeout)});
    if(!response.ok)throw Error('更新检查进程拒绝确认');
    const packet=await response.json(),{proof,...challenge}=packet;
    if(challenge.id!==ticket.id||!same(proof,mac(ticket.token,challenge))||!/^[a-f0-9]{64}$/.test(challenge.challenge)||!['loaded','stable'].includes(challenge.phase)||!Number.isInteger(challenge.waitMs)||challenge.waitMs<0||challenge.waitMs>300000)throw Error('更新检查进程身份无效');
    if(challenge.confirmed){onState({status:'confirmed'});return {status:'confirmed',attemptId:ticket.id};}
    if(challenge.waitMs){await wait(Math.min(challenge.waitMs,500));continue;}
    // This callback must check decrypted local data + the mounted, responsive
    // main-frame UI, not merely process/window existence. It is checked twice.
    if(await verifyReady()!==true){await wait(250);continue;}
    const value={id:ticket.id,challenge:challenge.challenge,pid:process.pid,version,digest,protocol:1,dataEpoch:1,target:ticket.target,execPath:await realpath(execPath),dataDir:await realpath(dataDir),dataLoaded:true,rendererReady:true};
    const ack=await fetch(ticket.url+'/ready',{method:'POST',headers:{Authorization:`Bearer ${ticket.token}`,'Content-Type':'application/json'},body:JSON.stringify({value,proof:mac(ticket.token,value)}),signal:AbortSignal.timeout(Math.min(5000,Math.max(1,ticket.deadline-Date.now())))});
    if(ack.ok){const result=await ack.json();if(result.status==='confirmed'&&result.attemptId===ticket.id){onState({status:'confirmed'});return result;}}
   }catch(error){
    if(/身份无效|拒绝确认/.test(error.message))throw error;
    // Connection loss may be a worker-triggered rollback. Keep the input gate
    // closed; never treat a network failure as permission to start new work.
   }
   await wait(250);
  }
  throw Error('更新未通过界面和数据健康确认；正在恢复旧版或需要检查更新备份');
 }catch(error){onState({status:'error',message:error.message});throw error;}
}
