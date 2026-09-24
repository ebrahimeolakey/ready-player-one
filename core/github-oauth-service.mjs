import { createServer } from "node:http";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadExternalDataKey } from "../desktop/services/data-key.mjs";
import { identityUrl, signIdentity, secretHash, githubLogin } from "./team-identity.mjs";
const authorizationEndpoint="https://github.com/login/oauth/authorize",tokenEndpoint="https://github.com/login/oauth/access_token",userEndpoint="https://api.github.com/user";
const random=()=>randomBytes(32).toString("base64url");
async function jsonBody(req){let raw="";for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error("请求过大");}try{return JSON.parse(raw);}catch{throw Error("无效 JSON");}}
function send(res,status,value){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(JSON.stringify(value));}
function page(res,status,message){res.writeHead(status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>头号玩家</title><body><p>${message}</p></body></html>`);}
export function createGitHubOAuthService({issuer,clientId,clientSecret,privateKey,allowedAudiences,fetchImpl=fetch,clock=()=>Date.now()}) {
  issuer=identityUrl(issuer);
  if(!clientId||!clientSecret||!privateKey||!Array.isArray(allowedAudiences)||!allowedAudiences.length)throw Error("必须配置独立 GitHub OAuth App、签名密钥及允许的 Hub audience");
  if(privateKey.asymmetricKeyType!=="ed25519")throw Error("身份签名需要 Ed25519 密钥");
  const allowed=new Set(allowedAudiences),requests=new Map(),states=new Map(),rates=new Map(),callback=`${issuer}/oauth/callback`;
  const prune=()=>{for(const[id,r]of requests)if(r.expires<=clock()){states.delete(r.state);requests.delete(id);}for(const[ip,r]of rates)if(r.reset<=clock())rates.delete(ip);};
  const server=createServer(async(req,res)=>{
    try {
      prune();const url=new URL(req.url,"http://localhost");
      if(req.method==="GET"&&url.pathname==="/health")return send(res,200,{ok:true});
      if(req.method==="POST"&&url.pathname==="/auth/requests") {
        if(req.headers.origin)throw Error("身份请求只接受原生客户端");
        const ip=req.socket.remoteAddress||"unknown",rate=rates.get(ip)||{count:0,reset:clock()+60000};rate.count++;rates.set(ip,rate);
        if(rate.count>20||requests.size>=1000)return send(res,429,{error:"登录请求过多"});
        const body=await jsonBody(req);
        if(!allowed.has(body.audience)||!/^[a-f0-9]{24}$/.test(body.peerId||"")||!/^[a-f0-9]{64}$/.test(body.nonce||""))throw Error("未授权的 Hub 或登录挑战");
        const id=randomUUID(),state=random(),verifier=random(),pollSecret=random(),expires=clock()+10*60000;
        requests.set(id,{id,state,verifier,pollHash:secretHash(pollSecret),expires,status:"pending",audience:body.audience,peerId:body.peerId,nonce:body.nonce});states.set(state,id);
        const authorize=new URL(authorizationEndpoint);authorize.search=new URLSearchParams({client_id:clientId,redirect_uri:callback,scope:"read:user",state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",prompt:"select_account"}).toString();
        return send(res,201,{id,authorizationUrl:authorize.href,pollSecret,expires});
      }
      if(req.method==="GET"&&url.pathname==="/oauth/callback") {
        const state=url.searchParams.get("state"),id=states.get(state),request=requests.get(id);
        if(!request||request.status!=="pending")return page(res,400,"登录请求已失效，请返回应用重试。");
        states.delete(state);request.status="verifying";
        if(url.searchParams.has("error")){request.status="denied";return page(res,400,"你已取消 GitHub 授权，可返回应用。");}
        const code=url.searchParams.get("code");if(!code||code.length>2000){request.status="failed";return page(res,400,"授权返回无效，请重新登录。");}
        try {
          const tokenResponse=await fetchImpl(tokenEndpoint,{method:"POST",headers:{Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:clientId,client_secret:clientSecret,code,redirect_uri:callback,code_verifier:request.verifier}),signal:AbortSignal.timeout(15000),redirect:"error"});
          if(!tokenResponse.ok)throw Error("GitHub token exchange failed");const token=await tokenResponse.json();
          if(typeof token.access_token!=="string"||token.access_token.length>8192||token.error)throw Error("GitHub token exchange failed");
          const userResponse=await fetchImpl(userEndpoint,{headers:{Authorization:`Bearer ${token.access_token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"Ready-Player-One-Team-Identity"},signal:AbortSignal.timeout(15000),redirect:"error"});
          if(!userResponse.ok)throw Error("GitHub identity check failed");const user=await userResponse.json();
          if(!Number.isSafeInteger(user.id)||user.id<=0||user.type!=="User")throw Error("GitHub user required");
          const login=githubLogin(user.login),now=Math.floor(clock()/1000);
          request.proof=signIdentity(privateKey,{iss:issuer,aud:request.audience,peer:request.peerId,nonce:request.nonce,sub:String(user.id),login,iat:now,exp:now+300,jti:randomUUID()});request.status="verified";
          delete request.verifier;
          // OAuth access/refresh tokens are deliberately not stored or returned to Hub/client.
          return page(res,200,"GitHub 身份已验证，请返回头号玩家。");
        }catch{request.status="failed";return page(res,502,"GitHub 身份验证失败，请返回应用重试。");}
      }
      const match=url.pathname.match(/^\/auth\/requests\/([a-f0-9-]{36})$/);
      if(req.method==="GET"&&match) {
        if(req.headers.origin)throw Error("身份请求只接受原生客户端");
        const request=requests.get(match[1]),bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        if(!request||!bearer)return send(res,401,{error:"登录轮询凭据无效"});
        const left=Buffer.from(secretHash(bearer),"hex"),right=Buffer.from(request.pollHash,"hex");if(!timingSafeEqual(left,right))return send(res,401,{error:"登录轮询凭据无效"});
        if(request.status==="verified"){const proof=request.proof;delete request.proof;request.status="consumed";return send(res,200,{status:"verified",proof});}
        return send(res,["pending","verifying"].includes(request.status)?202:410,{status:request.status});
      }
      return send(res,404,{error:"Not found"});
    }catch{return send(res,400,{error:"身份请求无效"});}
  });
  return {server,publicKey:createPublicKey(privateKey).export({type:"spki",format:"pem"}),listen:async({host="127.0.0.1",port=8788}={})=>{await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,resolve);});return server.address();},close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const dataDir=process.env.RPO_IDENTITY_DATA_DIR||join(homedir(),".ready-player-one","identity");
  if (!process.env.RPO_IDENTITY_SIGNING_KEY_FILE) throw Error("必须独立配置 RPO_IDENTITY_SIGNING_KEY_FILE，不能复用 Hub 数据密钥");
  const seed=loadExternalDataKey({keyFile:process.env.RPO_IDENTITY_SIGNING_KEY_FILE,dataDir});
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});seed.fill(0);
  const service=createGitHubOAuthService({issuer:process.env.RPO_IDENTITY_ISSUER,clientId:process.env.RPO_GITHUB_CLIENT_ID,clientSecret:process.env.RPO_GITHUB_CLIENT_SECRET,privateKey,allowedAudiences:(process.env.RPO_IDENTITY_AUDIENCES||"").split(",").filter(Boolean)});
  const address=await service.listen({port:Number(process.env.RPO_IDENTITY_PORT||8788)});console.log(`GitHub 团队身份服务监听 ${address.address}:${address.port}；需由 HTTPS 反向代理提供配置的 issuer。`);
  for(const signal of["SIGINT","SIGTERM"])process.on(signal,async()=>{await service.close();process.exit(0);});
}
