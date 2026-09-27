// One shared task session, independently owned execution lanes and deliverables.
export function projectTeamwork(hub, peer, method, a, api) {
  const db = hub.db.collaboration;
  if (method === "collab.session.context") {
    const session = hub.session(peer, a.sessionId);
    api.target(hub, peer, "projects", session.projectId);
    return {
      project: api.projectRunContext(hub, session),
      taskId: session.taskId || null,
      agents: db.agents
        .filter(
          (v) =>
            v.teamId === session.workspaceId &&
            !v.taskId &&
            (!v.projectId || v.projectId === session.projectId),
        )
        .map(({ id, name, role, provider, workerId }) => ({
          id,
          name,
          role,
          provider,
          workerId,
        })),
      work: db.tasks
        .filter((t) => t.sessionId === session.id)
        .map(
          ({
            id,
            parentTaskId,
            goal,
            status,
            agentId,
            requestedAgentId,
            workerId,
            artifactPath,
          }) => ({
            id,
            parentTaskId,
            goal,
            status,
            agentId,
            requestedAgentId,
            workerId,
            artifactPath,
          }),
        ),
    };
  }
  const task = api.target(hub, peer, "tasks", a.taskId, true);
  if (method === "collab.task.decline") {
    const agent = db.agents.find((v) => v.id === task.requestedAgentId);
    if (
      !task.parentTaskId ||
      !agent ||
      agent.workerId !== peer.id ||
      task.workerId ||
      task.status !== "proposed"
    )
      throw Error("只能拒绝发给自己的待接入分工");
    task.status = "declined";
    task.revision++;
    api.post(
      hub,
      db.channels.find((c) => c.id === task.channelId),
      { type: "system", name: "协作" },
      `${agent.name} 暂不参与：${task.goal}`,
      { taskId: task.parentTaskId },
    );
    return task;
  }
  const root = task.parentTaskId
    ? api.target(hub, peer, "tasks", task.parentTaskId, true)
    : task;
  if (a.sessionId && root.sessionId !== a.sessionId)
    throw Error("分工不属于当前共享会话");
  if (root.status === "accepted") throw Error("已验收任务不能再增加分工");
  const agent = api.target(hub, peer, "agents", a.agentId, true);
  if (
    agent.teamId !== root.teamId ||
    agent.taskId ||
    (agent.projectId && agent.projectId !== root.projectId && !agent.policy?.projectIds?.includes(root.projectId))
  )
    throw Error("Agent 不属于此项目");
  api.member(hub, root.teamId, agent.workerId);
  const prior = db.tasks.find(
    (t) =>
      t.parentTaskId === root.id &&
      t.createdBy === peer.id &&
      t.requestKey === a.requestKey,
  );
  if (
    !prior &&
    db.tasks.filter(
      (t) => t.parentTaskId === root.id && t.status !== "declined",
    ).length >= 20
  )
    throw Error("每项任务最多 20 项协作分工");
  const path = a.artifactPath || `contributions/${a.requestKey}.md`;
  if (typeof path !== "string") throw Error("产物路径无效");
  if (
    !prior &&
    db.tasks.some(
      (t) =>
        t.projectId === root.projectId &&
        t.status !== "declined" &&
        t.artifactPath.toLowerCase() === path.toLowerCase(),
    )
  )
    throw Error("产物路径已被另一项任务使用，请为此分工选择不同文件");
  const channel = db.channels.find((c) => c.id === root.channelId);
  const work = api.propose(hub, peer, channel, {
    parentTaskId: root.id,
    requestedAgentId: agent.id,
    goal: a.goal,
    acceptance: a.acceptance || root.acceptance,
    artifactPath: path,
    mode: root.mode,
    sourceMessageIds: root.contextSnapshot.map((m) => m.id),
    driUserId: root.driUserId,
    requestKey: a.requestKey,
  });
  if (work.duplicateTaskId)
    throw Error("这位 Agent 已有相同分工，请打开已有分工");
  if (agent.workerId === peer.id && work.status === "proposed")
    api.dispatch(hub, peer, "collab.task.claim", {
      taskId: work.id,
      agentId: agent.id,
      revision: work.revision,
      seenSeq: channel.seq,
    });
  if (!work.contributionPosted) {
    api.post(
      hub,
      channel,
      { type: "system", name: "协作" },
      `${agent.name} · ${work.goal}${work.workerId ? "（已加入）" : "（等待本人接入）"}`,
      { taskId: root.id },
    );
    work.contributionPosted = true;
  }
  return work;
}
