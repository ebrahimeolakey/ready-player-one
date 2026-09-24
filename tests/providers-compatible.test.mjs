import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import {
  registerOpenAICompatible,
  readSse,
} from "../core/providers/openai-compatible.mjs";

const stream = (events) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );

test("compatible provider waits for approval, refuses tool, then continues without running code", async () => {
  const runtime = new ProviderRuntime({
    env: { TEST_PROVIDER_KEY: "local-test-only" },
  });
  let executed = false;
  let calls = 0;
  let end;
  const ended = new Promise((resolve) => (end = resolve));
  const requests = [];
  registerOpenAICompatible(runtime, "local", {
    baseUrl: "http://127.0.0.1:12345/v1",
    apiKeyEnv: "TEST_PROVIDER_KEY",
    model: "test",
    tools: [
      {
        name: "write",
        parameters: { type: "object" },
        execute: () => {
          executed = true;
        },
      },
    ],
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options });
      calls++;
      return calls === 1
        ? stream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tool-1",
                        function: {
                          name: "write",
                          arguments: '{"path":"a.txt"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ])
        : stream([
            { choices: [{ delta: { content: "Denied as requested." } }] },
          ]);
    },
  });
  await runtime.start({
    runId: "c",
    provider: "local",
    cwd: "/tmp",
    prompt: "test",
    onApproval: () => ({ allow: false }),
    onEnd: end,
  });
  const result = await ended;
  assert.equal(result.status, "done");
  assert.equal(executed, false);
  assert.equal(calls, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:12345/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer local-test-only");
  assert.match(
    JSON.parse(requests[1].body).messages.at(-1).content,
    /User denied/,
  );
  assert.equal(runtime.runs.size, 0);
});

test("compatible stream handles UTF8/chunk boundaries and rejects truncated frame", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"text":"中文"}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  async function* body() {
    for (const byte of bytes) yield new Uint8Array([byte]);
  }
  const result = [];
  for await (const event of readSse(body())) result.push(event);
  assert.deepEqual(result, [{ text: "中文" }]);
  async function* broken() {
    yield new TextEncoder().encode("data: {");
  }
  await assert.rejects(async () => {
    for await (const _ of readSse(broken())) {
    }
  }, /incomplete/);
});

test("compatible provider validates endpoints and refuses missing credentials without network call", async () => {
  const runtime = new ProviderRuntime({ env: {} });
  assert.throws(
    () =>
      registerOpenAICompatible(runtime, "bad", {
        baseUrl: "http://api.example.com/v1",
      }),
    /HTTPS/,
  );
  registerOpenAICompatible(runtime, "private", {
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "KEY",
    model: "test",
    fetch: () => {
      throw Error("must not connect");
    },
  });
  await assert.rejects(
    () =>
      runtime.start({
        runId: "c",
        provider: "private",
        cwd: "/tmp",
        prompt: "hi",
      }),
    /Missing provider credential/,
  );
  assert.equal(runtime.runs.size, 0);
});
