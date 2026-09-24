import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ProviderConfigStore } from "../core/provider-config.mjs";

async function setup(available = true) {
  const root = await mkdtemp(join(tmpdir(), "rpo-provider-config-"));
  const path = join(root, "providers.json");
  const key = randomBytes(32);
  return {
    path,
    store: new ProviderConfigStore({
      path,
      isEncryptionAvailable: () => available,
      encrypt: (text) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([
          cipher.update(text, "utf8"),
          cipher.final(),
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decrypt: (buffer) => {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          buffer.subarray(0, 12),
        );
        decipher.setAuthTag(buffer.subarray(12, 28));
        return Buffer.concat([
          decipher.update(buffer.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      },
    }),
  };
}
const input = {
  name: "Test API",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "provider-secret-test",
};

test("provider config encrypts at rest and never returns plaintext or ciphertext to UI", async () => {
  const { path, store } = await setup();
  const saved = await store.save(input);
  assert.equal(saved.hasKey, true);
  assert.equal("apiKey" in saved, false);
  assert.equal("encryptedKey" in saved, false);
  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes(input.apiKey), false);
  assert.equal((await store.getRuntimeConfig(saved.id)).apiKey, input.apiKey);
  if (process.platform !== "win32")
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  const data = JSON.parse(raw);
  data.providers[0].injectedSecret = "DO_NOT_RETURN";
  await writeFile(path, JSON.stringify(data));
  assert.equal(
    JSON.stringify(await store.list()).includes("DO_NOT_RETURN"),
    false,
  );
});

test("provider edits retain key, rotate key, remove key, delete config without losing concurrent writes", async () => {
  const { store } = await setup();
  const [a, b] = await Promise.all([
    store.save(input),
    store.save({ ...input, name: "second" }),
  ]);
  assert.equal((await store.list()).length, 2);
  await store.save({ ...a, name: "renamed", apiKey: "" });
  assert.equal((await store.getRuntimeConfig(a.id)).apiKey, input.apiKey);
  await store.save({ ...a, apiKey: "rotated-secret" });
  assert.equal((await store.getRuntimeConfig(a.id)).apiKey, "rotated-secret");
  await store.save({ ...a, removeKey: true });
  assert.equal((await store.getRuntimeConfig(a.id)).apiKey, "");
  await store.remove(b.id);
  assert.equal((await store.list()).length, 1);
});

test("provider config fails closed when encryption unavailable or endpoints include credentials", async () => {
  const { store } = await setup(false);
  await assert.rejects(() => store.save(input), /系统加密不可用/);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(
    () =>
      store.save({ ...input, baseUrl: "https://user:password@example.com" }),
    /不能包含/,
  );
  await assert.rejects(
    () => store.save({ ...input, baseUrl: "http://api.example.com" }),
    /HTTPS/,
  );
  const noKey = await store.save({
    ...input,
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
  });
  assert.equal(noKey.hasKey, false);
});
