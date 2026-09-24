import { acpUsage } from "./usage.mjs";
import { emitReportedConfiguration } from "./configuration.mjs";
import { randomUUID } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { JsonLineProcess } from "./transport.mjs";
import { normalizeImages } from "./input.mjs";
import { validateACPConfig } from "../acp-config.mjs";
import { redactText } from "../secure-store.mjs";

const choices = (option) =>
  (option?.options || [])
    .flatMap((value) =>
      Array.isArray(value.options) ? value.options : [value],
    )
    .filter((value) => typeof value.value === "string");
const category = (session, name) =>
  (session.configOptions || []).find(
    (option) => option.type === "select" && option.category === name,
  );
/** Preferred stable configOptions plus an explicitly gated Hermes legacy model catalog. */
export function acpCatalog(session = {}, { legacyModelApi = false } = {}) {
  const model = category(session, "model"),
    effort = category(session, "thought_level"),
    mode = category(session, "mode");
  const efforts = choices(effort).map((value) => value.value);
  const currentModelId =
    model?.currentValue ||
    (legacyModelApi ? session.models?.currentModelId : "") ||
    "";
  const rawModels = model
    ? choices(model).map((value) => ({
        id: value.value,
        label: value.name || value.value,
        description: value.description || "",
      }))
    : legacyModelApi
      ? (session.models?.availableModels || [])
          .filter((value) => typeof value.modelId === "string")
          .map((value) => ({
            id: value.modelId,
            label: value.name || value.modelId,
            description: value.description || "",
          }))
      : [];
  const rawModes = mode
    ? choices(mode).map((value) => ({
        id: value.value,
        label: value.name || value.value,
        description: value.description || "",
      }))
    : (session.modes?.availableModes || []).map((value) => ({
        id: value.id,
        label: value.name || value.id,
        description: value.description || "",
      }));
  return {
    models: rawModels.slice(0, 2000).map((value) => ({
      ...value,
      default: value.id === currentModelId,
      efforts,
      defaultEffort: effort?.currentValue,
    })),
    currentModelId,
    modes: rawModes,
    currentModeId: mode?.currentValue || session.modes?.currentModeId || "",
    efforts,
  };
}
function mcpServers(value) {
  if (value === undefined) return [];
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value).map(([name, server]) => ({ name, ...server }));
  if (entries.length > 30) throw new Error("ACP MCP 配置过多");
  return entries.map((server) => {
    if (server.type && server.type !== "stdio")
      throw new Error("本轮 ACP 仅支持 stdio MCP");
    if (
      typeof server.name !== "string" ||
      !server.name ||
      server.name.length > 200
    )
      throw new Error("ACP MCP 名称无效");
    const env = Array.isArray(server.env)
      ? Object.fromEntries(server.env.map((value) => [value.name, value.value]))
      : server.env;
    const config = validateACPConfig({
      command: server.command,
      args: server.args,
      env,
    });
    return {
      name: server.name,
      command: config.command,
      args: config.args,
      env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
    };
  });
}

export function registerACP(runtime, name, config) {
  const checked = validateACPConfig(config);
  runtime.register(
    name,
    (options) =>
      new ACPRun(options, checked, {
        env: runtime.env,
        transportFactory: runtime.transportFactory,
      }),
  );
}

/** ACP v1 stdio adapter. Agent-owned native tools are not a host sandbox. */
export class ACPRun {
  constructor(
    options,
    config,
    {
      env = process.env,
      transportFactory = (command, args, settings) =>
        new JsonLineProcess(command, args, settings),
    } = {},
  ) {
    this.options = options;
    this.config = validateACPConfig(config);
    this.env = env;
    this.transportFactory = transportFactory;
    this.sessionId = options.sessionId || null;
    this.session = {};
    this.pending = new Map();
    this.approvals = new Map();
    this.messages = new Map();
    this.tools = new Map();
    this.nextId = 0;
    this.ended = false;
    this.activePrompt = false;
  }
  safe(value) {
    let text = redactText(String(value || ""));
    for (const secret of Object.values(this.config.env))
      if (secret.length >= 8) text = text.split(secret).join("[凭据已隐藏]");
    return text;
  }
  emit(event) {
    this.options.onEvent?.({
      runId: this.options.runId,
      provider: this.options.provider,
      ...event,
    });
  }
  write(message) {
    this.transport.write({ jsonrpc: "2.0", ...message });
  }
  rpc(method, params, timeout = this.options.requestTimeoutMs || 30000) {
    const id = `acp-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ACP 请求超时"));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  reply(id, result) {
    this.write({ id, result });
  }
  async connect() {
    if (!isAbsolute(this.options.cwd) && !win32.isAbsolute(this.options.cwd))
      throw new Error("ACP 工作目录必须是绝对路径");
    this.transport = this.transportFactory(
      this.config.command,
      this.config.args,
      {
        cwd: this.options.cwd,
        env: { ...this.env, ...this.config.env, ...this.options.env },
      },
    );
    this.transport.on("message", (message) => {
      try {
        this.receive(message);
      } catch (error) {
        void this.finish("error", this.safe(error.message));
      }
    });
    this.transport.on(
      "failure",
      (error) => void this.finish("error", this.safe(error.message)),
    );
    this.transport.on("close", ({ code, stderr }) => {
      if (!this.ended)
        void this.finish(
          this.interrupted ? "interrupted" : "error",
          this.safe(stderr || `ACP exited (${code})`),
        );
    });
    const initialized = await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      },
      clientInfo: {
        name: "ready-player-one",
        version: "0.4.0",
        title: "头号玩家",
      },
    });
    if (initialized.protocolVersion !== 1)
      throw new Error(`不支持 ACP 协议版本 ${initialized.protocolVersion}`);
    this.capabilities = initialized.agentCapabilities || {};
    this.agentInfo = {
      name: initialized.agentInfo?.name || "ACP",
      version: initialized.agentInfo?.version || "",
    };
    this.authMethods = (initialized.authMethods || []).map((method) => ({
      id: method.id,
      name: method.name,
      description: method.description,
      type: method.type,
    }));
    if (this.sessionId && !this.capabilities.loadSession)
      throw new Error("此 ACP Agent 不支持恢复会话，请新建通道");
    this.loading = Boolean(this.sessionId);
    const result = await this.rpc(
      this.sessionId ? "session/load" : "session/new",
      {
        cwd: this.options.cwd,
        mcpServers: mcpServers(this.options.mcpServers),
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    );
    this.loading = false;
    if (!this.sessionId) this.sessionId = result.sessionId;
    if (typeof this.sessionId !== "string" || !this.sessionId)
      throw new Error("ACP 未返回有效会话 ID");
    this.session = { ...this.session, ...result };
    return this;
  }
  async setCategory(name, value) {
    const option = category(this.session, name);
    if (option) {
      if (!choices(option).some((choice) => choice.value === value))
        throw new Error(`ACP 不支持所选 ${name}：${value}`);
      const result = await this.rpc("session/set_config_option", {
        sessionId: this.sessionId,
        configId: option.id,
        value,
      });
      if (!Array.isArray(result.configOptions))
        throw new Error("ACP 未返回完整配置状态");
      this.session.configOptions = result.configOptions;
      const changed = (result.configOptions || []).find(
        (entry) => entry.id === option.id,
      );
      if (changed?.currentValue !== value)
        throw new Error(`ACP 未确认所选 ${name}`);
      return;
    }
    if (
      name === "model" &&
      this.config.legacyModelApi &&
      this.session.models?.availableModels?.some(
        (model) => model.modelId === value,
      )
    ) {
      await this.rpc("session/set_model", {
        sessionId: this.sessionId,
        modelId: value,
      });
      this.session.models.currentModelId = value;
      return;
    }
    if (
      name === "mode" &&
      !this.session.configOptions?.length &&
      this.session.modes?.availableModes?.some((mode) => mode.id === value)
    ) {
      await this.rpc("session/set_mode", {
        sessionId: this.sessionId,
        modeId: value,
      });
      this.session.modes.currentModeId = value;
      return;
    }
    throw new Error(`此 ACP Agent 未提供可配置的 ${name}`);
  }
  async initialize() {
    if (!["read-only", "workspace-write"].includes(this.options.mode))
      throw new Error("请选择有效 ACP 权限模式");
    const modeId =
      this.options.mode === "read-only"
        ? this.config.readOnlyModeId
        : this.config.modeId;
    if (this.options.mode === "read-only" && !modeId)
      throw new Error("ACP 无通用只读沙箱；此 Provider 未配置已确认的只读模式");
    await this.connect();
    const model = this.options.model || this.config.model;
    if (model) await this.setCategory("model", model);
    if (this.options.effort)
      await this.setCategory("thought_level", this.options.effort);
    if (modeId) await this.setCategory("mode", modeId);
    const images = normalizeImages(this.options.images);
    if (images.length && !this.capabilities.promptCapabilities?.image)
      throw new Error("此 ACP Agent 未声明图片输入支持");
    this.emit({ type: "session", sessionId: this.sessionId });
    this.emit({ type: "catalog", ...acpCatalog(this.session, this.config) });
    emitReportedConfiguration(this, acpCatalog(this.session, this.config).currentModelId, category(this.session, "thought_level")?.currentValue);
    this.emit({ type: "started", sessionId: this.sessionId });
    this.activePrompt = true;
    this.promptPromise = this.rpc(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [
          { type: "text", text: this.options.prompt },
          ...images.map(({ mimeType, data }) => ({
            type: "image",
            mimeType,
            data,
          })),
        ],
      },
      this.options.promptTimeoutMs || 30 * 60 * 1000,
    )
      .then(async (result) => {
        this.activePrompt = false;
        this.flushMessages();
        const reason = result?.stopReason;
        if (this.interrupted || reason === "cancelled")
          return this.finish("interrupted", "执行已停止");
        if (reason === "end_turn") return this.finish("done");
        return this.finish(
          "error",
          `ACP 执行停止：${reason || "缺少 stopReason"}`,
        );
      })
      .catch((error) =>
        this.finish(
          this.interrupted ? "interrupted" : "error",
          this.safe(error.message),
        ),
      );
    return this;
  }
  receive(message) {
    if (this.ended) return;
    if (!message || message.jsonrpc !== "2.0")
      throw new Error("ACP 返回无效 JSON-RPC 消息");
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          this.safe(
            message.error.code === -32000
              ? "ACP 需要登录，请先在该 CLI 完成登录"
              : message.error.message,
          ),
        );
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.id !== undefined) {
      if (message.method !== "session/request_permission")
        return this.write({
          id: message.id,
          error: { code: -32601, message: "Client capability not supported" },
        });
      if (
        params.sessionId !== this.sessionId ||
        !this.activePrompt ||
        this.interrupted
      )
        return this.reply(message.id, { outcome: { outcome: "cancelled" } });
      const options = (params.options || []).filter(
        (option) =>
          typeof option.optionId === "string" &&
          [
            "allow_once",
            "reject_once",
            "allow_always",
            "reject_always",
          ].includes(option.kind),
      );
      const key = String(message.id);
      if (this.approvals.has(key)) throw new Error("重复 ACP 权限请求标识");
      const toolCall = {
        ...this.tools.get(params.toolCall?.toolCallId),
        ...params.toolCall,
      };
      const entry = { id: message.id, options, toolCall };
      this.approvals.set(key, entry);
      // Unknown, execute and switch_mode requests are denied in mapped read-only mode.
      if (
        this.options.mode === "read-only" &&
        !["read", "search", "think"].includes(toolCall.kind)
      )
        return this.respondApproval(key, { allow: false });
      const request = {
        kind: "acp",
        tool: toolCall.title || toolCall.name || "ACP 工具",
        toolCall,
        options,
      };
      this.emit({ type: "approval", approvalId: key, request });
      if (this.options.onApproval)
        Promise.resolve()
          .then(() =>
            this.options.onApproval({
              runId: this.options.runId,
              approvalId: key,
              ...request,
            }),
          )
          .then((decision) => {
            if (decision !== undefined && this.approvals.has(key))
              this.respondApproval(key, decision);
          })
          .catch(() => {
            if (this.approvals.has(key))
              this.respondApproval(key, { allow: false });
          });
      return;
    }
    if (message.method !== "session/update") return;
    if (params.sessionId !== this.sessionId) return;
    const update = params.update || {};
    if (update.sessionUpdate === "config_option_update") {
      this.session.configOptions = update.configOptions;
      if (!this.loading)
        this.emit({
          type: "catalog",
          ...acpCatalog(this.session, this.config),
        });
      if (!this.loading && this.activePrompt) emitReportedConfiguration(this, acpCatalog(this.session, this.config).currentModelId, category(this.session, "thought_level")?.currentValue);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      this.session.modes = {
        ...this.session.modes,
        currentModeId: update.currentModeId,
      };
      return;
    }
    if (this.loading || !this.activePrompt) return; // session/load history must not be duplicated into a new run.
    if (
      ["agent_message_chunk", "agent_thought_chunk"].includes(
        update.sessionUpdate,
      )
    ) {
      if (update.content?.type !== "text") return;
      const role =
        update.sessionUpdate === "agent_thought_chunk"
          ? "reasoning"
          : "assistant";
      const sourceId = update.messageId || `${this.segment || 0}-${role}`;
      const key = `${role}:${sourceId}`;
      if (!this.messages.has(key))
        this.messages.set(key, { itemId: randomUUID(), role, text: "" });
      const item = this.messages.get(key);
      item.text += update.content.text || "";
      if (Buffer.byteLength(item.text) > 2 * 1024 * 1024)
        throw new Error("ACP 消息超过 2 MB");
      this.emit({
        type: "delta",
        role,
        itemId: item.itemId,
        text: update.content.text || "",
      });
      return;
    }
    if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      if (typeof update.toolCallId !== "string") return;
      if (update.sessionUpdate === "tool_call")
        this.segment = (this.segment || 0) + 1;
      const old = this.tools.get(update.toolCallId) || {};
      const item = {
        ...old,
        ...Object.fromEntries(
          Object.entries(update).filter(
            ([, value]) => value !== null && value !== undefined,
          ),
        ),
      };
      this.tools.set(update.toolCallId, item);
      this.emit({
        type: "tool",
        phase: ["completed", "failed"].includes(item.status)
          ? "completed"
          : "started",
        itemId: item.toolCallId,
        item,
      });
      return;
    }
    if (update.sessionUpdate === "usage_update")
      this.emit({
        type: "usage",
        usage: { used: update.used, contextWindow: update.size },
        usageSnapshot: acpUsage(update),
        cost: update.cost,
      });
    if (update.sessionUpdate === "plan")
      this.emit({ type: "plan", entries: update.entries });
  }
  respondApproval(key, decision) {
    const entry = this.approvals.get(String(key));
    if (!entry || this.ended) throw new Error("ACP 审批已结束");
    const allow = decision === true || decision?.allow === true;
    // Never promote a single approval to persistent allow_always/reject_always.
    const selected = entry.options.find(
      (option) => option.kind === (allow ? "allow_once" : "reject_once"),
    );
    this.reply(entry.id, {
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
    this.approvals.delete(String(key));
    this.emit({ type: "approvalResolved", approvalId: String(key) });
  }
  flushMessages() {
    if (this.flushed) return;
    this.flushed = true;
    for (const message of this.messages.values())
      this.emit({ type: "message", ...message, streamed: true });
  }
  async steer() {
    return {
      unsupported: true,
      message: "ACP v1 不支持执行中追加指导；请保留草稿，当前任务结束后发送",
    };
  }
  async interrupt() {
    if (this.ended) return this.completion;
    this.interrupted = true;
    if (this.sessionId && this.transport && !this.transport.closed) {
      try {
        for (const entry of this.approvals.values())
          this.reply(entry.id, { outcome: { outcome: "cancelled" } });
        this.approvals.clear();
        this.write({
          method: "session/cancel",
          params: { sessionId: this.sessionId },
        });
      } catch {}
      if (this.promptPromise) {
        let timer;
        await Promise.race([
          this.promptPromise,
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.options.cancelTimeoutMs || 1500);
          }),
        ]);
        clearTimeout(timer);
      }
    }
    return this.finish("interrupted", "执行已停止");
  }
  finish(status, message = "") {
    if (this.ended) return this.completion;
    this.ended = true;
    this.activePrompt = false;
    for (const entry of this.approvals.values()) {
      try {
        this.reply(entry.id, { outcome: { outcome: "cancelled" } });
      } catch {}
    }
    this.approvals.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(this.safe(message) || "ACP 连接已关闭"));
    }
    this.pending.clear();
    this.flushMessages();
    this.completion = Promise.resolve(this.transport?.close()).then(() =>
      this.options.onEnd?.({
        runId: this.options.runId,
        status,
        message: this.safe(message),
        sessionId: this.sessionId,
      }),
    );
    return this.completion;
  }
  close() {
    return this.interrupt();
  }
}

/** Starts only the already-installed local Agent; no authenticate call, prompt or automatic installation. */
export async function probeACP(
  config,
  { cwd, env = process.env, timeoutMs = 20000, transportFactory } = {},
) {
  const run = new ACPRun({ cwd, requestTimeoutMs: timeoutMs }, config, {
    env,
    transportFactory,
  });
  try {
    await run.connect();
    return {
      connected: true,
      requiresAuth: false,
      agentInfo: run.agentInfo,
      capabilities: run.capabilities,
      ...acpCatalog(run.session, run.config),
    };
  } catch (error) {
    if (error.code === -32000)
      return {
        connected: true,
        requiresAuth: true,
        agentInfo: run.agentInfo,
        authMethods: run.authMethods,
        models: [],
        modes: [],
      };
    throw error;
  } finally {
    await run.finish("done");
  }
}
