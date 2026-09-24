import { filePath } from "./coordination-paths.mjs";
import { fileScopes, branchName, planIds, overlaps, scopeOverlap } from "./overlap.mjs";
export { filePath } from "./coordination-paths.mjs";
export { overlaps } from "./overlap.mjs";
import { redactRecord } from "./secure-store.mjs";
import { randomUUID } from "node:crypto";

export const ROLES = ["viewer", "commenter", "editor", "owner"];
const stamp = () => new Date().toISOString();
const uid = () => randomUUID();
const str = (value, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error("内容为空或超过长度限制");
  return value.trim();
};
export function role(value = "editor") {
  if (!ROLES.includes(value)) throw Error("未知成员角色");
  return value;
}
const revision = value => {
  if (typeof value !== "string" || !/^[a-f0-9]{7,64}$/i.test(value)) throw Error("需要有效的 commit 或内容哈希");
  return value.toLowerCase();
};
function references(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw Error("最多关联 100 个文件");
  return value.map(f => ({ path: filePath(f.path), commit: revision(f.commit), ...(f.hash ? { hash: revision(f.hash) } : {}) }));
}
function location(value) {
  if (!value) return undefined;
  const startLine = Number(value.startLine), endLine = Number(value.endLine ?? startLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > 10000000) throw Error("代码行范围无效");
  if (value.side && !["left", "right"].includes(value.side)) throw Error("diff 方向无效");
  return { path: filePath(value.path), startLine, endLine, commit: revision(value.commit), ...(value.hash ? { hash: revision(value.hash) } : {}), side: value.side || "right" };
}

const methods = new Set(["member.role", "member.remove", "plan.add", "plan.toggle", "plan.assign", "plan.claim", "plan.status", "plan.transfer", "plan.transfer.accept", "plan.transfer.decline", "comment.add", "comment.resolve", "comment.task", "comment.check", "memory.add", "memory.update", "memory.check", "lock.acquire", "lock.renew", "lock.release", "coordination.context", "coordination.message", "coordination.activity", "coordination.check"]);
export function handlesCoordination(method) { return method === "memory.list" || methods.has(method); }
export function coordination(hub, peer, method, a) {
  const sessionWorkspaceId = a.sessionId ? hub.session(peer, a.sessionId).workspaceId : undefined;
  if (sessionWorkspaceId && a.workspaceId && sessionWorkspaceId !== a.workspaceId) throw Error("工作区与当前会话不匹配");
  const workspaceId = sessionWorkspaceId || a.workspaceId;
  const member = memberId => {
    const value = hub.db.members.find(m => m.workspaceId === workspaceId && m.id === memberId && !m.removed);
    if (!value || ROLES.indexOf(value.role) < 1) throw Error("负责人必须是此工作区的 Commenter、Editor 或 Owner");
    return value;
  };
  const plan = () => {
    const s = hub.session(peer, a.sessionId), p = s.plan.find(p => p.id === a.id);
    if (!p) throw Error("计划不存在");
    return { s, p };
  };
  const record = (p, action) => { p.updatedAt = stamp(); (p.history ??= []).push({ actorId: peer.id, actor: peer.name, action, at: p.updatedAt }); };
  if (method === "member.role" || method === "member.remove") {
    hub.workspace(peer, workspaceId);
    const m = hub.db.members.find(m => m.workspaceId === workspaceId && m.id === a.memberId && !m.removed);
    if (!m) throw Error("成员不存在");
    if (m.host) throw Error("本机房主角色不能修改");
    const next = method === "member.remove" ? null : role(a.role);
    if (m.role === "owner" && next !== "owner" && hub.db.members.filter(v => v.workspaceId === workspaceId && !v.removed && v.role === "owner").length === 1) throw Error("必须保留至少一位 Owner");
    if (next) m.role = next; else m.removed = true;
    if (!next || ROLES.indexOf(next) < 2) hub.fenceMember(workspaceId, m.id);
    if (!next) for (const [ws, p] of hub.peers) if (p.workspaceId === workspaceId && p.id === m.id) ws.close(1008, "已移除此成员");
    return m;
  }
  if (method === "plan.add") {
    const s = hub.session(peer, a.sessionId);
    const assignee = a.assigneeId ? member(a.assigneeId) : null;
    if (hub.role(peer, workspaceId) === "commenter" && assignee && assignee.id !== peer.id) throw Error("Commenter 只能创建自己的计划");
    const p = { id: uid(), text: str(a.text, 500), fileScopes: fileScopes(a.files, a.fileScopes), owner: peer.name, ownerId: peer.id, done: false, status: "todo", assigneeId: assignee?.id || null, assignee: assignee?.name || null, history: [], at: stamp() };
    record(p, "created"); s.plan.push(p); return p;
  }
  if (method.startsWith("plan.")) {
    const { p } = plan();
    const commenter = hub.role(peer, workspaceId) === "commenter";
    if (method === "plan.transfer.accept" || method === "plan.transfer.decline") {
      const transfer = p.transferRequest;
      if (!transfer || !["awaiting-release", "awaiting-accept"].includes(transfer.status)) throw Error("没有待处理的转交");
      if (method === "plan.transfer.decline") {
        if (![transfer.fromId, transfer.toId, transfer.requestedBy].includes(peer.id)) throw Error("只有转交参与者可以拒绝");
        transfer.status = "declined"; transfer.respondedAt = stamp(); record(p, "transfer-declined"); return p;
      }
      const expected = transfer.status === "awaiting-release" ? transfer.fromId : transfer.toId;
      if (peer.id !== expected) throw Error("请由当前待确认的成员同意转交");
      if (transfer.status === "awaiting-release") transfer.status = "awaiting-accept";
      else {
        const recipient = member(transfer.toId);
        p.assigneeId = recipient.id; p.assignee = recipient.name; transfer.status = "accepted";
      }
      transfer.respondedAt = stamp(); record(p, `transfer-${transfer.status}`); return p;
    }
    if (commenter && !["plan.claim", "plan.transfer"].includes(method) && !(p.assigneeId === peer.id || (!p.assigneeId && p.ownerId === peer.id))) throw Error("Commenter 只能管理自己负责的计划");
    if (method === "plan.toggle" || method === "plan.status") {
      const status = method === "plan.toggle" ? (p.done ? "todo" : "done") : a.status;
      if (!["todo", "in-progress", "blocked", "done"].includes(status)) throw Error("未知计划状态");
      p.status = status; p.done = status === "done"; record(p, status);
    } else {
      if (method === "plan.claim" && p.assigneeId && p.assigneeId !== peer.id) throw Error("计划已由其他成员领取，请先转交");
      if (method === "plan.transfer" && p.assigneeId && p.assigneeId !== peer.id && hub.role(peer, workspaceId) !== "owner") throw Error("只有负责人或 Owner 可以转交计划");
      if (method === "plan.assign" && p.assigneeId && p.assigneeId !== peer.id && hub.role(peer, workspaceId) !== "owner") throw Error("只有负责人或 Owner 可以重新分配计划");
      if (method === "plan.transfer" && !a.assigneeId) throw Error("请选择接收步骤的成员");
      const assigned = method === "plan.claim" ? member(peer.id) : (a.assigneeId ? member(a.assigneeId) : null);
      if (["plan.transfer", "plan.assign"].includes(method) && p.assigneeId && p.assigneeId !== assigned?.id && ["in-progress", "blocked"].includes(p.status)) {
        if (!assigned) throw Error("进行中步骤不能直接移除负责人，请转交并等待同意");
        if (["awaiting-release", "awaiting-accept"].includes(p.transferRequest?.status)) throw Error("已有待确认的转交");
        p.transferRequest = { id: uid(), fromId: p.assigneeId, from: p.assignee, toId: assigned.id, to: assigned.name, requestedBy: peer.id, status: peer.id === p.assigneeId ? "awaiting-accept" : "awaiting-release", at: stamp() };
        record(p, "transfer-requested"); return p;
      }
      p.assigneeId = assigned?.id || null; p.assignee = assigned?.name || null;
      if (method === "plan.claim") { p.status = "in-progress"; p.done = false; }
      record(p, `${method}:${p.assigneeId || "unassigned"}`);
    }
    return p;
  }
  if (method === "comment.add") {
    const s = hub.session(peer, a.sessionId), loc = location(a.location);
    const c = { id: uid(), owner: peer.name, ownerId: peer.id, text: str(a.text, 5000), anchor: String(a.anchor || (loc ? `${loc.path}:${loc.startLine}-${loc.endLine}` : "")).slice(0, 500), ...(loc ? { location: loc } : {}), status: "open", at: stamp() };
    s.comments.push(c); return c;
  }
  if (method === "comment.check") {
    const s = hub.session(peer, a.sessionId), files = references(a.files);
    for (const c of s.comments) if (c.location) {
      const file = files.find(f => f.path === c.location.path);
      if (file) { c.stale = c.location.hash && file.hash ? c.location.hash !== file.hash : file.commit !== c.location.commit; c.checkedAt = stamp(); }
    }
    return s.comments;
  }
  if (method === "comment.resolve" || method === "comment.task") {
    const s = hub.session(peer, a.sessionId), c = s.comments.find(c => c.id === a.id);
    if (!c) throw Error("评论不存在");
    if (method === "comment.resolve") { c.status = a.restore ? "open" : "resolved"; c.resolvedBy = peer.name; c.resolvedAt = stamp(); return c; }
    if (c.taskId) throw Error("此评论已转为任务");
    // Validate all optional execution inputs before creating the plan.
    const assignee = a.assigneeId ? member(a.assigneeId) : null;
    if (a.laneId) hub.lane(peer, { sessionId: s.id, laneId: a.laneId });
    const prompt = a.prompt ? str(a.prompt, 20000) : `处理评论：${c.text}${c.anchor ? `\n位置：${c.anchor}` : ""}`;
    const taskText = str(a.text === undefined ? c.text.slice(0, 500) : a.text, 500);
    let approval;
    if (a.laneId) approval = hub.act(peer, "run.request", { sessionId: s.id, laneId: a.laneId, prompt, mode: a.mode || "read-only", files: c.location ? [c.location.path] : [] });
    const p = coordination(hub, peer, "plan.add", { sessionId: s.id, text: taskText, assigneeId: assignee?.id, fileScopes:c.location ? [{path:c.location.path,kind:"file"}] : [] });
    if(approval) { approval.planIds = [p.id]; hub.refreshOverlaps(approval); }
    p.commentId = c.id; c.taskId = p.id; c.status = "task"; if (approval) c.approvalId = approval.id;
    return { plan: p, approval, comment: c };
  }
  if (method === "memory.list") {
    hub.workspace(peer, workspaceId);
    if (a.includeRetired !== undefined && typeof a.includeRetired !== "boolean") throw Error("includeRetired 必须为布尔值");
    return redactRecord(hub.db.memories.filter(m => m.workspaceId === workspaceId && (a.includeRetired === true || !m.retired)));
  }
  if (method === "memory.add" || method === "memory.update") {
    let m = method === "memory.update" ? hub.db.memories.find(m => m.id === a.id) : null;
    if (method === "memory.update" && !m) throw Error("记忆不存在");
    hub.workspace(peer, m?.workspaceId || workspaceId);
    const update = { title: str(a.title ?? m?.title, 120), text: str(a.text ?? m?.text, 6000), files: a.files === undefined ? m?.files || [] : references(a.files), updatedAt: stamp() };
    if (m) { Object.assign(m, update, ...(a.files !== undefined ? [{ stale: false, staleFiles: [] }] : [])); return m; }
    m = { id: uid(), workspaceId, ...update, owner: peer.name, ownerId: peer.id, at: stamp(), retired: false, stale: false, staleFiles: [] };
    hub.db.memories.unshift(m); return m;
  }
  if (method === "memory.check") {
    hub.workspace(peer, workspaceId);
    const files = references(a.files), changed = [];
    for (const m of hub.db.memories.filter(m => m.workspaceId === workspaceId && !m.retired)) {
      const stale = new Map((m.staleFiles || []).map(f => [f.path, f]));
      for (const reference of m.files || []) {
        const file = files.find(f => f.path === reference.path);
        if (!file) continue;
        // File content equality avoids invalidating a memory for unrelated commits.
        const equal = reference.hash && file.hash ? reference.hash === file.hash : reference.commit === file.commit;
        if (equal) stale.delete(reference.path); else stale.set(reference.path, { path: reference.path, previousCommit: reference.commit, currentCommit: file.commit });
      }
      m.staleFiles = [...stale.values()]; m.stale = m.staleFiles.length > 0; m.checkedAt = stamp(); changed.push(m);
    }
    return changed;
  }
  if (method.startsWith("lock.")) {
    hub.workspace(peer, workspaceId);
    hub.db.locks = hub.db.locks.filter(l => l.expires > Date.now());
    const ttl = a.ttlMs === undefined ? 300000 : Number(a.ttlMs);
    if (method !== "lock.release" && (!Number.isFinite(ttl) || ttl < 1000 || ttl > 1800000)) throw Error("文件锁时长应在 1 秒至 30 分钟之间");
    if (method === "lock.acquire") {
      const { s, l } = hub.lane(peer, a), scope = a.kind === undefined ? fileScopes([a.path])[0] : fileScopes([], [{path:a.path,kind:a.kind}])[0], {path,kind} = scope;
      const conflicts = hub.db.locks.filter(lock => lock.workspaceId === workspaceId && lock.ownerId !== peer.id && scopeOverlap({path:lock.path,kind:lock.kind || "unknown"},scope));
      if (conflicts.length) return { acquired: false, conflicts };
      const existing = hub.db.locks.find(lock => lock.workspaceId === workspaceId && lock.laneId === l.id && lock.path === path);
      if (existing) { existing.expires = Date.now() + ttl; existing.kind = kind; return { acquired: true, lock: existing }; }
      const lock = { id: uid(), workspaceId: s.workspaceId, sessionId: s.id, laneId: l.id, path, kind, ownerId: peer.id, owner: peer.name, at: stamp(), expires: Date.now() + ttl };
      hub.db.locks.push(lock); return { acquired: true, lock };
    }
    const lock = hub.db.locks.find(l => l.id === a.id && l.workspaceId === workspaceId);
    if (!lock) throw Error("文件锁已过期或不存在");
    if (lock.ownerId !== peer.id && hub.role(peer, workspaceId) !== "owner") throw Error("只能操作自己的文件锁");
    if (method === "lock.renew") { lock.expires = Date.now() + ttl; return lock; }
    hub.db.locks = hub.db.locks.filter(l => l !== lock); return true;
  }
  if (method === "coordination.activity" || method === "coordination.check") {
    const {s,l} = hub.lane(peer,a);
    if(s.status !== "active") throw Error("会话已归档");
    const scopes = fileScopes(a.files,a.fileScopes), linked = planIds(s,a.planIds), branch = branchName(a.branch);
    if(method === "coordination.check") return redactRecord({algorithm:"deterministic-v1",advisory:true,checkedAt:stamp(),details:overlaps(hub,s,l,String(a.prompt || "").slice(0,20000),[],{scopes,planIds:linked,branch})});
    const ttl = a.ttlMs === undefined ? 120000 : a.ttlMs;
    if(!Number.isInteger(ttl) || ttl < 1000 || ttl > 300000) throw Error("活动信息有效期应在 1 秒至 5 分钟之间");
    l.activity = {fileScopes:scopes,planIds:linked || [],branch:branch || null,at:stamp(),expires:Date.now()+ttl};
    return l.activity;
  }
  if (method === "coordination.context") {
    const s = hub.session(peer, a.sessionId);
    return redactRecord({ session: s, memories: hub.db.memories.filter(m => m.workspaceId === s.workspaceId && !m.retired), locks: hub.db.locks.filter(l => l.workspaceId === s.workspaceId && l.expires > Date.now()), messages: hub.db.messages.filter(m => m.sessionId === s.id), members: hub.snapshot(peer).members.filter(m => m.workspaceId === s.workspaceId) });
  }
  if (method === "coordination.message") {
    const s = hub.session(peer, a.sessionId);
    if (a.laneId && !s.lanes.some(l => l.id === a.laneId)) throw Error("目标通道不存在");
    const m = { id: uid(), workspaceId: s.workspaceId, sessionId: s.id, laneId: a.laneId || null, ownerId: peer.id, owner: peer.name, text: str(a.text, 6000), at: stamp() };
    hub.db.messages.push(m);
    const sessionMessages = hub.db.messages.filter(v => v.sessionId === s.id);
    if (sessionMessages.length > 500) { const old = new Set(sessionMessages.slice(0, -500).map(v => v.id)); hub.db.messages = hub.db.messages.filter(v => !old.has(v.id)); }
    return m;
  }
  throw Error("不支持的协作操作");
}
