import { randomUUID } from "node:crypto";
import { identityUrl } from "../../core/team-identity.mjs";
import { requestIdentityChallenge } from "../../core/team-identity-client.mjs";
import { HubClient } from "../../core/client.mjs";
const methods=new Set(["team.status","team.begin","team.poll","team.revoke"]);
export const handlesTeamIdentity=method=>methods.has(method);
export function createTeamIdentity({client,endpoint,localConfig,saveConfig,openExternal,fetchImpl=fetch,scopeKey=url=>url}) {
  const jobs=new Map();localConfig.identitySessions ??= {};
  const currentEndpoint=()=>typeof endpoint==="function"?endpoint():endpoint||client()?.url;
  const publicJob=job=>({id:job.id,status:job.status,message:job.message||"",expires:job.expires,github:job.github});
  const getAuth=url=>{const saved=localConfig.identitySessions[scopeKey(url||currentEndpoint())];return saved?.expires>Date.now()?{identitySession:saved.token}:{};};
  async function begin(challenge,scope,joinAuth) {
    const issuer=identityUrl(challenge.issuer);
    const response=await fetchImpl(`${issuer}/auth/requests`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({audience:challenge.audience,peerId:challenge.peerId,nonce:challenge.nonce}),signal:AbortSignal.timeout(15000),redirect:"error"});
    if(!response.ok)throw Error("身份服务暂时无法创建登录请求");const data=await response.json();
    const authorize=new URL(data.authorizationUrl);
    if(authorize.origin!=="https://github.com"||authorize.pathname!=="/login/oauth/authorize"||typeof data.pollSecret!=="string"||!Number.isFinite(data.expires))throw Error("身份服务返回了无效的 GitHub 授权地址");
    const job={id:randomUUID(),requestId:data.id,pollSecret:data.pollSecret,issuer,scope,joinAuth,expires:data.expires,status:"pending"};jobs.set(job.id,job);
    await openExternal(authorize.href);return publicJob(job);
  }
  async function beginJoin({url,token,secret,name}) {
    const challenge=await requestIdentityChallenge(url,{token,secret});
    return begin(challenge,url,{url,token,secret,name});
  }
  return {
    getAuth,beginJoin,
    async invoke(method,args={}) {
      if(!methods.has(method))throw Error("不支持的团队身份操作");
      const c=client(),scope=currentEndpoint();
      if(method==="team.status") {
        const state=c?.state;
        return {configured:Boolean(state?.identity?.configured),issuer:state?.identity?.issuer||null,github:state?.me?.github||null,jobs:[...jobs.values()].filter(j=>j.scope===scope).map(publicJob)};
      }
      if(method==="team.begin") {
        if(!c)throw Error("请先连接协作空间");
        const challenge=await c.call("identity.begin");return begin(challenge,scope);
      }
      if(method==="team.revoke") {
        if(!c)throw Error("请先连接协作空间");
        await c.call("identity.revoke",{});delete localConfig.identitySessions[scopeKey(scope)];await saveConfig();return true;
      }
      const job=jobs.get(args.id);if(!job)throw Error("登录请求不存在");
      if(job.status!=="pending")return publicJob(job);
      if(job.expires<=Date.now()){job.status="expired";job.message="登录已过期，请重新开始";return publicJob(job);}
      if(job.polling)return publicJob(job);
      job.polling=true;
      try {
        if(!job.joinAuth&&job.scope!==scope)throw Error("协作空间已切换，请在当前空间重新登录");
        const response=await fetchImpl(`${job.issuer}/auth/requests/${job.requestId}`,{headers:{Authorization:`Bearer ${job.pollSecret}`},signal:AbortSignal.timeout(15000),redirect:"error"});
        const result=await response.json();
        if(response.status===202)return publicJob(job);
        if(!response.ok||result.status!=="verified"||typeof result.proof!=="string")throw Error(result.status==="denied"?"GitHub 授权已取消":"登录已失效，请重新开始");
        let bound;
        if(job.joinAuth){const temporary=new HubClient();try{bound=await temporary.connect(job.joinAuth.url,{...job.joinAuth,identityProof:result.proof});}finally{temporary.close();}}
        else bound=await c.call("identity.bind",{proof:result.proof});
        const github=bound.github||bound.me?.github;
        if(!bound.identitySession||!bound.identityExpires||!github)throw Error("Hub 未返回有效的身份绑定");
        localConfig.identitySessions[scopeKey(job.scope)]={token:bound.identitySession,expires:bound.identityExpires,github};await saveConfig();
        job.status="verified";job.github=github;delete job.pollSecret;delete job.joinAuth;return publicJob(job);
      }catch(error){job.status="failed";job.message=error.message;delete job.pollSecret;delete job.joinAuth;return publicJob(job);}
      finally{job.polling=false;}
    },
  };
}
export default createTeamIdentity;
