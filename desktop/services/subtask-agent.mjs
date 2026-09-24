import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { shellCommand, platformEnv } from "../../core/platform.mjs";
import { checkpointSubtaskSource, createSubtask, subtaskState } from "../../core/subtasks.mjs";
import { bindSessionWorktree } from "../../core/snapshots.mjs";

const exec = promisify(execFile);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function subtaskConnectionKey(client) {
  if (!client?.auth?.secret || !client?.url) throw Error("子任务桥缺少本机连接身份");
  return digest([client.state?.identity?.audience || client.url, client.auth.secret]);
}
export function agentSubtaskArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["requestId", "title", "prompt"].includes(key))) throw Error("子任务只接受 requestId、标题和任务，不接受命令或身份参数");
  if (typeof args.requestId !== "string" || !uuid.test(args.requestId)) throw Error("请提供 UUID requestId，重试时保持相同值");
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200 || typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20000) throw Error("请填写子任务标题和要求");
  return { requestId: args.requestId.toLowerCase(), title: args.title.trim(), prompt: args.prompt.trim() };
}
function commands(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some(line => typeof line !== "string" || !line.trim() || line.length > 10000)) throw Error("请明确输入至少一项必需检查命令");
  return value.map(line => line.trim());
}
async function repositoryKey(root) {
  const path = (await exec("git", ["rev-parse", "--git-common-dir"], { cwd: root, env: platformEnv(), timeout: 10000 })).stdout.trim();
  return realpath(resolve(root, path));
}

export function createAgentSubtasks({ client, runtime, localRoot, config, saveConfig, assertBoundContext }) {
  config.agentSubtaskSettings ??= {};
  config.agentSubtaskRequests ??= {};
  const inflight = new Map();
  async function context(sessionId) {
    const c = client();
    if (!c) throw Error("尚未连接协作空间");
    const state = await c.call("state");
    if (c !== client()) throw Error("协作连接已切换");
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session || session.status !== "active") throw Error("会话不存在或已归档");
    const role = state.me.roles?.[session.workspaceId] || (state.me.host ? "owner" : "viewer");
    if (!["owner", "editor"].includes(role)) throw Error("此操作需要 Editor 权限");
    const connectionKey = subtaskConnectionKey(c);
    return { c, state, session, connectionKey, settingsKey: digest([connectionKey, state.me.id, session.workspaceId]) };
  }
  async function authorize(binding) {
    const ctx = await context(binding.sessionId);
    if (ctx.connectionKey !== binding.connectionKey || ctx.state.me.id !== binding.ownerId || ctx.session.workspaceId !== binding.workspaceId) throw Error("子任务桥的连接身份已改变");
    const parent = ctx.session.lanes.find(l => l.id === binding.laneId && l.ownerId === binding.ownerId);
    const approval = ctx.state.approvals.find(a => a.id === binding.runId);
    if (!parent || parent.activeRunId !== binding.runId || parent.status !== "running" || parent.stopRequested || parent.fencedRunId === binding.runId || !runtime.runs.has(binding.runId) || approval?.status !== "claimed") throw Error("父执行已结束、停止或被替代");
    if (approval.mode !== "workspace-write") throw Error("只读执行不能创建子任务工作树");
    const root = localRoot({ workspaceId: ctx.session.workspaceId, sessionId: ctx.session.id, laneId: parent.id });
    await assertBoundContext(root, ctx.session.id);
    const repository = await repositoryKey(root);
    return { ...ctx, parent, root, repository };
  }
  return {
    async settings(method, args) {
      const ctx = await context(args.sessionId);
      if (args.workspaceId && args.workspaceId !== ctx.session.workspaceId) throw Error("工作区与会话不匹配");
      const root = localRoot({ workspaceId: ctx.session.workspaceId, sessionId: ctx.session.id });
      const repository = await repositoryKey(root);
      const current = config.agentSubtaskSettings[ctx.settingsKey];
      if (method === "tasks.settings.save") {
        if (typeof args.enabled !== "boolean") throw Error("请明确选择是否允许 Agent 拆分子任务");
        const checkCommands = args.enabled ? commands(args.checkCommands) : (current?.repository === repository ? current.checkCommands : []);
        config.agentSubtaskSettings[ctx.settingsKey] = { id: randomUUID(), enabled: args.enabled, checkCommands, repository, updatedAt: new Date().toISOString() };
        saveConfig();
      }
      const saved = config.agentSubtaskSettings[ctx.settingsKey];
      return saved?.repository === repository ? { id: saved.id, enabled: saved.enabled, checkCommands: saved.checkCommands, updatedAt: saved.updatedAt } : { enabled: false, checkCommands: [] };
    },
    async spawn(binding, rawArgs, validateLease = async () => {}) {
      const args = agentSubtaskArguments(rawArgs);
      const key = digest([binding, args.requestId]), payloadHash = digest(args);
      await validateLease();
      const ctx = await authorize(binding);
      const prior = config.agentSubtaskRequests[key];
      if (prior && prior.payloadHash !== payloadHash) throw Error("相同 requestId 不能用于不同子任务");
      if (prior && (prior.root !== ctx.root || prior.repository !== ctx.repository)) throw Error("本机项目已改变，请检查原子任务");
      if (inflight.has(key)) return inflight.get(key);
      const operation = (async () => {
        let record = config.agentSubtaskRequests[key];
        if (record?.result) return record.result;
        const profile = config.agentSubtaskSettings[ctx.settingsKey];
        if (!profile?.enabled || profile.repository !== ctx.repository) throw Error("请先在“Agent 子任务检查”中启用并保存必需检查");
        if (!record) {
          if (Object.keys(config.agentSubtaskRequests).length >= 1000) throw Error("本机子任务请求记录已达上限，请先整理记录");
          const requiredChecks = commands(profile.checkCommands).map((line, index) => { const [command, commandArgs] = shellCommand(line); return { id: `check-${index + 1}`, command, args: commandArgs }; });
          record = { payloadHash, requestId: args.requestId, binding, root: ctx.root, repository: ctx.repository, profileId: profile.id, requiredChecks, claimKey: randomUUID(), phase: "preparing", at: new Date().toISOString() };
          config.agentSubtaskRequests[key] = record; saveConfig();
        }
        const revalidate = async () => {
          await validateLease();
          const next = await authorize(binding);
          const activeProfile = config.agentSubtaskSettings[next.settingsKey];
          if (next.root !== record.root || next.repository !== record.repository || !activeProfile?.enabled || activeProfile.id !== record.profileId) throw Error("本机项目或检查设置已改变，请检查已有子任务后重新发起");
          return next;
        };
        try {
          await revalidate();
          if (!record.baseCommit) { record.baseCommit = await checkpointSubtaskSource(record.root); saveConfig(); }
          await revalidate();
          const created = await ctx.c.call("subtask.request", { sessionId: binding.sessionId, parentLaneId: binding.laneId, ownerId: binding.ownerId, sourceRunId: binding.runId, requestId: record.requestId, title: args.title, prompt: args.prompt, baseCommit: record.baseCommit, requiredCheckIds: record.requiredChecks.map(c => c.id) });
          if (record.taskId && record.taskId !== created.id) throw Error("子任务幂等标识不一致，停止本机创建");
          record.taskId = created.id; record.phase = "requested"; saveConfig();
          await revalidate();
          let local;
          try { local = await subtaskState(record.root, created.id); }
          catch (error) { if (error.code !== "ENOENT") throw error; local = await createSubtask(record.root, { id: created.id, baseCommit: record.baseCommit, requiredChecks: record.requiredChecks }); }
          if (local.baseCommit !== record.baseCommit || local.status !== "working") throw Error("已有子任务工作树状态已改变，请在界面审阅");
          await bindSessionWorktree(local.worktree, { sessionId: binding.sessionId, expectedBranch: local.branch });
          record.worktree = local.worktree; record.phase = "worktree"; saveConfig();
          await revalidate();
          const claimed = await ctx.c.call("subtask.claim", { id: created.id, baseCommit: record.baseCommit, worktreeReady: true, provider: ctx.parent.provider, claimKey: record.claimKey, deferRun: true });
          config.lanePaths[claimed.lane.id] = local.worktree;
          record.laneId = claimed.lane.id; record.phase = "prepared"; saveConfig();
          await revalidate();
          const started = await ctx.c.call("subtask.start", { id: created.id, claimKey: record.claimKey });
          record.result = { taskId: created.id, laneId: claimed.lane.id, approvalId: started.approval.id, status: "awaiting-approval", baseCommit: record.baseCommit, requiredCheckIds: created.requiredCheckIds };
          record.phase = "complete"; delete record.error; saveConfig();
          return record.result;
        } catch (error) { record.error = String(error.message).slice(0, 2000); saveConfig(); throw error; }
      })();
      inflight.set(key, operation);
      try { return await operation; } finally { inflight.delete(key); }
    },
  };
}
