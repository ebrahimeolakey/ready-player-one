// Node drives isolated Electron instances; Electron imports the actual desktop entry.
// Does not execute the installer, replace an app bundle, or contact a model provider.
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync,createReadStream} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bundleDigest} from '../desktop/services/update-health-worker.mjs';
const script=fileURLToPath(import.meta.url),repo=resolve(dirname(script),'..');
const mac=(token,value)=>createHmac('sha256',token).update(JSON.stringify(value)).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,timeout=30000){const end=Date.now()+timeout;while(!await predicate()){if(Date.now()>end)throw Error('Desktop smoke condition timed out');await sleep(50);}}

async function electronProbe(){
 const {app,BrowserWindow,dialog}=await import('electron');
 const evidenceDir=process.env.RPO_UPDATE_SMOKE_DIR,mode=process.env.RPO_UPDATE_SMOKE_MODE;
 assert(evidenceDir&&['confirm','reject'].includes(mode));
 const expected=JSON.parse(await readFile(join(evidenceDir,'expected.json'),'utf8'));
 const evidence={mode,checks:[],platform:process.platform,arch:process.arch,pid:process.pid,startedAt:new Date().toISOString()};
 const save=()=>writeFileSync(join(evidenceDir,'desktop.json'),JSON.stringify(evidence,null,2));
 let failed=false;
 const fail=error=>{if(failed)return;failed=true;evidence.error=error.stack||String(error);save();console.error(error);app.exit(1);};
 dialog.showErrorBox=(title,message)=>fail(Error(`${title}: ${message}`));
 process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
 const watchdog=setTimeout(()=>fail(Error('Electron health gate smoke timed out')),60000);
 try{
  assert.equal(app.getVersion(),expected.version,'Temporary launcher package must expose repository app version');
  assert(process.env.RPO_UPDATE_HEALTH_TICKET,'Ticket must exist before actual main import');
  const encodedTicket=process.env.RPO_UPDATE_HEALTH_TICKET,healthToken=JSON.parse(Buffer.from(encodedTicket,'base64url').toString('utf8')).token;
  await import('../desktop/main.mjs');
  assert.equal(Object.values(process.env).some(value=>value?.includes(healthToken)||value?.includes(encodedTicket)),false,'Health token and encoded ticket must not remain in any process.env value');
  assert.equal(Object.hasOwn(process.env,'RPO_UPDATE_HEALTH_TICKET'),false,'Actual main consumes ticket before creating any runtime');
  evidence.checks.push('health ticket consumed from process.env by actual main');
  await app.whenReady();
  assert.equal(await realpath(app.getPath('userData')),join(expected.dataDir,'electron'));
  let win;
  await until(async()=>{win=BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('头号玩家'));return !!win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector("[data-update-verification]") && !!document.documentElement.dataset.rpoUpdateBootstrap').catch(()=>false);});
  const invoke=(method,args={})=>win.webContents.executeJavaScript(`window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);
  const dom=()=>win.webContents.executeJavaScript('({text:document.body.innerText,marker:document.documentElement.dataset.rpoUpdateBootstrap||null,gate:!!document.querySelector("[data-update-verification]"),app:!!document.querySelector(".app-shell"),node:typeof process,bridge:typeof window.rpo})');
  const initial=await invoke('bootstrap'),checking=await dom();
  assert.equal(initial.local.updateVerification.status,'checking');assert.equal(initial.local.appVersion,expected.version);assert.equal(checking.marker,initial.local.updateVerification.bootstrapMarker);assert.equal(checking.node,'undefined');assert.equal(checking.bridge,'object');assert.match(checking.text,/正在验证更新/);assert.equal(checking.app,false);
  evidence.version=initial.local.appVersion;evidence.checking={...checking,marker:checking.marker?'matched-main-nonce':null};evidence.originalName=initial.local.name;
  await assert.rejects(invoke('updates.rendererReady',{marker:randomUUID()}),/更新界面确认无效/);
  const gateChecks=async()=>{const result=[];for(const [method,args] of [['settings.name',{name:'SHOULD-NOT-BE-WRITTEN'}],['terminal.open',{}],['updates.install',{}]]){let message;try{await invoke(method,args);}catch(e){message=e.message;}assert(message&&/验证更新|更新检查|拒绝确认|未通过/.test(message),`${method} must fail at update gate, got ${message}`);result.push({method,rejected:true,message});}assert.equal((await invoke('bootstrap')).local.name,initial.local.name);return result;};
  evidence.blockedBefore=await gateChecks();
  const encryptedBefore=await readFile(join(expected.dataDir,'client.json.enc'));evidence.checks.push('actual React checking view mounted, nonce matches main, wrong nonce refused');evidence.checks.push('settings.name / terminal.open / updates.install all rejected before confirmation; name unchanged');
  await writeFile(join(evidenceDir,'checking.png'),(await win.webContents.capturePage()).toPNG());
  // Release stable phase only after actual UI/IPC assertions have completed.
  await writeFile(join(evidenceDir,'gate-ready.json'),JSON.stringify({pid:process.pid,gateVerified:true}));
  await until(async()=>['confirmed','error'].includes((await invoke('bootstrap')).local.updateVerification.status),30000);
  const finalState=await invoke('bootstrap');evidence.healthState=finalState.local.updateVerification;
  if(evidence.healthState.message==='应用文件正在改变'){
   const anomalies=[];async function inspect(path){for(const name of await readdir(path)){const file=join(path,name),before=await lstat(file);if(before.isDirectory())await inspect(file);else if(before.isFile()){for await(const _ of createReadStream(file)){}const after=await lstat(file);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)anomalies.push({file,before:{ino:String(before.ino),size:String(before.size),mtimeMs:String(before.mtimeMs)},after:{ino:String(after.ino),size:String(after.size),mtimeMs:String(after.mtimeMs)}});}}}await inspect(expected.target);evidence.bundleDiagnostics=anomalies;
  }save();
  if(mode==='confirm'){
   assert.equal(finalState.local.updateVerification.status,'confirmed');await until(async()=>{const value=await dom();return value.app&&!value.gate;});
   await invoke('settings.name',{name:'Update smoke confirmed'});await until(async()=>(await invoke('bootstrap')).local.name==='Update smoke confirmed');
   evidence.final=await dom();evidence.checks.push('two authenticated phases unlock actual app shell and settings.name mutation');
  }else{
   assert.equal(finalState.local.updateVerification.status,'error');await until(async()=>/更新未通过检查/.test((await dom()).text));
   evidence.blockedAfter=await gateChecks();assert.deepEqual(await readFile(join(expected.dataDir,'client.json.enc')),encryptedBefore,'Rejected health state must not write settings');
   evidence.final=await dom();assert.equal(evidence.final.gate,true);assert.equal(evidence.final.app,false);evidence.checks.push('server rejection retains error UI and all IPC gates; encrypted settings unchanged');
  }
  assert.equal(Object.hasOwn(process.env,'RPO_UPDATE_HEALTH_TICKET'),false);evidence.final.marker=evidence.final.marker?'main-nonce-present':null;
  await writeFile(join(evidenceDir,'final.png'),(await win.webContents.capturePage()).toPNG());
  evidence.completedAt=new Date().toISOString();save();
  app.once('will-quit',()=>{clearTimeout(watchdog);console.log('UPDATE_HEALTH_DESKTOP_SMOKE_OK '+mode);});app.quit();
 }catch(error){clearTimeout(watchdog);fail(error);}
}

async function scenario(base,mode,target,digest,version){
 const directory=join(base,mode),dataDir=join(directory,'isolated 中文 data'),launchDir=join(directory,'launcher');await mkdir(join(dataDir,'bin'),{recursive:true});await mkdir(launchDir,{recursive:true});
 // Account refresh in actual main only encounters failing synthetic status binaries.
 // No real Codex/Claude/gh executable or real account network request is launched.
 for(const name of ['codex','claude','gh','cloudflared'])await writeFile(join(dataDir,'bin',name),'#!/bin/sh\nexit 1\n',{mode:0o700});
 const token=randomBytes(32).toString('hex'),id=randomUUID(),receiptPath=join(directory,'journal.json'),binary='Electron';
 let challenge=randomBytes(32).toString('hex'),phase='loaded',child,confirmed=false,stableAfter=0;
 const protocol={mode,ready:[],challenges:0,rejections:0,errors:[]};
 const server=createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   assert.equal(req.headers.host,`127.0.0.1:${server.address().port}`);assert.equal(req.headers.authorization,`Bearer ${token}`);assert.equal(req.headers.origin,undefined);
   const released=existsSync(join(directory,'gate-ready.json'));
   if(req.method==='GET'&&req.url==='/challenge'){
    protocol.challenges++;
    if(mode==='reject'&&phase==='stable'&&released){protocol.rejections++;return reply(403,{error:'synthetic authenticated worker refusal'});}
    const value={id,challenge,phase,waitMs:phase==='stable'?Math.max(released?0:200,stableAfter-Date.now()):0,confirmed};return reply(200,{...value,proof:mac(token,value)});
   }
   assert.equal(req.method,'POST');assert.equal(req.url,'/ready');let text='';for await(const chunk of req){text+=chunk;assert(text.length<8192);}
   const packet=JSON.parse(text),value=packet.value;assert.equal(packet.proof,mac(token,value));assert.equal(value.id,id);assert.equal(value.challenge,challenge);assert.equal(value.pid,child.pid);assert.equal(value.version,version);assert.equal(value.digest,digest);assert.equal(value.protocol,1);assert.equal(value.dataEpoch,1);assert.equal(value.target,target);assert.equal(value.execPath,join(target,'Contents','MacOS',binary));assert.equal(value.dataDir,dataDir);assert.equal(value.dataLoaded,true);assert.equal(value.rendererReady,true);
   protocol.ready.push({phase,pid:value.pid,version:value.version,digest:value.digest,dataLoaded:true,rendererReady:true,at:new Date().toISOString()});
   if(phase==='loaded'){phase='stable';stableAfter=Date.now()+500;challenge=randomBytes(32).toString('hex');return reply(200,{status:'checking'});}
   assert(released,'Cannot confirm before Electron gate assertions');assert.equal(mode,'confirm');
   const receipt={id,status:'confirmed',pid:child.pid,target,digest,version,dataDir};await writeFile(receiptPath,JSON.stringify({receipt,receiptProof:mac(token,receipt)}),{mode:0o600});confirmed=true;return reply(200,{status:'confirmed',attemptId:id});
  }catch(e){protocol.errors.push(e.message.split(token).join('[health-token-redacted]'));reply(409,{error:'synthetic worker check failed'});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const ticket={protocol:1,dataEpoch:1,id,token,url:`http://127.0.0.1:${server.address().port}`,target,binary,version,digest,dataDir,receiptPath,deadline:Date.now()+55000};
 await writeFile(join(directory,'expected.json'),JSON.stringify({version,target,digest,dataDir}));
 await writeFile(join(launchDir,'package.json'),JSON.stringify({name:'rpo-update-health-isolated-smoke',version,type:'module',main:'entry.mjs'}));
 await writeFile(join(launchDir,'entry.mjs'),`import ${JSON.stringify(pathToFileURL(script).href)};\n`);
 const env={...process.env,RPO_DATA_DIR:dataDir,RPO_UPDATE_SMOKE_DIR:directory,RPO_UPDATE_SMOKE_MODE:mode,RPO_UPDATE_HEALTH_TICKET:Buffer.from(JSON.stringify(ticket)).toString('base64url')};
 for(const key of ['ELECTRON_RUN_AS_NODE','RPO_IDENTITY_ISSUER','RPO_IDENTITY_PUBLIC_KEY_FILE','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])delete env[key];
 let output='';child=spawn(join(target,'Contents','MacOS',binary),[launchDir],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const timer=setTimeout(()=>child.kill('SIGTERM'),70000);
 try{
  const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});clearTimeout(timer);
  assert.equal(code,0,`Electron ${mode} exit ${code}: ${output.slice(-3000)}`);assert(output.includes(`UPDATE_HEALTH_DESKTOP_SMOKE_OK ${mode}`));
  assert.equal(protocol.errors.length,0);assert.equal(protocol.ready.length,mode==='confirm'?2:1);assert.equal(confirmed,mode==='confirm');
  if(mode==='reject')assert(protocol.rejections>0);
  const desktop=JSON.parse(await readFile(join(directory,'desktop.json'),'utf8'));assert(!desktop.error);
  return {mode,status:'passed',directory,checks:desktop.checks,authenticatedReadyPhases:protocol.ready.length};
 }finally{
  clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));
  // Never write the ticket/token or Authorization headers to the evidence log.
  await writeFile(join(directory,'electron.log'),output.split(token).join('[health-token-redacted]'));
  await writeFile(join(directory,'protocol.json'),JSON.stringify(protocol,null,2));
 }
}
async function driver(){
 assert.equal(process.platform,'darwin','This bounded smoke currently validates the macOS health path');
 const target=await realpath(join(repo,'node_modules/electron/dist/Electron.app')),version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version;
 assert(existsSync(join(repo,'dist/index.html')),'Run npm run build first');
 const base=await realpath(await mkdtemp(join(tmpdir(),'rpo-update-health-desktop-'))),digest=await bundleDigest(target);
 const evidence={version,target,digest,startedAt:new Date().toISOString(),scenarios:[],modelCalls:0,installedApplicationsModified:false};
 try{for(const mode of ['confirm','reject'])evidence.scenarios.push(await scenario(base,mode,target,digest,version));assert.equal(await bundleDigest(target),digest,'Electron bundle must remain unchanged');evidence.status='passed';}
 catch(error){evidence.status='failed';evidence.error=error.stack||String(error);process.exitCode=1;}
 evidence.completedAt=new Date().toISOString();await writeFile(join(base,'summary.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:join(base,'summary.json'),...evidence},null,2));
}
// Electron readiness waits for ESM entry evaluation; do not top-level await the probe.
if(process.versions.electron)void electronProbe();else await driver();
