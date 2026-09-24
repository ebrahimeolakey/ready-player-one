import { codexFailure, claudeFailure, acpFailure, validateFailure } from "./failure.mjs";
import { randomUUID } from "node:crypto";
import { JsonLineProcess, Requests } from "./transport.mjs";
import { codexInput, claudeInput } from "./input.mjs";

import { codexUsage, ClaudeUsage } from "./usage.mjs";
import { emitReportedConfiguration } from "./configuration.mjs";

const noOp = () => {};

class BaseRun {
  constructor(options, transport) {
    this.options = options;
    this.transport = transport;
    this.approvals = new Map();
    this.ended = false;
    this.sessionId = options.sessionId || null;
    this.turnId = null;
    transport.on("message", (message) => this.receive(message));
    transport.on("failure", (error) => this.finish("error", error.message));
    transport.on("close", ({ code, stderr }) => {
      if (!this.ended)
        this.finish(
          this.interrupted ? "interrupted" : "error",
          stderr || `Provider exited (${code})`,
        );
    });
  }
  emit(event) {
    (this.options.onEvent || noOp)({
      runId: this.options.runId,
      provider: this.options.provider,
      ...event,
    });
  }
  rememberSession(id) {
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit({ type: "session", sessionId: id });
    }
  }
  approval(id, request, answer) {
    const approvalId = String(id);
    this.approvals.set(approvalId, { answer, request });
    this.emit({ type: "approval", approvalId, request });
    if (this.options.onApproval) {
      Promise.resolve()
        .then(() =>
          this.options.onApproval({
            runId: this.options.runId,
            approvalId,
            ...request,
          }),
        )
        .then((decision) => {
          if (decision !== undefined && this.approvals.has(approvalId))
            this.respondApproval(approvalId, decision);
        })
        .catch(() => {
          if (this.approvals.has(approvalId))
            this.respondApproval(approvalId, { allow: false });
        });
    }
  }
  respondApproval(approvalId, decision) {
    if (this.ended) throw new Error("Run has ended");
    const entry = this.approvals.get(String(approvalId));
    if (!entry) throw new Error("Approval is no longer pending");
    this.approvals.delete(String(approvalId));
    entry.answer(
      decision === true ? { allow: true } : decision || { allow: false },
    );
    this.emit({ type: "approvalResolved", approvalId: String(approvalId) });
  }
  finish(status, message = "", failure = null) {
    if (this.ended) return this.completion;
    this.ended = true;
    this.approvals.clear();
    this.requests?.close();
    const finished = () =>
      (this.options.onEnd || noOp)({
        runId: this.options.runId,
        status,
        message,
        sessionId: this.sessionId,
        ...(status === "error" && failure ? { failure: validateFailure(failure, this.options.provider) } : {}),
      });
    const closing = this.transport.close();
    if (closing?.then) this.completion = closing.then(finished);
    else {
      finished();
      this.completion = Promise.resolve();
    }
    return this.completion;
  }
  close() {
    this.interrupted = true;
    return this.finish("interrupted", "执行已停止");
  }
}

export class CodexRun extends BaseRun {
  constructor(options, transport) {
    super(options, transport);
    this.requests = new Requests(
      (message) => transport.write(message),
      options.requestTimeoutMs,
    );
    this.streamedItems = new Set();
  }
  rpc(method, params) {
    return this.requests.request((id) => ({ id, method, params }));
  }
  async initialize() {
    await this.rpc("initialize", {
      clientInfo: {
        name: "ready_player_one",
        version: "0.4.0",
        title: "头号玩家",
      },
    });
    this.transport.write({ method: "initialized" });
    const params = {
      cwd: this.options.cwd,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox:
        this.options.mode === "read-only" ? "read-only" : "workspace-write",
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.codexConfig ? { config: this.options.codexConfig } : {}),
    };
    const result = this.sessionId
      ? await this.rpc("thread/resume", { ...params, threadId: this.sessionId })
      : await this.rpc("thread/start", params);
    this.rememberSession(result.thread.id);
    const turn = await this.rpc("turn/start", {
      threadId: this.sessionId,
      input: codexInput(this.options.prompt, this.options.images),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
    });
    this.turnId = turn.turn.id;
    // thread response confirms the model; an explicit turn effort is not echoed by turn/start.
    emitReportedConfiguration(this, result.model, this.options.effort ? null : result.reasoningEffort);
    this.emit({
      type: "started",
      sessionId: this.sessionId,
      turnId: this.turnId,
    });
    return this;
  }
  receive(message) {
    if (this.ended) return;
    if (message.id !== undefined && !message.method)
      return this.requests.resolve(message.id, message.result, message.error);
    const p = message.params || {};
    if (message.id !== undefined) {
      const reply = (result) =>
        this.transport.write({ id: message.id, result });
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(message.method)
      ) {
        return this.approval(
          message.id,
          {
            kind: message.method.includes("commandExecution")
              ? "command"
              : "file",
            ...p,
          },
          (decision) =>
            reply({ decision: decision.allow ? "accept" : "decline" }),
        );
      }
      if (message.method === "item/permissions/requestApproval") {
        return this.approval(
          message.id,
          { kind: "permissions", ...p },
          (decision) =>
            reply({
              permissions: decision.allow ? p.permissions : {},
              scope: "turn",
            }),
        );
      }
      if (message.method === "item/tool/requestUserInput") {
        return this.approval(
          message.id,
          { kind: "question", ...p },
          (decision) => reply({ answers: decision.answers || {} }),
        );
      }
      if (message.method === "mcpServer/elicitation/request") {
        return this.approval(
          message.id,
          { kind: "elicitation", ...p },
          (decision) =>
            reply({
              action: decision.allow ? "accept" : "decline",
              content: decision.content || null,
            }),
        );
      }
      // Unknown server capabilities must fail explicitly, never auto-approve.
      this.transport.write({
        id: message.id,
        error: { code: -32601, message: "Unsupported host request" },
      });
      return;
    }
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) return;
    if (message.method === "turn/started") this.turnId = p.turn.id;
    if (message.method === "item/agentMessage/delta") {
      this.streamedItems.add(p.itemId);
      this.emit({
        type: "delta",
        role: "assistant",
        itemId: p.itemId,
        text: p.delta,
      });
    }
    if (
      ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"].includes(
        message.method,
      )
    ) {
      const part = message.method.includes("summary") ? "summary" : "content";
      const index = part === "summary" ? p.summaryIndex : p.contentIndex;
      const itemId = `${p.itemId}:${part}:${index ?? 0}`;
      this.streamedItems.add(itemId);
      this.emit({ type: "delta", role: "reasoning", itemId, text: p.delta });
    }
    if (message.method === "item/commandExecution/outputDelta")
      this.emit({
        type: "delta",
        role: "tool",
        itemId: p.itemId,
        text: p.delta,
      });
    if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = p.item;
      if (item?.type === "agentMessage" && message.method === "item/completed")
        this.emit({
          type: "message",
          role: "assistant",
          itemId: item.id,
          text: item.text,
          streamed: this.streamedItems.has(item.id),
        });
      else if (item?.type === "reasoning") {
        if (message.method === "item/completed")
          for (const part of ["summary", "content"])
            for (const [index, text] of (item[part] || []).entries()) {
              const itemId = `${item.id}:${part}:${index}`;
              if (typeof text === "string" && text)
                this.emit({
                  type: "message",
                  role: "reasoning",
                  itemId,
                  text,
                  streamed: this.streamedItems.has(itemId),
                });
            }
      } else if (item && !["userMessage", "agentMessage"].includes(item.type))
        this.emit({
          type: "tool",
          phase: message.method.endsWith("started") ? "started" : "completed",
          itemId: item.id,
          item,
        });
    }
    if (message.method === "thread/tokenUsage/updated")
      this.emit({ type: "usage", usage: p.tokenUsage, usageSnapshot: codexUsage(p.tokenUsage) });
    if (message.method === "serverRequest/resolved") {
      this.approvals.delete(String(p.requestId));
      this.emit({ type: "approvalResolved", approvalId: String(p.requestId) });
    }
    if (message.method === "error")
      this.emit({
        type: "error",
        text: p.error?.message || "Codex 执行错误",
        retrying: Boolean(p.willRetry),
      });
    if (message.method === "turn/completed")
      this.finish(
        p.turn.status === "completed"
          ? "done"
          : p.turn.status === "interrupted"
            ? "interrupted"
            : "error",
        p.turn.error?.message || "",
        codexFailure(p.turn.error),
      );
  }
  async steer(text, images = []) {
    if (this.ended || !this.turnId) throw new Error("No active turn to steer");
    return this.rpc("turn/steer", {
      threadId: this.sessionId,
      expectedTurnId: this.turnId,
      input: codexInput(text, images),
    });
  }
  async interrupt() {
    if (this.ended) return this.completion;
    this.interrupted = true;
    if (this.turnId) {
      try {
        await this.rpc("turn/interrupt", {
          threadId: this.sessionId,
          turnId: this.turnId,
        });
      } finally {
        await this.close();
      }
    } else await this.close();
  }
}

export function claudeArgs(options) {
  return [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "manual",
    "--permission-prompts",
    "host",
    "--permission-prompt-tool",
    "stdio",
    ...(options.sessionId ? ["--resume", options.sessionId] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
    ...(options.mode === "read-only"
      ? ["--tools", "Read,Glob,Grep", "--strict-mcp-config"]
      : []),
    ...(options.disallowedTools?.length
      ? ["--disallowedTools", ...options.disallowedTools]
      : []),
    ...(options.mcpServers || options.mode === "read-only"
      ? [
          "--mcp-config",
          JSON.stringify({ mcpServers: options.mcpServers || {} }),
        ]
      : []),
  ];
}

export class ClaudeRun extends BaseRun {
  constructor(options, transport) {
    super(options, transport);
    this.requests = new Requests(
      (message) => transport.write(message),
      options.requestTimeoutMs,
    );
    this.streamedMessages = new Set();
    this.messageId = null;
    this.inflightMessages = 0;
  }
  control(request) {
    return this.requests.request((request_id) => ({
      type: "control_request",
      request_id,
      request,
    }));
  }
  async initialize() {
    await this.control({ subtype: "initialize", hooks: null });
    this.sendUser(this.options.prompt, this.options.images);
    this.emit({ type: "started", sessionId: this.sessionId });
    return this;
  }
  sendUser(text, images = []) {
    this.inflightMessages++;
    this.transport.write({
      type: "user",
      message: { role: "user", content: claudeInput(text, images) },
      uuid: randomUUID(),
      parent_tool_use_id: null,
      session_id: this.sessionId || "",
    });
  }
  receive(message) {
    if (this.ended) return;
    if (message.type === "control_response") {
      const r = message.response || {};
      return this.requests.resolve(
        r.request_id,
        r.response,
        r.subtype === "error" ? new Error(r.error) : null,
      );
    }
    if (message.type === "control_cancel_request") {
      this.approvals.delete(message.request_id);
      this.emit({ type: "approvalResolved", approvalId: message.request_id });
      return;
    }
    if (message.type === "control_request") {
      const request = message.request || {};
      if (request.subtype === "can_use_tool") {
        if (
          this.options.mode === "read-only" &&
          ![
            "Read",
            "Glob",
            "Grep",
            ...(this.options.readOnlyMcpTools || []),
          ].includes(request.tool_name)
        ) {
          this.transport.write({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: { behavior: "deny", message: "当前为只读模式" },
            },
          });
          return;
        }
        return this.approval(
          message.request_id,
          {
            kind: "tool",
            tool: request.tool_name,
            input: request.input,
            toolUseId: request.tool_use_id,
            description: request.description,
            reason: request.decision_reason,
          },
          (decision) => {
            this.transport.write({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: decision.allow
                  ? {
                      behavior: "allow",
                      updatedInput: request.input,
                      toolUseID: request.tool_use_id,
                    }
                  : {
                      behavior: "deny",
                      message: decision.message || "用户拒绝执行此工具",
                      toolUseID: request.tool_use_id,
                    },
              },
            });
          },
        );
      }
      this.transport.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: message.request_id,
          error: "Unsupported host request",
        },
      });
      return;
    }
    this.rememberSession(message.session_id);
    if (!message.parent_tool_use_id) {
      const model = message.type === "system" && message.subtype === "init" ? message.model
        : message.type === "assistant" ? message.message?.model
        : message.type === "stream_event" && message.event?.type === "message_start" ? message.event.message?.model : undefined;
      if (model) emitReportedConfiguration(this, model);
    }
    this.usageTracker ??= new ClaudeUsage();
    const usageSnapshot = this.usageTracker.receive(message);
    if (usageSnapshot) this.emit({ type: "usage", usageSnapshot });
    if (message.type === "stream_event") {
      const event = message.event || {};
      if (event.type === "message_start") this.messageId = event.message?.id;
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        this.streamedMessages.add(this.messageId);
        this.emit({
          type: "delta",
          role: "assistant",
          itemId: this.messageId,
          text: event.delta.text,
        });
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "thinking_delta"
      ) {
        const itemId = `${this.messageId}:thinking:${event.index ?? 0}`;
        this.streamedMessages.add(itemId);
        this.emit({
          type: "delta",
          role: "reasoning",
          itemId,
          text: event.delta.thinking,
        });
      }
    }
    if (message.type === "assistant") {
      if (!message.parent_tool_use_id) this.assistantError = message.error;
      const itemId = message.message?.id;
      const blocks = message.message?.content || [];
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text)
        this.emit({
          type: "message",
          role: "assistant",
          itemId,
          text,
          streamed: this.streamedMessages.has(itemId),
        });
      for (const [index, block] of blocks.entries()) {
        if (block.type === "thinking" && block.thinking) {
          const reasoningId = `${itemId}:thinking:${index}`;
          this.emit({
            type: "message",
            role: "reasoning",
            itemId: reasoningId,
            text: block.thinking,
            streamed: this.streamedMessages.has(reasoningId),
          });
        }
        if (block.type === "tool_use")
          this.emit({
            type: "tool",
            phase: "started",
            itemId: block.id,
            item: block,
          });
      }
    }
    if (message.type === "user") {
      for (const block of Array.isArray(message.message?.content)
        ? message.message.content
        : []) {
        if (block.type === "tool_result")
          this.emit({
            type: "tool",
            phase: "completed",
            itemId: block.tool_use_id,
            item: block,
          });
      }
    }
    if (message.type === "result") {
      this.inflightMessages--;
      if (message.is_error || this.inflightMessages <= 0)
        this.finish(
          message.is_error
            ? "error"
            : this.interrupted
              ? "interrupted"
              : "done",
          message.is_error
            ? (message.errors || []).join("\n") ||
                message.result ||
                "Claude 执行失败"
            : "",
          claudeFailure(message, this.assistantError),
        );
    }
  }
  async steer(text, images = []) {
    if (this.ended) throw new Error("Run has ended");
    // Claude queues stream-json input at its own safe execution boundary.
    this.sendUser(text, images);
    return { queued: true };
  }
  async interrupt() {
    if (this.ended) return this.completion;
    this.interrupted = true;
    try {
      await this.control({ subtype: "interrupt" });
    } finally {
      await this.close();
    }
  }
}

/** One native CLI process per active lane; session IDs persist across runs. */
export class ProviderRuntime {
  constructor({
    transportFactory = (command, args, options) =>
      new JsonLineProcess(command, args, options),
    env = process.env,
  } = {}) {
    this.transportFactory = transportFactory;
    this.env = env;
    this.runs = new Map();
    this.adapters = new Map();
  }
  register(provider, factory) {
    if (["codex", "claude"].includes(provider))
      throw new Error("Built-in providers cannot be overridden");
    this.adapters.set(provider, factory);
  }
  async start(options) {
    if (!options.runId || !options.cwd || typeof options.prompt !== "string")
      throw new Error("runId, cwd and prompt are required");
    if (this.runs.has(options.runId)) throw new Error("通道已经运行");
    if (
      !["codex", "claude"].includes(options.provider) &&
      !this.adapters.has(options.provider)
    )
      throw new Error("未知 Provider");
    let run;
    const onEnd = (result) => {
      if (this.runs.get(options.runId) === run) this.runs.delete(options.runId);
      options.onEnd?.(result);
    };
    const bound = { ...options, onEnd };
    if (this.adapters.has(options.provider))
      run = this.adapters.get(options.provider)(bound);
    else {
      const args =
        options.provider === "codex"
          ? ["app-server", "--listen", "stdio://"]
          : claudeArgs(options);
      const transport = this.transportFactory(
        options.command || options.provider,
        args,
        { cwd: options.cwd, env: { ...this.env, ...options.env } },
      );
      run =
        options.provider === "codex"
          ? new CodexRun(bound, transport)
          : new ClaudeRun(bound, transport);
    }
    this.runs.set(options.runId, run);
    try {
      await run.initialize();
    } catch (error) {
      await run.finish("error", error.message, options.provider === "codex" ? codexFailure(error) : options.provider?.startsWith("acp-") ? acpFailure(error) : error.failure);
      throw error;
    }
    return run;
  }
  steer(runId, text, images = []) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("执行已结束");
    return run.steer(text, images);
  }
  respondApproval(runId, approvalId, decision) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("执行已结束");
    return run.respondApproval(approvalId, decision);
  }
  interrupt(runId) {
    return this.runs.get(runId)?.interrupt();
  }
  close() {
    return Promise.all([...this.runs.values()].map((run) => run.close()));
  }
}
