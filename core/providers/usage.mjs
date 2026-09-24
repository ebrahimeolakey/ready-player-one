/** Protocol counters, not tokenizer estimates or an account billing ledger. */
export const MAX_USAGE_TOKENS = 1_000_000_000_000;
const keys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
];
const scopes = ["provider-session", "run", "turn"];
const token = (v) =>
  Number.isSafeInteger(v) && v >= 0 && v <= MAX_USAGE_TOKENS ? v : null;
const sum = (...values) =>
  values.every((v) => v !== null)
    ? token(values.reduce((a, b) => a + b, 0))
    : null;
const counters = (scope, includesSubagents, values) => ({
  scope,
  includesSubagents,
  ...Object.fromEntries(keys.map((k) => [k, token(values[k])])),
});
const snapshot = (
  source,
  used,
  limit,
  basis,
  cumulative = null,
  cost = null,
) => ({
  version: 1,
  source,
  context: {
    usedTokens: token(used),
    limitTokens: token(limit) > 0 ? token(limit) : null,
    basis,
  },
  cumulative,
  cost,
});
const cost = (amount, currency, scope, kind) =>
  typeof amount === "number" &&
  Number.isFinite(amount) &&
  amount >= 0 &&
  amount <= 1e9 &&
  typeof currency === "string" &&
  /^[A-Z]{3}$/.test(currency)
    ? { amount, currency, scope, kind }
    : null;

// Whitelist every shared field: raw provider metadata/headers never enter Hub state.
export function validateUsage(value) {
  if (
    !value ||
    value.version !== 1 ||
    !["codex", "claude", "acp", "openai-compatible"].includes(value.source)
  )
    throw Error("无效用量来源");
  const c = value.context;
  if (!c || !["provider-context", "last-request-input"].includes(c.basis))
    throw Error("无效上下文口径");
  const read = (v) => {
    if (v !== null && token(v) === null)
      throw Error("用量必须为范围内非负整数或 null");
    return v;
  };
  const context = {
    usedTokens: read(c.usedTokens),
    limitTokens: read(c.limitTokens),
    basis: c.basis,
  };
  if (context.limitTokens === 0) throw Error("上下文上限必须大于零");
  let cumulative = null,
    reportedCost = null;
  if (value.cumulative !== null) {
    const v = value.cumulative;
    if (
      !v ||
      !scopes.includes(v.scope) ||
      ![true, false, null].includes(v.includesSubagents)
    )
      throw Error("无效累计用量范围");
    cumulative = {
      scope: v.scope,
      includesSubagents: v.includesSubagents,
      ...Object.fromEntries(keys.map((k) => [k, read(v[k])])),
    };
  }
  if (value.cost !== null) {
    const v = value.cost;
    if (
      !v ||
      !scopes.includes(v.scope) ||
      !["estimate", "reported"].includes(v.kind) ||
      !(reportedCost = cost(v.amount, v.currency, v.scope, v.kind))
    )
      throw Error("无效费用");
  }
  return {
    version: 1,
    source: value.source,
    context,
    cumulative,
    cost: reportedCost,
  };
}
export function codexUsage(v = {}) {
  v ??= {};
  return snapshot(
    "codex",
    v.last?.totalTokens,
    v.modelContextWindow,
    "provider-context",
    v.total ? counters("provider-session", null, v.total) : null,
  );
}
export function acpUsage(v = {}) {
  v ??= {};
  return snapshot(
    "acp",
    v.used,
    v.size,
    "provider-context",
    null,
    cost(v.cost?.amount, v.cost?.currency, "provider-session", "reported"),
  );
}
const claudeInput = (v) =>
  sum(
    token(v?.input_tokens),
    token(v?.cache_read_input_tokens),
    token(v?.cache_creation_input_tokens),
  );
export class ClaudeUsage {
  constructor() {
    this.value = snapshot("claude", null, null, "last-request-input");
    this.model = null;
  }
  receive(message) {
    if (message.parent_tool_use_id) return null;
    if (
      message.type === "system" &&
      ["compact_boundary", "conversation_reset"].includes(message.subtype)
    ) {
      this.value.context.usedTokens = null;
      if (message.subtype === "conversation_reset") {
        this.value = snapshot("claude", null, null, "last-request-input");
        this.model = null;
      }
    } else if (
      message.type === "assistant" ||
      (message.type === "stream_event" &&
        message.event?.type === "message_start")
    ) {
      const m =
        message.type === "assistant" ? message.message : message.event.message;
      if (!m?.usage) return null;
      if (m.model !== this.model) this.value.context.limitTokens = null;
      this.model = typeof m.model === "string" ? m.model : null;
      this.value.context.usedTokens = claudeInput(m.usage);
    } else if (message.type === "result") {
      // Crash results can contain placeholder zeros; retain the last trustworthy snapshot.
      if (message.subtype === "error_during_execution") return null;
      const models = message.modelUsage;
      const rows =
        models && typeof models === "object" && !Array.isArray(models)
          ? Object.values(models)
          : [];
      this.value.context.limitTokens =
        token(models?.[this.model]?.contextWindow) > 0
          ? token(models[this.model].contextWindow)
          : null;
      if (rows.length) {
        const field = (key) => sum(...rows.map((v) => token(v?.[key])));
        const input = sum(
          field("inputTokens"),
          field("cacheReadInputTokens"),
          field("cacheCreationInputTokens"),
        );
        const output = field("outputTokens");
        this.value.cumulative = counters("provider-session", true, {
          inputTokens: input,
          outputTokens: output,
          totalTokens: sum(input, output),
          cachedInputTokens: field("cacheReadInputTokens"),
          cacheWriteInputTokens: field("cacheCreationInputTokens"),
        });
      } else if (message.usage) {
        const v = message.usage,
          input = claudeInput(v),
          output = token(v.output_tokens);
        this.value.cumulative = counters("turn", false, {
          inputTokens: input,
          outputTokens: output,
          totalTokens: sum(input, output),
          cachedInputTokens: v.cache_read_input_tokens,
          cacheWriteInputTokens: v.cache_creation_input_tokens,
        });
      } else this.value.cumulative = null;
      this.value.cost = cost(
        message.total_cost_usd,
        "USD",
        "provider-session",
        "estimate",
      );
    } else return null;
    return structuredClone(this.value);
  }
}
export class CompatibleUsage {
  constructor() {
    this.requests = new Map();
  }
  receive(id, v) {
    // One entry per HTTP response, including responses without usage. Missing counters
    // make the corresponding run total unknown rather than silently undercounting.
    const current = counters("run", false, {
      inputTokens: v?.prompt_tokens,
      outputTokens: v?.completion_tokens,
      totalTokens: v?.total_tokens,
      cachedInputTokens: v?.prompt_tokens_details?.cached_tokens,
      reasoningOutputTokens: v?.completion_tokens_details?.reasoning_tokens,
    });
    this.requests.set(id, current);
    const all = [...this.requests.values()];
    const totals = counters(
      "run",
      false,
      Object.fromEntries(keys.map((k) => [k, sum(...all.map((r) => r[k]))])),
    );
    return snapshot(
      "openai-compatible",
      v?.prompt_tokens,
      null,
      "last-request-input",
      totals,
    );
  }
}
