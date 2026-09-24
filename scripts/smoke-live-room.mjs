// Explicit acceptance test against a running desktop hub, on loopback only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { HubClient } from "../core/client.mjs";
const port = Number(process.argv[2]);
if (!port)
  throw Error("用法：node scripts/smoke-live-room.mjs <本机协作服务端口>");
const db = JSON.parse(
  await readFile(join(homedir(), ".ready-player-one/hub/hub.json"), "utf8"),
);
const host = new HubClient(),
  guest = new HubClient();
const secret = () => randomBytes(32).toString("hex");
try {
  await host.connect(`ws://127.0.0.1:${port}`, {
    token: db.hostToken,
    name: "本机验收协调器",
    secret: secret(),
  });
  const s = host.state.sessions.find((s) => s.status === "active");
  if (!s) throw Error("请先在桌面创建验收会话");
  const invite = await host.call("invite.create", {
    workspaceId: s.workspaceId,
  });
  await guest.connect(`ws://127.0.0.1:${port}`, {
    token: invite.token,
    name: "本机验收客户端",
    secret: secret(),
  });
  await guest.call("lane.create", { sessionId: s.id, provider: "claude" });
  const plan = await guest.call("plan.add", {
    sessionId: s.id,
    text: "验证独立客户端加入、审批与 Agent 结果实时同步",
  });
  await guest.call("comment.add", {
    sessionId: s.id,
    text: "这是同一电脑上启动的独立验收客户端。我已通过邀请加入，并将在这里批准房主的连接测试。",
  });
  const a = guest.state.approvals.find(
    (a) => a.sessionId === s.id && a.status === "pending",
  );
  if (!a) throw Error("请先在桌面提交最小连接测试，等待此客户端审批");
  await guest.call("approval.decide", { id: a.id, allow: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("等待 Agent 输出超时")), 90000);
    guest.on("state", (state) => {
      const l = state.sessions
        .find((v) => v.id === s.id)
        ?.lanes.find((v) => v.id === a.laneId);
      if (l?.status === "error") {
        clearTimeout(timer);
        reject(Error(l.entries.at(-1)?.text));
      }
      if (l?.status === "done") {
        clearTimeout(timer);
        try {
          assert(
            l.entries.some(
              (e) =>
                e.role === "assistant" && e.text.includes("共享会话连接成功"),
            ),
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    });
  });
  await guest.call("plan.toggle", { sessionId: s.id, id: plan.id });
  await guest.call("comment.add", {
    sessionId: s.id,
    text: "验收通过：第二客户端批准后，房主的本机 Codex 成功执行；「共享会话连接成功」已实时同步到本客户端。未读取或修改项目文件。",
  });
  console.log(
    "PASS: invitation → guest approval → host Codex execution → shared transcript → shared plan",
  );
} finally {
  host.close();
  guest.close();
}
