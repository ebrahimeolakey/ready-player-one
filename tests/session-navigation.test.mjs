import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SessionNavigation} from '../desktop/services/session-navigation.mjs';
import {SecureStore} from '../core/secure-store.mjs';
import {Hub} from './helpers/secure-hub.mjs';
import {HubClient} from '../core/client.mjs';
const wait=async(fn,timeout=3000)=>{const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('snapshot timeout');await new Promise(r=>setTimeout(r,10));}};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-session-navigation-'));const store=new SecureStore({dir:join(dir,'client'),key:randomBytes(32)}),hub=new Hub(join(dir,'hub'));await hub.listen();const clients=[];
 const connect=async(token=hub.db.hostToken,secret=randomBytes(32).toString('hex'))=>{const c=new HubClient();clients.push(c);await c.connect(`ws://127.0.0.1:${hub.port}`,{token,secret,name:'Fixture'});return c;};
 let current=await connect(),online=true,config={},fail=false;
 const nav=new SessionNavigation({client:()=>current,online:()=>online,config,saveConfig:()=>{if(fail)throw Error('disk failure');store.writeJSON('client.json',config);}});
 const w=await current.call('workspace.create',{name:'fixture'}),s=await current.call('session.create',{workspaceId:w.id,title:'active'});await wait(()=>current.state.sessions.some(x=>x.id===s.id));
 t.after(async()=>{clients.forEach(c=>c.close());await hub.close();store.destroy();await rm(dir,{recursive:true,force:true});});
 return {dir,store,hub,connect,nav,config,w,s,owner:current,set current(c){current=c;},set online(v){online=v;},set fail(v){fail=v;}};
}
test('remembered UI location is encrypted, survives restart and never executes provider or hub mutations',async t=>{
 const f=await fixture(t),scope=f.nav.metadata().scope;assert.equal(f.nav.restore({scope}),null);
 f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});const raw=await readFile(f.store.path('client.json'),'utf8');assert.ok(!raw.includes(f.s.id));assert.ok(!raw.includes(f.owner.auth.secret));
 const restored=new SessionNavigation({client:()=>f.owner,online:()=>true,config:f.store.readJSON('client.json'),saveConfig:()=>{throw Error('valid restore must not save');}});
 const call=f.owner.call;f.owner.call=()=>{throw Error('restore must not call Hub or Provider');};assert.deepEqual(restored.restore({scope}),{scope,workspaceId:f.w.id,sessionId:f.s.id});f.owner.call=call;
 f.fail=true;assert.throws(()=>f.nav.clear(),/disk/);assert.equal(f.config.lastOpenedSession.sessionId,f.s.id);
});
test('same room different identity, room audience, auth secret and session-limited grant cannot restore each other',async t=>{
 const f=await fixture(t),scope=f.nav.metadata().scope;f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});
 const other=await f.connect();f.current=other;assert.notEqual(f.nav.metadata().scope,scope);assert.equal(f.nav.restore({scope:f.nav.metadata().scope}),null);assert.throws(()=>f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id}),/身份/);
 const original=other.state;other.state={...original,identity:{...original.identity,audience:'other-room'}};assert.equal(f.nav.restore({scope:f.nav.metadata().scope}),null);other.state=original;
 f.current=f.owner;const previousSecret=f.owner.auth.secret;f.owner.auth.secret=randomBytes(32).toString('hex');assert.notEqual(f.nav.metadata().scope,scope);assert.equal(f.nav.restore({scope:f.nav.metadata().scope}),null);f.owner.auth.secret=previousSecret;f.owner.state={...f.owner.state,me:{...f.owner.state.me,sessionId:'not-visible'}};assert.equal(f.nav.restore({scope:f.nav.metadata().scope}),null);
});
test('fresh scoped snapshots fence revoked, archived or deleted sessions; offline cache is never enough',async t=>{
 const f=await fixture(t);const invite=await f.owner.call('invite.create',{workspaceId:f.w.id,sessionId:f.s.id,role:'viewer'}),guest=await f.connect(invite.token);f.current=guest;const scope=f.nav.metadata().scope;
 f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});f.online=false;assert.throws(()=>f.nav.restore({scope}),/刷新/);f.online=true;
 const hidden=await f.owner.call('session.create',{workspaceId:f.w.id,title:'hidden'});assert.throws(()=>f.nav.open({scope,workspaceId:f.w.id,sessionId:hidden.id}),/不可见/);
 await f.owner.call('session.archive',{sessionId:f.s.id,archived:true});await wait(()=>guest.state.sessions.find(s=>s.id===f.s.id)?.status==='archived');f.nav.observe();assert.equal(f.config.lastOpenedSession,undefined);assert.equal(f.nav.restore({scope}),null);
 // A snapshot removing a previously visible record must clear persistence too.
 guest.state={...guest.state,sessions:[{...f.s,status:'active'}]};f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});guest.state={...guest.state,sessions:[]};f.nav.observe();assert.equal(f.config.lastOpenedSession,undefined);
});
test('disabled preference and explicit logout do not restore; writes reject untrusted scope or args',async t=>{
 const f=await fixture(t),scope=f.nav.metadata().scope;f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});f.config.generalSettings={restoreLastSession:false};assert.equal(f.nav.restore({scope}),null);
 const before=JSON.stringify(f.config.lastOpenedSession);f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});assert.equal(JSON.stringify(f.config.lastOpenedSession),before);
 assert.throws(()=>f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id,secret:'inject'}),/参数/);const epoch=f.nav.metadata().epoch;f.nav.clear();assert.equal(f.nav.metadata().epoch,epoch+1);assert.equal(f.config.lastOpenedSession,undefined);
});

test('actual Hub member revocation prevents restoring the previously authorized cached session',async t=>{
 const f=await fixture(t),invite=await f.owner.call('invite.create',{workspaceId:f.w.id,role:'viewer'}),guest=await f.connect(invite.token);f.current=guest;const scope=f.nav.metadata().scope;f.nav.open({scope,workspaceId:f.w.id,sessionId:f.s.id});
 await f.owner.call('member.remove',{workspaceId:f.w.id,memberId:guest.state.me.id});await wait(()=>guest.ws.readyState!==1);
 assert.equal(f.nav.metadata().ready,false);assert.throws(()=>f.nav.restore({scope}),/刷新/);
});

test('offline events retain close codes after automatic reconnect, before a later authentication failure',async t=>{
 const f=await fixture(t),invite=await f.owner.call('invite.create',{workspaceId:f.w.id,role:'viewer'}),guest=await f.connect(invite.token);
 const memberId=guest.state.me.id,firstSocket=guest.ws,codes=[];guest.on('offline',code=>codes.push(code));
 const serverSocket=[...f.hub.peers].find(([,peer])=>peer.id===memberId)[0];serverSocket.terminate();
 await wait(()=>codes.length===1);assert.equal(codes[0],1006);
 await wait(()=>guest.ws!==firstSocket&&[...f.hub.peers.values()].some(peer=>peer.id===memberId)&&guest.state.me.id===memberId,6000);
 assert.equal(guest.closed,false);assert.equal(guest.ws.readyState,1);
 await f.owner.call('member.remove',{workspaceId:f.w.id,memberId});await wait(()=>codes.length===2);
 assert.deepEqual(codes,[1006,1008]);assert.equal(guest.closed,false,'event must carry policy rejection before the next authentication attempt fails');
});
