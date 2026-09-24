import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecureStore,
  StreamingRedactor,
  redactText,
  retainedTranscriptEntries,
} from "../core/secure-store.mjs";
import {
  loadDesktopDataKey,
  loadExternalDataKey,
} from "../desktop/services/data-key.mjs";
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "rpo-secure-")),
    dir = join(root, "data"),
    key = randomBytes(32);
  const store = new SecureStore({ dir, key });
  return {
    root,
    dir,
    key,
    store,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
};
test("encrypted database preserves auth values; random nonces and path AAD reject tampering", () => {
  const f = setup();
  try {
    const value = {
      hostToken: "HOST_TOKEN_PRIVATE",
      sessions: [],
      secret: "NO_PLAINTEXT",
    };
    f.store.writeJSON("hub.json", value);
    const first = readFileSync(join(f.dir, "hub.json.enc"), "utf8");
    assert.ok(
      !first.includes("HOST_TOKEN_PRIVATE") && !first.includes("NO_PLAINTEXT"),
    );
    assert.deepEqual(f.store.readJSON("hub.json"), value);
    f.store.writeJSON("hub.json", value);
    assert.notEqual(readFileSync(join(f.dir, "hub.json.enc"), "utf8"), first);
    copyFileSync(join(f.dir, "hub.json.enc"), join(f.dir, "other.json.enc"));
    assert.throws(() => f.store.readJSON("other.json"));
    const bad = JSON.parse(first);
    const bytes = Buffer.from(bad.ciphertext, "base64");
    bytes[0] ^= 1;
    bad.ciphertext = bytes.toString("base64");
    writeFileSync(join(f.dir, "hub.json.enc"), JSON.stringify(bad));
    assert.throws(() => f.store.readJSON("hub.json"));
    assert.throws(() => f.store.readJSON("../outside"));
  } finally {
    f.clean();
  }
});
test("JSONL encrypts and authenticates order/count while masking recognized credentials", () => {
  const f = setup();
  try {
    f.store.appendJSONL("transcripts/lane.jsonl", {
      id: "one",
      text: 'api_key="super_secret_api_value"',
    });
    f.store.appendJSONL("transcripts/lane.jsonl", {
      id: "two",
      text: "normal output",
    });
    const entries = f.store.readJSONL("transcripts/lane.jsonl");
    assert.ok(entries[0].text.includes("凭据已隐藏"));
    assert.equal(entries[1].text, "normal output");
    const file = join(f.dir, "transcripts/lane.jsonl.enc"),
      text = readFileSync(file, "utf8");
    assert.ok(!text.includes("super_secret_api_value"));
    const lines = text.trimEnd().split("\n");
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeFileSync(file, lines.join("\n") + "\n");
    assert.throws(() => f.store.readJSONL("transcripts/lane.jsonl"));
    writeFileSync(file, text.split("\n").slice(0, 2).join("\n"));
    assert.throws(() => f.store.readJSONL("transcripts/lane.jsonl"));
  } finally {
    f.clean();
  }
});
test("interrupted atomic write preserves committed data; first-write pending can be recovered", () => {
  const f = setup();
  try {
    f.store.writeJSON("hub.json", { saved: 1 });
    const interrupted = new SecureStore({
      dir: f.dir,
      key: f.key,
      beforeCommit: () => {
        throw Error("simulated interruption");
      },
    });
    assert.throws(() => interrupted.writeJSON("hub.json", { saved: 2 }));
    assert.deepEqual(f.store.readJSON("hub.json"), { saved: 1 });
    assert.ok(readdirSync(f.dir).some((n) => n.endsWith(".pending")));
    assert.throws(() =>
      interrupted.writeJSON("fresh.json", { recovered: true }),
    );
    assert.deepEqual(f.store.readJSON("fresh.json"), { recovered: true });
  } finally {
    f.clean();
  }
});
test("plaintext migration verifies before unlink, resumes partial work and preserves disagreements", () => {
  const f = setup();
  try {
    mkdirSync(join(f.dir, "transcripts"));
    const db = {
      hostToken: "KEEP_REAL_AUTH_TOKEN",
      memories: [{ text: "keep me" }],
    };
    writeFileSync(join(f.dir, "hub.json"), JSON.stringify(db));
    writeFileSync(
      join(f.dir, "transcripts/lane.jsonl"),
      JSON.stringify({ text: "password=secret123" }) + "\n",
    );
    const interrupted = new SecureStore({
      dir: f.dir,
      key: f.key,
      beforeCommit: () => {
        throw Error("disk interruption");
      },
    });
    assert.throws(() => interrupted.migrateLegacy());
    assert.ok(existsSync(join(f.dir, "hub.json")));
    f.store.migrateLegacy();
    assert.equal(existsSync(join(f.dir, "hub.json")), false);
    assert.equal(existsSync(join(f.dir, "transcripts/lane.jsonl")), false);
    assert.deepEqual(f.store.readJSON("hub.json"), db);
    assert.equal(
      f.store.readJSONL("transcripts/lane.jsonl")[0].text,
      "password=secret123",
    );
    writeFileSync(join(f.dir, "hub.json"), '{"different":true}');
    assert.throws(() => f.store.migrateLegacy(), /不一致/);
    assert.ok(existsSync(join(f.dir, "hub.json")));
    const wrong = new SecureStore({ dir: f.dir, key: randomBytes(32) });
    assert.throws(() => wrong.migrateLegacy());
    assert.ok(existsSync(join(f.dir, "hub.json")));
  } finally {
    f.clean();
  }
});
test("retention prunes transcript records only and retains invalid timestamps, active logs and empty encrypted files", () => {
  const f = setup();
  try {
    const now = Date.parse("2026-09-24T00:00:00Z"),
      old = { text: "old", at: "2026-01-01" },
      recent = { text: "new", at: "2026-09-23" };
    const db = { plans: ["keep"], memories: ["keep"] };
    f.store.writeJSON("hub.json", db);
    f.store.writeJSONL("transcripts/one.jsonl", [
      old,
      recent,
      { text: "unknown" },
    ]);
    f.store.writeJSONL("transcripts/two.jsonl", [old]);
    f.store.writeJSONL("transcripts/active.jsonl", [old]);
    const result = f.store.cleanupTranscripts({
      days: 30,
      now,
      activeNames: ["transcripts/active.jsonl"],
    });
    assert.equal(result.removedEntries, 2);
    assert.equal(f.store.readJSONL("transcripts/one.jsonl").length, 2);
    assert.deepEqual(f.store.readJSONL("transcripts/two.jsonl"), []);
    assert.ok(f.store.exists("transcripts/two.jsonl"));
    assert.equal(f.store.readJSONL("transcripts/active.jsonl").length, 1);
    assert.deepEqual(f.store.readJSON("hub.json"), db);
    assert.deepEqual(retainedTranscriptEntries([old, recent], result.cutoff), [
      recent,
    ]);
  } finally {
    f.clean();
  }
});
test("record-boundary redactor catches credentials split across chunks and caps oversized records", () => {
  const r = new StreamingRedactor();
  assert.equal(r.push("hello sk-pro"), "");
  assert.equal(r.push("j-abcdefghijklmnopqrs goodbye"), "");
  assert.equal(r.finish().includes("abcdefghijklmnopqrs"), false);
  r.push("-----BEGIN PRIVATE KEY-----\n");
  r.push("PRIVATE MATERIAL\n-----END PRIVATE KEY-----");
  assert.equal(r.finish(), "[凭据已隐藏]");
  const limited = new StreamingRedactor({ maxChars: 8 });
  limited.push("123456789secret");
  assert.match(limited.finish(), /上限/);
  assert.ok(!redactText("https://x.test?token=abc123#ok").includes("abc123"));
});
function fakeSafeStorage() {
  const systemKey = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString(text) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", systemKey, iv),
        data = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]);
    },
    decryptString(bytes) {
      const d = createDecipheriv(
        "aes-256-gcm",
        systemKey,
        bytes.subarray(0, 12),
      );
      d.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        d.update(bytes.subarray(28)),
        d.final(),
      ]).toString();
    },
  };
}
test("desktop key persists only wrapped bytes and fails closed for unavailable protection/lost key", () => {
  const f = setup();
  try {
    const safeStorage = fakeSafeStorage(),
      keyFile = join(f.root, "data-key.json");
    const key = loadDesktopDataKey({ safeStorage, keyFile, dataDir: f.dir });
    assert.equal(key.length, 32);
    assert.deepEqual(
      loadDesktopDataKey({ safeStorage, keyFile, dataDir: f.dir }),
      key,
    );
    assert.ok(!readFileSync(keyFile, "utf8").includes(key.toString("base64")));
    assert.throws(() =>
      loadDesktopDataKey({
        safeStorage: {
          ...safeStorage,
          getSelectedStorageBackend: () => "basic_text",
        },
        keyFile,
      }),
    );
    copyFileSync(keyFile, keyFile + ".pending");
    rmSync(keyFile);
    assert.deepEqual(
      loadDesktopDataKey({ safeStorage, keyFile, dataDir: f.dir }),
      key,
    );
    f.store.writeJSON("hub.json", { secret: true });
    rmSync(keyFile);
    assert.throws(
      () => loadDesktopDataKey({ safeStorage, keyFile, dataDir: f.dir }),
      /丢失/,
    );
  } finally {
    f.clean();
  }
});
test(
  "standalone key must be external and private",
  { skip: process.platform === "win32" },
  () => {
    const f = setup();
    try {
      const keyFile = join(f.root, "key");
      writeFileSync(keyFile, f.key.toString("hex"), { mode: 0o600 });
      assert.deepEqual(loadExternalDataKey({ keyFile, dataDir: f.dir }), f.key);
      chmodSync(keyFile, 0o644);
      assert.throws(
        () => loadExternalDataKey({ keyFile, dataDir: f.dir }),
        /600/,
      );
      const inside = join(f.dir, "key");
      writeFileSync(inside, f.key.toString("hex"), { mode: 0o600 });
      assert.throws(
        () => loadExternalDataKey({ keyFile: inside, dataDir: f.dir }),
        /目录内/,
      );
      assert.throws(
        () => loadExternalDataKey({ dataDir: f.dir }),
        /RPO_DATA_KEY_FILE/,
      );
    } finally {
      f.clean();
    }
  },
);

test("retention also prunes unfinished transcript snapshots without dropping recoverable files", () => {
  const f = setup();
  try {
    const name = "transcripts/old.jsonl";
    const old = { text: "old transcript", at: "2020-01-01" };
    f.store.writeJSONL(name, [old]);
    const interrupted = new SecureStore({
      dir: f.dir,
      key: f.key,
      beforeCommit() {
        throw Error("interrupted");
      },
    });
    assert.throws(() =>
      interrupted.writeJSONL(name, [
        old,
        { text: "keep recent", at: "2026-09-24" },
      ]),
    );
    const report = f.store.cleanupTranscripts({
      days: 30,
      now: Date.parse("2026-09-24"),
    });
    assert.equal(report.removedEntries, 2);
    assert.deepEqual(f.store.readJSONL(name), []);
    assert.ok(
      readdirSync(join(f.dir, "transcripts")).some((n) =>
        n.endsWith(".pending"),
      ),
    );
    rmSync(join(f.dir, name + ".enc"));
    assert.deepEqual(f.store.readJSONL(name), [
      { text: "keep recent", at: "2026-09-24" },
    ]);
  } finally {
    f.clean();
  }
});

test(
  "migration never removes malformed plaintext and never traverses symlinked folders",
  { skip: process.platform === "win32" },
  async () => {
    const { symlinkSync } = await import("node:fs");
    const f = setup();
    try {
      writeFileSync(join(f.dir, "hub.json"), "{broken");
      assert.throws(() => f.store.migrateLegacy());
      assert.equal(readFileSync(join(f.dir, "hub.json"), "utf8"), "{broken");
      const outside = join(f.root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(f.dir, "escape"));
      assert.throws(
        () => f.store.writeJSON("escape/data.json", { secret: true }),
        /符号链接/,
      );
      assert.equal(readdirSync(outside).length, 0);
    } finally {
      f.clean();
    }
  },
);

test("adding new redacted entries never rewrites legacy encrypted transcript contents", () => {
  const f = setup();
  try {
    mkdirSync(join(f.dir, "transcripts"));
    const legacy = { text: "password=old-password", at: "2026-09-24" };
    writeFileSync(
      join(f.dir, "transcripts/lane.jsonl"),
      JSON.stringify(legacy) + "\n",
    );
    f.store.migrateLegacy();
    f.store.appendJSONL("transcripts/lane.jsonl", {
      text: "password=new-password",
    });
    const entries = f.store.readJSONL("transcripts/lane.jsonl");
    assert.deepEqual(entries[0], legacy);
    assert.ok(!entries[1].text.includes("new-password"));
  } finally {
    f.clean();
  }
});
