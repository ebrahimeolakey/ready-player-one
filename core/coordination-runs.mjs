import { validatePrompt } from "./prompt-limits.mjs";
import { fileScopes, branchName, planIds } from "./overlap.mjs";
import { redactRecord } from "./secure-store.mjs";
import { randomUUID, createHash } from "node:crypto";
export function claimKeyHash(key) {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(key)) throw Error("领取标识无效");
  return createHash("sha256").update(key).digest("hex");
}
const stamp = () => new Date().toISOString();
const value = (v, max = 2000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw Error("内容为空或超过长度限制");
  return v.trim();
};
const methods = new Set(["run.session", "run.reconcile", "run.steer", "run.steer.read", "run.steer.ack", "run.steer.restore", "run.queue", "run.queue.cancel", "run.queue.next", "tool.request", "tool.decide", "tool.claim"]);
export const handlesRunCoordination = method => methods.has(method);
function current(hub, peer, a, control = false) {
  const { s, l } = control ? hub.controlledLane(peer, a) : hub.lane(peer, a);
  if (l.activeRunId !== a.runId || l.status !== "running" || l.stopRequested || l.fencedRunId === a.runId) throw Error("执行已结束或已撤销");
  return { s, l };
}
export function runCoordination(hub, peer, method, a) {
  if (method === "run.session") {
    const { l } = current(hub, peer, a);
    l.providerSessionId = value(a.providerSessionId, 500);
    return { providerSessionId: l.providerSessionId, runId: a.runId };
  }
  if (method === "run.reconcile") {
    const { l } = hub.lane(peer, a);
    const approval = hub.db.approvals.find(ap => ap.id === a.runId && ap.ownerId === peer.id);
    if (!approval || approval.status !== "claimed" || l.activeRunId !== a.runId || l.fencedRunId === a.runId || l.stopRequested || !["running", "interrupted"].includes(l.status)) throw Error("离线执行已被替代或撤销，不能补传为当前执行");
    // Only restore the same authenticated run. The caller replays its durable events
    // through run.entry(eventId), then reports finish. Unknown actions are never retried.
    l.status = "running"; delete l.offlineSince;
    l.reconciledAt = stamp();
    return { runId: a.runId, acceptedEventIds: l.acceptedEventIds || [], pendingTools: hub.db.toolApprovals.filter(t => t.runId === a.runId), stopRequested: false };
  }
  if (method === "run.steer") {
    const { l } = current(hub, peer, a, true);
    l.steering ??= [];
    const eventId = a.eventId ? value(a.eventId, 200) : randomUUID();
    const existing = l.steering.find(v => v.id === eventId);
    if (existing) return existing;
    if (l.steering.filter(v => v.status === "pending").length >= 50) throw Error("待传递指导过多");
    const instruction = { id: eventId, text: validatePrompt(a.text), runId: a.runId, ownerId: peer.id, at: stamp(), status: "pending" };
    l.steering.push(instruction); return instruction;
  }
  if (method === "run.steer.read") {
    const { l } = a.restore === true ? hub.lane(peer, a) : current(hub, peer, a);
    const instruction = l.steering?.find(v => v.id === a.id && v.runId === a.runId);
    const allowed = a.restore === true ? ["failed", "unsupported", "restored"] : ["pending"];
    if (!instruction || !allowed.includes(instruction.status)) throw Error("指导已结束或不属于当前执行");
    return { id: instruction.id, runId: instruction.runId, text: instruction.text };
  }
  if (method === "run.steer.restore") {
    const {l} = hub.lane(peer,a);
    const instruction = l.steering?.find(v => v.id === a.id && v.runId === a.runId && v.ownerId === peer.id);
    if(!instruction) throw Error("指导不存在");
    if(instruction.status === "restored") return instruction;
    if(!["failed","unsupported"].includes(instruction.status)) throw Error("只有失败或不支持的指导可以恢复");
    instruction.status = "restored"; instruction.restoredAt = stamp(); return instruction;
  }
  if (method === "run.steer.ack") {
    const { l } = current(hub, peer, a);
    const instruction = l.steering?.find(v => v.id === a.id && v.runId === a.runId);
    if (!instruction) throw Error("指导不存在");
    if (!["delivered", "unsupported", "failed"].includes(a.status)) throw Error("指导状态无效");
    if (instruction.status !== "pending") return instruction;
    instruction.status = a.status; instruction.message = String(a.message || "").slice(0, 2000); instruction.acknowledgedAt = stamp();
    return instruction;
  }
  if (method === "run.queue") {
    const { s, l } = hub.lane(peer, a);
    if (s.status !== "active") throw Error("会话已归档");
    if (!["read-only", "workspace-write"].includes(a.mode)) throw Error("未知权限模式");
    l.queue ??= [];
    if (l.queue.filter(v => v.status === "queued").length >= 50) throw Error("待执行队列已满");
    const q = { id: randomUUID(), ownerId: peer.id, prompt: validatePrompt(a.prompt), mode: a.mode, files: a.files || [], status: "queued", at: stamp() };
    // Validate file declarations without generating a run request that would change lane state.
    if (!Array.isArray(q.files) || q.files.length > 30 || q.files.some(f => typeof f !== "string" || f.length > 500)) throw Error("文件列表无效");
    const scopes = fileScopes(q.files,a.fileScopes);
    // Keep legacy paths separately; only explicit kinds enter fileScopes on resubmission.
    q.fileScopes = scopes.filter(scope => scope.kind !== "unknown");
    q.files = scopes.filter(scope => scope.kind === "unknown").map(scope => scope.path);
    q.planIds = planIds(s,a.planIds); q.branch = branchName(a.branch);
    l.queue.push(q); return q;
  }
  if (method === "run.queue.cancel") {
    const { l } = hub.lane(peer, a);
    const q = l.queue?.find(q => q.id === a.id);
    if (!q || q.status !== "queued") throw Error("队列任务不存在或已开始");
    q.status = "cancelled"; return q;
  }
  if (method === "run.queue.next") {
    const { l } = hub.lane(peer, a);
    if (["running", "awaiting", "needs_handoff"].includes(l.status) || (l.handoffNeeded && l.handoffNeeded.runId === l.activeRunId)) throw Error("当前任务尚未结束或需要接管");
    const q = l.queue?.find(q => q.status === "queued");
    if (!q) return null;
    const approval = hub.act(peer, "run.request", { sessionId: a.sessionId, laneId: a.laneId, prompt: q.prompt, mode: q.mode, files: q.files, fileScopes:q.fileScopes, planIds:q.planIds, branch:q.branch });
    q.status = "submitted"; q.approvalId = approval.id;
    return { queue: q, approval };
  }
  if (method === "tool.request") {
    const { s, l } = current(hub, peer, a);
    const providerRequestId = value(a.providerRequestId, 500);
    const existing = hub.db.toolApprovals.find(t => t.runId === a.runId && t.laneId === l.id && t.providerRequestId === providerRequestId);
    if (existing) return existing;
    const input = a.input ?? {};
    if (JSON.stringify(input).length > 100000) throw Error("工具输入超过大小限制");
    const request = { id: randomUUID(), approvalId: a.approvalId ? value(a.approvalId, 500) : undefined, workspaceId: s.workspaceId, sessionId: s.id, laneId: l.id, runId: a.runId, providerRequestId, action: value(a.action, 500), input: redactRecord(input), ownerId: peer.id, owner: peer.name, status: "pending", at: stamp() };
    hub.db.toolApprovals.push(request); return request;
  }
  if (method === "tool.claim") {
    const request = hub.db.toolApprovals.find(t => t.id === a.id);
    if (!request || request.ownerId !== peer.id) throw Error("只能领取自己执行中的工具审批");
    current(hub, peer, request);
    const keyHash = claimKeyHash(a.claimKey);
    if (request.status === "consumed" && keyHash && request.claimKeyHash === keyHash) return request;
    if (!["approved", "rejected"].includes(request.status)) throw Error("工具审批未决定或已经领取");
    request.claimKeyHash = keyHash;
    request.allowed = request.status === "approved";
    request.status = "consumed"; request.consumedAt = stamp();
    return request;
  }
  if (method === "tool.decide") {
    const request = hub.db.toolApprovals.find(t => t.id === a.id);
    if (!request) throw Error("工具审批不存在");
    hub.workspace(peer, request.workspaceId);
    if (request.status !== "pending") throw Error("工具审批已经处理");
    const { l } = hub.lane(peer, request, false);
    if (l.activeRunId !== request.runId || l.status !== "running" || l.stopRequested || l.fencedRunId === request.runId) throw Error("执行已结束或撤销");
    if (a.answers !== undefined) {
      if (a.allow !== true || request.action !== "question" || !a.answers || typeof a.answers !== "object" || Array.isArray(a.answers) || Object.keys(a.answers).length > 100) throw Error("问题回答结构无效");
      for (const [key, answer] of Object.entries(a.answers)) {
        if (!key || key.length > 200 || key === "__proto__" || !answer || typeof answer !== "object" || Object.keys(answer).some(k => k !== "answers") || !Array.isArray(answer.answers) || answer.answers.length > 20 || answer.answers.some(v => typeof v !== "string" || v.length > 10000)) throw Error("问题回答结构无效");
      }
      if (JSON.stringify(a.answers).length > 100000) throw Error("问题回答超过大小限制");
    }
    if (a.content !== undefined) {
      if (a.allow !== true || request.action !== "elicitation" || !a.content || typeof a.content !== "object" || Array.isArray(a.content)) throw Error("信息请求内容结构无效");
      const check = (value, depth = 0) => {
        if (depth > 10) return false;
        if (value === null || ["string", "boolean"].includes(typeof value)) return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (Array.isArray(value)) return value.length <= 100 && value.every(v => check(v, depth + 1));
        if (typeof value === "object") return Object.keys(value).length <= 100 && Object.entries(value).every(([k, v]) => k.length <= 200 && k !== "__proto__" && check(v, depth + 1));
        return false;
      };
      if (!check(a.content) || JSON.stringify(a.content).length > 100000) throw Error("信息请求内容超过大小或结构限制");
    }
    if (a.answers !== undefined) request.answers = structuredClone(a.answers);
    if (a.content !== undefined) request.content = structuredClone(a.content);
    request.status = a.allow === true ? "approved" : "rejected";
    request.reviewerId = peer.id; request.reviewer = peer.name; request.reviewedAt = stamp();
    return request;
  }
}
