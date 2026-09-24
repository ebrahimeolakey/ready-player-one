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

test("compatible model reporting uses response model and deduplicates repeated chunks", async () => {
  const runtime = new ProviderRuntime(), events = []; let ended;
  const done = new Promise(resolve => { ended = resolve; });
  registerOpenAICompatible(runtime, "model-report", { baseUrl: "http://127.0.0.1:12345/v1", model: "configured-alias", fetch: async () => stream([
    { model: "actual-model", choices: [{ delta: { content: "a" } }] },
    { model: "actual-model", choices: [{ delta: { content: "b" } }] },
  ]) });
  await runtime.start({ runId: "model", provider: "model-report", cwd: "/tmp", prompt: "fixture", effort: "high", onEvent: e => events.push(e), onEnd: ended });
  await done;
  const reports = events.filter(e => e.type === "configuration");
  assert.equal(reports.length, 1); assert.equal(reports[0].model, "actual-model"); assert.equal(reports[0].effort, null);
  await runtime.close();
});

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

test('compatible request opts into real streaming usage and emits a normalized snapshot',async()=>{
 const runtime=new ProviderRuntime();const events=[];let resolve;const done=new Promise(r=>resolve=r);
 registerOpenAICompatible(runtime,'usage-test',{baseUrl:'http://127.0.0.1:12345/v1',model:'model-with-no-known-limit',requestUsage:true,fetch:async(_url,options)=>{
  assert.deepEqual(JSON.parse(options.body).stream_options,{include_usage:true});
  return stream([{choices:[{delta:{content:'ok'}}]},{choices:[],usage:{prompt_tokens:100,completion_tokens:3,total_tokens:103}}]);
 }});
 await runtime.start({runId:'usage',provider:'usage-test',cwd:'/tmp',prompt:'synthetic',onEvent:e=>events.push(e),onEnd:resolve});await done;
 const v=events.find(e=>e.type==='usage').usageSnapshot;assert.equal(v.context.usedTokens,100);assert.equal(v.context.limitTokens,null);assert.equal(v.cumulative.totalTokens,103);await runtime.close();
});

test('legacy compatible endpoints receive no new usage request field and are never silently retried',async()=>{
 const runtime=new ProviderRuntime();const events=[];let resolve,calls=0;const done=new Promise(r=>resolve=r);
 registerOpenAICompatible(runtime,'legacy-usage',{baseUrl:'http://127.0.0.1:12345/v1',model:'legacy',fetch:async(_url,options)=>{
  calls++;assert.equal(Object.hasOwn(JSON.parse(options.body),'stream_options'),false);
  return stream([{choices:[{delta:{content:'legacy endpoint'}}]}]);
 }});
 await runtime.start({runId:'legacy',provider:'legacy-usage',cwd:'/tmp',prompt:'synthetic',onEvent:e=>events.push(e),onEnd:resolve});await done;
 assert.equal(calls,1);const v=events.find(e=>e.type==='usage').usageSnapshot;assert.equal(v.context.usedTokens,null);assert.equal(v.cumulative.totalTokens,null);await runtime.close();
});
