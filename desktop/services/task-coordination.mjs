import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellCommand, platformEnv } from "../../core/platform.mjs";
import { worktree } from "../../core/local.mjs";
import { publishSnapshot, receiveSnapshot, bindSessionWorktree, assertSessionWorktree } from "../../core/snapshots.mjs";
import { checkpointSubtaskSource, createSubtask, captureCandidate, reviewCandidate, checkCandidate, integrateCandidate, subtaskState } from "../../core/subtasks.mjs";
const exec = promisify(execFile);
const supported = new Set(["tasks.spawn", "tasks.review", "tasks.check", "tasks.integrate", "handoff.prepare", "handoff.receive"]);
export const handlesTaskCoordination = method => supported.has(method);
export function createTaskCoordination({ client, runtime, localRoot, config, saveConfig, dataDir, withRepository=async(_root,action)=>action() }) {
  config.lanePaths ??= {};
  async function context(args) {
    const c = client();
    if (!c) throw Error("尚未连接协作空间");
    const state = await c.call("state");
    const task = args.id && state.subtasks?.find(t => t.id === args.id);
    const handoff = args.id && state.handoffs?.find(h => h.id === args.id);
    const session = state.sessions.find(s => s.id === (args.sessionId || task?.sessionId || handoff?.sessionId));
    if (!session) throw Error("会话不存在");
    const role = state.me.roles?.[session.workspaceId] || (state.me.host ? "owner" : "viewer");
    if (!["owner", "editor"].includes(role)) throw Error("此操作需要 Editor 权限");
    return { c, state, session, task, handoff, params: { sessionId: session.id, workspaceId: session.workspaceId } };
  }
  async function dedicated(ctx, laneId) {
    const { session, state, params } = ctx;
    if (laneId && config.lanePaths[laneId]) return config.lanePaths[laneId];
    if (!config.sessionPaths[session.id]) {
      if (session.lanes.some(l => l.ownerId === state.me.id && runtime.runs.has(l.activeRunId))) throw Error("请先停止本机会话，再创建独立工作树");
      config.sessionPaths[session.id] = await worktree(localRoot({ workspaceId: session.workspaceId }), session.id, dataDir);
      saveConfig();
    }
    return localRoot({ ...params, laneId });
  }
  async function assertBoundContext(root, sessionId) {
    if (config.sessionPaths[sessionId] === root || Object.values(config.lanePaths).includes(root))
      await assertSessionWorktree(root, {sessionId});
  }
  function ownedLane(ctx, laneId) {
    const lane = ctx.session.lanes.find(l => l.id === laneId);
    if (!lane || lane.ownerId !== ctx.state.me.id) throw Error("只能操作自己的 Agent 通道");
    return lane;
  }
  async function waitStopped(ctx, lane) {
    if (lane.status === "awaiting") await ctx.c.call("lane.stop", { sessionId: ctx.session.id, laneId: lane.id });
    if (lane.activeRunId && runtime.runs.has(lane.activeRunId)) await runtime.interrupt(lane.activeRunId);
    const deadline = Date.now() + 20000;
    do {
      const state = await ctx.c.call("state");
      const latest = state.sessions.find(s => s.id === ctx.session.id)?.lanes.find(l => l.id === lane.id);
      if (!runtime.runs.has(lane.activeRunId) && latest && !["running", "awaiting"].includes(latest.status)) return;
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < deadline);
    throw Error("尚未确认原执行已安全结束，暂不接管");
  }
  async function candidate(ctx) {
    const { task, session, state, c } = ctx;
    if (!task) throw Error("子任务不存在");
    const child = ownedLane(ctx, task.laneId);
    if (["running", "awaiting"].includes(child.status) || runtime.runs.has(child.activeRunId)) throw Error("请先等待子任务执行结束");
    const root = localRoot({ workspaceId: session.workspaceId, sessionId: session.id, laneId: task.parentLaneId });
    const prior = await subtaskState(root, task.id);
    if (prior.status === "integrated") return { root, result: await reviewCandidate(root, { id: task.id }) };
    return withRepository(prior.worktree,async()=>{
    const [dirty, head] = await Promise.all([
      exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: prior.worktree, env: platformEnv() }),
      exec("git", ["rev-parse", "HEAD"], { cwd: prior.worktree, env: platformEnv() }),
    ]);
    if (prior.candidateCommit && !dirty.stdout.trim() && head.stdout.trim() === prior.candidateCommit) return { root, result: await reviewCandidate(root, { id: task.id }) };
    const result = await captureCandidate(root, { id: task.id });
    await c.call("subtask.candidate", { id: task.id, commit: result.candidateCommit, diff: result.diff });
    return { root, result };
    });
  }
  return {
    async invoke(method, args = {}) {
      if (!supported.has(method)) throw Error("不支持的任务协调操作");
      const ctx = await context(args), { c, state, session, params, task, handoff } = ctx;
      if (method === "tasks.spawn") {
        const parent = ownedLane(ctx, args.parentLaneId);
        if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200 || typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20000) throw Error("请填写子任务标题和要求");
        if (!Array.isArray(args.checkCommands) || !args.checkCommands.length || args.checkCommands.length > 20 || args.checkCommands.some(v => typeof v !== "string" || !v.trim() || v.length > 10000)) throw Error("请明确输入至少一项必需检查命令");
        // Only the renderer's explicit user form supplies commands; Agent messages never feed this config.
        const requiredChecks = args.checkCommands.map((line, index) => { const [command, shellArgs] = shellCommand(line); return { id: `check-${index + 1}`, command, args: shellArgs }; });
        const root = localRoot({ ...params, laneId: parent.id });
        await assertBoundContext(root, session.id);
        const baseCommit = await checkpointSubtaskSource(root);
        const created = await c.call("subtask.request", { ...params, parentLaneId: parent.id, ownerId: state.me.id, title: args.title.trim(), prompt: args.prompt.trim(), baseCommit, requiredCheckIds: requiredChecks.map(c => c.id) });
        try {
          const local = await createSubtask(root, { id: created.id, baseCommit, requiredChecks });
          await bindSessionWorktree(local.worktree, {sessionId:session.id, expectedBranch:local.branch});
          const claimed = await c.call("subtask.claim", { id: created.id, baseCommit, worktreeReady: true, provider: args.provider || parent.provider });
          config.lanePaths[claimed.lane.id] = local.worktree; saveConfig();
          return { ...claimed, worktree: local.worktree, baseCommit };
        } catch (error) { await c.call("subtask.cancel", { id: created.id }).catch(() => {}); throw error; }
      }
      if (method === "tasks.review") return (await candidate(ctx)).result;
      if (method === "tasks.check") {
        const { root, result } = await candidate(ctx);
        return checkCandidate(root, { id: task.id, candidateCommit: result.candidateCommit });
      }
      if (method === "tasks.integrate") {
        if (!task) throw Error("子任务不存在");
        const parent=ownedLane(ctx, task.parentLaneId);
        if(["running","awaiting"].includes(parent.status)||runtime.runs.has(parent.activeRunId))throw Error("请先等待或停止父 Agent，再集成子任务");
        const root = localRoot({ ...params, laneId: task.parentLaneId });
        return withRepository(root,async()=>{
        await assertBoundContext(root, session.id);
        const reviewed = await subtaskState(root, task.id);
        if (args.candidateCommit !== task.candidate?.commit || args.candidateCommit !== reviewed.candidateCommit) throw Error("候选已经变化，请重新审阅和检查");
        const expectedParentCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, env: platformEnv() })).stdout.trim();
        const result = await integrateCandidate(root, { id: task.id, candidateCommit: args.candidateCommit, expectedParentCommit, beforeApply: async () => {
          await assertBoundContext(root, session.id);
          const latest = await context(args);
          const parent=ownedLane(latest, latest.task.parentLaneId);
          if(["running","awaiting"].includes(parent.status)||runtime.runs.has(parent.activeRunId))throw Error("父 Agent 已开始执行，暂不集成");
          if (latest.task.status !== "review" || latest.task.candidate?.commit !== args.candidateCommit) throw Error("候选或协作权限已经改变");
        } });
        if (result.status === "integrated") {
          await c.call("subtask.integrated", { id: task.id, candidateCommit: args.candidateCommit, integrationCommit: result.integrationCommit, checks: result.integrationChecks }).catch(async error => {
            const latest = await c.call("state");
            const accepted = latest.subtasks?.find(t => t.id === task.id);
            if (accepted?.status !== "integrated" || accepted.integrationCommit !== result.integrationCommit) throw error;
          });
        }
        return result;
        });
      }
      if (!handoff) throw Error("接管请求不存在");
      if (method === "handoff.prepare") {
        const source = ownedLane(ctx, handoff.laneId);
        if (handoff.fromId !== state.me.id || handoff.status !== "requested") throw Error("不能准备此接管请求");
        await waitStopped(ctx, source);
        const originalRoot = localRoot({ ...params, laneId: source.id });
        return withRepository(originalRoot,async()=>{
        const sourceCheckpoint = await checkpointSubtaskSource(originalRoot);
        const root = await dedicated(ctx, source.id);
        const publish=async()=>{
          await assertSessionWorktree(root, {sessionId:session.id});
          if (root !== originalRoot) await exec("git", ["-c", "core.hooksPath=", "merge", "--ff-only", sourceCheckpoint], { cwd: root, env: platformEnv() });
          const snapshot = await publishSnapshot(root, { sessionId: session.id, ownerId: state.me.id });
          await c.call("snapshot.publish", { ...params, laneId: source.id, ...snapshot });
          return c.call("handoff.ack", { id: handoff.id, snapshotCommit: snapshot.commit, summary: args.summary || "已停止原执行，并发布最新代码快照。请从未完成计划继续。" });
        };
        return root===originalRoot?publish():withRepository(root,publish);
        });
      }
      if (method === "handoff.receive") {
        ownedLane(ctx, handoff.targetLaneId);
        if (handoff.toId !== state.me.id) throw Error("此接管不属于你");
        let prepared = handoff;
        if (prepared.status === "requested") {
          const source = session.lanes.find(l => l.id === handoff.laneId);
          if (!source?.snapshot) throw Error("来源通道没有可用快照");
          prepared = await c.call("handoff.offline", { id: handoff.id, snapshotCommit: source.snapshot.commit, acknowledgeUnconfirmedWork: args.acknowledgeUnconfirmedWork === true });
        }
        if (prepared.status !== "ready") throw Error("尚未准备好接管");
        const root = await dedicated(ctx, handoff.targetLaneId);
        return withRepository(root,async()=>{
        const sync = await receiveSnapshot(root, { sessionId: session.id, snapshot: prepared.checkpoint.snapshot });
        await c.call("snapshot.status", { ...params, laneId: handoff.targetLaneId, status: sync.status === "conflict" ? "conflict" : ["current", "synced"].includes(sync.status) ? "synced" : "paused", message: sync.status === "conflict" ? (sync.files || []).join("、") : "接管快照" });
        if (!["current", "synced"].includes(sync.status)) return { status: sync.status, files: sync.files, message: sync.status === "conflict" ? "请先在代码同步中解决冲突，再接管" : "快照已更新，请原执行者重新确认" };
        return { status: "accepted", ...await c.call("handoff.accept", { id: handoff.id, syncedCommit: prepared.checkpoint.snapshot.commit, mode: args.mode || "read-only" }) };
        });
      }
    },
  };
}
export default createTaskCoordination;
