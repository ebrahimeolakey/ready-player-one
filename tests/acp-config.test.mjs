import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ACPConfigStore, validateACPConfig } from "../core/acp-config.mjs";
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "rpo-acp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32),
    path = join(root, "acp.json");
  let available = true;
  const options = {
    path,
    isEncryptionAvailable: () => available,
    encrypt(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(bytes) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
  return {
    path,
    store: new ACPConfigStore(options),
    restart: () => new ACPConfigStore(options),
    unavailable: () => {
      available = false;
    },
  };
}
const config = {
  name: "Synthetic ACP",
  command: "synthetic",
  args: ["acp"],
  env: { TEST_CREDENTIAL: "fixture-private-environment" },
};
test("ACP launch configuration encrypted at rest; environment values never sent to renderer; restart preserves config", async (t) => {
  const f = await setup(t),
    saved = await f.store.save(config);
  assert.deepEqual(saved.envNames, ["TEST_CREDENTIAL"]);
  assert.equal(saved.hasEnvironment, true);
  assert.equal("env" in saved, false);
  assert.equal("encryptedConfig" in saved, false);
  const raw = await readFile(f.path, "utf8");
  assert.equal(raw.includes(config.env.TEST_CREDENTIAL), false);
  assert.equal(raw.includes('"command"'), false);
  if (process.platform !== "win32")
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const runtime = await f.restart().getRuntimeConfig(saved.id);
  assert.deepEqual(runtime.env, config.env);
  assert.deepEqual(runtime.args, ["acp"]);
});
test("ACP serial writes retain concurrent providers; edits retain or explicitly clear environment", async (t) => {
  const f = await setup(t);
  const [a, b] = await Promise.all([
    f.store.save(config),
    f.store.save({ ...config, name: "Other" }),
  ]);
  assert.equal((await f.store.list()).length, 2);
  await f.store.save({ ...a, name: "Renamed" });
  assert.deepEqual((await f.store.getRuntimeConfig(a.id)).env, config.env);
  await f.store.save({ ...a, removeEnv: true });
  assert.deepEqual((await f.store.getRuntimeConfig(a.id)).env, {});
  await f.store.remove(b.id);
  assert.equal((await f.store.list()).length, 1);
  await assert.rejects(f.store.save({ ...config, id: "missing" }), /不存在/);
});
test("ACP invalid config and unavailable encryption fail without overwriting saved configuration", async (t) => {
  const f = await setup(t),
    saved = await f.store.save(config);
  for (const patch of [
    { command: "bad\0program" },
    { args: "acp" },
    { args: [1] },
    { env: { INVALID: 123 } },
  ])
    assert.throws(
      () => validateACPConfig({ ...config, ...patch }),
      /无效|字符串/,
    );
  const before = await readFile(f.path, "utf8");
  f.unavailable();
  await assert.rejects(f.store.save(config), /系统加密/);
  await assert.rejects(f.store.getRuntimeConfig(saved.id), /系统加密/);
  assert.equal(await readFile(f.path, "utf8"), before);
});
