import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import { JsonLineProcess } from "../core/providers/transport.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeTransport extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.sent = [];
    this.closed = false;
  }
  write(message) {
    this.sent.push(message);
    if (message.method === "initialize")
      queueMicrotask(() =>
        this.emit("message", { id: message.id, result: {} }),
      );
    if (["thread/start", "thread/resume"].includes(message.method))
      queueMicrotask(() =>
        this.emit("message", {
          id: message.id,
          result: {
            thread: { id: message.params.threadId || "native-thread" },
          },
        }),
      );
    if (message.method === "turn/start")
      queueMicrotask(() =>
        this.emit("message", {
          id: message.id,
          result: { turn: { id: "turn-1" } },
        }),
      );
    if (message.method === "turn/steer" || message.method === "turn/interrupt")
      queueMicrotask(() =>
        this.emit("message", { id: message.id, result: {} }),
      );
    if (message.type === "control_request")
      queueMicrotask(() =>
        this.emit("message", {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        }),
      );
  }
  close() {
    this.closed = true;
  }
}
function harness(provider = "codex", options = {}) {
  let transport;
  let args;
  const events = [];
  const ends = [];
  const runtime = new ProviderRuntime({
    transportFactory: (command, argv) => {
      args = argv;
      return (transport = new FakeTransport(command));
    },
  });
  const start = runtime.start({
    runId: "lane",
    provider,
    cwd: "/tmp",
    prompt: "task",
    onEvent: (e) => events.push(e),
    onEnd: (e) => ends.push(e),
    ...options,
  });
  return {
    runtime,
    start,
    events,
    ends,
    get transport() {
      return transport;
    },
    get args() {
      return args;
    },
  };
}

test("Codex resumes native session and steers active turn without replaying fabricated history", async () => {
  const h = harness("codex", {
    sessionId: "persisted-id",
    model: "chosen-model",
    effort: "high",
  });
  await h.start;
  const resume = h.transport.sent.find((m) => m.method === "thread/resume");
  assert.equal(resume.params.threadId, "persisted-id");
  assert.equal(resume.params.approvalPolicy, "untrusted");
  assert.equal(resume.params.approvalsReviewer, "user");
  assert.equal(
    h.transport.sent.find((m) => m.method === "turn/start").params.effort,
    "high",
  );
  await h.runtime.steer("lane", "additional instruction");
  const steer = h.transport.sent.find((m) => m.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, "turn-1");
  assert.equal(steer.params.input[0].text, "additional instruction");
  h.runtime.close();
  assert.equal(h.ends[0].status, "interrupted");
});

test("tool approval pauses until explicit response and rejects duplicate/stale responses", async () => {
  const h = harness();
  await h.start;
  const n = h.transport.sent.length;
  h.transport.emit("message", {
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "native-thread", command: "touch file" },
  });
  assert.equal(h.transport.sent.length, n);
  assert.equal(h.events.at(-1).request.command, "touch file");
  h.runtime.respondApproval("lane", "77", { allow: false });
  assert.deepEqual(h.transport.sent.at(-1), {
    id: 77,
    result: { decision: "decline" },
  });
  assert.throws(
    () => h.runtime.respondApproval("lane", "77", { allow: true }),
    /no longer pending/,
  );
  h.runtime.close();
});

test("unknown host requests fail closed; read-only is requested and full privileges are never granted", async () => {
  const h = harness("codex", { mode: "read-only" });
  await h.start;
  assert.equal(
    h.transport.sent.find((m) => m.method === "thread/start").params.sandbox,
    "read-only",
  );
  h.transport.emit("message", {
    id: "unknown",
    method: "arbitrary/execute",
    params: {},
  });
  assert.equal(h.transport.sent.at(-1).error.code, -32601);
  h.transport.emit("message", {
    id: "permissions",
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  });
  h.runtime.respondApproval("lane", "permissions", { allow: false });
  assert.deepEqual(h.transport.sent.at(-1).result.permissions, {});
  h.runtime.close();
});

test("Codex partial and final messages correlate; errors end exactly once and remove run", async () => {
  const h = harness();
  await h.start;
  h.transport.emit("message", {
    method: "item/agentMessage/delta",
    params: { threadId: "native-thread", itemId: "text", delta: "hello" },
  });
  h.transport.emit("message", {
    method: "item/completed",
    params: {
      threadId: "native-thread",
      item: { id: "text", type: "agentMessage", text: "hello" },
    },
  });
  assert.equal(h.events.at(-1).streamed, true);
  h.transport.emit("message", {
    method: "turn/completed",
    params: {
      threadId: "native-thread",
      turn: { status: "failed", error: { message: "model unavailable" } },
    },
  });
  h.transport.emit("close", { code: 1 });
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].message, "model unavailable");
  assert.equal(h.runtime.runs.size, 0);
  assert.equal(h.transport.closed, true);
});

test("Claude sends official stream-json and returns scoped permission decisions", async () => {
  const h = harness("claude", {
    sessionId: "native-claude-session",
    model: "sonnet",
    effort: "high",
  });
  await h.start;
  assert.ok(h.args.includes("--resume"));
  assert.ok(h.args.includes("manual"));
  assert.ok(!h.args.includes("--dangerously-skip-permissions"));
  h.transport.emit("message", {
    type: "control_request",
    request_id: "tool-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: { file_path: "a.txt", content: "example" },
      tool_use_id: "call",
    },
  });
  h.runtime.respondApproval("lane", "tool-1", { allow: true });
  assert.deepEqual(h.transport.sent.at(-1).response.response, {
    behavior: "allow",
    updatedInput: { file_path: "a.txt", content: "example" },
    toolUseID: "call",
  });
  await h.runtime.interrupt("lane");
  assert.equal(h.transport.closed, true);
  assert.equal(h.ends[0].status, "interrupted");
});

test("Claude canceled approval cannot later approve a tool; callback errors deny", async () => {
  const h = harness("claude", {
    onApproval: () => {
      throw new Error("UI disconnected");
    },
  });
  await h.start;
  h.transport.emit("message", {
    type: "control_request",
    request_id: "a",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
    },
  });
  await tick();
  assert.equal(h.transport.sent.at(-1).response.response.behavior, "deny");
  h.transport.emit("message", {
    type: "control_request",
    request_id: "b",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
    },
  });
  h.transport.emit("message", {
    type: "control_cancel_request",
    request_id: "b",
  });
  await tick();
  assert.throws(
    () => h.runtime.respondApproval("lane", "b", true),
    /no longer pending/,
  );
  h.runtime.close();
});

test("transport preserves unicode split across chunks and terminates real child process", async () => {
  const code = `const b=Buffer.from(JSON.stringify({text:'中文😀'})+'\\n');process.stdout.write(b.subarray(0,11));setTimeout(()=>process.stdout.write(b.subarray(11)),10);setInterval(()=>{},1000);`;
  const transport = new JsonLineProcess(process.execPath, ["-e", code]);
  const message = await new Promise((resolve, reject) => {
    transport.once("message", resolve);
    transport.once("failure", reject);
  });
  assert.equal(message.text, "中文😀");
  const closed = new Promise((resolve) => transport.once("close", resolve));
  transport.close();
  await closed;
  assert.equal(transport.closed, true);
});

test("malformed JSON and oversized provider output fail closed", async () => {
  for (const output of ["{not json}\n", "x".repeat(2048)]) {
    const transport = new JsonLineProcess(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000)`,
      ],
      { maxLineBytes: 512 },
    );
    const closed = new Promise((resolve) => transport.once("close", resolve));
    const failure = await new Promise((resolve) =>
      transport.once("failure", resolve),
    );
    assert.ok(failure instanceof Error);
    await closed;
  }
});

test("MCP configuration is per-run; read-only rejects write permission requests locally", async () => {
  const h = harness("claude", {
    mode: "read-only",
    mcpServers: { rpo: { command: "node", args: ["bridge.mjs"] } },
    readOnlyMcpTools: ["mcp__rpo__rpo_context"],
  });
  await h.start;
  const config = JSON.parse(h.args[h.args.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers.rpo.command, "node");
  assert.ok(h.args.includes("--strict-mcp-config"));
  h.transport.emit("message", {
    type: "control_request",
    request_id: "write",
    request: { subtype: "can_use_tool", tool_name: "Write", input: {} },
  });
  assert.equal(h.transport.sent.at(-1).response.response.behavior, "deny");
  assert.equal(h.events.filter((e) => e.type === "approval").length, 0);
  h.transport.emit("message", {
    type: "control_request",
    request_id: "context",
    request: {
      subtype: "can_use_tool",
      tool_name: "mcp__rpo__rpo_context",
      input: {},
    },
  });
  assert.equal(h.events.at(-1).type, "approval");
  h.runtime.close();
});

test(
  "closing a provider terminates a real descendant process",
  { skip: process.platform === "win32" },
  async () => {
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');setInterval(()=>{},1000);`;
    const transport = new JsonLineProcess(process.execPath, ["-e", code]);
    const { pid } = await new Promise((resolve, reject) => {
      transport.once("message", resolve);
      transport.once("failure", reject);
    });
    const closed = new Promise((resolve) => transport.once("close", resolve));
    transport.close();
    await closed;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      alive,
      false,
      "spawned child must not survive lane cancellation",
    );
  },
);

test("starting assistant message is not displayed as a JSON tool event", async () => {
  const h = harness();
  await h.start;
  const n = h.events.length;
  h.transport.emit("message", {
    method: "item/started",
    params: {
      threadId: "native-thread",
      item: { id: "assistant-1", type: "agentMessage", text: "" },
    },
  });
  assert.equal(h.events.length, n);
  h.runtime.close();
});
