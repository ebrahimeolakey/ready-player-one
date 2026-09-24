import nodeTest from 'node:test';
const test=(name,...args)=>{const options=typeof args[0]==='object'?args.shift():{};return nodeTest(name,{...options,skip:options.skip||process.platform==='win32'},...args);};
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHmac,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {bundleDigest,bundleIdentity,executeTransaction,validatePlan,macContract,workerMain} from '../desktop/services/update-health-worker.mjs';
import {takeUpdateHealthTicket,confirmUpdateHealth} from '../desktop/services/update-health-client.mjs';
import {supportsAutomaticRollback,UpdateService} from '../desktop/services/updater.mjs';
import {SecureStore} from '../core/secure-store.mjs';
const clientURL=new URL('../desktop/services/update-health-client.mjs',import.meta.url).href;
const contract=version=>({id:'com.readyplayerone.desktop',version,binary:'头号 玩家',protocol:1,dataEpoch:1});
async function fixture(t){
 const base=await realpath(await mkdtemp(join(tmpdir(),'rpo-health-test-'))),id=randomUUID();
 const plan={format:1,id,platform:'darwin',token:randomBytes(32).toString('hex'),archiveDigest:'a'.repeat(64),
 target:join(base,'头号玩家 with spaces.app'),next:join(base,`.rpo-next-${id}.app`),backup:join(base,`.rpo-backup-${id}.app`),failed:join(base,`.rpo-failed-${id}.app`),
 directory:join(base,'private cache'),dataDir:join(base,'用户 data'),oldContract:contract('1.0.0'),newContract:contract('1.0.1'),relaunchEnv:{},parentPid:process.pid,timeoutMs:1400,stabilityMs:70};
 await mkdir(plan.directory);await mkdir(plan.dataDir);await writeFile(join(plan.dataDir,'project'),'never modify');
 for(const [path,contents] of [[plan.target,'old'],[plan.next,'new']]){await mkdir(join(path,'Contents','MacOS'),{recursive:true});await writeFile(join(path,'Contents','MacOS','头号 玩家'),contents);}
 plan.oldDigest=await bundleDigest(plan.target);plan.newDigest=await bundleDigest(plan.next);plan.oldIdentity=await bundleIdentity(plan.target);plan.nextIdentity=await bundleIdentity(plan.next);
 const children=[];
 t.after(async()=>{for(const c of children){if(c.exitCode===null&&c.signalCode===null&&c.pid){c.kill('SIGKILL');await once(c,'exit').catch(()=>{});}}await rm(base,{recursive:true,force:true});});
 const launch=(mode='healthy',hook)=> (p,ticket,rollback)=>{
  let code=rollback?'setTimeout(()=>{},100000)':`import {takeUpdateHealthTicket,confirmUpdateHealth} from ${JSON.stringify(clientURL)};
import {writeFile} from 'node:fs/promises';import {createHmac} from 'node:crypto';
const ticket=takeUpdateHealthTicket();
setInterval(()=>{},1000);
${mode==='exit'?'process.exit(9);':mode==='idle'?'':mode==='forged'?`const ch=await (await fetch(ticket.url+'/challenge',{headers:{Authorization:'Bearer '+ticket.token}})).json();
const value={id:ticket.id,challenge:ch.challenge,pid:process.pid+1,version:ticket.version,digest:ticket.digest,dataEpoch:1,protocol:1,target:ticket.target,execPath:ticket.target+'/Contents/MacOS/'+ticket.binary,dataDir:ticket.dataDir,dataLoaded:true,rendererReady:true};
const proof=createHmac('sha256',ticket.token).update(JSON.stringify(value)).digest('hex');
const r=await fetch(ticket.url+'/ready',{method:'POST',headers:{Authorization:'Bearer '+ticket.token},body:JSON.stringify({value,proof})});await writeFile(${JSON.stringify(join(base,'forged-status'))},String(r.status));`: `const result=await confirmUpdateHealth({ticket,version:ticket.version,execPath:ticket.target+'/Contents/MacOS/'+ticket.binary,dataDir:ticket.dataDir,verifyReady:async()=>${mode==='not-ready'?'false':'true'}}).catch(e=>({error:e.message}));await writeFile(${JSON.stringify(join(base,'client-result'))},JSON.stringify(result));`}`;
  const c=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,RPO_UPDATE_HEALTH_TICKET:ticket?Buffer.from(JSON.stringify(ticket)).toString('base64url'):''},detached:true,stdio:'ignore'});children.push(c);hook?.(p,c,rollback);return c;
 };
 return {base,plan,launch,children};
}
const options=launch=>({launch,waitForParent:false,lingerMs:0});
test('healthy authenticated two-phase app confirmation preserves backup and never touches user data',async t=>{
 const f=await fixture(t),began=Date.now();const result=await executeTransaction(f.plan,options(f.launch()));
 assert.equal(result.status,'confirmed');assert.ok(Date.now()-began>=f.plan.stabilityMs);
 assert.equal(await bundleDigest(f.plan.target),f.plan.newDigest);assert.equal(await bundleDigest(f.plan.backup),f.plan.oldDigest);
 assert.equal(await readFile(join(f.plan.dataDir,'project'),'utf8'),'never modify');
 const journal=JSON.parse(await readFile(join(f.plan.directory,'journal.json')));assert.equal(journal.status,'confirmed');assert.equal(journal.receiptProof,createHmac('sha256',f.plan.token).update(JSON.stringify(journal.receipt)).digest('hex'));
 const before=await readFile(join(f.plan.directory,'journal.json'),'utf8');await assert.rejects(()=>executeTransaction(f.plan,options(f.launch())),/已执行/);assert.equal(await readFile(join(f.plan.directory,'journal.json'),'utf8'),before);
});
for(const mode of ['idle','not-ready','exit','forged'])test(`${mode} child is not healthy; restore exact old bundle only after own process exits`,async t=>{
 const f=await fixture(t);const result=await executeTransaction(f.plan,options(f.launch(mode)));
 assert.equal(result.status,'rolled-back');assert.equal(await bundleDigest(f.plan.target),f.plan.oldDigest);assert.equal(await bundleDigest(f.plan.failed),f.plan.newDigest);
 assert.ok(f.children[0].exitCode!==null||f.children[0].signalCode!==null);assert.equal(await readFile(join(f.plan.dataDir,'project'),'utf8'),'never modify');
 if(mode==='forged')assert.equal(await readFile(join(f.base,'forged-status'),'utf8'),'409');
});
test('changed new app is never overwritten by rollback; old backup retained for manual recovery',async t=>{
 const f=await fixture(t);let mutation;
 const result=await executeTransaction(f.plan,options(f.launch('idle',(p,c,rollback)=>{if(!rollback)mutation=writeFile(join(p.target,'later-user-modification'),'preserve');})));
 await mutation;assert.equal(result.status,'manual-recovery');assert.equal(await readFile(join(f.plan.target,'later-user-modification'),'utf8'),'preserve');assert.equal(await bundleDigest(f.plan.backup),f.plan.oldDigest);
});
test('changed backup and unconfirmed process termination both prevent rollback writes',async t=>{
 for(const kind of ['backup','termination']){
  const f=await fixture(t);let mutation;
  const opts=options(f.launch('idle',(p,c,rollback)=>{if(!rollback&&kind==='backup')mutation=writeFile(join(p.backup,'changed'),'preserve');}));
  if(kind==='termination')opts.stopChild=async()=>false;
  const result=await executeTransaction(f.plan,opts);await mutation;assert.equal(result.status,'manual-recovery');assert.equal(await bundleDigest(f.plan.target),f.plan.newDigest);
  if(kind==='backup')assert.equal(await readFile(join(f.plan.backup,'changed'),'utf8'),'preserve');
 }
});
test('preflight content changes cancel before moving either bundle',async t=>{
 const f=await fixture(t);await writeFile(join(f.plan.target,'later-change'),'keep');let launches=0;
 const result=await executeTransaction(f.plan,{...options(()=>{launches++;}),waitForParent:false});
 assert.equal(result.status,'cancelled');assert.equal(launches,0);assert.equal(await readFile(join(f.plan.target,'later-change'),'utf8'),'keep');assert.equal(await bundleDigest(f.plan.next),f.plan.newDigest);
});
test('precise transaction paths, identities, allowed relaunch environment and epoch are mandatory',async t=>{
 const {plan}=await fixture(t);
 for(const patch of [{backup:plan.target},{dataDir:plan.next},{directory:plan.target},{oldIdentity:null},{relaunchEnv:{NODE_OPTIONS:'--inspect'}},{oldContract:{...plan.oldContract,dataEpoch:2}}])assert.throws(()=>validatePlan({...plan,...patch}));
 assert.equal(supportsAutomaticRollback(plan.oldContract,plan.newContract),true);assert.equal(supportsAutomaticRollback({...plan.oldContract,protocol:null},plan.newContract),false);assert.equal(supportsAutomaticRollback(plan.oldContract,{...plan.newContract,dataEpoch:2}),false);
});
test('bundle digest refuses external symlinks and worker rejects changed plan before any replacement',async t=>{
 const f=await fixture(t);await symlink(f.plan.dataDir,join(f.plan.next,'outside'));await assert.rejects(()=>bundleDigest(f.plan.next),/越界/);
 const path=join(f.plan.directory,'plan.json');await writeFile(path,JSON.stringify(f.plan));await assert.rejects(()=>workerMain(path,'0'.repeat(64)),/已改变/);assert.equal(await bundleDigest(f.plan.target),f.plan.oldDigest);
});
test('ticket is consumed even when malformed; signed durable receipt handles lost final acknowledgement',async t=>{
 const env={RPO_UPDATE_HEALTH_TICKET:'not a ticket'};assert.throws(()=>takeUpdateHealthTicket(env),/凭据无效/);assert.equal(env.RPO_UPDATE_HEALTH_TICKET,undefined);
 const f=await fixture(t);await rename(f.plan.target,f.plan.backup);await rename(f.plan.next,f.plan.target);
 const ticket={protocol:1,dataEpoch:1,id:f.plan.id,token:f.plan.token,url:'http://127.0.0.1:1',target:f.plan.target,binary:f.plan.newContract.binary,version:f.plan.newContract.version,digest:f.plan.newDigest,dataDir:f.plan.dataDir,receiptPath:join(f.plan.directory,'journal.json'),deadline:Date.now()+1000};
 const receipt={id:ticket.id,status:'confirmed',pid:process.pid,target:ticket.target,digest:ticket.digest,version:ticket.version,dataDir:ticket.dataDir};
 await writeFile(ticket.receiptPath,JSON.stringify({receipt,receiptProof:createHmac('sha256',ticket.token).update(JSON.stringify(receipt)).digest('hex')}));
 const good={RPO_UPDATE_HEALTH_TICKET:Buffer.from(JSON.stringify(ticket)).toString('base64url')};assert.equal(takeUpdateHealthTicket(good).id,ticket.id);assert.equal(good.RPO_UPDATE_HEALTH_TICKET,undefined);
 const result=await confirmUpdateHealth({ticket,version:ticket.version,execPath:join(ticket.target,'Contents','MacOS',ticket.binary),dataDir:ticket.dataDir,verifyReady:async()=>true});assert.equal(result.status,'confirmed');
});
test('current epoch storage instances preserve encrypted JSON/JSONL and additive fields (not a historical schema migration test)',async t=>{
 const f=await fixture(t),key=randomBytes(32);const readerA=new SecureStore({dir:f.plan.dataDir,key}),readerB=new SecureStore({dir:f.plan.dataDir,key});
 const state={schema:1,sessions:[{id:'synthetic',lanes:[]}],futureOptional:{enabled:true}};readerA.writeJSON('hub.json',state);
 assert.deepEqual(readerB.readJSON('hub.json'),state);readerB.writeJSON('hub.json',{...readerB.readJSON('hub.json'),newOptional:'kept'});assert.equal(readerA.readJSON('hub.json').newOptional,'kept');
 readerA.writeJSONL('transcripts/test.jsonl',[{role:'user',text:'中文保留'}]);readerB.appendJSONL('transcripts/test.jsonl',{role:'assistant',text:'new'});assert.equal(readerA.readJSONL('transcripts/test.jsonl').length,2);
 readerA.destroy();readerB.destroy();
});
test('actual macOS bundle declarations are read; missing health epoch is never inferred',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t);const plist=join(f.plan.target,'Contents','Info.plist');
 const xml=extras=>`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.readyplayerone.desktop</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleExecutable</key><string>头号 玩家</string>${extras}</dict></plist>`;
 await writeFile(plist,xml(''));assert.equal((await macContract(f.plan.target)).dataEpoch,null);
 await writeFile(plist,xml('<key>RPOUpdateHealthProtocol</key><integer>1</integer><key>RPODataCompatibilityEpoch</key><integer>1</integer>'));assert.deepEqual(await macContract(f.plan.target),f.plan.oldContract);
});
test('incompatible Mac installation requires a separate explicit user action and retains staging',async t=>{
 const f=await fixture(t),archive=join(f.plan.directory,'verified.zip');await writeFile(archive,'synthetic archive');let launches=0,quits=0,prepares=0;
 const service=new UpdateService({version:'1.0.0',platform:'darwin',dataDir:f.plan.dataDir,isPackaged:true,cacheDir:f.plan.directory,quit:()=>quits++});
 service.prepared={path:archive,directory:f.plan.directory,selection:{sha256:createHash('sha256').update('synthetic archive').digest('hex')}};
 service.prepareMac=async()=>{prepares++;return {...f.plan,oldContract:{...f.plan.oldContract,protocol:null},method:'mac-replace'};};service.launch=async()=>{launches++;};
 const first=await service.install();assert.equal(first.healthMode,'manual');assert.equal(first.status,'ready');assert.equal(launches,0);assert.equal(quits,0);
 await service.install({withoutAutomaticRollback:true});assert.equal(launches,1);assert.equal(quits,1);assert.equal(prepares,1);
});
test('failed OS spawn has no child to signal and restores the verified old app',async t=>{
 const f=await fixture(t),previous=f.launch('idle');const result=await executeTransaction(f.plan,options((plan,ticket,rollback)=>rollback?previous(plan,ticket,true):spawn(join(f.base,'nonexistent-program'),[],{detached:true,stdio:'ignore'})));
 assert.equal(result.status,'rolled-back');assert.equal(await bundleDigest(f.plan.target),f.plan.oldDigest);
});
test('forged receipt never bypasses app readiness or authentication',async t=>{
 const f=await fixture(t),ticket={protocol:1,dataEpoch:1,id:f.plan.id,token:f.plan.token,url:'http://127.0.0.1:1',target:f.plan.target,binary:f.plan.oldContract.binary,version:f.plan.oldContract.version,digest:f.plan.oldDigest,dataDir:f.plan.dataDir,receiptPath:join(f.plan.directory,'journal.json'),deadline:Date.now()+120};
 const receipt={id:ticket.id,status:'confirmed',pid:process.pid,target:ticket.target,digest:ticket.digest,version:ticket.version,dataDir:ticket.dataDir};await writeFile(ticket.receiptPath,JSON.stringify({receipt,receiptProof:'0'.repeat(64)}));
 await assert.rejects(()=>confirmUpdateHealth({ticket,version:ticket.version,execPath:join(ticket.target,'Contents','MacOS',ticket.binary),dataDir:ticket.dataDir,verifyReady:async()=>true}),/未通过/);
});
