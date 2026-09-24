// Session grants are separate from workspace membership. The scope is bound by
// the authenticated invitation, never by a client's RPC arguments.
export function grantMembers(hub, workspaceId, sessionId) {
  const candidates = [...hub.db.members.filter(m => m.workspaceId === workspaceId && !m.removed),
    ...hub.db.sessionMembers.filter(m => m.workspaceId === workspaceId && m.sessionId === sessionId && !m.removed && !hub.db.members.some(w => w.workspaceId === workspaceId && w.id === m.id && w.removed))];
  const ranks={viewer:0,commenter:1,editor:2,owner:3},members=new Map();
  for (const member of candidates) if (!members.has(member.id) || ranks[member.role]>ranks[members.get(member.id).role]) members.set(member.id,member);
  return [...members.values()];
}
export function assertSessionScope(hub, peer, method, a) {
  if (!peer.sessionId) return;
  hub.session(peer, peer.sessionId); // Also enforces immediate removal/demotion.
  if (["state", "identity.begin", "identity.bind", "identity.revoke"].includes(method)) return;
  if (/^(memory|workspace|member)\./.test(method) || method === "session.create") throw Error("会话邀请不授予工作区或共享记忆权限");
  if (!/^(session|lane|run|plan|comment|lock|coordination|snapshot|approval|tool|handoff|subtask|chat|outcome|invite)\./.test(method)) throw Error("此操作不在会话邀请范围内");
  if (a.workspaceId && a.workspaceId !== peer.workspaceId) throw Error("工作区不在邀请范围内");
  let sessionId = a.sessionId;
  const table = method.startsWith("approval.") || method === "run.claim" ? "approvals"
    : method.startsWith("outcome.") && a.id ? "outcomes" : method.startsWith("tool.") && a.id ? "toolApprovals"
    : method.startsWith("handoff.") && a.id ? "handoffs" : method.startsWith("subtask.") && a.id ? "subtasks"
    : method.startsWith("lock.") && a.id ? "locks" : method.startsWith("chat.task.") && a.id ? "groupTasks"
    : method === "invite.revoke" && a.id ? "invites" : null;
  if (table) {
    const target = hub.db[table].find(v => v.id === a.id);
    if (!target || target.sessionId !== peer.sessionId) throw Error("目标不在会话邀请范围内");
    sessionId = target.sessionId;
  }
  if (sessionId !== peer.sessionId) throw Error("目标不在会话邀请范围内");
}
export function scopedResult(value, peer) {
  if (!peer.sessionId || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.filter(v => !v?.sessionId || v.sessionId === peer.sessionId).map(v => scopedResult(v, peer));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "memories") result[key] = [];
    else result[key] = scopedResult(child, peer);
  }
  if (Array.isArray(result.overlapDetails)) result.overlaps = [...new Set(result.overlapDetails.map(d => `${d.sessionTitle || "文件锁"} / ${d.owner}`))];
  return result;
}
