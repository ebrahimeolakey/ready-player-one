import { readFileSync } from "node:fs";
import { createIdentityVerifier } from "./team-identity.mjs";
import { Hub } from "./hub.mjs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { inspectProject } from "./local.mjs";
import { SecureStore } from "./secure-store.mjs";
import { loadExternalDataKey } from "../desktop/services/data-key.mjs";
const dataDir = process.env.RPO_HUB_DIR || join(homedir(), ".ready-player-one", "standalone");
const key = loadExternalDataKey({ dataDir });
const store = new SecureStore({ dir: dataDir, key });
key.fill(0);
const retentionDays = process.env.RPO_TRANSCRIPT_RETENTION_DAYS === undefined
  ? undefined : process.env.RPO_TRANSCRIPT_RETENTION_DAYS === "forever" ? null : Number(process.env.RPO_TRANSCRIPT_RETENTION_DAYS);
const issuer = process.env.RPO_IDENTITY_ISSUER;
const publicKeyFile = process.env.RPO_IDENTITY_PUBLIC_KEY_FILE;
if (Boolean(issuer) !== Boolean(publicKeyFile)) throw Error("团队身份必须同时配置 RPO_IDENTITY_ISSUER 与 RPO_IDENTITY_PUBLIC_KEY_FILE");
const identityVerifier = issuer ? createIdentityVerifier({ issuer, publicKey: readFileSync(publicKeyFile, "utf8") }) : undefined;
const hub = new Hub(dataDir, { store, retentionDays, identityVerifier });
const host = process.env.RPO_SHARE === "1" ? "0.0.0.0" : "127.0.0.1";
const port = process.env.RPO_PORT === undefined ? 47831 : Number(process.env.RPO_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("RPO_PORT 必须是 0–65535 的整数");
await hub.listen({ host, port });
const owner = { id: "standalone-host", name: "房主", host: true };
let workspace = hub.db.workspaces[0];
if (!workspace) {
  const p = await inspectProject(process.cwd());
  workspace = hub.act(owner, "workspace.create", {
    name: basename(p.root),
    branch: p.branch,
    remote: p.remote,
  });
}
const invite = hub.act(owner, "invite.create", { workspaceId: workspace.id });
hub.save();
console.log(`头号玩家协作服务已启动：${host}:${hub.port}`);
console.log(
  `加入邀请（24 小时有效）：rpo://join?host=127.0.0.1&port=${hub.port}&token=${invite.token}`,
);
console.log(
  host === "0.0.0.0"
    ? "请把邀请中的 host 改为参与者可访问的局域网 / VPN 地址。"
    : "仅监听本机。可信局域网共享可设置 RPO_SHARE=1。",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await hub.close();
    store.destroy();
    process.exit(0);
  });
