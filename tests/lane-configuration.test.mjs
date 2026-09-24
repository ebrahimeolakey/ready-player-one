import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Hub } from "./helpers/secure-hub.mjs";
import { HubClient } from "../core/client.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-model-share-")), hub = new Hub(dir);
  const host = { id: "owner", name: "Owner", host: true };
  const workspace = hub.act(host, "workspace.create", { name: "Models" });
  const session = hub.act(host, "session.create", { workspaceId: workspace.id, title: "Share models" });
  const editor = { id: "editor", name: "Editor", host: false, workspaceId: workspace.id };
  const other = { id: "other", name: "Other", host: false, workspaceId: workspace.id };
  hub.registerMember(editor, workspace.id, "editor"); hub.registerMember(other, workspace.id, "editor");
  const lane = hub.act(editor, "lane.create", { sessionId: session.id, provider: "codex" });
  const act = (peer, method, args = {}) => hub.act(peer, method, { workspaceId: workspace.id, sessionId: session.id, laneId: lane.id, ...args });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  function claim() {
    const approval = act(editor, "run.request", { prompt: "fixture", mode: "read-only" });
    act(host, "approval.decide", { id: approval.id, allow: true });
    act(editor, "run.claim", { id: approval.id });
    return approval.id;
  }
  return { hub, host, editor, other, workspace, session, lane, act, claim, dir };
}

test("two remote clients share model choices while another editor and host cannot overwrite the lane", async t => {
  const { hub, host, workspace, session } = await fixture(t); await hub.listen();
  const first = new HubClient(), second = new HubClient();
  t.after(() => { first.close(); second.close(); });
  const invite = hub.act(host, "invite.create", { workspaceId: workspace.id, role: "editor" });
  for (const [client, name] of [[first, "Alice"], [second, "Bob"]]) await client.connect(`ws://127.0.0.1:${hub.port}`, { token: invite.token, secret: randomBytes(32).toString("hex"), name });
  const lane = await first.call("lane.create", { sessionId: session.id, provider: "claude" });
  assert.equal(lane.configuration, undefined);
  const scope = { sessionId: session.id, laneId: lane.id };
  await first.call("lane.configure", { ...scope, model: "opus-alias", effort: "high" });
  const shared = (await second.call("state")).sessions.find(s => s.id === session.id).lanes.find(l => l.id === lane.id);
  assert.equal(shared.configuration.model, "opus-alias"); assert.equal(shared.configuration.effort, "high");
  await assert.rejects(second.call("lane.configure", { ...scope, model: "wrong", effort: null }), /自己的/);
  assert.throws(() => hub.act(host, "lane.configure", { ...scope, model: "wrong" }), /自己的/);
  await first.call("lane.configure", { ...scope, model: null, effort: null });
  assert.equal((await second.call("state")).sessions.find(s => s.id === session.id).lanes.find(l => l.id === lane.id).configuration.model, null);
});

test("running selection is immutable and provider reports stay separate from next-run choices", async t => {
  const { act, claim, editor, other, host, lane, hub } = await fixture(t), runId = claim();
  const params = { runId, phase: "requested", model: "alias", effort: "high" };
  act(editor, "run.configuration", params);
  assert.equal(act(editor, "run.configuration", params).duplicate, true);
  assert.throws(() => act(editor, "run.configuration", { ...params, model: "changed" }), /已固定/);
  act(editor, "lane.configure", { model: "next-model", effort: "low" });
  const report = { runId, phase: "reported", sequence: 1, model: "actual-model-2026", effort: null };
  act(editor, "run.configuration", report);
  for (const peer of [other, host]) assert.throws(() => act(peer, "run.configuration", report), /自己的/);
  assert.equal(act(editor, "run.configuration", report).duplicate, true);
  assert.throws(() => act(editor, "run.configuration", { ...report, model: "rewritten" }), /内容冲突/);
  act(editor, "run.configuration", { ...report, sequence: 2, model: "actual-fallback" });
  assert.equal(act(editor, "run.configuration", report).duplicate, true);
  assert.equal(lane.configuration.model, "next-model");
  assert.equal(lane.runConfiguration.requested.model, "alias");
  assert.equal(lane.runConfiguration.reported.model, "actual-fallback");
  assert.throws(() => act(editor, "run.configuration", { ...report, runId: "obsolete" }), /执行已结束/);
  assert.equal(hub.snapshot(other).sessions[0].lanes[0].runConfiguration.reported.model, "actual-fallback");
  act(editor, "run.finish", { runId, status: "done" });
  assert.throws(() => act(editor, "run.configuration", { ...report, sequence: 3 }), /执行已结束/);
  const next = claim();
  assert.notEqual(next, runId); assert.equal(lane.runConfiguration, undefined);
  act(host, "member.role", { memberId: editor.id, role: "viewer" });
  for (const method of ["lane.configure", "run.configuration"]) assert.throws(() => act(editor, method, { ...report, runId: next }), /editor 权限/);
});

test("public metadata rejects credentials and malformed values without changing prior state", async t => {
  const { act, editor, lane, claim } = await fixture(t);
  act(editor, "lane.configure", { model: "org/model", effort: "high" });
  const before = structuredClone(lane.configuration);
  for (const args of [{ model: "a\nsecret" }, { model: "https://key@provider.example" }, { model: "sk-test-secret123" }, { model: "x".repeat(151) }, { model: {} }, { model: "safe", apiKey: "secret" }, { model: "safe", provider: "claude" }]) {
    assert.throws(() => act(editor, "lane.configure", args));
    assert.deepEqual(lane.configuration, before);
  }
  const runId = claim();
  assert.throws(() => act(editor, "run.configuration", { runId, phase: "reported", sequence: 1, model: "actual" }), /先记录/);
  act(editor, "run.configuration", { runId, phase: "requested", model: null, effort: null });
  assert.deepEqual(lane.runConfiguration.requested, { model: null, effort: null });
  assert.equal(lane.runConfiguration.reported, undefined);
  act(editor, "lane.stop");
  assert.throws(() => act(editor, "run.configuration", { runId, phase: "reported", sequence: 1, model: "late" }), /执行已结束/);
});

test("shared model metadata persists across Hub restart without inventing missing values", async t => {
  const { hub, dir, act, editor, lane, claim } = await fixture(t);
  act(editor, "lane.configure", { model: "selected", effort: null });
  const runId = claim();
  act(editor, "run.configuration", { runId, phase: "requested", model: "selected", effort: null });
  hub.save();
  const restored = new Hub(dir); t.after(() => restored.close());
  const saved = restored.db.sessions[0].lanes.find(l => l.id === lane.id);
  assert.equal(saved.configuration.model, "selected");
  assert.equal(saved.runConfiguration.requested.model, "selected");
  assert.equal(saved.runConfiguration.reported, undefined);
});
