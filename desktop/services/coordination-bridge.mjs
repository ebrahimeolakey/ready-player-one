import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { redactText } from "../../core/secure-store.mjs";
import { subtaskConnectionKey } from "./subtask-agent.mjs";

const hash = token => createHash("sha256").update(token).digest("hex");
/** Native MCP -> local Git service only. This is never a general-purpose IPC proxy. */
export class CoordinationBridge {
  constructor({ client, runtime, taskCoordination }) {
    Object.assign(this, { client, runtime, taskCoordination });
    this.leases = new Map(); this.closed = false;
  }
  async listen() {
    if (this.closed) throw Error("本机子任务桥已关闭");
    if (this.listening) return this.listening;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.server.keepAliveTimeout = 1000;
    this.listening = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(); });
    });
    return this.listening;
  }
  async issue({ sessionId, laneId, runId, workspaceId }) {
    await this.listen();
    const c = this.client();
    if (!c) throw Error("尚未连接协作空间");
    const state = await c.call("state");
    if (c !== this.client()) throw Error("协作连接已切换");
    const session = state.sessions.find(s => s.id === sessionId && s.workspaceId === workspaceId);
    const lane = session?.lanes.find(l => l.id === laneId && l.ownerId === state.me.id && l.activeRunId === runId);
    if (!lane || lane.status !== "running") throw Error("只能为当前本人执行配置子任务桥");
    this.revokeRun(runId);
    const token = randomBytes(32).toString("hex"), key = hash(token);
    const binding = { connectionKey: subtaskConnectionKey(c), ownerId: state.me.id, workspaceId, sessionId, laneId, runId };
    this.leases.set(key, { binding, client: c });
    return { RPO_COORDINATION_BRIDGE_URL: `http://127.0.0.1:${this.port}/subtasks`, RPO_COORDINATION_BRIDGE_TOKEN: token };
  }
  revokeRun(runId) { for (const [key, lease] of this.leases) if (lease.binding.runId === runId) this.leases.delete(key); }
  revokeAll() { this.leases.clear(); }
  async handle(req, res) {
    const reply = (code, body) => { if (!res.destroyed) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); } };
    try {
      if (this.closed || req.method !== "POST" || req.url !== "/subtasks" || req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}` || req.headers["content-type"] !== "application/json") return reply(403, { error: "不允许此子任务桥请求" });
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const key = token && hash(token), lease = key && this.leases.get(key);
      if (!lease) return reply(403, { error: "子任务桥凭据无效或已撤销" });
      const validate = async () => {
        if (this.closed || this.leases.get(key) !== lease || this.client() !== lease.client || subtaskConnectionKey(this.client()) !== lease.binding.connectionKey) throw Error("子任务桥凭据已撤销或协作连接已切换");
        if (!this.runtime.runs.has(lease.binding.runId)) throw Error("父执行已结束");
      };
      await validate();
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { reply(413, { error: "子任务请求过大" }); req.destroy(); return; } chunks.push(chunk); }
      let args;
      try { args = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { error: "子任务请求格式无效" }); }
      const result = await this.taskCoordination.spawnFromAgent(lease.binding, args, validate);
      reply(200, { result });
    } catch (error) { reply(400, { error: redactText(String(error.message)).slice(0, 2000) }); }
  }
  async close() {
    this.closed = true; this.revokeAll();
    if (!this.server) return;
    this.server.closeIdleConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }
}
