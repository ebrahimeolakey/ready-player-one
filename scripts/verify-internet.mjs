// Explicit, bounded live test. Never load production Hub data or provider credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Hub } from "../core/hub.mjs";
import { SecureStore } from "../core/secure-store.mjs";
import { HubClient } from "../core/client.mjs";
import { Tunnel } from "../core/tunnel.mjs";
import { localEnv } from "../core/local.mjs";

if (!process.argv.includes("--run")) {
  console.log(
    "Use node scripts/verify-internet.mjs --run to start a temporary public Quick Tunnel with synthetic data.",
  );
  process.exit(0);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const candidates = [
  join(homedir(), ".ready-player-one", "bin"),
  ...(localEnv().PATH || "").split(delimiter),
];
let binary;
for (const directory of candidates) {
  const candidate = join(
    directory,
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  try {
    await access(candidate, constants.X_OK);
    binary = candidate;
    break;
  } catch {}
}
if (!binary) {
  console.error(
    "BLOCKED: existing cloudflared not found; no installation attempted.",
  );
  process.exit(2);
}
const dir = await mkdtemp(join(tmpdir(), "rpo-public-verification-"));
const key = randomBytes(32),
  store = new SecureStore({ dir, key });
const hub = new Hub(dir, { store });
let tunnelChild;
const tunnel = new Tunnel({
  spawnProcess: (_command, args, options) => {
    tunnelChild = spawn(binary, args, options);
    return tunnelChild;
  },
});
const owner = new HubClient(),
  member = new HubClient();
const secret = () => randomBytes(32).toString("hex");
const checks = [];
const pass = (label) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const client of [member, owner]) {
    client.close();
    client.ws?.terminate();
  }
  const child = tunnelChild;
  tunnel.stop();
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      delay(3000),
    ]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  // Close any remaining test socket, including a failed-auth socket not registered as a peer.
  for (const { wss } of hub.servers)
    for (const ws of wss.clients) ws.terminate();
  await hub.close();
  key.fill(0);
  await rm(dir, { recursive: true, force: true });
}
const hardLimit = setTimeout(() => {
  console.error("FAIL live verification exceeded 180 seconds");
  void cleanup().finally(() => process.exit(1));
}, 180000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });
try {
  await hub.listen();
  console.log(
    "Starting existing cloudflared; temporary synthetic Hub only. Endpoint and credentials are not logged.",
  );
  const endpoint = await tunnel.start(hub.port),
    url = endpoint.replace("https:", "wss:");
  assert.match(url, /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  const ownerAuth = {
    token: hub.db.hostToken,
    secret: secret(),
    name: "Synthetic owner",
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await owner.connect(url, ownerAuth);
      break;
    } catch (error) {
      owner.close();
      if (attempt === 3) throw error;
      await delay(2000);
    }
  }
  const workspace = await owner.call("workspace.create", {
    name: "SYNTHETIC_PUBLIC_WORKSPACE",
  });
  await owner.call("workspace.create", { name: "SYNTHETIC_PRIVATE_WORKSPACE" });
  const session = await owner.call("session.create", {
    workspaceId: workspace.id,
    title: "Synthetic public collaboration",
  });
  const invitation = await owner.call("invite.create", {
    workspaceId: workspace.id,
    role: "viewer",
  });
  const memberAuth = {
    token: invitation.token,
    secret: secret(),
    name: "Synthetic member",
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await member.connect(url, memberAuth);
      break;
    } catch (error) {
      member.close();
      if (attempt === 3) throw error;
      await delay(2000);
    }
  }
  assert.equal(owner.url, url);
  assert.equal(member.url, url);
  assert.equal(member.state.workspaces.length, 1);
  assert.equal(member.state.me.role, "viewer");
  pass(
    "both independent clients authenticated over public WSS; invitation scoped",
  );
  for (const [method, args] of [
    ["plan.add", { sessionId: session.id, text: "REJECTED_VIEWER_WRITE" }],
    ["comment.add", { sessionId: session.id, text: "REJECTED_VIEWER_WRITE" }],
    ["lane.create", { sessionId: session.id, provider: "codex" }],
  ])
    await assert.rejects(member.call(method, args), /权限|角色|Viewer|viewer/);
  assert.equal(hub.db.sessions[0].plan.length, 0);
  assert.equal(hub.db.sessions[0].comments.length, 0);
  pass("viewer plan/comment/lane writes rejected without state mutation");
  await owner.call("member.role", {
    workspaceId: workspace.id,
    memberId: member.state.me.id,
    role: "editor",
  });
  await until(() => member.state.me.role === "editor", "editor role broadcast");
  const plan = await member.call("plan.add", {
    sessionId: session.id,
    text: "SYNTHETIC_PUBLIC_PLAN",
  });
  await member.call("comment.add", {
    sessionId: session.id,
    text: "SYNTHETIC_PUBLIC_COMMENT",
    anchor: "README.md:1",
  });
  await until(
    () =>
      owner.state.sessions
        .find((s) => s.id === session.id)
        ?.comments.some((c) => c.text === "SYNTHETIC_PUBLIC_COMMENT"),
    "comment broadcast",
  );
  assert.ok(
    owner.state.sessions
      .find((s) => s.id === session.id)
      .plan.some((p) => p.id === plan.id),
  );
  pass("editor plan/comment synchronized to owner over public WSS");
  const lane = await member.call("lane.create", {
    sessionId: session.id,
    provider: "codex",
  });
  const context = { sessionId: session.id, laneId: lane.id };
  const request = await member.call("run.request", {
    ...context,
    prompt: "SYNTHETIC_PROTOCOL_TASK",
    mode: "read-only",
    files: ["README.md"],
  });
  await assert.rejects(
    member.call("run.claim", { id: request.id }),
    /未获批准/,
  );
  await owner.call("approval.decide", { id: request.id, allow: true });
  await assert.rejects(owner.call("run.claim", { id: request.id }), /未获批准/);
  await member.call("run.claim", { id: request.id, claimKey: secret() });
  const run = { ...context, runId: request.id };
  const tool = await member.call("tool.request", {
    ...run,
    providerRequestId: randomUUID(),
    action: "readFile",
    input: { path: "README.md" },
  });
  await assert.rejects(member.call("tool.claim", { id: tool.id }), /未决定/);
  await owner.call("tool.decide", { id: tool.id, allow: false });
  assert.equal(
    (await member.call("tool.claim", { id: tool.id })).allowed,
    false,
  );
  pass(
    "run approval and execution-owner-only claim; synthetic tool denial enforced",
  );
  const entryId = randomUUID();
  for (const [index, text] of ["SYNTHETIC_", "PUBLIC_", "TRANSCRIPT"].entries())
    await member.call("run.entry", {
      ...run,
      role: "assistant",
      text,
      delta: true,
      entryId,
      eventId: `delta-${index}`,
    });
  await member.call("run.entry", {
    ...run,
    role: "assistant",
    text: "SYNTHETIC_PUBLIC_TRANSCRIPT",
    delta: false,
    entryId,
    eventId: "final",
  });
  await until(
    () =>
      owner.state.sessions
        .find((s) => s.id === session.id)
        ?.lanes[0].entries.some(
          (e) =>
            e.id === entryId &&
            e.text === "SYNTHETIC_PUBLIC_TRANSCRIPT" &&
            !e.streaming,
        ),
    "streamed transcript",
  );
  const oldSocket = member.ws,
    memberId = member.state.me.id;
  oldSocket.terminate();
  await until(
    () =>
      member.ws !== oldSocket &&
      member.ws.readyState === 1 &&
      hub.peers.size === 2,
    "automatic WSS reconnect",
    20000,
  );
  await member.call("state");
  assert.equal(member.state.me.id, memberId);
  await member.call("run.reconcile", run);
  assert.equal(
    (
      await member.call("run.entry", {
        ...run,
        role: "assistant",
        text: "SYNTHETIC_PUBLIC_TRANSCRIPT",
        entryId,
        eventId: "final",
      })
    ).duplicate,
    true,
  );
  await member.call("run.finish", {
    ...run,
    status: "done",
    message: "SYNTHETIC_TASK_FINISHED",
  });
  const exported = await owner.call("session.export", {
    sessionId: session.id,
  });
  assert.equal(exported.lanes[0].status, "done");
  assert.equal(
    exported.lanes[0].entries.filter((e) => e.id === entryId).length,
    1,
  );
  assert.equal(
    exported.lanes[0].entries.find((e) => e.id === entryId).text,
    "SYNTHETIC_PUBLIC_TRANSCRIPT",
  );
  pass(
    "streamed transcript; automatic reconnect, run reconciliation and replay deduplication",
  );
  for (const filename of ["hub.json", `transcripts/${lane.id}.jsonl`]) {
    const bytes = await readFile(store.path(filename));
    for (const sentinel of [
      "SYNTHETIC_PUBLIC_TRANSCRIPT",
      "SYNTHETIC_PROTOCOL_TASK",
      invitation.token,
    ])
      assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  }
  pass("test Hub and transcript persisted encrypted, no plaintext sentinels");
  const revokedSocket = member.ws;
  let closeCode;
  revokedSocket.once("close", (code) => {
    closeCode = code;
  });
  await owner.call("invite.revoke", { workspaceId: workspace.id });
  await until(() => closeCode !== undefined, "revocation closes guest");
  assert.equal(closeCode, 1008);
  member.close();
  await assert.rejects(member.connect(url, memberAuth), /失效/);
  member.close();
  pass(
    "invite revocation disconnects member with 1008 and rejects reauthentication",
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      checks: checks.length,
      transport: "public Cloudflare Quick Tunnel WSS",
      clients: 2,
      physicalComputers: 1,
      providerExecution: false,
      timestamp: new Date().toISOString(),
    }),
  );
} catch (error) {
  // Never include raw request/response objects, URLs, invite tokens or credentials in reports.
  console.error(
    "FAIL",
    String(error.message).replace(
      /https?:\/\/\S+|wss?:\/\/\S+|[a-f0-9]{64}/gi,
      "[redacted]",
    ),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(hardLimit);
  await cleanup();
  console.log(
    "CLEANUP: test clients, tunnel, Hub and temporary encrypted data removed.",
  );
}
