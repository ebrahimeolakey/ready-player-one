import { Hub } from "./hub.mjs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { inspectProject } from "./local.mjs";
const hub = new Hub(
  process.env.RPO_HUB_DIR || join(homedir(), ".ready-player-one", "standalone"),
);
const host = process.env.RPO_SHARE === "1" ? "0.0.0.0" : "127.0.0.1";
await hub.listen({ host, port: Number(process.env.RPO_PORT) || 47831 });
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
    process.exit(0);
  });
