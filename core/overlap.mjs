import { summarizePrompt } from "./prompt-limits.mjs";
import { filePath } from "./coordination-paths.mjs";
export function fileScopes(files = [], explicit = [], limit = 100) {
  if (!Array.isArray(files) || !Array.isArray(explicit) || files.length + explicit.length > limit) throw Error("文件范围列表无效或过长");
  const scopes = files.map(path => {
    const directory = typeof path === "string" && /[\\/]$/.test(path);
    return { path: filePath(directory ? path.slice(0, -1) : path), kind: directory ? "directory" : "unknown" };
  });
  for (const scope of explicit) {
    if (!scope || !["file", "directory"].includes(scope.kind)) throw Error("文件范围需要 file 或 directory 类型");
    const path = scope.kind === "directory" && typeof scope.path === "string" ? scope.path.replace(/[\\/]$/, "") : scope.path;
    scopes.push({ path: filePath(path), kind: scope.kind });
  }
  return [...new Map(scopes.map(scope => [scope.path, scope])).values()];
}
export function branchName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 250 || /[\s\x00-\x1f~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.includes("//") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) throw Error("分支名称无效");
  return value;
}
export function scopeOverlap(a, b) {
  return a.path === b.path || (a.kind !== "file" && b.path.startsWith(a.path + "/")) || (b.kind !== "file" && a.path.startsWith(b.path + "/"));
}
export function mentionedPaths(text) {
  const scopes = [];
  for (let token of String(text || "").split(/[\s`'"<>()[\]{},;，。；：]+/u)) {
    if (!token || /^(?:[a-z]+:|\/|\\)/i.test(token) || token.includes("://") || token.includes("@") || /[?*]/.test(token)) continue;
    token = token.replace(/[.!?]+$/, "");
    if (!token.includes("/") && !token.includes("\\") && !/\.[a-z][a-z0-9]{0,8}$/i.test(token)) continue;
    try { scopes.push(...fileScopes([token])); } catch { /* prose is not a validated declaration */ }
  }
  return [...new Map(scopes.map(s => [s.path, s])).values()].slice(0, 30);
}
const ignored = new Set(["the", "and", "with", "this", "that", "please", "file", "files", "src", "change", "update", "implement", "tests", "test", "fix", "add", "refactor"]);
function terms(text) {
  return new Set((String(text || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) || []).filter(t => !ignored.has(t)));
}
function sharedTerms(left, right) { const rightTerms = terms(right); return [...terms(left)].filter(t => rightTerms.has(t)).slice(0, 12); }
function activePlans(session, lane, planIds) {
  const linked = new Set(planIds || []);
  return (session.plan || []).filter(plan => !plan.done && !["done", "cancelled"].includes(plan.status) && (linked.has(plan.id) || (!planIds?.length && plan.assigneeId === lane.ownerId)));
}
export function planIds(session, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some(id => typeof id !== "string" || !(session.plan || []).some(p => p.id === id && !p.done && !["done", "cancelled"].includes(p.status)))) throw Error("关联计划不存在、已结束或不属于当前会话");
  return [...new Set(value)];
}
function scopeSources(scopes, source, planId) { return scopes.map(scope => ({ ...scope, source, ...(planId ? { planId } : {}) })); }
function safeScopes(value) { return (Array.isArray(value) ? value : []).filter(v => v && typeof v.path === "string" && ["file", "directory", "unknown"].includes(v.kind)); }
function planSources(plans) {
  return plans.flatMap(plan => scopeSources([...safeScopes(plan.fileScopes), ...mentionedPaths(plan.text)], "plan", plan.id));
}
function activity(lane, now) { return lane.activity?.expires > now ? lane.activity : null; }
function currentApproval(hub, lane) {
  if (lane.status === "running") return hub.db.approvals.find(a => a.id === lane.activeRunId && a.laneId === lane.id && a.status === "claimed");
  if (lane.status === "awaiting") return hub.db.approvals.find(a => a.laneId === lane.id && ["pending", "approved"].includes(a.status));
  return null;
}
function branch(session, lane, approval, now) { return activity(lane, now)?.branch || approval?.branch || session.branch || null; }
export function overlaps(hub, session, lane, prompt, files = [], options = {}) {
  const promptSummary = summarizePrompt(prompt || "");
  prompt = promptSummary.text;
  const now = options.now ?? Date.now(), ownActivity = activity(lane, now);
  const requestedPlans = activePlans(session, lane, options.planIds ?? ownActivity?.planIds);
  const declared = options.scopes || fileScopes(files);
  const currentScopes = [...scopeSources(declared, "declared"), ...scopeSources(lane.changesExpires > now ? (lane.changedFiles || []).map(f => ({path:f.path,kind:"file"})) : [], "changed"), ...scopeSources(safeScopes(ownActivity?.fileScopes), "open"), ...scopeSources(mentionedPaths(prompt), "prompt"), ...planSources(requestedPlans)];
  const currentBranch = options.branch || branch(session, lane, null, now);
  const details = [];
  for (const other of hub.db.sessions.filter(s => s.workspaceId === session.workspaceId && s.status === "active")) {
    for (const candidate of other.lanes || []) {
      if (candidate.id === lane.id) continue;
      const member = hub.db.members.find(m => m.id === candidate.ownerId && m.workspaceId === session.workspaceId);
      if (member?.removed) continue;
      const otherActivity = activity(candidate, now), approval = currentApproval(hub, candidate);
      const candidatePromptSummary = summarizePrompt(approval?.prompt || "");
      const candidatePlans = activePlans(other, candidate, approval?.planIds ?? otherActivity?.planIds);
      const changed = candidate.changesExpires > now ? candidate.changedFiles || [] : [];
      if (!approval && !otherActivity && !changed.length && !candidatePlans.some(p => ["in-progress", "blocked"].includes(p.status))) continue;
      const otherBranch = branch(other, candidate, approval, now), branchRelation = currentBranch && otherBranch ? (currentBranch === otherBranch ? "same" : "different") : "unknown";
      const candidateScopes = [...scopeSources(approval ? approval.fileScopes || fileScopes(approval.files || []) : [], "declared"), ...scopeSources(changed.map(f => ({path:f.path,kind:"file"})), "changed"), ...scopeSources(safeScopes(otherActivity?.fileScopes), "open"), ...scopeSources(mentionedPaths(candidatePromptSummary.text), "prompt"), ...planSources(candidatePlans)];
      const evidence = [], evidenceKeys = new Set();
      for (const left of currentScopes) for (const right of candidateScopes) {
        if (!scopeOverlap(left, right)) continue;
        const key = [left.path, left.source, left.planId, right.path, right.source, right.planId].join("\n");
        if (evidenceKeys.has(key) || evidence.length >= 30) continue;
        evidenceKeys.add(key); evidence.push({ type: left.source === "plan" || right.source === "plan" ? "plan-path" : "path", current: left, other: right });
      }
      const sharedPlans = session.id === other.id ? requestedPlans.filter(p => candidatePlans.some(q => q.id === p.id)) : [];
      if (sharedPlans.length) evidence.push({ type: "plan-step", planIds: sharedPlans.map(p => p.id), text: sharedPlans.map(p => p.text).join("、").slice(0, 1000) });
      if (branchRelation === "same") {
        const taskTerms = sharedTerms([prompt, ...requestedPlans.map(p => p.text)].join(" "), [candidatePromptSummary.text, other.title, other.description, ...candidatePlans.map(p => p.text)].join(" "));
        if (taskTerms.length >= 2) evidence.push({ type: "task-keywords", terms: taskTerms });
      }
      if (!evidence.length) continue;
      const matched = evidence.filter(e => e.current && e.other), actual = matched.some(e => !["plan", "prompt"].includes(e.current.source) && !["plan", "prompt"].includes(e.other.source));
      const branchText = branchRelation === "same" ? `同一分支 ${currentBranch}` : branchRelation === "different" ? `不同分支 ${currentBranch} / ${otherBranch}，后续集成需核对` : "分支信息不完整";
      const fileList = [...new Set(matched.map(e => e.current.path))];
      const reasons = [];
      if (actual) reasons.push(`活动文件范围重叠：${fileList.join("、")}`);
      if (matched.some(e => e.type === "plan-path")) reasons.push(`计划中的路径相交：${fileList.join("、")}`);
      if (!actual && matched.some(e => e.type === "path")) reasons.push(`任务声明路径相交：${fileList.join("、")}`);
      if (sharedPlans.length) reasons.push(`关联同一计划步骤：${sharedPlans.map(p => p.text).join("、")}`);
      const keywords = evidence.find(e => e.type === "task-keywords");
      if (keywords) reasons.push(`任务关键词相同：${keywords.terms.join("、")}（规则匹配）`);
      details.push({ promptCoverage: {truncated:promptSummary.truncated,codePoints:promptSummary.codePoints,limit:promptSummary.limit}, candidatePromptCoverage: {truncated:candidatePromptSummary.truncated,codePoints:candidatePromptSummary.codePoints,limit:candidatePromptSummary.limit}, sessionId: other.id, sessionTitle: other.title, laneId: candidate.id, ownerId: candidate.ownerId, owner: candidate.owner, files: fileList, kind: actual ? "overlapping" : "adjacent", confidence: actual ? "high" : "advisory", currentBranch, otherBranch, branchRelation, planIds: [...new Set(evidence.flatMap(e => [e.current?.planId, e.other?.planId, ...(e.planIds || [])].filter(Boolean)))], evidence, algorithm: "deterministic-v1", advisory: true, reason: `${branchText}；${reasons.join("；")}` });
    }
  }
  for (const lock of hub.db.locks.filter(l => l.workspaceId === session.workspaceId && l.expires > now && l.ownerId !== lane.ownerId)) {
    const held = { path: lock.path, kind: lock.kind || "unknown", source: "lock" }, matches = currentScopes.filter(scope => scopeOverlap(scope, held));
    if (!matches.length) continue;
    const otherSession = hub.db.sessions.find(s => s.id === lock.sessionId && s.workspaceId === session.workspaceId);
    if (!otherSession || otherSession.status !== "active") continue;
    details.push({ sessionId: lock.sessionId, sessionTitle: otherSession.title, laneId: lock.laneId, ownerId: lock.ownerId, owner: lock.owner, files: [lock.path], kind: "lock", confidence: "high", currentBranch, otherBranch: otherSession.branch || null, branchRelation: currentBranch && otherSession.branch ? currentBranch === otherSession.branch ? "same" : "different" : "unknown", planIds: [...new Set(matches.map(v => v.planId).filter(Boolean))], lockId: lock.id, expires: lock.expires, evidence: matches.slice(0, 30).map(current => ({type:"lock",current,other:held})), algorithm: "deterministic-v1", advisory: true, reason: `${lock.owner} 持有建议性文件锁：${lock.path}；需协商，不能阻止本机写入` });
  }
  return details;
}
