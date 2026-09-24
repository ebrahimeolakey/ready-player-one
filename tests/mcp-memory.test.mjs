import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./helpers/secure-hub.mjs";
import { createCoordinationMcp } from "../core/mcp-coordination.mjs";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-mcp-memory-")), hub = new Hub(dir);
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const host = { id: "host", name: "Host", host: true };
  const w = hub.act(host, "workspace.create", { name: "Current" });
  const other = hub.act(host, "workspace.create", { name: "Other" });
  const session = hub.act(host, "session.create", { workspaceId: w.id, title: "Current session" });
  const otherSession = hub.act(host, "session.create", { workspaceId: other.id, title: "Other session" });
  const peer = { id: "editor", name: "Editor", host: false, workspaceId: w.id };
  hub.registerMember(peer, w.id, "editor");
  const act = (method, args = {}) => hub.act(host, method, { workspaceId: w.id, sessionId: session.id, ...args });
  async function mcp(as = host) {
    const dispatch = createCoordinationMcp({ client: { call: (method, args) => hub.act(as, method, args) }, sessionId: session.id });
    await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    return (name, args = {}) => dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: `rpo_${name}`, arguments: args } });
  }
  return { hub, host, w, other, session, otherSession, peer, act, mcp };
}
const data = response => { assert.equal(response.result?.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); };
const denied = response => { assert.equal(response.result?.isError, true, JSON.stringify(response)); return response.result.content[0].text; };

test("MCP host cannot mutate or discover another workspace through IDs or scope arguments", async t => {
  const { hub, host, other, otherSession, act, mcp } = await setup(t), call = await mcp();
  const own = act("memory.add", { title: "Current", text: "safe" });
  const foreign = hub.act(host, "memory.add", { workspaceId: other.id, title: "Private", text: "other workspace" });
  const plan = hub.act(host, "plan.add", { sessionId: otherSession.id, text: "Private plan" });
  assert.deepEqual(data(await call("memory_list", { includeRetired: true })).map(v => v.id), [own.id]);
  assert.match(denied(await call("memory_update", { id: foreign.id, text: "changed" })), /当前工作区/);
  assert.match(denied(await call("memory_retire", { id: foreign.id, retired: true })), /当前工作区/);
  assert.match(denied(await call("plan_assign", { id: plan.id, assigneeId: host.id })), /计划不存在/);
  for (const name of ["memory_list", "memory_update", "memory_retire", "plan_assign"]) {
    const args = name === "memory_list" ? {} : { id: own.id, ...(name === "memory_retire" ? { retired: true } : name === "plan_assign" ? { assigneeId: host.id } : {}) };
    assert.equal((await call(name, { ...args, workspaceId: other.id })).error.code, -32602);
  }
  // Bypassing MCP must not bypass the same session-bound restriction at the server.
  for (const method of ["memory.update", "memory.retire"]) assert.throws(() => act(method, { id: foreign.id, text: "changed", retired: true }), /当前工作区/);
  assert.throws(() => act("memory.list", { workspaceId: other.id, includeRetired: true }), /会话不匹配/);
  assert.equal(foreign.text, "other workspace"); assert.equal(foreign.retired, false);
});

test("explicit retire survives repeated delivery, lists retired records and can explicitly restore", async t => {
  const { act, mcp } = await setup(t), call = await mcp();
  const memory = act("memory.add", { title: "Rule", text: "v1" });
  const files = [{ path: "src/rule.js", commit: "a".repeat(40), hash: "b".repeat(64) }];
  data(await call("memory_update", { id: memory.id, text: "v2", files }));
  assert.equal(memory.text, "v2"); assert.deepEqual(memory.files, files);
  for (let i = 0; i < 2; i++) data(await call("memory_retire", { id: memory.id, retired: true }));
  assert.equal(memory.retired, true);
  assert.deepEqual(data(await call("memory_list")), []);
  assert.equal(data(await call("memory_list", { includeRetired: true }))[0].id, memory.id);
  for (let i = 0; i < 2; i++) data(await call("memory_retire", { id: memory.id, retired: false }));
  assert.equal(memory.retired, false);
  for (const retired of ["false", 0, null]) {
    assert.equal((await call("memory_retire", { id: memory.id, retired })).error.code, -32602);
    assert.throws(() => act("memory.retire", { id: memory.id, retired }), /布尔值/);
  }
  assert.equal((await call("memory_retire", { id: memory.id })).error.code, -32602);
  assert.equal((await call("memory_list", { includeRetired: "true" })).error.code, -32602);
  assert.match(denied(await call("memory_update", { id: memory.id, files: [{ path: "../outside", commit: "a".repeat(40) }] })), /路径/);
  assert.deepEqual(memory.files, files);
  act("memory.retire", { id: memory.id }); assert.equal(memory.retired, true);
  act("memory.retire", { id: memory.id }); assert.equal(memory.retired, false);
});

test("existing MCP connection observes role downgrade immediately and removal blocks reads", async t => {
  const { act, peer, mcp } = await setup(t), call = await mcp(peer);
  const plan = act("plan.add", { text: "Unclaimed" });
  const memory = act("memory.add", { title: "Rule", text: "safe" });
  data(await call("plan_assign", { id: plan.id, assigneeId: peer.id }));
  data(await call("memory_update", { id: memory.id, text: "updated" }));
  act("member.role", { memberId: peer.id, role: "viewer" });
  for (const [name, args] of [["plan_assign", { id: plan.id, assigneeId: peer.id }], ["memory_update", { id: memory.id, text: "denied" }], ["memory_retire", { id: memory.id, retired: true }]]) {
    assert.match(denied(await call(name, args)), /editor 权限/);
  }
  assert.equal(data(await call("memory_list", { includeRetired: true })).length, 1);
  assert.equal(memory.text, "updated"); assert.equal(memory.retired, false);
  act("member.remove", { memberId: peer.id });
  assert.match(denied(await call("memory_list", { includeRetired: true })), /访问权限/);
});

test("MCP assignment retains in-progress consent and list masks recognized credentials", async t => {
  const { act, host, peer, mcp } = await setup(t), call = await mcp();
  const plan = act("plan.add", { text: "In progress", assigneeId: peer.id });
  act("plan.status", { id: plan.id, status: "in-progress" });
  const requested = data(await call("plan_assign", { id: plan.id, assigneeId: host.id }));
  assert.equal(requested.assigneeId, peer.id);
  assert.equal(requested.transferRequest.status, "awaiting-release");
  const secret = "bearer-token-that-must-not-leak-123456";
  act("memory.add", { title: "Protected", text: `Authorization: Bearer ${secret}` });
  assert.equal(JSON.stringify(data(await call("memory_list"))).includes(secret), false);
});
