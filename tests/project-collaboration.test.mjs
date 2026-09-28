import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Hub } from "./helpers/secure-hub.mjs";
import { HubClient } from "../core/client.mjs";
import { projectPath } from "../core/project-collaboration.mjs";
import {
  withinProject,
  publishProjectArtifact,
} from "../desktop/services/project-artifacts.mjs";
import { artifactDocument } from "../core/artifact-preview.mjs";
const key = () => randomUUID();
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-project-")),
    hub = new Hub(dir);
  await hub.listen();
  const clients = [];
  const connect = async (token, name) => {
    const c = new HubClient();
    clients.push(c);
    await c.connect(`ws://127.0.0.1:${hub.port}`, {
      token,
      secret: randomBytes(32).toString("hex"),
      name,
    });
    return c;
  };
  const host = await connect(hub.db.hostToken, "负责人"),
    team = await host.call("workspace.create", { name: "团队 A" });
  const invite = await host.call("invite.create", {
      workspaceId: team.id,
      role: "editor",
    }),
    guest = await connect(invite.token, "小李");
  const project = await host.call("collab.project.create", {
    teamId: team.id,
    name: "官网",
    requestKey: key(),
  });
  const channel = hub.db.collaboration.channels[0];
  const agent = async (c, name) => {
    const s = await c.call("session.create", {
        workspaceId: team.id,
        title: name,
      }),
      l = await c.call("lane.create", { sessionId: s.id, provider: "codex" });
    return c.call("collab.agent.register", {
      teamId: team.id,
      sessionId: s.id,
      laneId: l.id,
      name,
    });
  };
  const ha = await agent(host, "负责人 Agent"),
    ga = await agent(guest, "执行 Agent");
  const proposal = async (extra = {}) =>
    host.call("collab.task.propose", {
      channelId: channel.id,
      goal: "创建活动页面",
      acceptance: "标题清楚",
      mode: "workspace-write",
      artifactPath: "index.html",
      requestKey: key(),
      ...extra,
    });
  const claim = async (task) =>
    guest.call("collab.task.claim", {
      taskId: task.id,
      agentId: ga.id,
      revision: task.revision,
      seenSeq: channel.seq,
      controllers: [host.state.me.id],
    });
  const start = async (task, extra = {}) =>
    host.call("collab.task.start", {
      taskId: task.id,
      revision: task.revision,
      requestKey: key(),
      ...extra,
    });
  const live = (id) => hub.db.collaboration.tasks.find((t) => t.id === id);
  const workerClaim = (task) =>
    guest.call("run.claim", { id: task.runId, claimKey: key() });
  const finish = (task) =>
    guest.call("run.finish", {
      sessionId: task.sessionId,
      laneId: task.laneId,
      runId: task.runId,
      status: "done",
    });
  t.after(async () => {
    clients.forEach((c) => c.close());
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    hub,
    host,
    guest,
    team,
    project,
    channel,
    ha,
    ga,
    proposal,
    claim,
    start,
    live,
    workerClaim,
    finish,
    connect,
  };
}
test("projects form isolated trees, session invitations never expose project chat, channels outlive sessions", async (t) => {
  const f = await setup(t),
    { host, guest, hub, team, project, channel } = f;
  const other = await host.call("workspace.create", { name: "团队 B" });
  const p = await host.call("collab.project.create", {
    teamId: other.id,
    name: "机密",
    requestKey: key(),
  });
  await assert.rejects(
    guest.call("collab.project.create", {
      teamId: team.id,
      parentProjectId: p.id,
      name: "跨团队",
      requestKey: key(),
    }),
    /访问|团队/,
  );
  await assert.rejects(
    guest.call("collab.project.create", {
      teamId: other.id,
      name: "跨团队",
      requestKey: key(),
    }),
    /访问/,
  );
  await host.call("collab.project.create", {
    teamId: team.id,
    parentProjectId: project.id,
    name: "子项目",
    requestKey: key(),
  });
  const m = await host.call("collab.message.send", {
    channelId: channel.id,
    text: "持续讨论",
    requestKey: key(),
  });
  const s = await host.call("session.create", {
    workspaceId: team.id,
    title: "临时讨论",
  });
  const invite = await host.call("invite.create", {
      workspaceId: team.id,
      sessionId: s.id,
      role: "editor",
    }),
    limited = await f.connect(invite.token, "仅会话");
  assert.equal(limited.state.collaboration.channelMessages.length, 0);
  await assert.rejects(
    limited.call("collab.message.send", {
      channelId: channel.id,
      text: "越权",
      requestKey: key(),
    }),
    /范围/,
  );
  await host.call("session.archive", { sessionId: s.id });
  assert.equal(hub.db.collaboration.channelMessages[0].id, m.id);
  const state = await guest.call("state");
  assert.equal(
    state.collaboration.projects.some((v) => v.id === p.id),
    false,
  );
});
test("proposal/message retries are idempotent; spoofed identity and foreign references fail; equivalent goals suggest reuse", async (t) => {
  const { host, channel, proposal, hub } = await setup(t);
  const a = { channelId: channel.id, text: "讨论", requestKey: key() };
  const m = await host.call("collab.message.send", a);
  assert.equal((await host.call("collab.message.send", a)).id, m.id);
  await assert.rejects(
    host.call("collab.message.send", { ...a, text: "另一个" }),
    /标识/,
  );
  await assert.rejects(
    host.call("collab.message.send", { ...a, author: { type: "agent" } }),
    /身份/,
  );
  const k = key(),
    task = await proposal({ requestKey: k, sourceMessageIds: [m.id] });
  assert.equal(
    (await proposal({ requestKey: k, sourceMessageIds: [m.id] })).id,
    task.id,
  );
  assert.equal((await proposal()).duplicateTaskId, task.id);
  await assert.rejects(proposal({ sourceMessageIds: ["foreign"] }), /引用/);
  await host.call("collab.message.send", {
    channelId: channel.id,
    text: "新增要求",
    requestKey: key(),
  });
  assert.deepEqual(
    hub.db.collaboration.tasks[0].contextSnapshot.map((v) => v.text),
    ["讨论"],
  );
});
test("concurrent claim chooses one worker and stale context does not create a session", async (t) => {
  const f = await setup(t),
    task = await f.proposal();
  await f.host.call("collab.message.send", {
    channelId: f.channel.id,
    text: "先检查要求",
    requestKey: key(),
  });
  const count = f.hub.db.sessions.length;
  await assert.rejects(
    f.guest.call("collab.task.claim", {
      taskId: task.id,
      agentId: f.ga.id,
      revision: 1,
      seenSeq: 0,
    }),
    /新消息/,
  );
  assert.equal(f.hub.db.sessions.length, count);
  const results = await Promise.allSettled([
    f.host.call("collab.task.claim", {
      taskId: task.id,
      agentId: f.ha.id,
      revision: 1,
      seenSeq: f.channel.seq,
    }),
    f.claim(task),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.hub.db.sessions.length, count);
});
test("controllers start remotely but only worker claims, writes run output and publishes artifacts; raw run bypass denied", async (t) => {
  const f = await setup(t),
    claimed = await f.claim(await f.proposal()),
    task = await f.start(claimed);
  assert.equal(
    f.hub.db.approvals.find((a) => a.id === task.runId).ownerId,
    f.guest.state.me.id,
  );
  await assert.rejects(
    f.host.call("run.claim", { id: task.runId }),
    /领取|批准/,
  );
  await assert.rejects(
    f.host.call("run.request", {
      sessionId: task.sessionId,
      laneId: task.laneId,
      prompt: "绕过",
      mode: "workspace-write",
    }),
    /项目任务/,
  );
  await f.workerClaim(task);
  await assert.rejects(
    f.host.call("run.entry", {
      sessionId: task.sessionId,
      laneId: task.laneId,
      runId: task.runId,
      text: "假结果",
      role: "assistant",
    }),
    /自己/,
  );
  await assert.rejects(
    f.host.call("collab.artifact.publish", {
      taskId: task.id,
      runId: task.runId,
      generation: task.generation,
      content: "fake",
    }),
    /授权/,
  );
  const steering = await f.host.call("run.steer", {
    sessionId: task.sessionId,
    laneId: task.laneId,
    runId: task.runId,
    text: "缩短标题",
  });
  assert.equal(
    (
      await f.guest.call("run.steer.read", {
        sessionId: task.sessionId,
        laneId: task.laneId,
        runId: task.runId,
        id: steering.id,
      })
    ).text,
    "缩短标题",
  );
});
test("start idempotency survives retry and revoke fences output, artifacts and stale stop without killing next run", async (t) => {
  const f = await setup(t),
    claimed = await f.claim(await f.proposal()),
    k = key(),
    task = await f.start(claimed, { requestKey: k });
  assert.equal((await f.start(claimed, { requestKey: k })).runId, task.runId);
  assert.equal(f.hub.db.approvals.length, 1);
  await f.workerClaim(task);
  const revoked = await f.guest.call("collab.controller.set", {
    taskId: task.id,
    revision: task.revision,
    userId: f.host.state.me.id,
    allow: false,
  });
  await assert.rejects(
    f.host.call("collab.task.start", {
      taskId: task.id,
      revision: revoked.revision,
      requestKey: key(),
    }),
    /控制权/,
  );
  await assert.rejects(
    f.guest.call("collab.artifact.publish", {
      taskId: task.id,
      runId: task.runId,
      generation: 1,
      content: "旧结果",
    }),
    /撤销|授权/,
  );
  const next = await f.guest.call("collab.task.start", {
    taskId: task.id,
    revision: revoked.revision,
    requestKey: key(),
  });
  await f.workerClaim(next);
  await assert.rejects(
    f.guest.call("collab.task.stop", {
      taskId: task.id,
      runId: task.runId,
      generation: 1,
    }),
    /替代/,
  );
  assert.equal(
    f.hub.db.sessions.find((s) => s.id === task.sessionId).lanes[0].status,
    "running",
  );
});
test("immutable artifacts, safe preview checks, version comments, multiple turns and explicit human acceptance", async (t) => {
  const f = await setup(t),
    task = await f.start(await f.claim(await f.proposal()));
  await f.workerClaim(task);
  const root = join(f.dir, "checkout");
  await mkdir(root);
  await writeFile(join(root, "index.html"), "<h1>第一版</h1>");
  const v1 = await publishProjectArtifact(f.guest, task, root);
  const retry = await publishProjectArtifact(f.guest, task, root);
  assert.equal(retry.id, v1.id);
  await f.finish(task);
  assert.equal(f.live(task.id).status, "review");
  await assert.rejects(
    f.host.call("collab.task.accept", {
      taskId: task.id,
      revision: f.live(task.id).revision,
      versionId: v1.id,
    }),
    /预览/,
  );
  await f.host.call("collab.artifact.check", {
    taskId: task.id,
    versionId: v1.id,
    hash: v1.hash,
    loaded: true,
  });
  await f.host.call("collab.artifact.comment", {
    taskId: task.id,
    versionId: v1.id,
    text: "标题短一点",
    anchor: "标题",
    requestKey: key(),
  });
  const next = await f.start(f.live(task.id));
  await f.workerClaim(next);
  assert.match(
    f.hub.db.approvals.find((a) => a.id === next.runId).prompt,
    /标题短一点/,
  );
  assert.equal(next.sessionId, task.sessionId);
  assert.equal(next.generation, 2);
  await assert.rejects(
    f.guest.call("collab.artifact.publish", {
      taskId: task.id,
      runId: task.runId,
      generation: 1,
      content: "旧版迟到",
    }),
    /授权/,
  );
  await writeFile(join(root, "index.html"), "<h1>新版</h1>");
  const v2 = await publishProjectArtifact(f.guest, next, root);
  await f.finish(next);
  await f.host.call("collab.artifact.check", {
    taskId: task.id,
    versionId: v2.id,
    hash: v2.hash,
    loaded: false,
  });
  assert.equal(f.live(task.id).previewVersionId, v1.id);
  await assert.rejects(
    f.host.call("collab.task.accept", {
      taskId: task.id,
      revision: f.live(task.id).revision,
      versionId: v1.id,
    }),
    /本轮/,
  );
  assert.equal(
    (await f.host.call("collab.artifact.read", { versionId: v1.id })).content,
    "<h1>第一版</h1>",
  );
  const v3 = await f.guest.call("collab.artifact.publish", {
    taskId: task.id,
    runId: next.runId,
    generation: 2,
    content: "<h1>可用版本</h1>",
  });
  await f.host.call("collab.artifact.check", {
    taskId: task.id,
    versionId: v3.id,
    hash: v3.hash,
    loaded: true,
  });
  await f.host.call("collab.task.accept", {
    taskId: task.id,
    revision: f.live(task.id).revision,
    versionId: v3.id,
  });
  assert.equal(f.live(task.id).status, "accepted");
  assert.equal(f.hub.db.collaboration.artifactComments[0].versionId, v1.id);
});
test("leader uses existing provider approval and turns authenticated output into proposals, never auto-executes them", async (t) => {
  const f = await setup(t),
    m = await f.host.call("collab.message.send", {
      channelId: f.channel.id,
      text: "准备发布页面",
      requestKey: key(),
    });
  const a = {
    channelId: f.channel.id,
    agentId: f.ha.id,
    sourceMessageIds: [m.id],
    requestKey: key(),
  };
  const task = await f.host.call("collab.lead.plan", a);
  assert.equal((await f.host.call("collab.lead.plan", a)).id, task.id);
  await f.host.call("run.claim", { id: task.runId, claimKey: key() });
  await f.host.call("run.entry", {
    sessionId: task.sessionId,
    laneId: task.laneId,
    runId: task.runId,
    role: "assistant",
    text: '[{"goal":"制作发布页面","acceptance":"包含活动时间"}]',
  });
  await f.host.call("run.finish", {
    sessionId: task.sessionId,
    laneId: task.laneId,
    runId: task.runId,
    status: "done",
  });
  const child = f.hub.db.collaboration.tasks.find(
    (t) => t.goal === "制作发布页面",
  );
  assert.equal(child.status, "proposed");
  assert.equal(child.runId, undefined);
  assert.equal(child.proposedByAgent.type, "agent");
  assert.equal(f.hub.db.approvals.length, 1);
});
test("paths reject traversal and symlink escapes, Markdown escapes HTML and preview disables active content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rpo-artifact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const p of [
    "../secret",
    "/tmp/x",
    "a/../../x",
    "a\\b",
    "%2e%2e/x",
    ".git/config",
    "a/./b",
  ])
    assert.throws(() => projectPath(p));
  await mkdir(join(dir, "project"));
  await writeFile(join(dir, "outside"), "secret");
  await symlink(join(dir, "outside"), join(dir, "project", "escape.md"));
  assert.throws(() => withinProject(join(dir, "project"), "escape.md"), /越过/);
  const doc = artifactDocument(
    "# Hello\n<script>alert(1)</script>",
    "markdown",
  );
  assert.match(doc, /<h1>Hello<\/h1>/);
  assert.match(doc, /&lt;script&gt;/);
  assert.match(doc, /script-src 'none'/);
});

test("encrypted artifact objects survive reload and team deletion removes exact metadata and stored content", async (t) => {
  const f = await setup(t),
    task = await f.start(await f.claim(await f.proposal()));
  await f.workerClaim(task);
  const artifact = await f.guest.call("collab.artifact.publish", {
    taskId: task.id,
    runId: task.runId,
    generation: task.generation,
    content: "<h1>Private immutable artifact</h1>",
  });
  await f.finish(task);
  const stored = f.hub.store.readJSON("hub.json").collaboration;
  assert.equal(stored.artifactVersions[0].content, undefined);
  assert.ok(f.hub.store.exists(`artifacts/${artifact.id}.json`));
  const restored = new Hub(f.dir);
  try {
    assert.equal(restored.db.collaboration.tasks[0].status, "review");
    assert.equal(
      restored.store.readJSON(`artifacts/${artifact.id}.json`).content,
      "<h1>Private immutable artifact</h1>",
    );
  } finally {
    await restored.close();
  }
  let preview = await f.host.call("workspace.delete.preview", {
    workspaceId: f.team.id,
  });
  await f.host.call("collab.message.send", {
    channelId: f.channel.id,
    text: "新的群聊",
    requestKey: key(),
  });
  await assert.rejects(
    f.host.call("workspace.delete", {
      workspaceId: f.team.id,
      previewId: preview.previewId,
      confirmation: f.team.name,
    }),
    /已变化/,
  );
  preview = await f.host.call("workspace.delete.preview", {
    workspaceId: f.team.id,
  });
  assert.equal(preview.counts.artifactVersions, 1);
  await f.host.call("workspace.delete", {
    workspaceId: f.team.id,
    previewId: preview.previewId,
    confirmation: f.team.name,
  });
  assert.equal(f.hub.db.collaboration.tasks.length, 0);
  assert.equal(f.hub.db.collaboration.channelMessages.length, 0);
  assert.equal(f.hub.store.exists(`artifacts/${artifact.id}.json`), false);
});
test("offline worker stays queued; DRI alone is not a controller and demoted worker loses execution authority", async (t) => {
  const f = await setup(t),
    proposed = await f.proposal({ driUserId: f.host.state.me.id });
  let task = await f.guest.call("collab.task.claim", {
    taskId: proposed.id,
    agentId: f.ga.id,
    revision: proposed.revision,
    seenSeq: f.channel.seq,
  });
  await assert.rejects(f.start(task), /控制权/);
  task = await f.guest.call("collab.controller.set", {
    taskId: task.id,
    revision: task.revision,
    userId: f.host.state.me.id,
    allow: true,
  });
  f.guest.close();
  await new Promise((r) => setTimeout(r, 30));
  task = await f.start(task);
  const state = await f.host.call("state");
  assert.equal(state.collaboration.tasks[0].execution, "waiting-worker");
  assert.equal(f.hub.db.approvals[0].status, "approved");
  await f.host.call("member.role", {
    workspaceId: f.team.id,
    memberId: task.workerId,
    role: "viewer",
  });
  await f.host.call("collab.task.stop", {
    taskId: task.id,
    runId: task.runId,
    generation: task.generation,
  });
  await assert.rejects(f.start(f.live(task.id)), /团队执行权限/);
});

test("a task owns one stable shared session; independent agents never share provider lanes", async (t) => {
  const f = await setup(t);
  const first = await f.proposal(),
    second = await f.proposal({ goal: "另一件工作" });
  assert.ok(first.sessionId);
  assert.notEqual(first.sessionId, second.sessionId);
  const before = f.hub.db.sessions.length;
  const opened = await f.host.call("collab.task.open", { taskId: first.id });
  assert.equal(opened.sessionId, first.sessionId);
  await assert.rejects(
    f.host.call("lane.create", {
      sessionId: first.sessionId,
      provider: "codex",
    }),
    /任务会话/,
  );
  const a = await f.claim(first),
    b = await f.claim(second);
  assert.equal(a.sessionId, first.sessionId);
  assert.equal(f.hub.db.sessions.length, before);
  assert.notEqual(a.agentId, b.agentId);
  assert.notEqual(a.laneId, b.laneId);
  const instance = f.hub.db.collaboration.agents.find(
    (v) => v.id === a.agentId,
  );
  assert.equal(instance.sessionId, a.sessionId);
  assert.equal(instance.sourceLaneId, a.laneId);
  const retry = await f.claim(first);
  assert.equal(retry.agentId, a.agentId);
  assert.equal(f.hub.db.sessions.length, before);
  const third = await f.proposal({ goal: "直接使用本机 Claude" });
  const direct = await f.host.call("collab.task.claim", {
    taskId: third.id,
    provider: "claude",
    revision: third.revision,
    seenSeq: f.channel.seq,
  });
  assert.equal(direct.sessionId, third.sessionId);
  assert.equal(f.hub.db.sessions.length, before + 1);
  assert.equal(
    f.hub.db.collaboration.agents.find((v) => v.id === direct.agentId).provider,
    "claude",
  );
});

test("project context refreshes each run without pooling private sessions or other projects", async (t) => {
  const f = await setup(t);
  const send = (channelId, text) =>
    f.host.call("collab.message.send", { channelId, text, requestKey: key() });
  await send(f.channel.id, "项目共识：交付中文版本");
  const other = await f.host.call("collab.project.create", {
    teamId: f.team.id,
    name: "另外的项目",
    requestKey: key(),
  });
  const otherChannel = f.hub.db.collaboration.channels.find(
    (c) => c.projectId === other.id,
  );
  await send(otherChannel.id, "OTHER_PROJECT_SECRET");
  const source = f.hub.db.sessions.find((s) =>
    s.lanes.some((l) => l.id === f.ga.sourceLaneId),
  );
  f.hub.entry(source.lanes[0], "assistant", "PRIVATE_EXECUTION_HISTORY");
  const task = await f.claim(await f.proposal());
  await send(f.channel.id, "后续补充：周五交付");
  let running = await f.start(task);
  let ap = f.hub.db.approvals.find((a) => a.id === running.runId);
  assert.match(JSON.stringify(ap.projectContext), /周五交付/);
  assert.doesNotMatch(
    JSON.stringify(ap.projectContext),
    /OTHER_PROJECT_SECRET|PRIVATE_EXECUTION_HISTORY/,
  );
  assert.equal(ap.projectContext.projectId, f.project.id);
  assert.equal(ap.projectBinding.branch, f.project.branch);
  const snapshot = JSON.stringify(ap.projectContext);
  await f.workerClaim(running);
  await f.finish(running);
  await send(f.channel.id, "再次补充：先做草稿");
  running = await f.start(f.live(task.id));
  ap = f.hub.db.approvals.find((a) => a.id === running.runId);
  assert.match(JSON.stringify(ap.projectContext), /先做草稿/);
  assert.doesNotMatch(snapshot, /先做草稿/);
  const invite = await f.host.call("invite.create", {
    workspaceId: f.team.id,
    sessionId: task.sessionId,
    role: "viewer",
    scope: "session",
  });
  const viewer = await f.connect(invite.token, "会话访客");
  const state = await viewer.call("state");
  assert.equal(
    state.approvals.find((a) => a.id === running.runId).projectContext,
    null,
  );
  await assert.rejects(
    viewer.call("collab.task.open", { taskId: task.id }),
    /范围|权限/,
  );
});

test("project-bound provider sessions register independent agent instances and inherit project context", async (t) => {
  const f = await setup(t);
  const source = await f.host.call("session.create", {
    workspaceId: f.team.id,
    projectId: f.project.id,
    title: "调研 Agent",
  });
  const lane = await f.host.call("lane.create", {
    sessionId: source.id,
    provider: "codex",
  });
  const instance = f.hub.db.collaboration.agents.find(
    (a) => a.sourceLaneId === lane.id,
  );
  assert.equal(instance.sessionId, source.id);
  assert.equal(instance.projectId, f.project.id);
  const second = await f.host.call("lane.create", {
    sessionId: source.id,
    provider: "claude",
  });
  assert.notEqual(
    f.hub.db.collaboration.agents.find((a) => a.sourceLaneId === second.id).id,
    instance.id,
  );
  await f.host.call("collab.message.send", {
    channelId: f.channel.id,
    text: "共享的项目目标",
    requestKey: key(),
  });
  const ap = await f.host.call("run.request", {
    sessionId: source.id,
    laneId: lane.id,
    prompt: "请开始调研",
    mode: "read-only",
  });
  assert.equal(ap.prompt, "请开始调研");
  assert.match(JSON.stringify(ap.projectContext), /共享的项目目标/);
  const other = await f.host.call("workspace.create", { name: "另一个团队" });
  await assert.rejects(
    f.host.call("session.create", {
      workspaceId: other.id,
      projectId: f.project.id,
      title: "不允许跨团队关联",
    }),
    /项目不属于/,
  );
});

test("project output streams collect separate sessions, preserve versions and reject foreign publishers", async (t) => {
  const f = await setup(t);
  const s = await f.guest.call("session.create", {
    workspaceId: f.team.id,
    projectId: f.project.id,
    title: "研究会话",
  });
  const l = await f.guest.call("lane.create", {
    sessionId: s.id,
    provider: "claude",
  });
  const output = await f.guest.call("collab.output.track", {
    sessionId: s.id,
    laneId: l.id,
    path: "brief.md",
  });
  assert.equal(output.projectId, f.project.id);
  assert.equal(
    (
      await f.guest.call("collab.output.track", {
        sessionId: s.id,
        laneId: l.id,
        path: "brief.md",
      })
    ).id,
    output.id,
  );
  await assert.rejects(
    f.guest.call("collab.output.track", {
      sessionId: s.id,
      laneId: l.id,
      path: "../private.md",
    }),
    /路径/,
  );
  await assert.rejects(
    f.host.call("collab.output.publish", {
      outputId: output.id,
      content: "# Unauthorized",
    }),
    /本机/,
  );
  const publish = (content) =>
    f.guest.call("collab.output.publish", { outputId: output.id, content });
  const a = await publish("# First"),
    same = await publish("# First"),
    b = await publish("# Second"),
    reverted = await publish("# First");
  assert.equal(same.id, a.id);
  assert.equal(b.number, 2);
  assert.equal(reverted.number, 3);
  await f.host.call("collab.output.check", {
    outputId: output.id,
    versionId: a.id,
    hash: a.hash,
    loaded: true,
  });
  await f.host.call("collab.output.check", {
    outputId: output.id,
    versionId: b.id,
    hash: b.hash,
    loaded: false,
  });
  assert.equal(
    f.hub.db.collaboration.outputs.find((o) => o.id === output.id)
      .previewVersionId,
    a.id,
  );
  assert.equal(
    (await f.host.call("collab.output.read", { versionId: b.id })).content,
    "# Second",
  );
  const invite = await f.host.call("invite.create", {
      workspaceId: f.team.id,
      sessionId: s.id,
      role: "viewer",
      scope: "session",
    }),
    viewer = await f.connect(invite.token, "会话访客");
  await assert.rejects(
    viewer.call("collab.output.read", { versionId: a.id }),
    /范围/,
  );
  assert.equal((await viewer.call("state")).collaboration.outputs.length, 0);
});

test('different members collaborate in one task session with separately owned lanes and execution authority', async t => {
  const f=await setup(t),{host,guest,hub,team,channel,ha,ga}=f;
  let root=await f.proposal();
  root=await host.call('collab.task.claim',{taskId:root.id,agentId:ha.id,revision:root.revision,seenSeq:channel.seq});
  const input={taskId:root.id,agentId:ga.id,goal:'调研用户需求',artifactPath:'research.md',requestKey:key()};
  let work=await host.call('collab.task.contribute',input);
  assert.equal(work.sessionId,root.sessionId);
  assert.equal(work.status,'proposed');
  assert.equal(work.workerId,undefined);
  assert.equal((await host.call('collab.task.contribute',input)).id,work.id);
  assert.equal(hub.db.sessions.find(s=>s.id===root.sessionId).taskId,root.id);
  await assert.rejects(host.call('collab.task.claim',{taskId:work.id,agentId:ha.id,revision:work.revision,seenSeq:channel.seq}),/受邀/);
  await assert.rejects(host.call('collab.task.start',{taskId:work.id,revision:work.revision,requestKey:key()}),/控制权/);
  work=await guest.call('collab.task.claim',{taskId:work.id,agentId:ga.id,revision:work.revision,seenSeq:channel.seq});
  assert.equal(hub.db.sessions.find(s=>s.id===root.sessionId).taskId,root.id);
  assert.notEqual(work.laneId,root.laneId);
  const s=hub.db.sessions.find(s=>s.id===root.sessionId);
  assert.deepEqual(s.lanes.map(l=>l.ownerId).sort(),[host.state.me.id,guest.state.me.id].sort());
  root=await host.call('collab.task.start',{taskId:root.id,revision:root.revision,requestKey:key()});
  work=await guest.call('collab.task.start',{taskId:work.id,revision:work.revision,requestKey:key()});
  assert.equal(root.status,'running');assert.equal(work.status,'running');
  await assert.rejects(host.call('run.claim',{id:work.runId,claimKey:key()}),/通道|执行|自己|授权|批准/);
  await host.call('run.claim',{id:root.runId,claimKey:key()});
  await guest.call('run.claim',{id:work.runId,claimKey:key()});
  await assert.rejects(guest.call('run.request',{sessionId:s.id,laneId:work.laneId,prompt:'绕过任务',mode:'workspace-write'}),/项目任务/);
  await assert.rejects(host.call('collab.task.stop',{taskId:work.id,runId:work.runId,generation:work.generation}),/控制权/);
  const published=await guest.call('collab.artifact.publish',{taskId:work.id,runId:work.runId,generation:work.generation,content:'# 调研\n用户希望协作更清楚'});
  await guest.call('collab.artifact.check',{taskId:work.id,versionId:published.id,hash:published.hash,loaded:true});
  await guest.call('run.finish',{sessionId:s.id,laneId:work.laneId,runId:work.runId,status:'done'});
  await guest.call('coordination.message',{sessionId:s.id,senderLaneId:work.laneId,text:'调研已完成，主 Agent 可以开始汇总'});
  await assert.rejects(host.call('coordination.message',{sessionId:s.id,senderLaneId:work.laneId,text:'假冒同伴'}),/自己/);
  await host.call('run.finish',{sessionId:s.id,laneId:root.laneId,runId:root.runId,status:'done'});
  const refreshed=await host.call('collab.task.start',{taskId:root.id,revision:f.live(root.id).revision,instruction:'根据同伴调研汇总',requestKey:key()});
  const context=hub.db.approvals.find(a=>a.id===refreshed.runId).projectContext;
  assert.equal(context.collaboration.deliverables[0].content,'# 调研\n用户希望协作更清楚');
  assert.match(context.collaboration.messages[0].text,/调研已完成/);
  assert.equal(context.collaboration.work.length,2);
  const spectator=await host.call('invite.create',{workspaceId:team.id,sessionId:s.id,scope:'session',role:'viewer'});
  const viewer=await f.connect(spectator.token,'仅看会话');
  assert.equal(viewer.state.sessions[0].lanes.length,2);
  assert.equal(viewer.state.collaboration.projects.length,0);
  await assert.rejects(viewer.call('collab.session.context',{sessionId:s.id}),/范围|权限/);
  await assert.rejects(viewer.call('collab.task.contribute',{...input,requestKey:key()}),/范围|权限/);
});

test('multiple owned agents, remote opt-in, declined work, path isolation and MCP project collaboration', async t => {
  const f=await setup(t),{host,guest,hub,team,project,ha,ga}=f;
  const root=await f.proposal();
  const mine=await host.call('collab.task.contribute',{taskId:root.id,agentId:ha.id,goal:'制作初稿',requestKey:key()});
  assert.equal(mine.status,'ready');assert.equal(mine.sessionId,root.sessionId);
  const second=await host.call('collab.agent.register',{teamId:team.id,projectId:project.id,provider:'claude',name:'我的复核 Agent',role:'复核',requestKey:key()});
  const review=await host.call('collab.task.contribute',{taskId:root.id,agentId:second.id,goal:'复核初稿',requestKey:key()});
  assert.equal(review.status,'ready');assert.notEqual(review.laneId,mine.laneId);
  await assert.rejects(host.call('collab.task.contribute',{taskId:root.id,agentId:ga.id,goal:'覆盖文件',artifactPath:mine.artifactPath,requestKey:key()}),/路径/);
  const otherProject=await host.call('collab.project.create',{teamId:team.id,name:'隔离项目',requestKey:key()});
  const otherAgent=await host.call('collab.agent.register',{teamId:team.id,projectId:otherProject.id,provider:'codex',name:'隔离 Agent',requestKey:key()});
  await assert.rejects(host.call('collab.task.contribute',{taskId:root.id,agentId:otherAgent.id,goal:'跨项目',requestKey:key()}),/项目/);
  const {createCoordinationMcp}=await import('../core/mcp-coordination.mjs');
  const mcp=createCoordinationMcp({client:host,sessionId:root.sessionId,laneId:mine.laneId});
  await mcp({jsonrpc:'2.0',id:1,method:'initialize'});
  const ctx=await mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'rpo_project_context',arguments:{}}});
  const data=JSON.parse(ctx.result.content[0].text);
  assert.ok(data.agents.some(a=>a.id===ga.id));assert.ok(!data.agents.some(a=>a.id===otherAgent.id));
  const requested=await mcp({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'rpo_task_contribute',arguments:{agentId:ga.id,goal:'请同伴做调研',requestKey:key()}}});
  assert.equal(requested.result.isError,false);
  const work=JSON.parse(requested.result.content[0].text);
  assert.equal(work.status,'proposed');assert.equal(work.workerId,undefined);
  assert.equal(work.parentTaskId,root.id);assert.equal(work.sessionId,root.sessionId);
  await assert.rejects(host.call('collab.task.decline',{taskId:work.id}),/自己的/);
  const declined=await guest.call('collab.task.decline',{taskId:work.id});
  assert.equal(declined.status,'declined');
  const viewerInvite=await host.call('invite.create',{workspaceId:team.id,role:'viewer'});
  const viewer=await f.connect(viewerInvite.token,'团队查看者');
  const visible=await viewer.call('collab.session.context',{sessionId:root.sessionId});
  assert.equal(visible.work.length,4);
  await assert.rejects(viewer.call('collab.task.contribute',{taskId:root.id,agentId:ha.id,goal:'不能执行',requestKey:key()}),/editor/);
});

test('binary drafts are visible before approval; only DRI approves and releases immutable bytes, new versions need new approval', async t=>{
 const f=await setup(t);
 const s=await f.guest.call('session.create',{workspaceId:f.team.id,projectId:f.project.id,title:'共享文件'});
 const lane=await f.guest.call('lane.create',{sessionId:s.id,provider:'codex'});
 const output=await f.guest.call('collab.output.track',{sessionId:s.id,laneId:lane.id,path:'budget.xlsx'});
 // Large enough to exercise the former 300 KB limit and binary transport.
 const bytes=Buffer.alloc(2*1024*1024,0xa3);bytes.write('PK');
 const v=await f.guest.call('collab.output.publish',{outputId:output.id,encoding:'base64',content:bytes.toString('base64')});
 const invite=await f.host.call('invite.create',{workspaceId:f.team.id,role:'viewer'}),viewer=await f.connect(invite.token,'只读同事');
 const read=await viewer.call('collab.artifact.read',{versionId:v.id});assert.deepEqual(Buffer.from(read.content,'base64'),bytes);assert.equal(read.previewStatus,'ready');
 await assert.rejects(f.guest.call('collab.output.approve',{outputId:output.id,versionId:v.id}),/DRI/);
 await assert.rejects(f.host.call('collab.artifact.release',{versionId:v.id}),/审批/);
 await f.host.call('collab.output.approve',{outputId:output.id,versionId:v.id});
 const released=await f.host.call('collab.artifact.release',{versionId:v.id});assert.deepEqual(Buffer.from(released.version.content,'base64'),bytes);
 await assert.rejects(f.guest.call('collab.artifact.release',{versionId:v.id}),/DRI/);
 bytes[100]=0x11;
 const v2=await f.guest.call('collab.output.publish',{outputId:output.id,encoding:'base64',content:bytes.toString('base64')});
 assert.notEqual(v2.hash,v.hash);assert.equal(v2.approval,undefined);
 await assert.rejects(f.host.call('collab.output.approve',{outputId:output.id,versionId:v.id}),/最新/);
 await assert.rejects(f.host.call('collab.artifact.release',{versionId:v2.id}),/审批/);
 // The previous approval still pins v1 until the DRI approves v2.
 assert.equal((await f.host.call('collab.artifact.release',{versionId:v.id})).version.hash,v.hash);
 await f.host.call('collab.output.approve',{outputId:output.id,versionId:v2.id});
 await assert.rejects(f.host.call('collab.artifact.release',{versionId:v.id}),/审批/);
 f.guest.close();await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(Buffer.from((await viewer.call('collab.artifact.read',{versionId:v2.id})).content,'base64'),bytes);
 await assert.rejects(viewer.call('collab.output.approve',{outputId:output.id,versionId:v2.id}),/权限/);
});

test('a controller who is not the DRI cannot accept a task; DRI need not control execution',async t=>{
 const f=await setup(t);let task=await f.claim(await f.proposal());task=await f.start(task);await f.workerClaim(task);
 const version=await f.guest.call('collab.artifact.publish',{taskId:task.id,runId:task.runId,generation:task.generation,content:'<p>Approved only by DRI</p>'});
 await f.host.call('collab.artifact.check',{taskId:task.id,versionId:version.id,hash:version.hash,loaded:true});await f.finish(task);
 await assert.rejects(f.guest.call('collab.task.accept',{taskId:task.id,versionId:version.id,revision:f.live(task.id).revision}),/DRI/);
 // Controller removal does not remove DRI approval authority.
 f.live(task.id).controllers=f.live(task.id).controllers.filter(c=>c.userId!==f.host.state.me.id);
 await f.host.call('collab.task.accept',{taskId:task.id,versionId:version.id,revision:f.live(task.id).revision});
 const release=await f.host.call('collab.artifact.release',{versionId:version.id});assert.equal(release.version.approval.by,f.host.state.me.id);
});

test('Cindy uses an owned independent session, real read-only approval, idempotency and scoped progress', async t => {
  const {host,guest,hub,team,project,ha}=await setup(t);
  const create=(c,name)=>c.call('collab.agent.register',{teamId:team.id,projectId:project.id,provider:'codex',name,role:'上手引导',requestKey:key()});
  const cindy=await create(host,'Cindy');
  const guestCindy=await create(guest,'Cindy');
  await assert.rejects(guest.call('collab.onboarding.attach',{projectId:project.id,agentId:cindy.id}),/自己的/);
  await assert.rejects(host.call('collab.onboarding.attach',{projectId:project.id,agentId:ha.id}),/自己的|Cindy/);
  await host.call('collab.onboarding.attach',{projectId:project.id,agentId:cindy.id});
  await guest.call('collab.onboarding.attach',{projectId:project.id,agentId:guestCindy.id});
  const args={projectId:project.id,text:'帮我配置调研和复核两个 Agent',requestKey:key()};
  const turn=await host.call('collab.onboarding.send',args);
  assert.equal((await host.call('collab.onboarding.send',args)).id,turn.id);
  await assert.rejects(host.call('collab.onboarding.send',{...args,text:'不同内容'}),/冲突/);
  const ap=hub.db.approvals.find(a=>a.id===turn.runId);
  assert.equal(ap.mode,'read-only');assert.equal(ap.status,'approved');assert.equal(ap.ownerId,host.state.me.id);
  assert.match(ap.prompt,/Cindy/);assert.match(ap.prompt,/不能自行配置账号/);
  assert.equal(hub.db.collaboration.tasks.length,0,'asking Cindy does not create tasks');
  const run=await host.call('run.claim',{id:turn.runId,claimKey:key()});
  assert.equal(run.session.id,cindy.sessionId);
  await host.call('run.entry',{sessionId:cindy.sessionId,laneId:cindy.sourceLaneId,runId:turn.runId,eventId:key(),role:'assistant',text:JSON.stringify({text:'先接入调研搭档',actions:[{type:'agent',label:'添加调研',name:'调研搭档',role:'调研'}]})});
  await host.call('run.finish',{sessionId:cindy.sessionId,laneId:cindy.sourceLaneId,runId:turn.runId,status:'done'});
  await host.call('collab.onboarding.status',{projectId:project.id,dismissed:true});
  const state=await host.call('state');
  assert.equal(state.collaboration.onboarding.length,1);assert.equal(state.collaboration.onboarding[0].turns[0].id,turn.id);
  assert.equal(state.collaboration.onboarding[0].dismissed,true);
  assert.equal((await guest.call('state')).collaboration.onboarding[0].turns.length,0);
  await assert.rejects(guest.call('collab.agent.update',{agentId:cindy.id,name:'接管',role:'执行'}),/自己的/);
  await host.call('collab.agent.update',{agentId:cindy.id,name:'Cindy',role:'帮助新同事上手'});
  assert.equal(hub.db.collaboration.agents.find(a=>a.id===cindy.id).role,'帮助新同事上手');
  const invite=await host.call('invite.create',{workspaceId:team.id,role:'viewer'});
  const viewer=await setupViewer(invite);
  async function setupViewer(invite){const c=new HubClient();await c.connect(`ws://127.0.0.1:${hub.port}`,{token:invite.token,secret:randomBytes(32).toString('hex'),name:'只读'});t.after(()=>c.close());return c;}
  await assert.rejects(viewer.call('collab.onboarding.attach',{projectId:project.id,agentId:cindy.id}),/editor/);
});

async function configureWorker(f,c,agent,id='pc-'+agent.id,extra={}){
 await c.call('collab.computer.heartbeat',{teamId:f.team.id,id,name:'测试电脑',providers:['codex','claude']});
 return c.call('collab.agent.configure',{agentId:agent.id,computerId:id,policy:{trigger:'mentions',projectIds:[f.project.id],autoTasks:false,maxTurnsPerHour:20,...extra}});
}
test('Agent mentions persist once, dispatch only to the bound computer, consult another owner without impersonation',async t=>{
 const f=await setup(t),{hub,host,guest,ha,ga,channel,team}=f;
 const a=await configureWorker(f,host,ha),b=await configureWorker(f,guest,ga);
 await host.call('collab.message.send',{channelId:channel.id,text:'@'+a.name+' 帮我拆分',requestKey:'mention-1'});
 await host.call('collab.message.send',{channelId:channel.id,text:'@'+a.name+' 帮我拆分',requestKey:'mention-1'});
 assert.equal(hub.db.collaboration.agentEvents.length,1);
 await guest.call('collab.agent.poll',{teamId:team.id,computerId:b.computerId});
 assert.equal(hub.db.collaboration.agentEvents[0].status,'queued');
 await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});
 const e=hub.db.collaboration.agentEvents[0];assert.equal(e.status,'running');
 assert.equal(hub.db.approvals.find(x=>x.id===e.runId).computerId,a.computerId);
 await assert.rejects(host.call('run.claim',{id:e.runId,claimKey:key(),computerId:b.computerId}),/另一台电脑/);
 await host.call('run.claim',{id:e.runId,claimKey:key(),computerId:a.computerId});
 await host.call('run.entry',{sessionId:e.sessionId,laneId:e.laneId,runId:e.runId,eventId:key(),role:'assistant',text:JSON.stringify({text:'请复核',consult:[{agentId:b.id,text:'检查目标'}]})});
 await host.call('run.finish',{sessionId:e.sessionId,laneId:e.laneId,runId:e.runId,status:'done'});
 assert.equal(e.status,'done');
 const consult=hub.db.collaboration.agentEvents.find(x=>x.agentId===b.id);assert.ok(consult);assert.equal(consult.status,'queued');
 assert.equal(hub.db.collaboration.channelMessages.at(-1).author.id,a.id);
 await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});assert.equal(consult.status,'queued');
 await guest.call('collab.agent.poll',{teamId:team.id,computerId:b.computerId});assert.equal(consult.status,'running');
 assert.notEqual(e.sessionId,a.sessionId,'shared discussion never resumes private source history');
});
test('Agent lifecycle preserves identity and memory, private onboarding is inaccessible to other members',async t=>{
 const f=await setup(t),{host,guest,hub,team,project}=f;
 const s=await host.call('session.create',{workspaceId:team.id,title:'Cindy'}),l=await host.call('lane.create',{sessionId:s.id,provider:'codex'});
 const a=await host.call('collab.agent.register',{teamId:team.id,projectId:project.id,sessionId:s.id,laneId:l.id,name:'Cindy',role:'引导'});
 await host.call('collab.onboarding.attach',{projectId:project.id,agentId:a.id});
 await host.call('collab.agent.configure',{agentId:a.id,memory:'只属于我的记忆'});
 const turn=await host.call('collab.onboarding.send',{projectId:project.id,text:'私密问题',requestKey:key()});
 const state=await guest.call('state');assert.ok(!state.sessions.some(x=>x.id===s.id));assert.ok(!state.approvals.some(x=>x.id===turn.runId));assert.ok(!JSON.stringify(state).includes('私密问题'));assert.ok(!JSON.stringify(state).includes('只属于我的记忆'));
 await assert.rejects(guest.call('session.export',{sessionId:s.id}),/私密|无权|仅/);
 await assert.rejects(guest.call('approval.decide',{id:turn.runId,allow:false}),/私密|无权|仅/);
 await host.call('lane.stop',{sessionId:s.id,laneId:l.id});
 const next=await host.call('collab.agent.lifecycle',{agentId:a.id,action:'reset'});
 assert.equal(next.id,a.id);assert.notEqual(next.sessionId,s.id);assert.equal(next.memory,'只属于我的记忆');assert.equal(hub.db.sessions.find(x=>x.id===s.id).status,'archived');
 assert.deepEqual(hub.db.sessions.find(x=>x.id===next.sessionId).privateUserIds,[host.state.me.id]);
 await assert.rejects(guest.call('collab.agent.configure',{agentId:a.id,name:'劫持'}),/自己的/);
});
test('Agent queued events respect pause, policy changes and a single serial hourly budget',async t=>{
 const f=await setup(t),{host,ha,hub,channel,team}=f,a=await configureWorker(f,host,ha,undefined,{maxTurnsPerHour:1});
 for(let i=0;i<2;i++)await host.call('collab.message.send',{channelId:channel.id,text:'@'+a.name+' 第'+i+'问',requestKey:key()});
 const poll=()=>host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});await poll();await poll();
 assert.equal(hub.db.collaboration.agentEvents.filter(e=>e.status==='running').length,1);
 const e=hub.db.collaboration.agentEvents[0];await host.call('lane.stop',{sessionId:e.sessionId,laneId:e.laneId});await poll();
 assert.equal(e.status,'cancelled');assert.equal(hub.db.collaboration.agentEvents[1].status,'queued');
 await host.call('collab.agent.configure',{agentId:a.id,policy:{...a.policy,trigger:'manual'}});
 assert.equal(hub.db.collaboration.agentEvents[1].status,'cancelled');
 await host.call('collab.agent.lifecycle',{agentId:a.id,action:'pause'});
 await assert.rejects(host.call('run.request',{sessionId:a.sessionId,laneId:a.sourceLaneId,prompt:'暂停不能运行',mode:'read-only',files:[]}),/已暂停/);
});
test('Role templates and eight-step progress persist, reminder emits only once when due',async t=>{
 const f=await setup(t),{host,ha,hub,project,team}=f,a=await configureWorker(f,host,ha);
 const role=await host.call('collab.template.save',{teamId:team.id,name:'活动协调',role:'列出分工和截止日期'});
 await host.call('collab.template.save',{teamId:team.id,id:role.id,name:'活动协调',role:'验收须附证据'});
 assert.equal(hub.db.collaboration.roleTemplates.length,1);
 await host.call('collab.onboarding.status',{projectId:project.id,guideStep:7,guideComplete:true});
 await assert.rejects(host.call('collab.onboarding.status',{projectId:project.id,guideStep:8}),/步骤/);
 const r=await host.call('collab.agent.reminder',{agentId:a.id,projectId:project.id,title:'跟进进度',dueAt:new Date(Date.now()+60000).toISOString(),requestKey:'reminder1'});
 hub.db.collaboration.agentReminders.find(x=>x.id===r.id).dueAt=new Date(Date.now()-1000).toISOString();
 for(let i=0;i<2;i++)await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});
 assert.equal(hub.db.collaboration.agentEvents.filter(e=>e.key.startsWith('reminder:')).length,1);
 const state=await host.call('state');assert.equal(state.collaboration.onboarding[0].guideComplete,true);assert.equal(state.collaboration.roleTemplates.find(x=>x.id===role.id).role,'验收须附证据');
});

test('External runtime pairs for one Agent only, cannot impersonate another, and revokes immediately',async t=>{
 const {ExternalAgentBridge}=await import('../desktop/services/external-agent.mjs');
 const f=await setup(t),a=await configureWorker(f,f.host,f.ha),config={};
 const bridge=new ExternalAgentBridge({client:()=>f.host,config,save:()=>{},computerId:()=>a.computerId});t.after(()=>bridge.close());
 const grant=await bridge.issue(a.id);
 const request=async(path,body,token,extra={})=>{const r=await fetch(grant.url+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 assert.equal((await request('/pair',{code:grant.code},null,{origin:'https://evil.example'})).status,403);
 const paired=await request('/pair',{code:grant.code});assert.equal(paired.status,200);assert.equal(paired.data.agentId,a.id);assert.equal(config.externalAgents[bridge.scope()+':'+a.id].hash.includes(paired.data.token),false);
 assert.equal((await request('/pair',{code:grant.code})).status,400);
 await f.host.call('collab.message.send',{channelId:f.channel.id,text:'@'+a.name+' 请回复',requestKey:key()});
 await f.host.call('collab.agent.poll',{teamId:f.team.id,computerId:a.computerId});
 const next=await request('/next',{},paired.data.token);assert.equal(next.status,200,JSON.stringify(next.data));assert.ok(next.data.work.runId);assert.ok(!JSON.stringify(next.data).includes(f.host.auth.secret));
 assert.equal((await request('/reply',{runId:'other-agent',text:'伪造'},paired.data.token)).status,400);
 const answer=await request('/reply',{runId:next.data.work.runId,text:JSON.stringify({text:'外接 Agent 已回复'})},paired.data.token);assert.equal(answer.status,200);assert.equal(f.hub.db.collaboration.channelMessages.at(-1).author.id,a.id);
 bridge.revoke(a.id);assert.equal((await request('/next',{},paired.data.token)).status,400);
});
test('Cindy suggestions become durable editable drafts and committing twice creates one actual Agent',async t=>{
 const f=await setup(t),{host,team,project,hub}=f;
 const agent=await host.call('collab.agent.register',{teamId:team.id,projectId:project.id,provider:'codex',name:'Cindy',role:'引导',requestKey:key()});
 await host.call('collab.onboarding.attach',{projectId:project.id,agentId:agent.id});
 const turn=await host.call('collab.onboarding.send',{projectId:project.id,text:'配置复核搭档',requestKey:key()});
 await host.call('run.claim',{id:turn.runId,claimKey:key()});
 await host.call('run.entry',{sessionId:turn.sessionId,laneId:turn.laneId,runId:turn.runId,eventId:key(),role:'assistant',text:JSON.stringify({text:'建议添加复核搭档',actions:[{type:'agent',label:'添加复核搭档',name:'复核',role:'检查遗漏'}]})});
 await host.call('run.finish',{sessionId:turn.sessionId,laneId:turn.laneId,runId:turn.runId,status:'done'});
 const record=hub.db.collaboration.onboarding.find(r=>r.projectId===project.id),draft=record.drafts[0];assert.equal(draft.name,'复核');
 const args={projectId:project.id,draftId:draft.id,provider:'claude',name:'事实复核',role:'核对来源，不自动发布'};
 const one=await host.call('collab.onboarding.draft.commit',args),two=await host.call('collab.onboarding.draft.commit',args);assert.equal(one.id,two.id);assert.equal(one.name,'事实复核');assert.equal(record.drafts[0].agentId,one.id);
});
test('Automatic task opt-in claims, binds the execution computer, pauses tasks and leaves DRI approval required',async t=>{
 const f=await setup(t),{hub,host,ha,channel,team}=f,a=await configureWorker(f,host,ha,undefined,{autoTasks:true});
 await host.call('collab.message.send',{channelId:channel.id,text:'@'+a.name+' 提出一个交付任务',requestKey:key()});
 await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});
 const e=hub.db.collaboration.agentEvents[0];
 await host.call('run.claim',{id:e.runId,claimKey:key(),computerId:a.computerId});
 await host.call('run.entry',{sessionId:e.sessionId,laneId:e.laneId,runId:e.runId,eventId:key(),role:'assistant',text:JSON.stringify({text:'先做初稿',tasks:[{goal:'制作一页介绍',acceptance:'包含目标'}]})});
 await host.call('run.finish',{sessionId:e.sessionId,laneId:e.laneId,runId:e.runId,status:'done'});
 await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});
 const task=hub.db.collaboration.tasks.find(t=>e.taskIds?.includes(t.id));assert.ok(task);assert.equal(task.status,'running');assert.equal(task.driUserId,host.state.me.id);
 const approval=hub.db.approvals.find(ap=>ap.id===task.runId);assert.equal(approval.computerId,a.computerId);
 await host.call('collab.agent.poll',{teamId:team.id,computerId:a.computerId});assert.equal(hub.db.collaboration.tasks.length,1);
 await host.call('collab.agent.lifecycle',{agentId:a.id,action:'pause'});assert.equal(task.status,'interrupted');assert.equal(approval.status,'cancelled');assert.notEqual(task.status,'accepted');
});

test('project DRI configures shared PR target separately from execution repo with concurrent update protection',async t=>{
 const f=await setup(t),args={projectId:f.project.id,repository:'team/output',baseBranch:'main',pathPrefix:'drafts',revision:0};
 await assert.rejects(f.guest.call('collab.project.githubTarget',args),/负责人/);
 const p=await f.host.call('collab.project.githubTarget',args);
 assert.deepEqual(p.githubTarget,{repository:'team/output',baseBranch:'main',pathPrefix:'drafts'});
 assert.equal(p.repository,f.project.repository);assert.equal(p.githubTargetRevision,1);
 await assert.rejects(f.host.call('collab.project.githubTarget',args),/已被更新/);
 await assert.rejects(f.host.call('collab.project.githubTarget',{...args,revision:1,pathPrefix:'../escape'}),/项目路径/);
 const visible=f.hub.snapshot(f.hub.peers.values().next().value);
 assert.ok(visible);
});
