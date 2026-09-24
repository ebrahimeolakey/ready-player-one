import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import { registerACP, probeACP } from "../core/providers/acp.mjs";
const peer = fileURLToPath(new URL("./fixtures/acp-peer.mjs", import.meta.url));
async function setup(t, mode = "stable", extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "rpo-acp-"));
  const runtime = new ProviderRuntime();
  t.after(async () => {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const config = {
    command: process.execPath,
    args: [peer],
    env: { ACP_FIXTURE_CASE: mode },
    ...extra,
  };
  registerACP(runtime, "acp-fixture", config);
  return {
    cwd,
    runtime,
    config,
    wire: async () =>
      (await readFile(join(cwd, "wire.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
async function start(fixture, options = {}) {
  let ended;
  const completion = new Promise((resolve) => {
    ended = resolve;
  });
  const events = [];
  const run = await fixture.runtime.start({
    runId: "run-" + Math.random(),
    provider: "acp-fixture",
    cwd: fixture.cwd,
    mode: "workspace-write",
    prompt: "Synthetic protocol test",
    onEvent: (event) => events.push(event),
    onEnd: ended,
    ...options,
  });
  return { run, events, completion };
}
const absent = async (path) => assert.rejects(access(path));
test("real stdio child: negotiate config catalogs, model/effort/mode, MCP, image, streaming and one-shot approvals", async (t) => {
  const f = await setup(t, "stable", { modeId: "ask" });
  const probe = await probeACP(f.config, { cwd: f.cwd });
  assert.equal(probe.agentInfo.name, "synthetic-acp-peer");
  assert.deepEqual(
    probe.models.map((m) => m.id),
    ["fixture-model", "other-model"],
  );
  assert.deepEqual(probe.efforts, ["low", "high"]);
  const { events, completion } = await start(f, {
    model: "other-model",
    effort: "high",
    mcpServers: {
      rpo: {
        command: process.execPath,
        args: ["synthetic-mcp"],
        env: { SYNTHETIC_ENV: "local-only" },
      },
    },
    images: [
      {
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
        mimeType: "image/png",
      },
    ],
    onApproval: () => ({ allow: true }),
  });
  assert.equal((await completion).status, "done");
  assert.equal(
    await readFile(join(f.cwd, "approved.txt"), "utf8"),
    "only after allow_once",
  );
  await absent(join(f.cwd, "bypass.txt"));
  assert.ok(events.some((e) => e.type === "delta" && e.role === "reasoning"));
  assert.ok(
    events.some(
      (e) =>
        e.type === "message" &&
        e.role === "assistant" &&
        e.text === "ACP complete" &&
        e.streamed,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.type === "tool" &&
        e.item.name === "edit_file" &&
        e.phase === "completed",
    ),
  );
  const wire = await f.wire();
  assert.ok(
    wire.some(
      (m) =>
        m.method === "session/set_config_option" &&
        m.params.configId === "thinking" &&
        m.params.value === "high",
    ),
  );
  assert.ok(
    wire.some(
      (m) =>
        m.method === "session/new" &&
        m.params.mcpServers[0]?.env[0]?.name === "SYNTHETIC_ENV",
    ),
  );
  assert.ok(
    wire.some(
      (m) =>
        m.method === "session/prompt" && m.params.prompt[1]?.type === "image",
    ),
  );
  assert.ok(wire.some((m) => m.id === "denied-fs" && m.error?.code === -32601));
});
test("deny and allow-always-only requests never create files or persist broader grants", async (t) => {
  for (const mode of ["stable", "always-only"]) {
    const f = await setup(t, mode);
    const { completion } = await start(f, {
      onApproval: () => ({ allow: mode === "always-only" }),
    });
    assert.equal((await completion).status, "done");
    await absent(join(f.cwd, "approved.txt"));
    const response = (await f.wire()).find((m) => m.id === "permission-1");
    assert.equal(
      response.result.outcome.outcome,
      mode === "stable" ? "selected" : "cancelled",
    );
    assert.notEqual(response.result.outcome.optionId, "always");
  }
});
test("session/load resumes native ID without replaying old transcript; unsupported load fails instead of a new session", async (t) => {
  const f = await setup(t);
  const first = await start(f, { onApproval: () => ({ allow: false }) });
  const ended = await first.completion;
  const next = await start(f, {
    sessionId: ended.sessionId,
    onApproval: () => ({ allow: false }),
  });
  assert.equal((await next.completion).sessionId, "fixture-session");
  assert.ok(!JSON.stringify(next.events).includes("OLD_HISTORY"));
  const noLoad = await setup(t, "no-load");
  await assert.rejects(
    start(noLoad, { sessionId: "fixture-session" }),
    /不支持恢复/,
  );
  assert.ok(!(await noLoad.wire()).some((m) => m.method === "session/new"));
});
test("legacy Hermes-style models require explicit compatibility flag and use the advertised model API", async (t) => {
  const f = await setup(t, "legacy", { legacyModelApi: true, modeId: "ask" });
  const probe = await probeACP(f.config, { cwd: f.cwd });
  assert.equal(probe.models[0].id, "legacy-model");
  const run = await start(f, {
    model: "legacy-other",
    onApproval: () => ({ allow: false }),
  });
  assert.equal((await run.completion).status, "done");
  assert.ok(
    (await f.wire()).some(
      (m) =>
        m.method === "session/set_model" && m.params.modelId === "legacy-other",
    ),
  );
  const normal = await probeACP(
    { ...f.config, legacyModelApi: false },
    { cwd: f.cwd },
  );
  assert.deepEqual(normal.models, []);
});
test("unsupported protocol, image and read-only modes fail before any prompt; auth probe never signs in", async (t) => {
  const version = await setup(t, "version");
  await assert.rejects(start(version), /协议版本/);
  const noImage = await setup(t, "no-image");
  await assert.rejects(
    start(noImage, {
      images: [
        {
          data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        },
      ],
    }),
    /图片/,
  );
  assert.ok(!(await noImage.wire()).some((m) => m.method === "session/prompt"));
  const readonly = await setup(t);
  await assert.rejects(
    start(readonly, { mode: "read-only" }),
    /无通用只读沙箱/,
  );
  await absent(join(readonly.cwd, "wire.jsonl"));
  const auth = await setup(t, "auth");
  const probe = await probeACP(auth.config, { cwd: auth.cwd });
  assert.equal(probe.requiresAuth, true);
  assert.ok(!(await auth.wire()).some((m) => m.method === "authenticate"));
});
test("mapped read-only mode denies edit permission, unsupported steering preserves caller draft", async (t) => {
  const f = await setup(t, "stable", { readOnlyModeId: "read" });
  let approvals = 0;
  const { run, completion } = await start(f, {
    mode: "read-only",
    onApproval: () => {
      approvals++;
      return { allow: true };
    },
  });
  assert.equal((await run.steer("Keep this draft")).unsupported, true);
  assert.equal((await completion).status, "done");
  assert.equal(approvals, 0);
  await absent(join(f.cwd, "approved.txt"));
  assert.ok(
    (await f.wire()).some(
      (m) =>
        m.method === "session/set_config_option" && m.params.value === "read",
    ),
  );
});
test("cancel answers pending permission with cancelled and sends notification, then ends once", async (t) => {
  const f = await setup(t, "wait-cancel");
  let approved;
  const approval = new Promise((resolve) => {
    approved = resolve;
  });
  let ends = 0;
  const { run, completion } = await start(f, {
    onApproval: () => {
      approved();
      return undefined;
    },
  });
  await approval;
  await run.interrupt();
  assert.equal((await completion).status, "interrupted");
  const wire = await f.wire();
  assert.ok(
    wire.some(
      (m) =>
        m.id === "permission-1" && m.result.outcome.outcome === "cancelled",
    ),
  );
  assert.ok(
    wire.some((m) => m.method === "session/cancel" && m.id === undefined),
  );
  await absent(join(f.cwd, "approved.txt"));
});
test("cancellation kills a real ignoring descendant after unresponsive agent", async (t) => {
  const f = await setup(t, "hang");
  const { run, completion } = await start(f, { cancelTimeoutMs: 50 });
  let pid;
  for (let i = 0; i < 100; i++) {
    try {
      pid = Number(await readFile(join(f.cwd, "descendant.pid"), "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assert.ok(pid);
  await run.interrupt();
  assert.equal((await completion).status, "interrupted");
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
});
