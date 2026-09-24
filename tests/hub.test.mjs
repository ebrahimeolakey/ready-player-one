import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub } from "./helpers/secure-hub.mjs";
import { HubClient } from "../core/client.mjs";
const secret = () => randomBytes(32).toString("hex");
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-hub-"));
  const hub = new Hub(dir);
  await hub.listen();
  const host = new HubClient();
  await host.connect(`ws://127.0.0.1:${hub.port}`, {
    token: hub.db.hostToken,
    secret: secret(),
    name: "房主",
  });
  const clients = [host];
  t.after(async () => {
    for (const c of clients) c.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const workspace = await host.call("workspace.create", {
    name: "共享项目",
    branch: "main",
  });
  const invite = await host.call("invite.create", {
    workspaceId: workspace.id,
  });
  async function guest(name = "协作者") {
    const c = new HubClient();
    clients.push(c);
    await c.connect(`ws://127.0.0.1:${hub.port}`, {
      token: invite.token,
      secret: secret(),
      name,
    });
    return c;
  }
  return { hub, host, workspace, invite, guest, dir };
}
const tick = () => new Promise((r) => setTimeout(r, 25));
test("two native clients share live sessions, lanes, plans, comments and memories", async (t) => {
  const { host, guest, workspace } = await setup(t);
  const member = await guest();
  const session = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "多人一起开发",
    description: "共享上下文",
  });
  const lane = await member.call("lane.create", {
    sessionId: session.id,
    provider: "codex",
  });
  assert.equal(lane.owner, "协作者");
  const plan = await host.call("plan.add", {
    sessionId: session.id,
    text: "完成登录接口",
  });
  await member.call("plan.toggle", { sessionId: session.id, id: plan.id });
  await member.call("comment.add", {
    sessionId: session.id,
    text: "我来负责测试",
    anchor: "src/auth.ts:12",
  });
  await host.call("memory.add", {
    workspaceId: workspace.id,
    title: "测试约定",
    text: "使用 node:test",
  });
  await tick();
  assert.equal(host.state.sessions[0].lanes.length, 1);
  assert.equal(member.state.sessions[0].plan[0].done, true);
  assert.equal(host.state.sessions[0].comments[0].anchor, "src/auth.ts:12");
  assert.equal(member.state.memories[0].title, "测试约定");
});
test("invitations are scoped to one workspace; invalid credentials cannot connect", async (t) => {
  const { hub, host, guest } = await setup(t);
  const other = await host.call("workspace.create", {
    name: "不可访问的工作区",
  });
  const member = await guest();
  assert.equal(member.state.workspaces.length, 1);
  await assert.rejects(
    member.call("session.create", { workspaceId: other.id, title: "越权" }),
    /访问权限/,
  );
  const bad = new HubClient();
  t.after(() => bad.close());
  await assert.rejects(
    bad.connect(`ws://127.0.0.1:${hub.port}`, {
      token: "incorrect",
      secret: secret(),
      name: "无效用户",
    }),
    /失效/,
  );
});
test("a collaborator approves, only the owner claims, and simultaneous claims execute once", async (t) => {
  const { host, guest, workspace } = await setup(t);
  const member = await guest();
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "执行审批",
  });
  const l = await member.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  const ap = await member.call("run.request", {
    sessionId: s.id,
    laneId: l.id,
    prompt: "检查 README",
    mode: "read-only",
    files: ["README.md"],
  });
  await assert.rejects(member.call("run.claim", { id: ap.id }), /未获批准/);
  await host.call("approval.decide", { id: ap.id, allow: true });
  await assert.rejects(host.call("run.claim", { id: ap.id }), /未获批准/);
  const results = await Promise.allSettled([
    member.call("run.claim", { id: ap.id }),
    member.call("run.claim", { id: ap.id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    host.call("run.entry", {
      sessionId: s.id,
      laneId: l.id,
      runId: ap.id,
      role: "assistant",
      text: "伪造",
    }),
    /自己的/,
  );
  await member.call("run.entry", {
    sessionId: s.id,
    laneId: l.id,
    runId: ap.id,
    role: "assistant",
    text: "检查完成",
  });
  await member.call("run.finish", {
    sessionId: s.id,
    laneId: l.id,
    runId: ap.id,
    status: "done",
  });
  await tick();
  assert.equal(host.state.sessions[0].lanes[0].entries.at(-2).text, "检查完成");
  assert.equal(host.state.sessions[0].lanes[0].status, "done");
});
test("overlap warnings, cancellation, rejection and stale-run fencing", async (t) => {
  const { host, guest, workspace } = await setup(t);
  const member = await guest();
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "冲突协同",
  });
  const a = await host.call("lane.create", {
    sessionId: s.id,
    provider: "claude",
  });
  const b = await member.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  const one = await host.call("run.request", {
    sessionId: s.id,
    laneId: a.id,
    prompt: "编辑",
    mode: "workspace-write",
    files: ["a.ts"],
  });
  const two = await member.call("run.request", {
    sessionId: s.id,
    laneId: b.id,
    prompt: "编辑",
    mode: "workspace-write",
    files: ["a.ts"],
  });
  assert.equal(two.overlaps.length, 1);
  await assert.rejects(
    host.call("session.archive", { sessionId: s.id }),
    /先停止/,
  );
  await host.call("lane.stop", { sessionId: s.id, laneId: b.id });
  await assert.rejects(
    member.call("approval.decide", { id: two.id, allow: true }),
    /已经处理/,
  );
  await member.call("approval.decide", { id: one.id, allow: false });
  const three = await member.call("run.request", {
    sessionId: s.id,
    laneId: b.id,
    prompt: "读取",
    mode: "read-only",
  });
  await host.call("approval.decide", { id: three.id, allow: true });
  await member.call("run.claim", { id: three.id });
  await assert.rejects(
    member.call("run.entry", {
      sessionId: s.id,
      laneId: b.id,
      runId: two.id,
      role: "assistant",
      text: "过期结果",
    }),
    /结束/,
  );
});
test("diff publication is visible to peers and attributed to its lane", async (t) => {
  const { host, guest, workspace } = await setup(t);
  const member = await guest();
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "代码审阅",
  });
  const l = await host.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  await host.call("diff.publish", {
    sessionId: s.id,
    laneId: l.id,
    diff: "diff --git a/a b/a\n+你好",
    files: [{ path: "a", status: " M" }],
  });
  await tick();
  assert.match(member.state.sessions[0].lanes[0].diff, /你好/);
  await assert.rejects(
    member.call("diff.publish", {
      sessionId: s.id,
      laneId: l.id,
      diff: "伪造",
    }),
    /自己的/,
  );
});
test("revoking an invitation disconnects guests and prevents future joins", async (t) => {
  const { host, guest, workspace } = await setup(t);
  const member = await guest();
  const off = new Promise((resolve) => member.once("offline", resolve));
  await host.call("invite.revoke", { workspaceId: workspace.id });
  await off;
  member.close();
  await assert.rejects(guest(), /失效/);
});
test("data survives restart and running turns are marked interrupted", async (t) => {
  const { hub, host, workspace, dir } = await setup(t);
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "持久化会话",
  });
  const l = await host.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  const a = await host.call("run.request", {
    sessionId: s.id,
    laneId: l.id,
    prompt: "测试",
    mode: "read-only",
  });
  await host.call("approval.decide", { id: a.id, allow: true });
  await host.call("run.claim", { id: a.id });
  const restored = new Hub(dir);
  assert.equal(restored.db.sessions[0].title, "持久化会话");
  assert.equal(restored.db.sessions[0].lanes[0].status, "interrupted");
  assert.equal(restored.db.hostToken, hub.db.hostToken);
});

test("opening an additional listener preserves running sessions and existing clients", async (t) => {
  const { hub, host, workspace } = await setup(t);
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "共享不中断执行",
  });
  const l = await host.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  const a = await host.call("run.request", {
    sessionId: s.id,
    laneId: l.id,
    prompt: "测试",
    mode: "read-only",
  });
  await host.call("approval.decide", { id: a.id, allow: true });
  await host.call("run.claim", { id: a.id });
  const originalPort = hub.port;
  const secondPort = await hub.listen({ host: "127.0.0.1" });
  assert.notEqual(originalPort, secondPort);
  assert.equal(hub.port, originalPort);
  const state = await host.call("state");
  assert.equal(state.sessions[0].lanes[0].status, "running");
  await host.call("run.finish", {
    sessionId: s.id,
    laneId: l.id,
    runId: a.id,
    status: "done",
  });
});

test("full transcripts remain exportable after the live window is trimmed", async (t) => {
  const { hub, host, workspace } = await setup(t);
  const s = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "长期记录",
  });
  const l = await host.call("lane.create", {
    sessionId: s.id,
    provider: "codex",
  });
  const stored = hub.db.sessions.find((v) => v.id === s.id).lanes[0];
  for (let i = 0; i < 610; i++) hub.entry(stored, "assistant", `事件 ${i}`);
  hub.broadcast();
  const live = await host.call("state");
  assert.equal(live.sessions[0].lanes[0].entries.length, 600);
  const full = await host.call("session.export", { sessionId: s.id });
  assert.equal(full.lanes[0].entries.length, 611);
  assert.equal(full.lanes[0].entries[1].text, "事件 0");
});
test("malformed remote messages close the client without crashing", async (t) => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  const client = new HubClient();
  t.after(() => {
    client.close();
    for (const s of server.clients) s.terminate();
    server.close();
  });
  server.on("connection", (socket) => socket.send("not json"));
  await assert.rejects(
    client.connect(`ws://127.0.0.1:${server.address().port}`, {
      token: "test",
    }),
    /断开|未连接/,
  );
  client.close();
});

test('usage snapshots are persisted/shared, owner-fenced, bounded and idempotent without summing',async t=>{
 const {codexUsage}=await import('../core/providers/usage.mjs');
 const {hub,host,workspace,guest}=await setup(t),other=await guest();
 const session=await host.call('session.create',{workspaceId:workspace.id,title:'usage'});
 const lane=await host.call('lane.create',{sessionId:session.id,provider:'codex'});
 const start=async()=>{const a=await host.call('run.request',{sessionId:session.id,laneId:lane.id,prompt:'synthetic',mode:'read-only'});await host.call('approval.decide',{id:a.id,allow:true});await host.call('run.claim',{id:a.id});return a.id;};
 const runId=await start();
 const usage=codexUsage({last:{totalTokens:20},total:{totalTokens:120},modelContextWindow:1000});
 const a={sessionId:session.id,laneId:lane.id,runId,sequence:1,usage};
 await assert.rejects(other.call('run.usage',a),/自己的/);
 await host.call('member.role',{workspaceId:workspace.id,memberId:other.state.me.id,role:'viewer'});
 await assert.rejects(other.call('run.usage',a),/editor 权限/);
 await assert.rejects(host.call('run.usage',{...a,runId:'wrong'}),/结束/);
 for(const n of [-1,0,1.5,100001]) await assert.rejects(host.call('run.usage',{...a,sequence:n}),/序号/);
 for(const n of [-1,1.5,1e15,'10'])await assert.rejects(host.call('run.usage',{...a,usage:{...usage,context:{...usage.context,usedTokens:n}}}),/非负整数/);
 await assert.rejects(host.call('run.usage',{...a,usage:{...usage,source:'claude'}}),/来源/);
 assert.equal((await host.call('run.usage',a)).duplicate,false);
 assert.equal((await host.call('run.usage',a)).duplicate,true);
 await assert.rejects(host.call('run.usage',{...a,usage:{...usage,context:{...usage.context,usedTokens:21}}}),/冲突/);
 const reduced={...a,sequence:2,usage:{...usage,context:{...usage.context,usedTokens:5}}};await host.call('run.usage',reduced);
 assert.equal((await host.call('run.usage',a)).duplicate,true);
 const stored=hub.store.readJSON(hub.file).sessions.find(s=>s.id===session.id).lanes.find(l=>l.id===lane.id).usage;
 assert.equal(stored.sequence,2);assert.equal(stored.context.usedTokens,5);assert.equal(stored.cumulative.totalTokens,120);
 await other.call('state');assert.equal(other.state.sessions.find(s=>s.id===session.id).lanes[0].usage.context.usedTokens,5);
 await host.call('run.finish',{sessionId:session.id,laneId:lane.id,runId,status:'done'});
 await assert.rejects(host.call('run.usage',reduced),/结束/);
 const next=await start();assert.equal(hub.db.sessions.find(s=>s.id===session.id).lanes[0].usage,undefined);
 await assert.rejects(host.call('run.usage',{...a,sequence:3}),/结束/);
 await host.call('run.usage',{...a,runId:next});
 await host.call('lane.stop',{sessionId:session.id,laneId:lane.id});
 await assert.rejects(host.call('run.usage',{...a,runId:next,sequence:2}),/结束/);
});
