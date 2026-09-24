import { claimKeyHash } from './coordination-runs.mjs';
import { redactRecord, redactText } from './secure-store.mjs';

const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('结果证据为空或过长');
  return redactText(value.trim()).replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]*/g, '[凭据已隐藏]');
};
const date = value => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw Error('证据时间无效');
  return new Date(value).toISOString();
};
const boundedInput = value => {
  const clean = redactRecord(value), json = JSON.stringify(clean);
  return json.length <= 8000 ? clean : {preview:json.slice(0,8000),truncated:true};
};
export const handlesOutcomes = method => ['outcome.report', 'outcome.resolve'].includes(method);

// Reports preserve historical evidence. They must never reconcile, resume, or
// finish a lane: another member may already have taken over that run.
export function outcomes(hub, peer, method, a) {
  if (method === 'outcome.report') {
    const { s, l } = hub.lane(peer, a);
    const approval = hub.db.approvals.find(v => v.id === a.runId && v.sessionId === s.id && v.laneId === l.id && v.ownerId === peer.id);
    if (!approval?.claimKeyHash || claimKeyHash(a.claimKey) !== approval.claimKeyHash) throw Error('缺少原执行领取凭证');
    const existing = hub.db.outcomes.find(v => v.id === a.runId);
    if (existing) return existing;
    const dispatchAt = date(a.dispatchAt);
    if (!Array.isArray(a.dispatches) || a.dispatches.length > 100) throw Error('操作证据数量无效');
    const dispatches = a.dispatches.map(d => {
      const tool = hub.db.toolApprovals.find(t => t.id === d.approvalId && t.runId === a.runId && t.ownerId === peer.id && t.sessionId === s.id && t.laneId === l.id);
      if (!tool || tool.status !== 'consumed' || tool.allowed !== true) throw Error('工具证据没有对应的已领取审批');
      return { approvalId: tool.id, providerRequestId: tool.providerRequestId, action: tool.action, input: boundedInput(tool.input), at: date(d.at), reviewer: tool.reviewer || null, reviewedAt: tool.reviewedAt || null };
    });
    if (!Array.isArray(a.observations) || a.observations.length > 50) throw Error('观测证据数量无效');
    const observations = a.observations.map(o => ({ itemId: text(o.itemId, 500), phase: text(o.phase, 100), text: text(o.text, 8000), at: date(o.at) }));
    const outcome = {
      id: a.runId, runId: a.runId, workspaceId: s.workspaceId, sessionId: s.id, laneId: l.id,
      ownerId: peer.id, owner: peer.name, provider: approval.provider,
      prompt: text(approval.prompt, 20000), dispatchAt, dispatches, observations,
      lastOutput: typeof a.lastOutput === 'string' && !a.lastOutput.trim() ? null : a.lastOutput ? text(a.lastOutput, 8000) : null,
      reason: text(a.reason, 2000), at: new Date().toISOString(), status: 'unknown', version: 0, history: [],
    };
    hub.db.outcomes.push(outcome);
    return outcome;
  }
  const outcome = hub.db.outcomes.find(v => v.id === a.id);
  if (!outcome) throw Error('结果记录不存在');
  hub.workspace(peer, outcome.workspaceId);
  if (a.sessionId && a.sessionId !== outcome.sessionId) throw Error('结果不属于当前会话');
  if (a.workspaceId && a.workspaceId !== outcome.workspaceId) throw Error('结果不属于当前工作区');
  const requestId = text(a.requestId, 100);
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw Error('记录请求标识无效');
  if (!['succeeded', 'failed', 'unknown'].includes(a.status)) throw Error('结果状态无效');
  const evidence = text(a.evidence, 4000);
  const prior = outcome.history.find(h => h.requestId === requestId);
  if (prior) {
    if (prior.ownerId !== peer.id || prior.status !== a.status || prior.evidence !== evidence) throw Error('同一记录请求不能更改内容');
    return outcome;
  }
  if (!Number.isSafeInteger(a.expectedVersion) || a.expectedVersion !== outcome.version) throw Error('其他成员已更新结果，请查看最新记录再提交');
  if (outcome.history.length >= 100) throw Error('结果记录已达到历史上限');
  outcome.version++;
  outcome.status = a.status;
  outcome.history.push({ requestId, version: outcome.version, status: a.status, evidence, ownerId: peer.id, owner: peer.name, at: new Date().toISOString() });
  return outcome;
}
