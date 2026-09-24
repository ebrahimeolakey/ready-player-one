import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./helpers/secure-hub.mjs";
import { HubClient } from "../core/client.mjs";
import { createIdentityVerifier, signIdentity } from "../core/team-identity.mjs";
import { createGitHubOAuthService } from "../core/github-oauth-service.mjs";
import { requestIdentityChallenge } from "../core/team-identity-client.mjs";
import { createTeamIdentity } from "../desktop/services/team-identity.mjs";
const issuer="https://identity.example.test";
async function fixture(t) {
  const keys=generateKeyPairSync("ed25519"),dir=await mkdtemp(join(tmpdir(),"rpo-identity-test-"));
  const hub=new Hub(dir,{identityVerifier:createIdentityVerifier({issuer,publicKey:keys.publicKey})});await hub.listen();
  const url=`ws://127.0.0.1:${hub.port}`,host=new HubClient(),clients=[host],hostAuth={token:hub.db.hostToken,secret:randomBytes(32).toString("hex"),name:"Host"};
  await host.connect(url,hostAuth);const workspace=await host.call("workspace.create",{name:"Identity"});
  let profile={id:1234,login:"alice",type:"User"},tokenCalls=0,userCalls=0,lastVerifier="";
  const oauthToken="gho_"+"A".repeat(32);
  const service=createGitHubOAuthService({issuer,clientId:"dedicated-client",clientSecret:"dedicated-oauth-secret",privateKey:keys.privateKey,allowedAudiences:[hub.db.identityAudience],fetchImpl:async(resource,options)=>{
    if(resource==="https://github.com/login/oauth/access_token") {tokenCalls++;const body=JSON.parse(options.body);assert.equal(body.client_id,"dedicated-client");assert.equal(body.client_secret,"dedicated-oauth-secret");assert.equal(body.redirect_uri,`${issuer}/oauth/callback`);lastVerifier=body.code_verifier;return new Response(JSON.stringify({access_token:oauthToken,token_type:"bearer"}),{status:200});}
    if(resource==="https://api.github.com/user") {userCalls++;assert.equal(options.headers.Authorization,`Bearer ${oauthToken}`);return new Response(JSON.stringify(profile),{status:200});}
    throw Error("unexpected external boundary");
  }});
  const address=await service.listen({port:0}),base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{for(const c of clients)c.close();await hub.close();await service.close();await rm(dir,{recursive:true,force:true});});
  async function oauth(challenge,{complete=true}={}) {
    const response=await fetch(`${base}/auth/requests`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({audience:challenge.audience,peerId:challenge.peerId,nonce:challenge.nonce})});assert.equal(response.status,201);const request=await response.json();
    const authorize=new URL(request.authorizationUrl);assert.equal(authorize.origin,"https://github.com");assert.equal(authorize.searchParams.get("scope"),"read:user");assert.equal(authorize.searchParams.get("code_challenge_method"),"S256");
    if(complete){const callback=await fetch(`${base}/oauth/callback?state=${authorize.searchParams.get("state")}&code=github-temporary-code`);assert.equal(callback.status,200);assert.equal(authorize.searchParams.get("code_challenge"),createHash("sha256").update(lastVerifier).digest("base64url"));}
    return {...request,authorize,poll:()=>fetch(`${base}/auth/requests/${request.id}`,{headers:{Authorization:`Bearer ${request.pollSecret}`}})};
  }
  const proof=async challenge=>{const flow=await oauth(challenge),response=await flow.poll();assert.equal(response.status,200);return(await response.json()).proof;};
  return {hub,host,hostAuth,workspace,url,clients,keys,oauth,proof,base,service,setProfile:p=>profile=p,counts:()=>({tokenCalls,userCalls}),oauthToken};
}
test("OAuth verifies GitHub /user after PKCE exchange and returns single-use signed proof, never access token",async t=>{
  const f=await fixture(t),challenge=await f.host.call("identity.begin"),flow=await f.oauth(challenge);
  const response=await flow.poll(),data=await response.json();assert.equal(response.status,200);assert.equal(JSON.stringify(data).includes(f.oauthToken),false);assert.equal((await flow.poll()).status,410);
  const bound=await f.host.call("identity.bind",{proof:data.proof});assert.equal(bound.github.login,"alice");assert.equal(bound.github.id,"1234");assert.ok(bound.identitySession);
  assert.equal(JSON.stringify(f.hub.db).includes(f.oauthToken),false);assert.equal(JSON.stringify(await f.host.call("state")).includes(bound.identitySession),false);
  assert.equal((await f.host.call("state")).me.github.id,"1234");assert.deepEqual(f.counts(),{tokenCalls:1,userCalls:1});
  await assert.rejects(f.host.call("identity.bind",{proof:data.proof}),/已过期或已使用/);
});
test("OAuth rejects wrong state, audience and poll credential and checks callback once",async t=>{
  const f=await fixture(t),challenge=await f.host.call("identity.begin"),flow=await f.oauth(challenge,{complete:false});
  assert.equal((await fetch(`${f.base}/oauth/callback?state=wrong&code=anything`)).status,400);
  assert.equal((await fetch(`${f.base}/auth/requests/${flow.id}`,{headers:{Authorization:`Bearer ${"X".repeat(43)}`}})).status,401);
  assert.equal((await flow.poll()).status,202);
  assert.equal((await fetch(`${f.base}/auth/requests`,{method:"POST",body:JSON.stringify({...challenge,audience:"attacker-hub"})})).status,400);
  assert.equal((await fetch(`${f.base}/oauth/callback?state=${flow.authorize.searchParams.get("state")}&code=valid`)).status,200);
  assert.equal((await fetch(`${f.base}/oauth/callback?state=${flow.authorize.searchParams.get("state")}&code=replay`)).status,400);
  assert.deepEqual(f.counts(),{tokenCalls:1,userCalls:1});
});
test("username-scoped invite requires verified same account, binds local identity and session reconnect, and honors removal",async t=>{
  const f=await fixture(t),invite=await f.host.call("invite.create",{workspaceId:f.workspace.id,githubLogin:"ALICE",role:"commenter"});
  const auth={token:invite.token,secret:randomBytes(32).toString("hex"),name:"Alice"},guest=new HubClient();f.clients.push(guest);
  await assert.rejects(guest.connect(f.url,auth),/GitHub/);
  const challenge=await requestIdentityChallenge(f.url,auth),proof=await f.proof(challenge);
  const joined=await guest.connect(f.url,{...auth,identityProof:proof});assert.equal(joined.me.github.id,"1234");assert.equal(joined.me.role,"commenter");const ticket=joined.identitySession;assert.ok(ticket);
  guest.close();await assert.rejects(guest.connect(f.url,auth),/已绑定/);
  const reconnect=await guest.connect(f.url,{...auth,identitySession:ticket});assert.equal(reconnect.me.github.id,"1234");
  const swapped=new HubClient();f.clients.push(swapped);await assert.rejects(swapped.connect(f.url,{...auth,secret:randomBytes(32).toString("hex"),identitySession:ticket}),/GitHub/);
  await f.host.call("member.remove",{workspaceId:f.workspace.id,memberId:reconnect.me.id});guest.close();await assert.rejects(guest.connect(f.url,{...auth,identitySession:ticket}),/移除/);
});
test("wrong GitHub account, expired proof, wrong audience and self-signed issuer cannot bind",async t=>{
  const f=await fixture(t),challenge=await f.host.call("identity.begin"),now=Math.floor(Date.now()/1000);
  const claims={iss:issuer,aud:challenge.audience,peer:challenge.peerId,nonce:challenge.nonce,sub:"1234",login:"alice",iat:now,exp:now+300,jti:randomUUID()};
  const attacker=generateKeyPairSync("ed25519");await assert.rejects(f.host.call("identity.bind",{proof:signIdentity(attacker.privateKey,claims)}),/签名/);
  await assert.rejects(f.host.call("identity.bind",{proof:signIdentity(f.keys.privateKey,{...claims,aud:"other"})}),/不属于/);
  await assert.rejects(f.host.call("identity.bind",{proof:signIdentity(f.keys.privateKey,{...claims,exp:now-1})}),/过期/);
  await f.host.call("identity.bind",{proof:signIdentity(f.keys.privateKey,claims)});
  const next=await f.host.call("identity.begin");await assert.rejects(f.host.call("identity.bind",{proof:signIdentity(f.keys.privateKey,{...claims,nonce:next.nonce,sub:"9999",login:"bob",jti:randomUUID()})}),/另一个/);
});
test("native adapter opens only GitHub authorization, keeps poll/ticket secrets out of renderer, and persists encrypted-config credential",async t=>{
  const f=await fixture(t),localConfig={},opened=[];let saves=0;
  const fetchImpl=(resource,options)=>fetch(String(resource).replace(issuer,f.base),options);
  const adapter=createTeamIdentity({client:()=>f.host,endpoint:()=>f.url,localConfig,saveConfig:()=>saves++,openExternal:url=>opened.push(url),fetchImpl});
  assert.equal((await adapter.invoke("team.status")).configured,true);
  const job=await adapter.invoke("team.begin");assert.equal(job.status,"pending");assert.equal(job.pollSecret,undefined);assert.equal(new URL(opened[0]).origin,"https://github.com");
  const authorize=new URL(opened[0]);await fetch(`${f.base}/oauth/callback?state=${authorize.searchParams.get("state")}&code=good`);
  const result=await adapter.invoke("team.poll",{id:job.id});assert.equal(result.status,"verified");assert.equal(result.github.id,"1234");assert.equal(result.identitySession,undefined);assert.equal(saves,1);assert.ok(adapter.getAuth(f.url).identitySession);
  assert.equal(JSON.stringify(await adapter.invoke("team.status")).includes(adapter.getAuth(f.url).identitySession),false);
});
test("pre-connect adapter can verify a username invite without sending existing gh repository credentials",async t=>{
  const f=await fixture(t),invite=await f.host.call("invite.create",{workspaceId:f.workspace.id,githubLogin:"alice",role:"viewer"}),localConfig={},opened=[];
  const adapter=createTeamIdentity({client:()=>null,endpoint:()=>f.url,localConfig,saveConfig:()=>{},openExternal:url=>opened.push(url),fetchImpl:(url,options)=>fetch(String(url).replace(issuer,f.base),options)});
  const auth={url:f.url,token:invite.token,secret:randomBytes(32).toString("hex"),name:"Alice"};const job=await adapter.beginJoin(auth);
  await fetch(`${f.base}/oauth/callback?state=${new URL(opened[0]).searchParams.get("state")}&code=good`);
  assert.equal((await adapter.invoke("team.poll",{id:job.id})).status,"verified");
  const guest=new HubClient();f.clients.push(guest);const joined=await guest.connect(f.url,{...auth,...adapter.getAuth(f.url)});assert.equal(joined.me.role,"viewer");assert.equal(joined.me.github.id,"1234");
});
test("username invite rejects a genuinely verified different GitHub user and role changes survive account reconnect",async t=>{
  const f=await fixture(t),invite=await f.host.call("invite.create",{workspaceId:f.workspace.id,githubLogin:"alice",role:"editor"}),auth={token:invite.token,secret:randomBytes(32).toString("hex"),name:"Member"},guest=new HubClient();f.clients.push(guest);
  f.setProfile({id:777,login:"bob",type:"User"});const wrong=await f.proof(await requestIdentityChallenge(f.url,auth));
  await assert.rejects(guest.connect(f.url,{...auth,identityProof:wrong}),/指定的 GitHub/);
  f.setProfile({id:1234,login:"alice",type:"User"});const valid=await f.proof(await requestIdentityChallenge(f.url,auth));
  const joined=await guest.connect(f.url,{...auth,identityProof:valid});
  await f.host.call("member.role",{workspaceId:f.workspace.id,memberId:joined.me.id,role:"viewer"});guest.close();
  assert.equal((await guest.connect(f.url,{...auth,identitySession:joined.identitySession})).me.role,"viewer");
  await f.host.call("invite.revoke",{workspaceId:f.workspace.id});guest.close();await assert.rejects(guest.connect(f.url,{...auth,identitySession:joined.identitySession}),/失效/);
});
test("revoking or expiring an identity session forces fresh OAuth while keeping immutable account binding",async t=>{
  const f=await fixture(t),proof=await f.proof(await f.host.call("identity.begin")),bound=await f.host.call("identity.bind",{proof});
  await f.host.call("identity.revoke");f.host.close();
  await assert.rejects(f.host.connect(f.url,{...f.hostAuth,identitySession:bound.identitySession}),/已绑定/);
  const fresh=await f.proof(await requestIdentityChallenge(f.url,f.hostAuth));const reauth=await f.host.connect(f.url,{...f.hostAuth,identityProof:fresh});
  assert.equal(reauth.me.github.id,"1234");assert.notEqual(reauth.identitySession,bound.identitySession);
  f.hub.db.identities.find(i=>i.peerId===reauth.me.id).expires=Date.now()-1;f.host.close();
  await assert.rejects(f.host.connect(f.url,{...f.hostAuth,identitySession:reauth.identitySession}),/已绑定/);
});

test("native identity sessions use injected stable Hub scope across changing local ports", async t => {
  const f=await fixture(t),localConfig={},opened=[];let endpoint=f.url;
  const localScope=url=>url===f.url||url==="ws://127.0.0.1:55555"?`local:${f.hub.db.identityAudience}`:url;
  const adapter=createTeamIdentity({client:()=>f.host,endpoint:()=>endpoint,localConfig,scopeKey:localScope,saveConfig:()=>{},openExternal:url=>opened.push(url),fetchImpl:(url,options)=>fetch(String(url).replace(issuer,f.base),options)});
  const job=await adapter.invoke("team.begin");
  await fetch(`${f.base}/oauth/callback?state=${new URL(opened[0]).searchParams.get("state")}&code=good`);
  assert.equal((await adapter.invoke("team.poll",{id:job.id})).status,"verified");
  const original=adapter.getAuth(f.url);endpoint="ws://127.0.0.1:55555";
  assert.deepEqual(adapter.getAuth(),original);assert.ok(original.identitySession);
  assert.deepEqual(adapter.getAuth("wss://another-hub.example"),{});
  await adapter.invoke("team.revoke");assert.deepEqual(adapter.getAuth(),{});
});
