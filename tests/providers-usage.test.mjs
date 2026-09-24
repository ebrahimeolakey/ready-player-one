import test from "node:test";
import assert from "node:assert/strict";
import {
  codexUsage,
  acpUsage,
  ClaudeUsage,
  CompatibleUsage,
  validateUsage,
  MAX_USAGE_TOKENS,
} from "../core/providers/usage.mjs";
const claudeMessage = (id = "a", model = "exact-model", input = 10) => ({
  type: "assistant",
  message: {
    id,
    model,
    usage: {
      input_tokens: input,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 70,
      output_tokens: 1,
    },
  },
});
const models = {
  "exact-model": {
    inputTokens: 100,
    cacheReadInputTokens: 700,
    cacheCreationInputTokens: 200,
    outputTokens: 40,
    contextWindow: 200000,
  },
  "subagent-model": {
    inputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 10,
    contextWindow: 1000000,
  },
};
test("Codex last snapshot remains distinct from session counters; compaction can reduce context", () => {
  const total = {
    inputTokens: 500,
    outputTokens: 100,
    totalTokens: 600,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 40,
  };
  const v = codexUsage({
    last: { totalTokens: 90, reasoningOutputTokens: 20 },
    total,
    modelContextWindow: 1000,
  });
  assert.equal(v.context.usedTokens, 90);
  assert.equal(v.cumulative.totalTokens, 600);
  assert.equal(v.context.limitTokens, 1000);
  assert.equal(
    codexUsage({ last: { totalTokens: 10 }, total }).context.limitTokens,
    null,
  );
  assert.deepEqual(validateUsage(v), v);
});
test("Claude main-loop context, exact model window, session model totals and estimated costs have distinct scopes", () => {
  const tracker = new ClaudeUsage();
  assert.equal(tracker.receive(claudeMessage()).context.usedTokens, 100);
  assert.equal(
    tracker.receive({
      ...claudeMessage("sub", "subagent-model", 999),
      parent_tool_use_id: "tool",
    }),
    null,
  );
  const v = tracker.receive({
    type: "result",
    modelUsage: models,
    total_cost_usd: 0.02,
    usage: { input_tokens: 999999 },
  });
  assert.equal(v.context.usedTokens, 100);
  assert.equal(v.context.limitTokens, 200000);
  assert.equal(v.cumulative.inputTokens, 1005);
  assert.equal(v.cumulative.totalTokens, 1055);
  assert.equal(v.cumulative.includesSubagents, true);
  assert.equal(v.cost.kind, "estimate");
  assert.deepEqual(
    tracker.receive({
      type: "result",
      modelUsage: models,
      total_cost_usd: 0.02,
    }),
    v,
  );
  assert.equal(
    tracker.receive(claudeMessage("b", "unknown-model")).context.limitTokens,
    null,
  );
  assert.equal(
    tracker.receive({ type: "result", modelUsage: models }).context.limitTokens,
    null,
  );
  assert.equal(
    tracker.receive({ type: "system", subtype: "compact_boundary" }).context
      .usedTokens,
    null,
  );
  assert.equal(
    tracker.receive({
      type: "result",
      subtype: "error_during_execution",
      usage: { input_tokens: 0 },
    }),
    null,
  );
});
test("Claude turn fallback is labeled main agent only and missing cache data stays unknown", () => {
  const t = new ClaudeUsage();
  const v = t.receive({
    type: "result",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 5,
    },
  });
  assert.equal(v.cumulative.totalTokens, 65);
  assert.equal(v.cumulative.scope, "turn");
  assert.equal(v.context.usedTokens, null);
  assert.equal(v.cost, null);
  assert.equal(
    t.receive({
      type: "assistant",
      message: { model: "x", usage: { input_tokens: 5 } },
    }).context.usedTokens,
    null,
  );
});
test("ACP session usage is context only; genuine zero is retained without inventing cumulative tokens", () => {
  const v = acpUsage({
    used: 0,
    size: 1000,
    cost: { amount: 0, currency: "USD" },
  });
  assert.equal(v.context.usedTokens, 0);
  assert.equal(v.cumulative, null);
  assert.equal(v.cost.amount, 0);
  assert.equal(acpUsage({}).context.usedTokens, null);
});
test("compatible per-response snapshots deduplicate; cache/reasoning subsets do not inflate run totals", () => {
  const t = new CompatibleUsage();
  const u = {
    prompt_tokens: 100,
    completion_tokens: 30,
    total_tokens: 130,
    prompt_tokens_details: { cached_tokens: 50 },
    completion_tokens_details: { reasoning_tokens: 20 },
  };
  t.receive("1", u);
  const a = t.receive("1", u);
  assert.equal(a.cumulative.totalTokens, 130);
  const b = t.receive("2", u);
  assert.equal(b.cumulative.totalTokens, 260);
  assert.equal(b.context.usedTokens, 100);
  assert.equal(b.context.limitTokens, null);
  const c = t.receive("3", undefined);
  assert.equal(c.cumulative.totalTokens, null);
  assert.equal(c.context.usedTokens, null);
  assert.equal(t.receive("4", u).cumulative.totalTokens, null);
});
test("shared usage schema rejects unsafe counters/cost, missing fields and strips arbitrary payload", () => {
  const v = codexUsage({ last: { totalTokens: 2 } });
  for (const x of [
    -1,
    NaN,
    Infinity,
    1.2,
    "2",
    MAX_USAGE_TOKENS + 1,
    undefined,
  ])
    assert.throws(() =>
      validateUsage({ ...v, context: { ...v.context, usedTokens: x } }),
    );
  assert.throws(() =>
    validateUsage({ ...v, context: { ...v.context, limitTokens: 0 } }),
  );
  assert.throws(() =>
    validateUsage({
      ...v,
      cost: {
        amount: Infinity,
        currency: "USD",
        scope: "run",
        kind: "estimate",
      },
    }),
  );
  assert.deepEqual(validateUsage({ ...v, secret: "discard me" }), v);
});
