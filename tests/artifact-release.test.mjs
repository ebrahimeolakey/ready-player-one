import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ArtifactReleaseService } from "../desktop/services/artifact-release.mjs";
import {
  filePayload,
  validateFile,
  storedBytes,
  MAX_ARTIFACT_BYTES,
} from "../core/artifact-files.mjs";
const sha = (b) =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
function fixture() {
  let saved,
    scope = "team:DRI",
    approved = true,
    account = 1,
    remote = null,
    fail = false,
    privateRepo = true;
  const calls = [];
  const bytes = Buffer.from("approved bytes, not local dirty files"),
    hash = createHash("sha256").update(bytes).digest("hex");
  const source = {
    version: {
      id: "v1",
      number: 1,
      hash,
      content: bytes.toString(),
      approval: { by: "DRI", hash, at: "now" },
    },
    project: { repository: "team/repo", branch: "main" },
    path: "docs/result.md",
  };
  const service = new ArtifactReleaseService({
    store: () => ({
      recoverFile() {},
      exists: () => !!saved,
      readJSON: () => structuredClone(saved),
      writeJSON: (_, v) => {
        saved = structuredClone(v);
      },
    }),
    scope: () => scope,
    resolve: async () => {
      if (!approved) throw Error("审批已撤销");
      return structuredClone(source);
    },
    run: async () => ({ stdout: "synthetic-token" }),
    request: async (path, options) => {
      calls.push({ path, ...options });
      if (path === "user") return { id: account, login: "dri" };
      if (path === "repos/team/repo")
        return {
          id: 99,
          full_name: "team/repo",
          private: privateRepo,
          permissions: { push: true },
        };
      if (path.includes("/branches/")) return { name: "main" };
      if (options.body) {
        assert.equal(saved.operations.at(-1).status, "dispatching");
        if (fail) throw Error("connection lost");
        remote = {
          type: "file",
          sha: sha(Buffer.from(options.body.content, "base64")),
        };
        return { content: remote, commit: { sha: "a".repeat(40) } };
      }
      if (path.includes("/contents/")) {
        if (!remote) throw Object.assign(Error("missing"), { status: 404 });
        return remote;
      }
      throw Error("unexpected " + path);
    },
  });
  return {
    service,
    source,
    calls,
    bytes,
    setScope: (v) => (scope = v),
    setApproved: (v) => (approved = v),
    setAccount: (v) => (account = v),
    setRemote: (v) => (remote = v),
    setFail: (v) => (fail = v),
    setPrivate: (v) => (privateRepo = v),
    restore: () => {
      const copy = new ArtifactReleaseService({
        store: service.store,
        scope: service.scope,
        resolve: service.resolve,
        run: service.run,
        request: service.request,
      });
      return copy;
    },
  };
}
test("publication uses only approved immutable bytes, no write before confirmation, durable receipts prevent duplicate sends", async () => {
  const f = fixture(),
    r = await f.service.preview({ versionId: "v1" });
  assert.equal(
    f.calls.some((c) => c.body),
    false,
  );
  assert.equal(r.status, "prepared");
  const done = await f.service.publish({ id: r.id });
  assert.equal(done.status, "published");
  assert.deepEqual(
    Buffer.from(f.calls.find((c) => c.body).body.content, "base64"),
    f.bytes,
  );
  await f.restore().publish({ id: r.id });
  assert.equal(f.calls.filter((c) => c.body).length, 1);
});
test("changed GitHub file, account, visibility, approval or collaboration scope fences publishing", async () => {
  for (const change of [
    "remote",
    "account",
    "visibility",
    "approval",
    "scope",
  ]) {
    const f = fixture(),
      r = await f.service.preview({ versionId: "v1" });
    if (change === "remote") f.setRemote({ type: "file", sha: "changed" });
    if (change === "account") f.setAccount(2);
    if (change === "visibility") f.setPrivate(false);
    if (change === "approval") f.setApproved(false);
    if (change === "scope") f.setScope("other");
    await assert.rejects(f.service.publish({ id: r.id }));
    assert.equal(
      f.calls.some((c) => c.body),
      false,
    );
  }
});
test("uncertain dispatch is never resent, even after restart; lookup checks the approved blob", async () => {
  const f = fixture(),
    r = await f.service.preview({ versionId: "v1" });
  f.setFail(true);
  assert.equal((await f.service.publish({ id: r.id })).status, "unknown");
  await f.restore().publish({ id: r.id });
  assert.equal(f.calls.filter((c) => c.body).length, 1);
  await assert.rejects(f.service.preview({ versionId: "v1" }), /待核实/);
  f.setRemote({ type: "file", sha: sha(f.bytes) });
  assert.equal((await f.service.lookup({ id: r.id })).status, "verified");
});
test("binary payloads preserve bytes, reject corruption, traversal is validated elsewhere; text stays secret-filtered", () => {
  const text = Buffer.from("\ufeff预算,金额\r\n场地,12000\r\n");
  const csv = validateFile(filePayload(text, "budget.csv"), "budget.csv");
  assert.deepEqual(storedBytes(csv, csv), text);
  const bytes = Buffer.from([0, 255, 1, 3]);
  const file = validateFile(filePayload(bytes, "a.xlsx"), "a.xlsx");
  assert.deepEqual(storedBytes(file, file), bytes);
  assert.throws(
    () => validateFile({ content: "%%%bad", encoding: "base64" }, "a.pdf"),
    /编码/,
  );
  assert.throws(
    () => filePayload(Buffer.alloc(MAX_ARTIFACT_BYTES + 1), "a.zip"),
    /8 MB/,
  );
  assert.throws(
    () => validateFile({ content: "password=secret" }, "a.txt"),
    /凭据/,
  );
  assert.throws(() => storedBytes({ ...file, content: "YWJj" }, file), /校验/);
});
