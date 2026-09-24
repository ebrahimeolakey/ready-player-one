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
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { ROLES, role, filePath, overlaps, handlesCoordination, coordination } from "./coordination.mjs";
import { handlesRunCoordination, runCoordination, claimKeyHash } from "./coordination-runs.mjs";
import { handlesHandoffs, handoffs } from "./coordination-handoffs.mjs";
import { SecureStore, redactRecord, redactText, retainedTranscriptEntries } from "./secure-store.mjs";
import { TeamIdentity, githubLogin } from "./team-identity.mjs";
const id = () => randomUUID();
const transcriptText = value => redactText(String(value)).replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]*/g, "[凭据已隐藏]");
const transcriptEntry = entry => ({ ...redactRecord(entry), text: transcriptText(entry.text || "") });
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
  constructor(dir, { store, retentionDays, identityVerifier } = {}) {
    super();
    if (!(store instanceof SecureStore)) throw Error("Hub 必须注入 SecureStore；缺少安全存储时不会回退为明文");
    this.store = store;
    this.rawEntries = new Map();
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (store.dir !== realpathSync(dir)) throw Error("SecureStore 与 Hub 数据目录不一致");
    this.file = "hub.json";
    this.transcripts = join(dir, "transcripts");
    mkdirSync(this.transcripts, { recursive: true, mode: 0o700 });
    try {
      store.migrateLegacy();
      store.migrateFile("hub.json.tmp", "json");
      this.db = store.readJSON(this.file);
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
    this.db.members ??= [];
    this.db.locks ??= [];
    this.db.messages ??= [];
    this.db.toolApprovals ??= [];
    this.db.handoffs ??= [];
    this.db.subtasks ??= [];
    this.identity = new TeamIdentity(this, identityVerifier);
    for (const s of this.db.sessions) {
      for (const p of s.plan || []) { p.status ??= p.done ? "done" : "todo"; p.assigneeId ??= null; }
      for (const c of s.comments || []) c.status ??= "open";
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
        l.entries = l.entries.map(transcriptEntry);
        const log = this.logName(l);
        store.recoverFile(log, "jsonl");
        if (!store.exists(log)) store.writeJSONL(log, l.entries);
        else store.readJSONL(log); // Fail closed on corrupt/transplanted transcripts before any broadcast.
      }
    this.db.storage ??= { retentionDays: null };
    if (retentionDays !== undefined) this.db.storage.retentionDays = this.validRetention(retentionDays);
    this.peers = new Map();
    this.servers = [];
    this.cleanupTranscripts();
    this.retentionTimer = setInterval(() => { try { this.cleanupTranscripts(); this.broadcast(); } catch (error) { this.emit("storage-error", error); } }, 24 * 3600e3);
    this.retentionTimer.unref();
    this.save();
  }
  logName(lane) { return `transcripts/${lane.id}.jsonl`; }
  validRetention(days) {
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) throw Error("转录保留期应为 1–36500 天或永久保留");
    return days;
  }
  cleanupTranscripts(clock = Date.now()) {
    const days = this.validRetention(this.db.storage.retentionDays);
    if (days === null) return { removedEntries: 0 };
    const active = this.db.sessions.flatMap(s => s.lanes).filter(l => ["running", "awaiting"].includes(l.status) || this.db.approvals.some(a => a.laneId === l.id && a.status === "claimed"));
    const result = this.store.cleanupTranscripts({ days, now: clock, activeNames: active.map(l => this.logName(l)) });
    for (const s of this.db.sessions) for (const l of s.lanes) if (!active.includes(l)) l.entries = retainedTranscriptEntries(l.entries, result.cutoff);
    this.db.storage.lastCleanupAt = new Date(clock).toISOString();
    return result;
  }
  save() { this.store.writeJSON(this.file, this.db); }
  snapshot(peer) {
    const allowed = (w) => peer.host || w.id === peer.workspaceId;
    const workspaces = this.db.workspaces.filter(allowed);
    const ids = new Set(workspaces.map((w) => w.id));
    return redactRecord({
      workspaces,
      sessions: this.db.sessions.filter((s) => ids.has(s.workspaceId)),
      memories: this.db.memories.filter((m) => ids.has(m.workspaceId)),
      approvals: this.db.approvals.filter((a) => ids.has(a.workspaceId)),
      toolApprovals: this.db.toolApprovals.filter((a) => ids.has(a.workspaceId)),
      handoffs: this.db.handoffs.filter(h => ids.has(h.workspaceId)),
      subtasks: this.db.subtasks.filter(t => ids.has(t.workspaceId)),
      members: this.db.members.filter(m => ids.has(m.workspaceId) && !m.removed).map(m => ({ ...m, online: [...this.peers.values()].some(p => p.id === m.id && (p.host || p.workspaceId === m.workspaceId)) })),
      locks: this.db.locks.filter(l => ids.has(l.workspaceId) && l.expires > Date.now()),
      messages: this.db.messages.filter(m => ids.has(m.workspaceId)),
      me: { id: peer.id, name: peer.name, host: peer.host, github: this.db.identities.find(v => v.peerId === peer.id)?.github, role: peer.host ? "owner" : this.role(peer, peer.workspaceId), roles: Object.fromEntries(workspaces.map(w => [w.id, this.role(peer, w.id)])) },
      identity: this.identity.info,
      storage: { encrypted: true, ...this.db.storage },
      shared: this.shared,
      version: 1,
    });
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
            if (msg.method === "identity.begin") {
              const args = msg.args || {};
              const host = eq(args.token, this.db.hostToken);
              const invite = this.db.invites.find(i => eq(i.token, args.token) && !i.revoked && i.expires > Date.now());
              if (!host && !invite) throw Error("邀请已失效，请向房主索取新邀请");
              text(args.secret, 200); if (args.secret.length < 32) throw Error("客户端身份无效");
              const peerId = createHash("sha256").update(args.secret).digest("hex").slice(0, 24);
              const result = this.identity.begin(peerId, host ? undefined : invite.workspaceId);
              ws.send(JSON.stringify({ id: msg.id, result }));
              return;
            }
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
            if (!host && this.db.members.some(m => m.id === peer.id && m.workspaceId === invite.workspaceId && m.removed)) throw Error("此成员已被移除");
            const verified = this.identity.authenticate(peer.id, msg.args || {}, peer.workspaceId, invite?.githubLogin);
            peer.github = verified.github;
            if (invite?.githubLogin) {
              const existingMember = this.db.members.find(m => m.id === peer.id && m.workspaceId === invite.workspaceId && !m.removed);
              if (!msg.args.identityProof && !existingMember?.inviteIds?.includes(invite.id)) throw Error("用户名邀请首次加入需要重新验证 GitHub 身份");
              if (invite.boundGithubId && invite.boundGithubId !== peer.github?.id) throw Error("此邀请已绑定其他 GitHub 账号");
              invite.boundGithubId = peer.github.id;
            }
            if (host) {
              for (const w of this.db.workspaces) this.registerMember(peer, w.id, "owner");
            } else {
              const member = this.registerMember(peer, invite.workspaceId, role(invite.role));
              member.inviteIds ??= [];
              if (!member.inviteIds.includes(invite.id)) member.inviteIds.push(invite.id);
            }
            this.peers.set(ws, peer);
            clearTimeout(timeout);
            this.broadcast();
            ws.send(
              JSON.stringify({ id: msg.id, result: { ...this.snapshot(peer), ...(verified.grant || {}) } }),
            );
            return;
          }
          const result = this.act(
            this.peers.get(ws),
            msg.method,
            msg.args || {},
          );
          this.broadcast();
          ws.send(JSON.stringify({ id: msg.id, result }));
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
                l.offlineSince = now();
        }
        this.broadcast();
      });
      ws.on("error", () => {});
    });
    return boundPort;
  }
  registerMember(peer, workspaceId, memberRole) {
    let member = this.db.members.find(m => m.id === peer.id && m.workspaceId === workspaceId);
    if (member?.removed && !peer.host) throw Error("此成员已被移除");
    if (!member) {
      member = { id: peer.id, name: peer.name, workspaceId, role: memberRole, host: peer.host, at: now() };
      this.db.members.push(member);
    } else {
      member.name = peer.name;
      if (peer.host) Object.assign(member, { role: "owner", host: true, removed: false });
    }
    if (peer.github) member.github = { id: peer.github.id, login: peer.github.login, verifiedAt: peer.github.verifiedAt };
    return member;
  }
  role(peer, workspaceId) {
    if (peer.host) return "owner";
    const member = this.db.members.find(m => m.id === peer.id && m.workspaceId === workspaceId && !m.removed);
    return member?.role || "viewer";
  }
  fenceMember(workspaceId, memberId) {
    for (const s of this.db.sessions.filter(s => s.workspaceId === workspaceId))
      for (const l of s.lanes.filter(l => l.ownerId === memberId)) {
        if (["running", "awaiting"].includes(l.status)) {
          l.stopRequested = now(); l.fencedRunId = l.activeRunId; l.status = "interrupted";
          this.entry(l, "system", "成员权限已改变，执行已停止");
        }
      }
    for (const ap of this.db.approvals)
      if (ap.workspaceId === workspaceId && ap.ownerId === memberId && ["pending", "approved"].includes(ap.status)) ap.status = "cancelled";
    this.db.locks = this.db.locks.filter(l => l.workspaceId !== workspaceId || l.ownerId !== memberId);
    for (const t of this.db.toolApprovals)
      if (t.workspaceId === workspaceId && t.ownerId === memberId && t.status === "pending") t.status = "cancelled";
  }
  authorize(peer, method, a) {
    if (["state", "workspace.create", "identity.begin", "identity.bind", "identity.revoke"].includes(method)) return;
    let workspaceId = a.workspaceId;
    if (a.sessionId) workspaceId = this.session(peer, a.sessionId).workspaceId;
    if (["approval.decide", "run.claim"].includes(method)) workspaceId = this.db.approvals.find(v => v.id === a.id)?.workspaceId;
    if (method.startsWith("handoff.") && a.id) workspaceId = this.db.handoffs.find(v => v.id === a.id)?.workspaceId;
    if (method.startsWith("subtask.") && a.id) workspaceId = this.db.subtasks.find(v => v.id === a.id)?.workspaceId;
    if (["tool.decide", "tool.claim"].includes(method)) workspaceId = this.db.toolApprovals.find(v => v.id === a.id)?.workspaceId;
    if (["memory.update", "memory.retire"].includes(method)) workspaceId = this.db.memories.find(v => v.id === a.id)?.workspaceId;
    if (!workspaceId) return; // The target handler supplies its specific missing-resource error.
    this.workspace(peer, workspaceId);
    const required = ["invite.create", "invite.revoke", "member.role", "member.remove"].includes(method) ? "owner"
      : ["session.export", "coordination.context"].includes(method) ? "viewer"
      : ["comment.add", "comment.resolve", "plan.add", "plan.claim", "plan.status", "plan.toggle", "plan.transfer", "plan.transfer.accept", "plan.transfer.decline"].includes(method) ? "commenter" : "editor";
    if (ROLES.indexOf(this.role(peer, workspaceId)) < ROLES.indexOf(required)) throw Error(`此操作需要 ${required} 权限`);
  }
  workspace(peer, workspaceId) {
    const w = this.db.workspaces.find((w) => w.id === workspaceId);
    if (!w || (!peer.host && (peer.workspaceId !== w.id || this.db.members.some(m => m.workspaceId === w.id && m.id === peer.id && m.removed))))
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
  entry(l, role, value, metadata = {}) {
    const entry = {
      id: id(),
      role,
      text: transcriptText(value).slice(0, 24000),
      at: now(),
      ...metadata,
    };
    this.store.appendJSONL(this.logName(l), entry);
    l.entries.push(entry);
    if (l.entries.length > 600) l.entries.splice(0, l.entries.length - 600);
    return entry;
  }
  act(peer, method, a) {
    this.authorize(peer, method, a);
    if (handlesCoordination(method)) return coordination(this, peer, method, a);
    if (handlesRunCoordination(method)) return runCoordination(this, peer, method, a);
    if (handlesHandoffs(method)) return handoffs(this, peer, method, a);
    if (method === "state") return this.snapshot(peer);
    if (method === "identity.begin") return this.identity.begin(peer.id, peer.workspaceId);
    if (method === "identity.bind") {
      const result = this.identity.bind(peer, a.proof);
      peer.github = result.github;
      return result;
    }
    if (method === "identity.revoke") {
      const memberId = a.memberId || peer.id;
      if (memberId !== peer.id && !peer.host) throw Error("只能撤销自己的登录状态");
      this.identity.revoke(memberId);
      for (const [ws, connected] of this.peers) if (connected.id === memberId) queueMicrotask(() => ws.close(1008, "GitHub 团队登录已撤销"));
      return true;
    }
    if (method === "storage.retention") {
      if (!peer.host) throw Error("只有本机房主可以修改转录保留期");
      this.db.storage.retentionDays = this.validRetention(a.days);
      const cleaned = this.cleanupTranscripts();
      return { ...this.db.storage, ...cleaned };
    }
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
      this.registerMember(peer, w.id, "owner");
      return w;
    }
    if (method === "invite.create") {
      this.workspace(peer, a.workspaceId);
      if (a.githubLogin && !this.identity.info.configured) throw Error("请先配置 GitHub 团队身份服务");
      const login = a.githubLogin ? githubLogin(a.githubLogin) : undefined;
      const invite = {
        id: id(),
        workspaceId: a.workspaceId,
        token: randomBytes(32).toString("hex"),
        role: role(a.role),
        ...(login ? { githubLogin: login } : {}),
        expires: Date.now() + 24 * 3600e3,
      };
      this.db.invites.push(invite);
      return invite;
    }
    if (method === "invite.revoke") {
      this.workspace(peer, a.workspaceId);
      for (const i of this.db.invites)
        if (i.workspaceId === a.workspaceId) i.revoked = true;
      for (const member of this.db.members)
        if (!member.host && member.workspaceId === a.workspaceId) this.fenceMember(a.workspaceId, member.id);
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
      return redactRecord({
        ...s,
        lanes: s.lanes.map(l => ({ ...l, entries: [...new Map(this.store.readJSONL(this.logName(l)).map(entry => [entry.id, transcriptEntry(entry)])).values()] })),
      });
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
      if (!["codex", "claude"].includes(a.provider) && !/^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.provider || "")) throw Error("未知智能体");
      if (Object.keys(a).some(k => /^(apiKey|api_key|key|secret|token|encryptedKey|baseUrl|headers|authorization|runtimeConfig)$/i.test(k))) throw Error("协作通道只允许 Provider 标识与短名称，不接收密钥或连接配置");
      const providerLabel = text(a.providerLabel || (a.provider === "codex" ? "Codex" : a.provider === "claude" ? "Claude Code" : "自定义 Provider"), 80);
      if (transcriptText(providerLabel) !== providerLabel || /[\r\n]/.test(providerLabel)) throw Error("Provider 名称不能包含凭据或换行");
      const l = {
        id: id(),
        ownerId: peer.id,
        owner: peer.name,
        provider: a.provider,
        providerLabel,
        status: "idle",
        entries: [],
        files: [],
      };
      s.lanes.push(l);
      this.entry(
        l,
        "system",
        `${peer.name} 加入了会话 · ${providerLabel}`,
      );
      return l;
    }
    if (method === "run.request") {
      const { s, l } = this.lane(peer, a);
      if (s.status !== "active") throw Error("会话已归档");
      if (this.db.handoffs.some(h => h.laneId === l.id && h.status === "ready")) throw Error("此通道正在等待确认接管");
      if (["running", "awaiting"].includes(l.status))
        throw Error("当前通道已有待处理任务");
      if (!["read-only", "workspace-write"].includes(a.mode))
        throw Error("未知权限模式");
      const prompt = text(a.prompt, 20000);
      if (!Array.isArray(a.files || [])) throw Error("文件列表无效");
      const files = (a.files || []).slice(0, 30).map(filePath);
      const overlapDetails = overlaps(this, s, l, prompt, files);
      const overlapNames = [...new Set(overlapDetails.map(d => `${this.db.sessions.find(v => v.id === d.sessionId)?.title || "文件锁"} / ${d.owner}`))];
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
        overlaps: overlapNames,
        overlapDetails,
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
      if (!ap || ap.ownerId !== peer.id) throw Error("任务已经领取或未获批准");
      const { s, l } = this.lane(peer, ap);
      const keyHash = claimKeyHash(a.claimKey);
      const result = () => ({ approval: ap, session: s, memories: this.db.memories.filter(m => m.workspaceId === s.workspaceId && !m.retired) });
      if (ap.status === "claimed" && keyHash && ap.claimKeyHash === keyHash && l.activeRunId === ap.id && ["running", "interrupted"].includes(l.status) && !l.stopRequested && l.fencedRunId !== ap.id) return result();
      if (ap.status !== "approved") throw Error("任务已经领取或未获批准");
      ap.claimKeyHash = keyHash;
      ap.status = "claimed";
      l.status = "running";
      l.activeRunId = ap.id;
      delete l.stopRequested;
      delete l.offlineSince;
      l.acceptedEventIds = [];
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
      if (l.status !== "running" || l.activeRunId !== a.runId || l.stopRequested || l.fencedRunId === a.runId)
        throw Error("执行已结束");
      if (!["assistant", "tool", "system"].includes(a.role)) throw Error("无效消息");
      const eventId = a.eventId === undefined ? undefined : text(a.eventId, 200);
      l.acceptedEventIds ??= [];
      if (eventId && l.acceptedEventIds.includes(eventId)) return { accepted: true, duplicate: true };
      if (l.acceptedEventIds.length >= 100000) throw Error("本次执行事件数量超过限制");
      const entryId = a.entryId === undefined ? undefined : text(a.entryId, 200);
      if (a.delta && !entryId) throw Error("流式输出需要 entryId");
      const previous = entryId && l.entries.find(e => e.id === entryId && e.runId === a.runId);
      if (previous && previous.role !== a.role) throw Error("不能更改流式消息角色");
      const bufferKey = `${l.id}:${a.runId}:${entryId || eventId || id()}`;
      let displayText;
      if (a.delta) {
        let buffer = this.rawEntries.get(bufferKey);
        if (!buffer) buffer = { raw: "", blocked: Boolean(previous?.streaming) };
        if (!buffer.blocked) buffer.raw += String(a.text || "");
        if (buffer.raw.length > 256 * 1024) { buffer.raw = ""; buffer.blocked = true; }
        this.rawEntries.set(bufferKey, buffer);
        displayText = buffer.blocked ? "[流式记录等待完整输出后脱敏]" : transcriptText(buffer.raw);
      } else { displayText = transcriptText(a.text || ""); this.rawEntries.delete(bufferKey); }
      if (previous) {
        if (previous.role !== a.role) throw Error("不能更改流式消息角色");
        previous.text = displayText.slice(0, 24000); previous.streaming = Boolean(a.delta);
        previous.updatedAt = now();
        this.store.appendJSONL(this.logName(l), previous);
      } else {
        if (entryId && l.entries.some(e => e.id === entryId)) throw Error("消息标识已使用");
        this.entry(l, a.role, displayText, { runId: a.runId, streaming: Boolean(a.delta), ...(entryId ? { id: entryId } : {}) });
      }
      if (eventId) l.acceptedEventIds.push(eventId);
      return { accepted: true, duplicate: false };
    }
    if (method === "run.finish") {
      const { l } = this.lane(peer, a);
      if (a.runId !== l.activeRunId) throw Error("执行标识不匹配");
      if (l.finishedRunId === a.runId) return true;
      if (l.fencedRunId === a.runId) throw Error("执行已撤销");
      l.status = ["done", "error", "interrupted"].includes(a.status)
        ? a.status
        : "error";
      for (const key of this.rawEntries.keys()) if (key.startsWith(`${l.id}:${a.runId}:`)) this.rawEntries.delete(key);
      for (const instruction of l.steering || []) if (instruction.runId === a.runId && instruction.status === "pending") Object.assign(instruction, { status: "failed", message: "执行已结束", acknowledgedAt: now() });
      l.finishedRunId = a.runId;
      const approval = this.db.approvals.find(ap => ap.id === a.runId);
      if (approval) approval.status = "finished";
      for (const t of this.db.toolApprovals) if (t.runId === a.runId && t.status === "pending") t.status = "cancelled";
      this.entry(l, "system", a.message || "执行结束");
      return true;
    }
    if (method === "lane.stop") {
      const { l } = this.lane(peer, a, false);
      l.stopRequested = now();
      l.fencedRunId = l.activeRunId;
      for (const instruction of l.steering || []) if (instruction.runId === l.activeRunId && instruction.status === "pending") Object.assign(instruction, { status: "failed", message: "执行已停止", acknowledgedAt: now() });
      if (l.status === "running") l.status = "interrupted";
      for (const t of this.db.toolApprovals) if (t.laneId === l.id && t.status === "pending") t.status = "cancelled";
      for (const ap of this.db.approvals)
        if (ap.laneId === l.id && ["pending", "approved"].includes(ap.status))
          ap.status = "cancelled";
      if (l.status === "awaiting") {
        l.status = "idle";
        this.entry(l, "system", `${peer.name} 取消了执行请求`);
      }
      return true;
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
    if (method === "snapshot.publish") {
      const { s, l } = this.lane(peer, a);
      const ref = String(a.ref || "");
      if (ref !== `refs/rpo/snapshots/${s.id}/${peer.id}` || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(a.commit || "")) throw Error("快照引用或 commit 无效");
      l.snapshot = { ref, commit: a.commit.toLowerCase(), at: now(), ownerId: peer.id, laneId: l.id, sessionId: s.id };
      s.snapshots ??= [];
      s.snapshots = s.snapshots.filter(v => v.laneId !== l.id);
      s.snapshots.push(l.snapshot);
      return l.snapshot;
    }
    if (method === "snapshot.status") {
      const { l } = this.lane(peer, a);
      if (!["synced", "conflict", "paused", "syncing", "error"].includes(a.status)) throw Error("同步状态无效");
      l.snapshotStatus = { status: a.status, message: String(a.message || "").slice(0, 2000), at: now() };
      return l.snapshotStatus;
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
    clearInterval(this.retentionTimer);
    this.rawEntries.clear();
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
