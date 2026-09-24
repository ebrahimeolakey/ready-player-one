// Synthetic ACP protocol peer. It is NOT OpenCode/Hermes and never calls a model.
import { createInterface } from "node:readline";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const mode = process.env.ACP_FIXTURE_CASE || "stable",
  sessionId = "fixture-session";
const journal = join(process.cwd(), "wire.jsonl");
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, value) => send({ id, result: value });
const error = (id, code, message) => send({ id, error: { code, message } });
const update = (value) =>
  send({ method: "session/update", params: { sessionId, update: value } });
let configOptions = [
  {
    id: "model-choice",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture-model",
    options: [
      {
        group: "local",
        name: "Local",
        options: [
          { value: "fixture-model", name: "Fixture model" },
          { value: "other-model", name: "Other model" },
        ],
      },
    ],
  },
  {
    id: "thinking",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "access",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "read", name: "Read only" },
    ],
  },
];
const legacy = {
  models: {
    currentModelId: "legacy-model",
    availableModels: [
      { modelId: "legacy-model", name: "Hermes-style model" },
      { modelId: "legacy-other", name: "Alternative" },
    ],
  },
  modes: {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "read", name: "Read" },
    ],
  },
};
let promptId, permissionId;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(journal, JSON.stringify(message) + "\n");
  assert.equal(message.jsonrpc, "2.0");
  const p = message.params || {};
  if (!message.method) {
    if (message.id === permissionId) {
      if (mode === "wait-cancel") continue;
      assert.ok(
        ["selected", "cancelled"].includes(message.result.outcome.outcome),
      );
      if (message.result.outcome.optionId === "once")
        writeFileSync(
          join(process.cwd(), "approved.txt"),
          "only after allow_once",
        );
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { allowed: message.result.outcome.optionId === "once" },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "answer",
        content: { type: "text", text: "ACP " },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "answer",
        content: { type: "text", text: "complete" },
      });
      update({
        sessionUpdate: "usage_update",
        used: 10,
        size: 1000,
        cost: { amount: 0, currency: "USD" },
      });
      result(promptId, { stopReason: "end_turn" });
    }
    continue;
  }
  if (message.method === "initialize") {
    assert.equal(p.protocolVersion, 1);
    assert.equal(p.clientCapabilities.fs.writeTextFile, false);
    assert.equal(p.clientCapabilities.terminal, false);
    result(message.id, {
      protocolVersion: mode === "version" ? 99 : 1,
      agentInfo: { name: "synthetic-acp-peer", version: "1" },
      agentCapabilities: {
        loadSession: mode !== "no-load",
        promptCapabilities: { image: mode !== "no-image" },
      },
      authMethods: [{ id: "manual", name: "Manual CLI sign-in" }],
    });
  } else if (["session/new", "session/load"].includes(message.method)) {
    assert.equal(realpathSync(p.cwd), realpathSync(process.cwd()));
    assert.ok(Array.isArray(p.mcpServers));
    if (mode === "auth") {
      error(message.id, -32000, "sign in required");
      continue;
    }
    if (message.method === "session/load") {
      assert.equal(p.sessionId, sessionId);
      assert.ok(existsSync(join(process.cwd(), "saved-session")));
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OLD_HISTORY_MUST_NOT_REPLAY" },
      });
    } else writeFileSync(join(process.cwd(), "saved-session"), sessionId);
    result(message.id, {
      sessionId,
      ...(mode === "legacy" ? legacy : { configOptions }),
    });
  } else if (message.method === "session/set_config_option") {
    assert.equal(p.sessionId, sessionId);
    const option = configOptions.find((option) => option.id === p.configId);
    assert.ok(option);
    option.currentValue = p.value;
    result(message.id, { configOptions });
  } else if (message.method === "session/set_model") {
    assert.equal(mode, "legacy");
    assert.ok(
      legacy.models.availableModels.some(
        (value) => value.modelId === p.modelId,
      ),
    );
    result(message.id, {});
  } else if (message.method === "session/set_mode") {
    assert.equal(mode, "legacy");
    result(message.id, {});
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    assert.equal(p.sessionId, sessionId);
    assert.equal(p.prompt[0].type, "text");
    if (mode === "token-limit") { result(promptId, { stopReason: "max_tokens" }); continue; }
    if (mode === "quota-text") { error(promptId, -32603, "quota exhausted 429"); continue; }
    if (mode === "hang") {
      const child = spawn(
        process.execPath,
        ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        { stdio: "ignore" },
      );
      writeFileSync(join(process.cwd(), "descendant.pid"), String(child.pid));
      continue;
    }
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Checking protocol" },
    });
    // Unadvertised filesystem request must be rejected; the client must not create this file.
    send({
      id: "denied-fs",
      method: "fs/write_text_file",
      params: {
        sessionId,
        path: join(process.cwd(), "bypass.txt"),
        content: "must not write",
      },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      name: "edit_file",
      title: "Synthetic edit",
      kind: "edit",
      status: "pending",
      rawInput: { path: "approved.txt" },
    });
    permissionId = "permission-1";
    send({
      id: permissionId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "tool-1" },
        options:
          mode === "always-only"
            ? [{ optionId: "always", name: "Always", kind: "allow_always" }]
            : [
                { optionId: "once", name: "Once", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
      },
    });
  } else if (message.method === "session/cancel") {
    if (mode !== "hang") result(promptId, { stopReason: "cancelled" });
  } else error(message.id, -32601, "unsupported fixture method");
}
