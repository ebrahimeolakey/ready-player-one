import { randomUUID } from "node:crypto";
import { claimKeyHash } from "./coordination-runs.mjs";
const at = () => new Date().toISOString();
const hash = value => {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw Error("需要完整 commit 标识");
  return value;
};
const text = (value, max = 20000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error("内容为空或超过长度限制");
  return value.trim();
};
export const handlesHandoffs = method => /^(handoff|subtask)\./.test(method);
function fence(hub, lane) {
  lane.stopRequested = at(); lane.fencedRunId = lane.activeRunId; lane.status = "interrupted";
  for (const a of hub.db.approvals) if (a.laneId === lane.id && ["pending", "approved", "claimed"].includes(a.status)) a.status = "handed-off";
  for (const a of hub.db.toolApprovals) if (a.laneId === lane.id && a.status === "pending") a.status = "cancelled";
  hub.db.locks = hub.db.locks.filter(l => l.laneId !== lane.id);
}
export function handoffs(hub, peer, method, a) {
  if (method === "handoff.request") {
    const { s, l } = hub.lane(peer, a, false);
    if (l.ownerId === peer.id) throw Error("请选择其他成员的执行通道");
    const target = hub.lane(peer, { sessionId: s.id, laneId: a.targetLaneId }).l;
    if (["running", "awaiting"].includes(target.status)) throw Error("接收通道需要空闲");
    if (hub.db.handoffs.some(h => h.laneId === l.id && ["requested", "ready"].includes(h.status))) throw Error("此通道已有待处理接管");
    const request = { id: randomUUID(), workspaceId: s.workspaceId, sessionId: s.id, laneId: l.id, targetLaneId: target.id, fromId: l.ownerId, from: l.owner, toId: peer.id, to: peer.name, runId: l.activeRunId || null, reason: text(a.reason || "请求接手当前工作", 2000), status: "requested", at: at() };
    hub.db.handoffs.push(request); l.handoffRequested = request.id; return request;
  }
  if (method.startsWith("handoff.")) {
    const h = hub.db.handoffs.find(v => v.id === a.id);
    if (!h) throw Error("接管请求不存在");
    const { s, l } = hub.lane(peer, h, false);
    const active = ["requested", "ready"].includes(h.status);
    if (!active) throw Error("接管请求已经处理");
    if (method === "handoff.cancel" || method === "handoff.reject") {
      if ((method === "handoff.cancel" ? h.toId : h.fromId) !== peer.id) throw Error("只有对应参与者可以取消或拒绝");
      h.status = method === "handoff.cancel" ? "cancelled" : "rejected"; h.updatedAt = at(); delete l.handoffRequested; return h;
    }
    if (method === "handoff.ack" || method === "handoff.offline") {
      if (h.status !== "requested" || l.handoffRequested !== h.id || l.activeRunId !== (h.runId || undefined)) throw Error("来源执行已改变，请重新请求接管");
      if (method === "handoff.ack" && h.fromId !== peer.id) throw Error("只有原执行者可以确认安全停止");
      if (method === "handoff.offline") {
        if (h.toId !== peer.id || !l.offlineSince || [...hub.peers.values()].some(p => p.id === h.fromId && (p.host || p.workspaceId === s.workspaceId))) throw Error("原执行者仍在线，必须等待其确认");
        if (a.acknowledgeUnconfirmedWork !== true) throw Error("需要明确确认离线未同步工作可能未包含在快照内");
      }
      const snapshotCommit = hash(a.snapshotCommit);
      if (!l.snapshot || l.snapshot.commit !== snapshotCommit) throw Error("需要来源通道最近已发布的确认快照");
      const completedStepIds = a.completedStepIds || s.plan.filter(p => p.done).map(p => p.id);
      if (!Array.isArray(completedStepIds) || completedStepIds.some(id => !s.plan.some(p => p.id === id && p.done))) throw Error("确认步骤必须来自已经完成的共享计划");
      const summary = text(a.summary || (method === "handoff.offline" ? "原执行者离线，从最近已发布快照和确认步骤继续；不要重试结果未知的动作。" : "已安全停止，从共享计划继续。"), 12000);
      fence(hub, l);
      Object.assign(h, { status: "ready", checkpoint: { snapshot: { ...l.snapshot }, summary, completedStepIds, acknowledgedBy: peer.id, offline: method === "handoff.offline", at: at() } });
      return h;
    }
    if (method === "handoff.accept") {
      if (h.toId !== peer.id || h.status !== "ready" || l.handoffRequested !== h.id) throw Error("接管未准备好或不属于当前接收者");
      if (hash(a.syncedCommit) !== h.checkpoint.snapshot.commit) throw Error("请先同步确认快照再接管");
      const target = hub.lane(peer, { sessionId: s.id, laneId: h.targetLaneId }).l;
      if (["running", "awaiting"].includes(target.status)) throw Error("接收通道已有执行");
      const prompt = `接手 ${h.from} 的任务，使用你自己的账号和新的原生会话。\n确认快照：${h.checkpoint.snapshot.commit}\n交接说明：${h.checkpoint.summary}\n已确认完成的步骤：${h.checkpoint.completedStepIds.join(", ") || "无"}\n从尚未完成的共享计划继续。不要假定已迁移另一位用户的 Provider session，也不要盲目重试未知结果的动作。`;
      const approval = hub.act(peer, "run.request", { sessionId: s.id, laneId: target.id, prompt, mode: a.mode || "read-only", files: l.files || [] });
      // Claiming this approval launches a fresh provider session under the recipient.
      delete target.providerSessionId;
      target.handoffFrom = { handoffId: h.id, laneId: l.id, snapshotCommit: h.checkpoint.snapshot.commit };
      h.status = "accepted"; h.approvalId = approval.id; h.acceptedAt = at(); delete l.handoffRequested;
      return { handoff: h, approval, context: { plan: s.plan, memories: hub.db.memories.filter(m => m.workspaceId === s.workspaceId && !m.retired), summary: h.checkpoint.summary, snapshot: h.checkpoint.snapshot } };
    }
    throw Error("不支持的接管操作");
  }
  if (method === "subtask.request") {
    const { s, l } = hub.lane(peer, { sessionId: a.sessionId, laneId: a.parentLaneId });
    if (s.status !== "active") throw Error("会话已归档");
    const executorId = a.ownerId || peer.id;
    const member = hub.db.members.find(m => m.id === executorId && m.workspaceId === s.workspaceId && !m.removed && ["editor", "owner"].includes(m.role));
    if (!member) throw Error("子任务执行者需要 Editor 权限");
    const requiredCheckIds = a.requiredCheckIds;
    if (!Array.isArray(requiredCheckIds) || !requiredCheckIds.length || requiredCheckIds.length > 20 || requiredCheckIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw Error("必须指定本机明确配置的检查 ID");
    const input = {ownerId:executorId,title:text(a.title,200),prompt:text(a.prompt),baseCommit:hash(a.baseCommit),requiredCheckIds:[...new Set(requiredCheckIds)]};
    if (a.requestId !== undefined || a.sourceRunId !== undefined) {
      if (typeof a.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.requestId)) throw Error("子任务 requestId 必须是 UUID");
      const source = hub.db.approvals.find(v=>v.id===a.sourceRunId);
      if (executorId!==peer.id || l.activeRunId!==a.sourceRunId || l.status!=="running" || l.stopRequested || l.fencedRunId===a.sourceRunId || source?.status!=="claimed" || source.mode!=="workspace-write") throw Error("父执行已结束或不允许拆分子任务");
      const existing = hub.db.subtasks.find(v=>v.requestedBy===peer.id && v.parentLaneId===l.id && v.sourceRunId===a.sourceRunId && v.requestId===a.requestId.toLowerCase());
      if (existing) {
        if (Object.keys(input).some(key=>JSON.stringify(existing[key])!==JSON.stringify(input[key]))) throw Error("相同 requestId 不能用于不同子任务");
        return existing;
      }
    }
    const task = { id: randomUUID(), workspaceId: s.workspaceId, sessionId: s.id, parentLaneId: l.id, requestedBy: peer.id, ...input, owner: member.name, ...(a.requestId ? {requestId:a.requestId.toLowerCase(),sourceRunId:a.sourceRunId}:{}), status: "requested", at: at() };
    hub.db.subtasks.push(task); return task;
  }
  if (method.startsWith("subtask.")) {
    const task = hub.db.subtasks.find(v => v.id === a.id);
    if (!task) throw Error("子任务不存在");
    const s = hub.session(peer, task.sessionId), parent = s.lanes.find(l => l.id === task.parentLaneId);
    const sourceActive = () => {
      if (s.status!=="active") throw Error("会话已归档");
      if (task.sourceRunId && (parent.activeRunId!==task.sourceRunId || parent.status!=="running" || parent.stopRequested || parent.fencedRunId===task.sourceRunId)) throw Error("父执行已结束或被替代");
    };
    const result = () => ({task,lane:s.lanes.find(l=>l.id===task.laneId),approval:hub.db.approvals.find(v=>v.id===task.approvalId)});
    if (method === "subtask.claim") {
      sourceActive();
      if (task.ownerId !== peer.id) throw Error("子任务已领取或不属于当前执行者");
      if (hash(a.baseCommit) !== task.baseCommit || a.worktreeReady !== true) throw Error("请先从指定快照创建独立工作树");
      const provider = a.provider || parent.provider;
      const key = claimKeyHash(a.claimKey);
      if(a.deferRun!==undefined && typeof a.deferRun!=="boolean")throw Error("deferRun 必须为布尔值");
      if (a.deferRun && !key) throw Error("准备子任务需要持久领取标识");
      if (task.status !== "requested") {
        if (key && key===task.claimKeyHash && ["prepared","running"].includes(task.status) && s.lanes.find(l=>l.id===task.laneId)?.provider===provider && task.deferredRun===(a.deferRun===true)) return result();
        throw Error("子任务已领取或不属于当前执行者");
      }
      const l = hub.act(peer, "lane.create", { sessionId: s.id, provider, providerLabel: a.providerLabel || (provider === parent.provider ? parent.providerLabel : undefined) });
      Object.assign(l, { subtaskId: task.id, parentLaneId: parent.id, baseCommit: task.baseCommit });
      Object.assign(task,{laneId:l.id,claimKeyHash:key,deferredRun:a.deferRun===true,claimedAt:at()});
      if(a.deferRun===true){task.status="prepared";return result();}
      const approval = hub.act(peer, "run.request", { sessionId: s.id, laneId: l.id, prompt: task.prompt, mode: "workspace-write" });
      Object.assign(task, { status: "running", laneId: l.id, approvalId: approval.id, claimedAt: at() });
      return { task, lane: l, approval };
    }
    if(method==="subtask.start") {
      sourceActive();
      const key=claimKeyHash(a.claimKey);
      if(task.ownerId!==peer.id || !task.deferredRun || !key || key!==task.claimKeyHash)throw Error("子任务启动标识无效");
      if(task.status==="running" && task.approvalId)return result();
      if(task.status!=="prepared")throw Error("子任务尚未准备或已结束");
      const approval=hub.act(peer,"run.request",{sessionId:s.id,laneId:task.laneId,prompt:task.prompt,mode:"workspace-write"});
      Object.assign(task,{status:"running",approvalId:approval.id,startedAt:at()});
      return result();
    }
    if (method === "subtask.candidate") {
      if (task.ownerId !== peer.id || !["running", "review"].includes(task.status)) throw Error("不能发布此子任务候选");
      const l = s.lanes.find(l => l.id === task.laneId);
      if (["running", "awaiting"].includes(l?.status)) throw Error("请先结束子任务执行，再提交候选");
      const candidate = { commit: hash(a.commit), diff: String(a.diff || "").slice(0, 150000), at: at(), revision: (task.candidate?.revision || 0) + 1 };
      task.candidate = candidate; task.status = "review"; return task;
    }
    if (method === "subtask.integrated") {
      if (parent.ownerId !== peer.id || task.status !== "review" || task.candidate?.commit !== a.candidateCommit) throw Error("候选已改变、已集成或不属于父通道执行者");
      const checks = a.checks;
      if (!Array.isArray(checks) || task.requiredCheckIds.some(id => !checks.some(c => c.id === id && c.passed === true && c.exitCode === 0 && c.commit === a.integrationCommit))) throw Error("缺少本机合并结果的成功检查记录");
      task.integrationCommit = hash(a.integrationCommit); task.status = "integrated"; task.integratedAt = at(); task.checks = checks;
      return task;
    }
    if (method === "subtask.cancel") {
      if (![task.ownerId, parent.ownerId].includes(peer.id) || !["requested", "prepared", "running", "review"].includes(task.status)) throw Error("不能取消此子任务");
      const lane = s.lanes.find(l => l.id === task.laneId); if (lane) fence(hub, lane);
      task.status = "cancelled"; return task;
    }
    throw Error("不支持的子任务操作");
  }
}
