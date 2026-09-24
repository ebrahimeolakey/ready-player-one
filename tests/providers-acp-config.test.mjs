import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  ACPConfigStore,
  validateACPConfig,
  ACP_PRESETS,
} from "../core/acp-config.mjs";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rpo-acp-config-")),
    path = join(directory, "providers.json"),
    key = randomBytes(32);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const encrypt = (text) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  };
  const decrypt = (buffer) => {
    const cipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([
      cipher.update(buffer.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  };
  return {
    path,
    options: { path, encrypt, decrypt },
    store: new ACPConfigStore({ path, encrypt, decrypt }),
  };
}
test("ACP CRUD encrypts complete launch data and never returns env values in public metadata", async (t) => {
  const { path, store } = await fixture(t);
  const created = await store.save({
    name: "Local agent",
    command: "/synthetic/bin/my agent",
    args: ["acp", "--synthetic-private-argument"],
    env: { SYNTHETIC_KEY: "secret-fixture-value" },
    readOnlyModeId: "read",
    legacyModelApi: true,
  });
  assert.match(created.id, /^acp-/);
  assert.deepEqual(created.envNames, ["SYNTHETIC_KEY"]);
  assert.equal(created.hasEnvironment, true);
  assert.ok(!JSON.stringify(created).includes("secret-fixture-value"));
  const disk = await readFile(path, "utf8");
  for (const value of [
    "secret-fixture-value",
    "synthetic-private-argument",
    "/synthetic/bin",
  ])
    assert.ok(!disk.includes(value));
  if (process.platform !== "win32")
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.save({ id: created.id, name: "Renamed", model: "model-a" });
  assert.equal(
    (await store.getRuntimeConfig(created.id)).env.SYNTHETIC_KEY,
    "secret-fixture-value",
  );
  assert.equal((await store.list())[0].model, "model-a");
  await store.save({ id: created.id, name: "Renamed", removeEnv: true });
  assert.deepEqual((await store.getRuntimeConfig(created.id)).env, {});
  await store.remove(created.id);
  assert.deepEqual(await store.list(), []);
});
test("safeStorage availability fails closed and malformed command/env arguments cannot be stored", async (t) => {
  const { options } = await fixture(t);
  const disabled = new ACPConfigStore({
    ...options,
    isEncryptionAvailable: () => false,
  });
  await assert.rejects(
    disabled.save({ name: "A", command: "opencode", args: ["acp"] }),
    /加密不可用/,
  );
  for (const config of [
    { command: "x\0x" },
    { command: "x", args: "acp" },
    { command: "x", args: ["a\0b"] },
    { command: "x", env: { "BAD=NAME": "x" } },
    { command: "x", env: { KEY: 42 } },
  ])
    assert.throws(() => validateACPConfig(config));
  assert.deepEqual(
    ACP_PRESETS.map((value) => [value.command, ...value.args]),
    [
      ["opencode", "acp"],
      ["hermes", "acp"],
    ],
  );
});
test("serialized ACP configuration edits preserve independent records; corrupt ciphertext is not silently ignored", async (t) => {
  const { store, path, options } = await fixture(t);
  await Promise.all(
    ["one", "two", "three"].map((name) =>
      store.save({ name, command: "agent", args: ["acp"] }),
    ),
  );
  assert.equal((await store.list()).length, 3);
  const wrong = new ACPConfigStore({
    ...options,
    decrypt: () => {
      throw new Error("bad key");
    },
  });
  await assert.rejects(wrong.list(), /无法解密/);
  const record = (await store.list())[0];
  await assert.rejects(
    store.save({ id: "missing", name: "x", command: "agent" }),
    /不存在/,
  );
  assert.equal((await store.list()).length, 3);
});
