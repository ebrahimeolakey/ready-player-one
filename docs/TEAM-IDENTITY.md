# GitHub 团队身份

本功能把 GitHub 验证过的账号与本机协作身份绑定，并支持仅限指定 GitHub 用户名的邀请。它与 `gh` 的仓库授权独立：不会读取或向房主发送现有 GitHub CLI repository token，不自动获得仓库权限，不授予团队管理员角色。

默认没有部署好的身份服务。未配置时 UI 显示“尚未配置团队登录服务”，用户名邀请会明确拒绝创建。当前不是已交付的托管企业 SSO，也不包含组织目录、SAML、SCIM 或强制 MFA 策略。

## 信任与流程

1. 原生客户端向 Hub 申请 `identity.begin`。未连接时可携有效邀请与本机 secret 申请；Hub 返回与派生 peer ID、Hub audience 和 10 分钟 nonce 绑定的挑战。
2. 客户端向部署者的身份服务 `POST /auth/requests`，只发送上述公开标识与 nonce。服务返回 GitHub 授权地址和不暴露给网页的轮询凭据。
3. 浏览器进入 GitHub，使用 OAuth authorization code + PKCE S256 + 随机 state。回调地址固定为部署者配置的 `/oauth/callback`。
4. 身份服务用它自己的 OAuth App secret 换取 token，随后请求 GitHub `GET /user`，验证不可变数值 ID 和当前 login。账号必须为 User。
5. 身份服务以 Ed25519 签发有效期 5 分钟的最小身份凭证。凭证不包含 GitHub access token、refresh token 或仓库权限；轮询成功后仅领取一次。
6. Hub 用部署者在本机明确配置的公钥验证 issuer、audience、peer ID、nonce、期限、签名和账号绑定。绝不采用客户端自报的 issuer/JWKS。验证成功后，仅向原生请求者返回 24 小时随机重连票据，Hub 加密 DB 只保存其哈希。
7. 票据与相同 peer ID 绑定；更换本机 secret 不能复用。身份已绑定后，普通邀请也不能跳过 GitHub 身份验证。移除成员、撤销邀请、降权和手动撤销票据继续由 Hub 服务端执行。

用户名邀请首次加入必须完成新的 OAuth 验证，之后该邀请固定到首次通过的 GitHub 数值 ID。现有成员重连可用仍有效的票据。GitHub 用户改名后需要重新验证并由房主按新名称重新邀请；不会把旧用户名的后来持有人自动当作原账号。

## 部署者必须提供

- 自己注册的、仅用于团队身份的 GitHub OAuth App；请求 `read:user`，不请求 `repo`。
- 公网 HTTPS issuer，例如 `https://identity.example.com`。GitHub OAuth App 的 callback 必须准确配置为 `https://identity.example.com/oauth/callback`。
- 独立随机 32 字节签名 seed，保存为 hex/base64 私有文件；不能与 Hub 数据加密密钥复用。文件权限由 `loadExternalDataKey` 校验，POSIX 必须当前用户私有、Windows 必须通过 ACL 验证。
- 允许接入的 Hub audience 白名单，来源于 Hub 的 `state.identity.audience`；这是公开标识，不是邀请凭据。
- 将此 seed 对应的 Ed25519 公钥通过受信任配置写入 Hub。首次配置及密钥轮换不能从任意客户端提供的地址自动发现公钥。

启动模块（环境变量中的实际 secret 不应写进仓库、README 或聊天记录）：

```sh
RPO_IDENTITY_ISSUER=https://identity.example.com \
RPO_GITHUB_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID \
RPO_GITHUB_CLIENT_SECRET=YOUR_OAUTH_APP_CLIENT_SECRET \
RPO_IDENTITY_SIGNING_KEY_FILE=/private/credentials/rpo-identity.key \
RPO_IDENTITY_AUDIENCES=YOUR_HUB_AUDIENCE \
node core/github-oauth-service.mjs
```

默认监听 `127.0.0.1:8788`，使用 `RPO_IDENTITY_PORT` 改端口。由部署者的 HTTPS 反向代理提供公网地址，不应直接暴露未加密 HTTP。身份服务只有短期内存登录请求，重启后未完成流程需要重试；当前不提供多实例共享状态或负载均衡会话持久化。

Hub 集成：

```js
import { createIdentityVerifier } from './core/team-identity.mjs';
const verifier = createIdentityVerifier({
  issuer: configuredIssuer,
  publicKey: locallyTrustedPublicKeyPem,
});
const hub = new Hub(hubDir, { store, identityVerifier: verifier });
```

standalone 入口可通过部署者本机环境注入验证器：

```sh
RPO_DATA_KEY_FILE=/private/credentials/hub-data.key \
RPO_IDENTITY_ISSUER=https://identity.example.com \
RPO_IDENTITY_PUBLIC_KEY_FILE=/private/config/identity-public.pem \
node core/standalone.mjs
```

issuer 和公钥文件必须同时配置，否则启动失败；均未配置则保持团队登录未启用。这里是 Ed25519 公钥 PEM，不能填写签名 seed、GitHub token 或客户端提供的 JWKS URL。公钥文件应由部署者控制，不能让加入者替换。

公钥可在创建服务实例后从 `service.publicKey` 获取并通过部署者的配置渠道分发。OAuth 服务输出不打印 GitHub token、App secret 或签名 seed。

## 原生适配与 UI

`desktop/services/team-identity.mjs` 导出 `createTeamIdentity({client,endpoint,localConfig,saveConfig,openExternal,scopeKey})`，`client` 和 `endpoint` 可为当前连接 getter。`localConfig` 必须由主进程的 SecureStore 保存。

- `invoke('team.status')`：是否配置、当前 GitHub 账号及不含凭据的登录进度。
- `invoke('team.begin')`：已连接时开始绑定，只打开 GitHub 官方授权地址。
- `invoke('team.poll',{id})`：轮询并在主进程完成 proof 验证及票据保存，不把 proof、pollSecret 或票据返回 renderer。
- `invoke('team.revoke')`：撤销自己的重连票据；保留不可变账号绑定。
- `getAuth(url)`：主进程连接 Hub 时合并该方法返回的 `identitySession`。绑定成功后也更新已有 `client.auth`，供自动重连与 MCP 使用。可注入受信任的 `scopeKey(url)`；默认按完整 URL 隔离。本机随机端口可映射到 `local:<持久 Hub audience>`，避免重启后票据丢失；不要把任意远程 URL 全部归入同一 scope。
- `beginJoin({url,token,secret,name})`：用户名邀请首次加入或票据过期时，先申请挑战，再进行 OAuth。poll 成功后调用正常连接并合并 `getAuth(url)`。
- `src/TeamIdentity.tsx`：`<TeamIdentity call={call}/>` 提供配置状态、绑定、进度和错误入口。

所有新的 Agent MCP 连接也需在私有环境传入 `RPO_IDENTITY_SESSION`；不能只给旧邀请 token 后绕开已绑定身份。底层 Hub 原生 `auth.identityProof` 成功结果包含一次性保存所需票据，该完整结果不得原样转发 renderer；适配器使用临时原生连接隔离此数据。

## 验证边界

测试使用实际本机 HTTP OAuth 服务、真实 WebSocket Hub、Ed25519 签名和客户端适配器。只 mock GitHub 官方 token 与 `/user` 上游边界，验证 PKCE、state、poll 凭据、单次领取、错误签名/issuer/audience、账号不匹配、邀请限制、重连、降权、撤销及 renderer 不含凭据。

没有注册真实 OAuth App，没有部署公网身份服务器，没有对真实 GitHub 账号完成此授权流程。因此不能把当前测试等同于真实 OAuth 回调、部署域名、反向代理或 GitHub 授权页面的端到端验收。已有 `gh auth login` 仍属于独立仓库访问功能。

官方依据：[GitHub OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)。
