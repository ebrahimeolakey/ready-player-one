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
  assert.equal(f.hub.db.sessions.length, count + 1);
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
