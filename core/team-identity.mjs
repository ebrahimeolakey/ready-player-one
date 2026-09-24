import { createPublicKey, createHash, verify, sign, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
export const secretHash = value => createHash("sha256").update(String(value)).digest("hex");
export function githubLogin(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value)) throw Error("GitHub 用户名无效");
  return value.toLowerCase();
}
export function identityUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw Error("身份服务必须使用 HTTPS（本机测试可用 HTTP）");
  return url.origin;
}
export function signIdentity(privateKey, claims) {
  const header = Buffer.from(JSON.stringify({ alg:"EdDSA",typ:"JWT" })).toString("base64url"), payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const body = `${header}.${payload}`;
  return `${body}.${sign(null,Buffer.from(body),privateKey).toString("base64url")}`;
}
export function createIdentityVerifier({ issuer, publicKey, clock = () => Date.now() }) {
  const trustedIssuer = identityUrl(issuer), key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw Error("身份服务验证密钥必须是 Ed25519");
  return {
    issuer:trustedIssuer,
    verify(proof,{audience,peerId,nonce}) {
      if (typeof proof !== "string" || proof.length>12000) throw Error("GitHub 身份凭证无效");
      const parts=proof.split(".");if(parts.length!==3)throw Error("GitHub 身份凭证无效");
      let header,claims;try{header=JSON.parse(Buffer.from(parts[0],"base64url"));claims=JSON.parse(Buffer.from(parts[1],"base64url"));}catch{throw Error("GitHub 身份凭证无效");}
      if(header.alg!=="EdDSA"||header.typ!=="JWT"||Object.keys(header).some(k=>!["alg","typ"].includes(k))||!verify(null,Buffer.from(`${parts[0]}.${parts[1]}`),key,Buffer.from(parts[2],"base64url")))throw Error("GitHub 身份签名无效");
      const now=Math.floor(clock()/1000);
      if(claims.iss!==trustedIssuer||claims.aud!==audience||claims.peer!==peerId||claims.nonce!==nonce||!Number.isInteger(claims.exp)||claims.exp<=now||claims.exp>now+600||!Number.isInteger(claims.iat)||claims.iat>now+30||claims.iat<now-600||typeof claims.jti!=="string"||!/^[a-f0-9-]{36}$/.test(claims.jti)||!/^[1-9][0-9]{0,19}$/.test(String(claims.sub)))throw Error("GitHub 身份凭证已过期或不属于此身份/工作区服务");
      return {id:String(claims.sub),login:githubLogin(claims.login),verifiedAt:new Date(clock()).toISOString(),jti:claims.jti};
    },
  };
}
export class TeamIdentity {
  constructor(hub,verifier) {
    this.hub=hub;this.verifier=verifier;this.challenges=new Map();
    hub.db.identityAudience ??= randomUUID();hub.db.identities ??= [];
  }
  get info(){return {configured:Boolean(this.verifier),issuer:this.verifier?.issuer||null,audience:this.hub.db.identityAudience};}
  begin(peerId,workspaceId) {
    if(!this.verifier)throw Error("尚未配置 GitHub 团队身份服务");
    const now=Date.now();for(const [nonce,c]of this.challenges)if(c.expires<=now)this.challenges.delete(nonce);
    if(this.challenges.size>=1000)throw Error("登录请求过多，请稍后重试");
    if([...this.challenges.values()].filter(c=>c.peerId===peerId).length>=5)throw Error("此身份已有待完成登录");
    const nonce=randomBytes(32).toString("hex"),expires=now+10*60000;
    this.challenges.set(nonce,{peerId,workspaceId,expires});
    return {...this.info,peerId,nonce,expires};
  }
  verifyProof(peerId,proof) {
    if(!this.verifier)throw Error("尚未配置 GitHub 团队身份服务");
    let nonce;try{nonce=JSON.parse(Buffer.from(String(proof).split(".")[1],"base64url")).nonce;}catch{throw Error("GitHub 身份凭证无效");}
    const challenge=this.challenges.get(nonce);
    if(!challenge||challenge.peerId!==peerId||challenge.expires<=Date.now())throw Error("登录挑战已过期或已使用");
    const github=this.verifier.verify(proof,{audience:this.hub.db.identityAudience,peerId,nonce});
    const existing=this.hub.db.identities.find(v=>v.peerId===peerId);
    if(existing&&existing.github.id!==github.id)throw Error("此本机身份已绑定另一个 GitHub 账号");
    this.challenges.delete(nonce);
    return {github,workspaceId:challenge.workspaceId};
  }
  establish(peerId,github) {
    const token=randomBytes(32).toString("hex"),expires=Date.now()+24*3600e3;
    let identity=this.hub.db.identities.find(v=>v.peerId===peerId);
    if(identity&&identity.github.id!==github.id)throw Error("此本机身份已绑定另一个 GitHub 账号");
    if(!identity){identity={peerId};this.hub.db.identities.push(identity);}
    Object.assign(identity,{github,sessionHash:secretHash(token),expires});
    for(const member of [...this.hub.db.members,...(this.hub.db.sessionMembers||[])])if(member.id===peerId)member.github={id:github.id,login:github.login,verifiedAt:github.verifiedAt};
    return {identitySession:token,identityExpires:expires,github:identity.github};
  }
  authenticate(peerId,{identityProof,identitySession},workspaceId,requiredLogin) {
    let github,grant;
    if(identityProof){const verified=this.verifyProof(peerId,identityProof);if(verified.workspaceId!==workspaceId)throw Error("GitHub 登录挑战不属于此邀请");github=verified.github;}
    const identity=this.hub.db.identities.find(v=>v.peerId===peerId);
    if(!github&&identitySession&&identity?.sessionHash&&identity.expires>Date.now()) {
      const expected=Buffer.from(identity.sessionHash,"hex"),actual=Buffer.from(secretHash(identitySession),"hex");
      if(expected.length===actual.length&&timingSafeEqual(expected,actual))github=identity.github;
    }
    if((requiredLogin||identity)&&!github)throw Error("请先验证已绑定的 GitHub 团队身份");
    if(requiredLogin&&githubLogin(requiredLogin)!==github?.login)throw Error("此邀请仅限指定的 GitHub 用户");
    if(identityProof)grant=this.establish(peerId,github);
    return {github,grant};
  }
  bind(peer,proof) {
    const verified=this.verifyProof(peer.id,proof);
    if(verified.workspaceId!==peer.workspaceId)throw Error("登录挑战不属于当前协作连接");
    return this.establish(peer.id,verified.github);
  }
  revoke(peerId){const identity=this.hub.db.identities.find(v=>v.peerId===peerId);if(identity){delete identity.sessionHash;identity.expires=0;}return true;}
}
