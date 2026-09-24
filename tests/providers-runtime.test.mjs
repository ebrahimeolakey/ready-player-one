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
            ...(this.threadConfiguration || {}),
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

test("Codex model confirmation comes from protocol response, not requested alias or turn effort", async () => {
  const h = harness("codex", { model: "requested-alias", effort: "high" });
  h.transport.threadConfiguration = { model: "resolved-model", reasoningEffort: "low" };
  await h.start;
  const event = h.events.find(e => e.type === "configuration");
  assert.equal(event.model, "resolved-model"); assert.equal(event.effort, null);
  await h.runtime.close();
  const missing = harness("codex", { model: "requested-alias" });
  await missing.start;
  assert.equal(missing.events.some(e => e.type === "configuration"), false);
  await missing.runtime.close();
});

test("Claude reports resolved parent model once and ignores subagent models and credentials", async () => {
  const h = harness("claude", { model: "alias", effort: "high" }); await h.start;
  for (let i = 0; i < 3; i++) h.transport.emit("message", { type: "system", subtype: "init", session_id: "s", model: "actual-model" });
  h.transport.emit("message", { type: "assistant", parent_tool_use_id: "child", message: { model: "child-model", content: [] } });
  h.transport.emit("message", { type: "system", subtype: "init", model: "sk-secret-model-key" });
  const events = h.events.filter(e => e.type === "configuration");
  assert.equal(events.length, 1); assert.equal(events[0].model, "actual-model"); assert.equal(events[0].effort, null);
  h.transport.emit("message", { type: "stream_event", event: { type: "message_start", message: { id: "response", model: "fallback-model" } } });
  assert.equal(h.events.filter(e => e.type === "configuration").at(-1).model, "fallback-model");
  await h.runtime.close();
});

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

test("Codex reasoning summary/text deltas and final parts use distinct stable reasoning IDs, never tool rows", async () => {
  const h = harness("codex");
  await h.start;
  h.transport.emit("message", {
    method: "item/started",
    params: {
      threadId: "native-thread",
      item: { id: "reason", type: "reasoning" },
    },
  });
  h.transport.emit("message", {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "native-thread",
      itemId: "reason",
      summaryIndex: 0,
      delta: "Summary",
    },
  });
  h.transport.emit("message", {
    method: "item/reasoning/textDelta",
    params: {
      threadId: "native-thread",
      itemId: "reason",
      contentIndex: 0,
      delta: "Visible reasoning",
    },
  });
  h.transport.emit("message", {
    method: "item/completed",
    params: {
      threadId: "native-thread",
      item: {
        id: "reason",
        type: "reasoning",
        summary: ["Summary"],
        content: ["Visible reasoning"],
      },
    },
  });
  assert.equal(h.events.filter((e) => e.type === "tool").length, 0);
  const finals = h.events.filter((e) => e.type === "message");
  assert.equal(finals.length, 2);
  for (const final of finals) {
    assert.equal(final.role, "reasoning");
    assert.equal(final.streamed, true);
    assert.ok(
      h.events.some(
        (e) =>
          e.type === "delta" &&
          e.itemId === final.itemId &&
          e.text === final.text,
      ),
    );
  }
  await h.runtime.close();
});
test("Claude thinking deltas match final thinking blocks and omit signature/redacted data", async () => {
  const h = harness("claude");
  await h.start;
  const stream = (event) =>
    h.transport.emit("message", { type: "stream_event", event });
  stream({ type: "message_start", message: { id: "answer-1" } });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Visible thought" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "PRIVATE_SIGNATURE" },
  });
  stream({
    type: "content_block_delta",
    index: 2,
    delta: { type: "text_delta", text: "Answer" },
  });
  h.transport.emit("message", {
    type: "assistant",
    message: {
      id: "answer-1",
      content: [
        {
          type: "thinking",
          thinking: "Visible thought",
          signature: "PRIVATE_SIGNATURE",
        },
        { type: "redacted_thinking", data: "PRIVATE_REDACTED" },
        { type: "text", text: "Answer" },
      ],
    },
  });
  const final = h.events.find(
    (e) => e.type === "message" && e.role === "reasoning",
  );
  assert.equal(final.itemId, "answer-1:thinking:0");
  assert.equal(final.streamed, true);
  assert.ok(
    h.events.some((e) => e.type === "delta" && e.itemId === final.itemId),
  );
  assert.ok(!JSON.stringify(h.events).includes("PRIVATE_"));
  assert.equal(
    h.events.find((e) => e.type === "message" && e.role === "assistant").text,
    "Answer",
  );
  await h.runtime.close();
});

test("Codex reasoning summary/content streams reconcile by part and never render as tools", async () => {
  const h = harness();
  await h.start;
  const notify = (method, params) =>
    h.transport.emit("message", {
      method,
      params: { threadId: "native-thread", ...params },
    });
  notify("item/started", { item: { id: "r", type: "reasoning" } });
  notify("item/reasoning/summaryTextDelta", {
    itemId: "r",
    summaryIndex: 0,
    delta: "Checking",
  });
  notify("item/reasoning/textDelta", {
    itemId: "r",
    contentIndex: 0,
    delta: "Visible thought",
  });
  notify("item/completed", {
    item: {
      id: "r",
      type: "reasoning",
      summary: ["Checking files", "Next step"],
      content: ["Visible thought"],
    },
  });
  const final = h.events.filter((e) => e.type === "message");
  assert.deepEqual(
    final.map((e) => [e.itemId, e.role, e.streamed]),
    [
      ["r:summary:0", "reasoning", true],
      ["r:summary:1", "reasoning", false],
      ["r:content:0", "reasoning", true],
    ],
  );
  assert.equal(
    h.events.some((e) => e.type === "tool"),
    false,
  );
  assert.equal(final[0].text, "Checking files");
  const before = h.events.length;
  h.transport.emit("message", {
    method: "item/reasoning/textDelta",
    params: { threadId: "other-thread", itemId: "r", delta: "wrong" },
  });
  assert.equal(h.events.length, before);
  await h.runtime.close();
});

test("Claude thinking blocks reconcile separately from answer; signature/redacted blocks stay private", async () => {
  const h = harness("claude");
  await h.start;
  const stream = (event) =>
    h.transport.emit("message", { type: "stream_event", event });
  stream({ type: "message_start", message: { id: "msg" } });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Checking" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "SECRET_SIGNATURE" },
  });
  stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Answer" },
  });
  h.transport.emit("message", {
    type: "assistant",
    message: {
      id: "msg",
      content: [
        {
          type: "thinking",
          thinking: "Checking files",
          signature: "SECRET_SIGNATURE",
        },
        { type: "text", text: "Answer" },
        { type: "redacted_thinking", data: "SECRET_REDACTED" },
        { type: "thinking", thinking: "Another visible block" },
      ],
    },
  });
  const final = h.events.filter((e) => e.type === "message");
  assert.deepEqual(
    final.map((e) => [e.itemId, e.role, e.streamed]),
    [
      ["msg", "assistant", true],
      ["msg:thinking:0", "reasoning", true],
      ["msg:thinking:3", "reasoning", false],
    ],
  );
  assert.equal(JSON.stringify(h.events).includes("SECRET_"), false);
  await h.runtime.close();
});

test('native usage frames are normalized and unrelated thread/subagent frames cannot replace context',async()=>{
 const codex=harness('codex');await codex.start;
 const frame={method:'thread/tokenUsage/updated',params:{threadId:'native-thread',tokenUsage:{last:{totalTokens:100},total:{totalTokens:900},modelContextWindow:1000}}};
 codex.transport.emit('message',frame);
 assert.equal(codex.events.at(-1).usageSnapshot.context.usedTokens,100);
 codex.transport.emit('message',{...frame,params:{...frame.params,threadId:'other'}});
 assert.equal(codex.events.filter(e=>e.type==='usage').length,1);await codex.runtime.close();
 const claude=harness('claude');await claude.start;
 claude.transport.emit('message',{type:'stream_event',event:{type:'message_start',message:{id:'m',model:'exact',usage:{input_tokens:5,cache_read_input_tokens:10,cache_creation_input_tokens:20}}}});
 assert.equal(claude.events.at(-1).usageSnapshot.context.usedTokens,35);
 claude.transport.emit('message',{type:'assistant',parent_tool_use_id:'sub',message:{id:'sub',usage:{input_tokens:900}}});
 assert.equal(claude.events.filter(e=>e.type==='usage').length,1);
 claude.transport.emit('message',{type:'result',modelUsage:{exact:{inputTokens:5,cacheReadInputTokens:10,cacheCreationInputTokens:20,outputTokens:2,contextWindow:200000}},total_cost_usd:0.1});
 assert.equal(claude.events.at(-1).usageSnapshot.context.limitTokens,200000);
 await claude.runtime.close();
});
