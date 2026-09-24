import { WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
const id = () => randomUUID();
const now = () => new Date().toISOString();
const text = (v, n = 2000) => {
  if (typeof v !== "string" || !v.trim() || v.length > n)
    throw Error("内容为空或超过长度限制");
  return v.trim();
};
const eq = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class Hub extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "hub.json");
    this.transcripts = join(dir, "transcripts");
    mkdirSync(this.transcripts, { recursive: true, mode: 0o700 });
    try {
      this.db = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw Error("本地数据无法读取，请从备份恢复：" + e.message);
      this.db = {
        version: 1,
        hostToken: randomBytes(32).toString("hex"),
        invites: [],
        workspaces: [],
        sessions: [],
        memories: [],
        approvals: [],
      };
    }
    for (const s of this.db.sessions)
      for (const l of s.lanes)
        if (l.status === "running") {
          l.status = "interrupted";
          l.entries.push({
            id: id(),
            role: "system",
            text: "协作服务重启，上一次执行已中断。请检查结果后重新发起。",
            at: now(),
          });
        }
    for (const s of this.db.sessions)
      for (const l of s.lanes) {
        const log = join(this.transcripts, l.id + ".jsonl");
        if (!existsSync(log))
          writeFileSync(
            log,
            l.entries.map((e) => JSON.stringify(e)).join("\n") +
              (l.entries.length ? "\n" : ""),
            { mode: 0o600 },
          );
      }
    this.peers = new Map();
    this.servers = [];
    this.save();
  }
  save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.db), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  snapshot(peer) {
    const allowed = (w) => peer.host || w.id === peer.workspaceId;
    const workspaces = this.db.workspaces.filter(allowed);
    const ids = new Set(workspaces.map((w) => w.id));
    return {
      workspaces,
      sessions: this.db.sessions.filter((s) => ids.has(s.workspaceId)),
      memories: this.db.memories.filter((m) => ids.has(m.workspaceId)),
      approvals: this.db.approvals.filter((a) => ids.has(a.workspaceId)),
      members: [...this.peers.values()]
        .filter(
          (p) => peer.host || p.workspaceId === peer.workspaceId || p.host,
        )
        .map((p) => ({ id: p.id, name: p.name, host: p.host })),
      me: { id: peer.id, name: peer.name, host: peer.host },
      shared: this.shared,
      version: 1,
    };
  }
  broadcast() {
    this.save();
    for (const [ws, peer] of this.peers)
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ event: "state", data: this.snapshot(peer) }));
    this.emit("change");
  }
  async listen({ host = "127.0.0.1", port = 0 } = {}) {
    this.shared = this.shared || host !== "127.0.0.1";
    const wss = new WebSocketServer({
      host,
      port,
      maxPayload: 2 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const boundPort = wss.address().port;
    this.port ??= boundPort;
    if (host !== "127.0.0.1") this.sharePort = boundPort;
    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 15000);
    heartbeat.unref();
    this.servers.push({ wss, heartbeat });
    wss.on("connection", (ws, req) => {
      ws.on("error", () => {});
      if (wss.clients.size > 128) {
        ws.close(1013, "协作连接数量已达上限");
        return;
      }
      let messageWindow = Date.now(),
        messageCount = 0;
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      // Browser sites cannot speak to a local hub. Native clients have no Origin.
      if (req.headers.origin) {
        ws.close(1008, "不允许浏览器来源");
        return;
      }
      const timeout = setTimeout(() => ws.close(1008, "认证超时"), 5000);
      ws.on("message", (raw) => {
        let msg;
        try {
          if (Date.now() - messageWindow > 1000) {
            messageWindow = Date.now();
            messageCount = 0;
          }
          if (++messageCount > 120) {
            ws.close(1008, "请求过于频繁");
            return;
          }
          msg = JSON.parse(raw.toString());
          if (!msg || typeof msg !== "object") throw Error("请求格式无效");
          if (!this.peers.has(ws)) {
            if (msg.method !== "auth") throw Error("请先验证邀请");
            const { token, secret, name } = msg.args || {};
            const host = eq(token, this.db.hostToken);
            const invite = this.db.invites.find(
              (i) => eq(i.token, token) && !i.revoked && i.expires > Date.now(),
            );
            if (!host && !invite) throw Error("邀请已失效，请向房主索取新邀请");
            text(secret, 200);
            if (secret.length < 32) throw Error("客户端身份无效");
            const peer = {
              id: createHash("sha256")
                .update(secret)
                .digest("hex")
                .slice(0, 24),
              name: text(name, 40),
              host,
              workspaceId: invite?.workspaceId,
              inviteId: invite?.id,
            };
            this.peers.set(ws, peer);
            clearTimeout(timeout);
            ws.send(
              JSON.stringify({ id: msg.id, result: this.snapshot(peer) }),
            );
            this.broadcast();
            return;
          }
          const result = this.act(
            this.peers.get(ws),
            msg.method,
            msg.args || {},
          );
          ws.send(JSON.stringify({ id: msg.id, result }));
          this.broadcast();
        } catch (e) {
          ws.send(JSON.stringify({ id: msg?.id, error: e.message }));
          if (!this.peers.has(ws)) ws.close(1008, "认证失败");
        }
      });
      ws.on("close", () => {
        clearTimeout(timeout);
        const p = this.peers.get(ws);
        this.peers.delete(ws);
        if (p && ![...this.peers.values()].some((v) => v.id === p.id)) {
          for (const s of this.db.sessions)
            for (const l of s.lanes)
              if (l.ownerId === p.id && l.status === "running")
                l.status = "interrupted";
        }
        this.broadcast();
      });
      ws.on("error", () => {});
    });
    return boundPort;
  }
  workspace(peer, workspaceId) {
    const w = this.db.workspaces.find((w) => w.id === workspaceId);
    if (!w || (!peer.host && peer.workspaceId !== w.id))
      throw Error("没有此工作区的访问权限");
    return w;
  }
  session(peer, sessionId) {
    const s = this.db.sessions.find((s) => s.id === sessionId);
    if (!s) throw Error("会话不存在");
    this.workspace(peer, s.workspaceId);
    return s;
  }
  lane(peer, a, owned = true) {
    const s = this.session(peer, a.sessionId);
    const l = s.lanes.find((l) => l.id === a.laneId);
    if (!l || (owned && l.ownerId !== peer.id))
      throw Error("只能操作自己的 Agent 通道");
    return { s, l };
  }
  entry(l, role, value) {
    const entry = {
      id: id(),
      role,
      text: String(value).slice(0, 24000),
      at: now(),
    };
    appendFileSync(
      join(this.transcripts, l.id + ".jsonl"),
      JSON.stringify(entry) + "\n",
      { mode: 0o600 },
    );
    l.entries.push(entry);
    if (l.entries.length > 600) l.entries.splice(0, l.entries.length - 600);
  }
  act(peer, method, a) {
    if (method === "state") return this.snapshot(peer);
    if (method === "workspace.create") {
      if (!peer.host) throw Error("只有房主可以添加工作区");
      const w = {
        id: id(),
        name: text(a.name, 100),
        branch: String(a.branch || "main"),
        remote: String(a.remote || ""),
        at: now(),
      };
      this.db.workspaces.push(w);
      return w;
    }
    if (method === "invite.create") {
      if (!peer.host) throw Error("只有房主可以邀请");
      this.workspace(peer, a.workspaceId);
      const invite = {
        id: id(),
        workspaceId: a.workspaceId,
        token: randomBytes(32).toString("hex"),
        expires: Date.now() + 24 * 3600e3,
      };
      this.db.invites.push(invite);
      return invite;
    }
    if (method === "invite.revoke") {
      if (!peer.host) throw Error("只有房主可以撤销邀请");
      this.workspace(peer, a.workspaceId);
      for (const i of this.db.invites)
        if (i.workspaceId === a.workspaceId) i.revoked = true;
      for (const [ws, p] of this.peers)
        if (!p.host && p.workspaceId === a.workspaceId)
          ws.close(1008, "邀请已撤销");
      return true;
    }
    if (method === "session.create") {
      const w = this.workspace(peer, a.workspaceId);
      const s = {
        id: id(),
        workspaceId: w.id,
        title: text(a.title, 150),
        description: String(a.description || "").slice(0, 5000),
        branch: w.branch,
        status: "active",
        ownerId: peer.id,
        owner: peer.name,
        at: now(),
        lanes: [],
        plan: [],
        comments: [],
        diff: "",
        files: [],
      };
      this.db.sessions.unshift(s);
      return s;
    }
    if (method === "session.export") {
      const s = this.session(peer, a.sessionId);
      return {
        ...s,
        lanes: s.lanes.map((l) => ({
          ...l,
          entries: existsSync(join(this.transcripts, l.id + ".jsonl"))
            ? readFileSync(join(this.transcripts, l.id + ".jsonl"), "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
            : l.entries,
        })),
      };
    }
    if (method === "session.archive") {
      const s = this.session(peer, a.sessionId);
      if (s.lanes.some((l) => ["running", "awaiting"].includes(l.status)))
        throw Error("请先停止运行中的 Agent");
      s.status = a.restore ? "active" : "archived";
      return true;
    }
    if (method === "lane.create") {
      const s = this.session(peer, a.sessionId);
      if (s.status !== "active") throw Error("请先恢复会话");
      if (!["codex", "claude"].includes(a.provider)) throw Error("未知智能体");
      const l = {
        id: id(),
        ownerId: peer.id,
        owner: peer.name,
        provider: a.provider,
        status: "idle",
        entries: [],
        files: [],
      };
      s.lanes.push(l);
      this.entry(
        l,
        "system",
        `${peer.name} 加入了会话 · ${a.provider === "codex" ? "Codex" : "Claude Code"}`,
      );
      return l;
    }
    if (method === "run.request") {
      const { s, l } = this.lane(peer, a);
      if (s.status !== "active") throw Error("会话已归档");
      if (["running", "awaiting"].includes(l.status))
        throw Error("当前通道已有待处理任务");
      if (!["read-only", "workspace-write"].includes(a.mode))
        throw Error("未知权限模式");
      const prompt = text(a.prompt, 20000);
      const files = (a.files || []).slice(0, 30).map((f) => text(f, 500));
      const overlaps = this.db.sessions
        .filter((o) => o.workspaceId === s.workspaceId && o.status === "active")
        .flatMap((o) =>
          o.lanes
            .filter(
              (ol) =>
                ol.id !== l.id &&
                ["running", "awaiting"].includes(ol.status) &&
                files.some((f) => ol.files.includes(f)),
            )
            .map((ol) => `${o.title} / ${ol.owner}`),
        );
      const approval = {
        id: id(),
        workspaceId: s.workspaceId,
        sessionId: s.id,
        laneId: l.id,
        ownerId: peer.id,
        owner: peer.name,
        provider: l.provider,
        prompt,
        mode: a.mode,
        files,
        overlaps,
        status: "pending",
        at: now(),
      };
      this.db.approvals.unshift(approval);
      l.status = "awaiting";
      l.files = files;
      return approval;
    }
    if (method === "approval.decide") {
      const ap = this.db.approvals.find((ap) => ap.id === a.id);
      if (!ap) throw Error("审批不存在");
      this.workspace(peer, ap.workspaceId);
      if (ap.status !== "pending") throw Error("此请求已经处理");
      ap.status = a.allow === true ? "approved" : "rejected";
      ap.reviewer = peer.name;
      ap.reviewedAt = now();
      if (!a.allow) {
        const { l } = this.lane(peer, ap, false);
        l.status = "idle";
        this.entry(l, "system", `${peer.name} 拒绝了本次执行`);
      }
      return ap;
    }
    if (method === "run.claim") {
      const ap = this.db.approvals.find((ap) => ap.id === a.id);
      if (!ap || ap.ownerId !== peer.id || ap.status !== "approved")
        throw Error("任务已经领取或未获批准");
      const { s, l } = this.lane(peer, ap);
      ap.status = "claimed";
      l.status = "running";
      l.activeRunId = ap.id;
      this.entry(l, "user", ap.prompt);
      return {
        approval: ap,
        session: s,
        memories: this.db.memories.filter(
          (m) => m.workspaceId === s.workspaceId && !m.retired,
        ),
      };
    }
    if (method === "run.entry") {
      const { l } = this.lane(peer, a);
      if (l.status !== "running" || l.activeRunId !== a.runId)
        throw Error("执行已结束");
      if (!["assistant", "tool", "system"].includes(a.role))
        throw Error("无效消息");
      this.entry(l, a.role, a.text);
      return true;
    }
    if (method === "run.finish") {
      const { l } = this.lane(peer, a);
      if (a.runId !== l.activeRunId) throw Error("执行标识不匹配");
      l.status = ["done", "error", "interrupted"].includes(a.status)
        ? a.status
        : "error";
      this.entry(l, "system", a.message || "执行结束");
      return true;
    }
    if (method === "lane.stop") {
      const { l } = this.lane(peer, a, false);
      l.stopRequested = now();
      for (const ap of this.db.approvals)
        if (ap.laneId === l.id && ["pending", "approved"].includes(ap.status))
          ap.status = "cancelled";
      if (l.status === "awaiting") {
        l.status = "idle";
        this.entry(l, "system", `${peer.name} 取消了执行请求`);
      }
      return true;
    }
    if (method === "plan.add") {
      const s = this.session(peer, a.sessionId);
      const p = {
        id: id(),
        text: text(a.text, 500),
        owner: peer.name,
        done: false,
      };
      s.plan.push(p);
      return p;
    }
    if (method === "plan.toggle") {
      const s = this.session(peer, a.sessionId);
      const p = s.plan.find((p) => p.id === a.id);
      if (!p) throw Error("计划不存在");
      p.done = !p.done;
      return p;
    }
    if (method === "comment.add") {
      const s = this.session(peer, a.sessionId);
      const c = {
        id: id(),
        owner: peer.name,
        text: text(a.text, 5000),
        anchor: String(a.anchor || "").slice(0, 500),
        at: now(),
      };
      s.comments.push(c);
      return c;
    }
    if (method === "diff.publish") {
      const { s, l } = this.lane(peer, a);
      const diff = String(a.diff || "").slice(0, 150000);
      l.diff = diff;
      l.changedFiles = (a.files || []).slice(0, 300);
      s.diff = diff;
      s.files = l.changedFiles;
      return true;
    }
    if (method === "memory.add") {
      this.workspace(peer, a.workspaceId);
      const m = {
        id: id(),
        workspaceId: a.workspaceId,
        title: text(a.title, 120),
        text: text(a.text, 6000),
        owner: peer.name,
        at: now(),
        retired: false,
      };
      this.db.memories.unshift(m);
      return m;
    }
    if (method === "memory.retire") {
      const m = this.db.memories.find((m) => m.id === a.id);
      if (!m) throw Error("记忆不存在");
      this.workspace(peer, m.workspaceId);
      m.retired = !m.retired;
      return true;
    }
    throw Error("不支持的操作：" + method);
  }
  async close() {
    for (const { heartbeat } of this.servers) clearInterval(heartbeat);
    for (const ws of this.peers.keys()) ws.close();
    await Promise.all(
      this.servers.map(
        ({ wss }) => new Promise((resolve) => wss.close(resolve)),
      ),
    );
    this.servers = [];
    this.save();
  }
}
