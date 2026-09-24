import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as local from "../core/local.mjs";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-local-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("file access blocks traversal, symlink escapes and Git internals", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "hello.txt"), "你好");
  await symlink("/etc", join(root, "outside"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "private");
  assert.equal((await local.read(root, "hello.txt")).content, "你好");
  await assert.rejects(local.read(root, "../secrets"), /超出/);
  await assert.rejects(local.read(root, "outside/hosts"), /之外/);
  await assert.rejects(local.read(root, ".git/config"), /内部/);
  assert.equal(
    (await local.files(root)).some((f) => f.name === "outside"),
    false,
  );
});
test("save detects external writes and preserves the other version", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "a.txt"), "版本一");
  const f = await local.read(root, "a.txt");
  await writeFile(join(root, "a.txt"), "其他程序写入");
  await assert.rejects(
    local.save(root, "a.txt", "本机编辑", f.hash),
    /其他程序修改/,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "其他程序写入");
  const fresh = await local.read(root, "a.txt");
  await local.save(root, "a.txt", "合并后", fresh.hash);
  assert.equal((await local.read(root, "a.txt")).content, "合并后");
});
test("worktrees isolate changes and Git diff includes staged and unstaged changes", async (t) => {
  const dir = await fixture(t),
    root = join(dir, "repo");
  await mkdir(root);
  await local.git(root, ["init", "-b", "main"]);
  await local.git(root, ["config", "user.name", "RPO Test"]);
  await local.git(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "a.txt"), "before\n");
  await local.git(root, ["add", "."]);
  await local.git(root, ["commit", "-m", "initial"]);
  const wt = await local.worktree(root, "test-session-123", join(dir, "data"));
  await writeFile(join(wt, "a.txt"), "after\n");
  await local.git(wt, ["add", "a.txt"]);
  const c = await local.changes(wt);
  assert.match(c.diff, /\+after/);
  assert.equal(c.branch, "rpo/test-ses");
  assert.equal((await local.read(root, "a.txt")).content, "before\n");
  assert.equal(c.files[0].path, "a.txt");
});
test("provider adapters use explicit bounded modes and normalize real CLI event shapes", () => {
  for (const p of ["codex", "claude"])
    for (const mode of ["read-only", "workspace-write"]) {
      const args = local.providerCommand(p, mode).join(" ");
      assert.doesNotMatch(args, /bypass|danger-full-access|skip-permissions/);
    }
  assert.deepEqual(
    local.normalizeEvent("codex", {
      type: "item.completed",
      item: { type: "agent_message", text: "你好" },
    }),
    { role: "assistant", text: "你好" },
  );
  assert.deepEqual(
    local.normalizeEvent("claude", {
      type: "assistant",
      message: { content: [{ type: "text", text: "已完成" }] },
    }),
    { role: "assistant", text: "已完成" },
  );
  assert.equal(local.normalizeEvent("codex", { type: "thread.started" }), null);
});
