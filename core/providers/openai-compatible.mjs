import { compatibleFailure, readErrorEvidence } from "./failure.mjs";
import { CompatibleUsage } from "./usage.mjs";
import { emitReportedConfiguration } from "./configuration.mjs";
import { randomUUID } from "node:crypto";
import { normalizeImages } from "./input.mjs";
const compatibleInput = (text, images = []) => {
  const parsed = normalizeImages(images);
  return parsed.length
    ? [
        { type: "text", text },
        ...parsed.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      ]
    : text;
};

/** Optional adapter for Chat Completions-compatible endpoints.
 * Credentials are read only from the process environment, never from shared state.
 * Local tools must be explicitly registered by the host; every call awaits approval.
 */
export function registerOpenAICompatible(runtime, name, config) {
  const base = new URL(config.baseUrl);
  if (
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
      ))
  )
    throw new Error(
      "Provider URL must use HTTPS (or loopback HTTP) without embedded credentials",
    );
  runtime.register(
    name,
    (options) =>
      new CompatibleRun(
        options,
        { ...config, baseUrl: base.toString() },
        { ...runtime.env, ...options.env },
      ),
  );
}

class CompatibleRun {
  constructor(options, config, env) {
    this.options = options;
    this.config = config;
    this.env = env;
    this.sessionId = options.sessionId || randomUUID();
    this.controller = new AbortController();
    this.approvals = new Map();
    this.pending = [];
    this.usageTracker = new CompatibleUsage();
    this.ended = false;
    this.messages = [
      ...(options.history || []),
      {
        role: "user",
        content: compatibleInput(options.prompt, options.images),
      },
    ];
  }
  emit(event) {
    this.options.onEvent?.({
      runId: this.options.runId,
      provider: this.options.provider,
      ...event,
    });
  }
  async initialize() {
    if (!this.options.model && !this.config.model)
      throw new Error("Custom provider requires a model");
    if (this.config.apiKeyEnv && !this.env[this.config.apiKeyEnv])
      throw new Error(
        `Missing provider credential environment variable: ${this.config.apiKeyEnv}`,
      );
    this.emit({ type: "session", sessionId: this.sessionId });
    this.emit({ type: "started", sessionId: this.sessionId });
    this.loop().catch((error) =>
      this.finish(
        this.controller.signal.aborted ? "interrupted" : "error",
        error.message,
        error.failure,
      ),
    );
    return this;
  }
  async loop() {
    for (let step = 0; step < (this.config.maxToolRounds || 32); step++) {
      const key = this.config.apiKeyEnv
        ? this.env[this.config.apiKeyEnv]
        : null;
      const response = await (this.config.fetch || fetch)(
        new URL("chat/completions", this.config.baseUrl.replace(/\/?$/, "/")),
        {
          method: "POST",
          signal: this.controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model: this.options.model || this.config.model,
            messages: this.messages,
            stream: true,
            ...(this.config.requestUsage === true ? { stream_options: { include_usage: true } } : {}),
            ...(this.options.effort
              ? { reasoning_effort: this.options.effort }
              : {}),
            ...(this.config.tools?.length
              ? {
                  tools: this.config.tools.map((t) => ({
                    type: "function",
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                }
              : {}),
          }),
        },
      );
      // Never echo response bodies: upstream errors may contain credentials or requests.
      if (!response.ok) throw Object.assign(new Error(`Provider HTTP ${response.status}`), {failure:compatibleFailure(response.status, await readErrorEvidence(response))});
      if (!response.body) throw new Error("Provider response has no stream");
      const itemId = randomUUID();
      let text = "";
      const calls = new Map();
      let usage;
      for await (const event of readSse(response.body)) {
        if (event.error) throw Object.assign(new Error("Provider stream returned an error"), {failure:compatibleFailure(undefined,event.error)});
        if (event.model) emitReportedConfiguration(this, event.model);
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta || {};
        if (typeof delta.content === "string") {
          text += delta.content;
          this.emit({
            type: "delta",
            role: "assistant",
            itemId,
            text: delta.content,
          });
        }
        for (const part of delta.tool_calls || []) {
          const call = calls.get(part.index) || {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments)
            call.function.arguments += part.function.arguments;
          calls.set(part.index, call);
        }
      }
      if (this.ended) return;
      this.messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
      });
      if (text)
        this.emit({
          type: "message",
          role: "assistant",
          itemId,
          text,
          streamed: true,
        });
      this.emit({ type: "usage", usage, usageSnapshot: this.usageTracker.receive(itemId, usage) });
      for (const call of calls.values()) {
        const tool = this.config.tools?.find(
          (t) => t.name === call.function.name,
        );
        let result;
        if (!tool) result = { error: "Tool is not registered" };
        else if (this.options.mode === "read-only" && tool.readOnly !== true)
          result = { error: "Tool is not available in read-only mode" };
        else {
          let input;
          try {
            input = JSON.parse(call.function.arguments);
          } catch {
            result = { error: "Invalid tool arguments" };
          }
          if (!result) {
            const allow = await this.approve(call, input);
            if (!allow) result = { error: "User denied tool execution" };
            else {
              this.emit({
                type: "tool",
                phase: "started",
                itemId: call.id,
                item: { name: tool.name, input },
              });
              if(this.ended)return;
              const execution=Promise.resolve().then(()=>tool.execute(input, {
                signal:this.controller.signal,cwd:this.options.cwd,approved:true,mode:this.options.mode,
              }));
              this.activeTool=execution;
              try {
                result = await execution;
              } catch {
                result = { error: "Tool execution failed" };
              } finally {
                if(this.activeTool===execution)this.activeTool=null;
              }
              if(this.ended)return;
              this.emit({
                type: "tool",
                phase: "completed",
                itemId: call.id,
                item: { name: tool.name, result },
              });
            }
          }
        }
        if (this.ended) return;
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result ?? null).slice(0, 256000),
        });
      }
      if (this.pending.length)
        this.messages.push(
          ...this.pending
            .splice(0)
            .map((content) => ({ role: "user", content })),
        );
      else if (!calls.size) {
        this.finish("done");
        return;
      }
    }
    this.finish("error", "Tool round limit reached");
  }
  approve(call, input) {
    const request = { kind: "tool", tool: call.function.name, input };
    return new Promise((resolve) => {
      this.approvals.set(call.id, resolve);
      this.emit({ type: "approval", approvalId: call.id, request });
      if (this.options.onApproval)
        Promise.resolve()
          .then(() =>
            this.options.onApproval({
              runId: this.options.runId,
              approvalId: call.id,
              ...request,
            }),
          )
          .then((decision) => {
            if (decision !== undefined && this.approvals.has(call.id))
              this.respondApproval(call.id, decision);
          })
          .catch(() => {
            if (this.approvals.has(call.id))
              this.respondApproval(call.id, false);
          });
    });
  }
  respondApproval(id, decision) {
    const resolve = this.approvals.get(id);
    if (!resolve) throw new Error("Approval is no longer pending");
    this.approvals.delete(id);
    resolve(decision === true || decision?.allow === true);
    this.emit({ type: "approvalResolved", approvalId: id });
  }
  async steer(text, images = []) {
    if (this.ended) throw new Error("Run has ended");
    this.pending.push(compatibleInput(text, images));
    return { queued: true };
  }
  interrupt() {
    return this.close();
  }
  close() {
    return this.finish("interrupted", "执行已停止");
  }
  finish(status, message = "", failure = null) {
    if (this.ended) return this.completion;
    this.ended = true;
    this.controller.abort();
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
    const finished=()=>this.options.onEnd?.({
      runId: this.options.runId,
      status,
      message,
      sessionId: this.sessionId,
      history: this.messages,
      ...(status === "error" && failure ? {failure} : {}),
    });
    if(this.activeTool)this.completion=Promise.resolve(this.activeTool).catch(()=>{}).then(finished);
    else {finished();this.completion=Promise.resolve();}
    return this.completion;
  }
}

export async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 8 * 1024 * 1024)
      throw new Error("Provider stream frame exceeds limit");
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
      buffer = buffer.slice(boundary + separator.length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        throw new Error("Provider returned invalid stream JSON");
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim())
    throw new Error("Provider stream ended with an incomplete event");
}
