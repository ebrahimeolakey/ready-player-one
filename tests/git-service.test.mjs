import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, parseGitStatus } from "../desktop/services/git.mjs";
const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args], { env })).stdout.trim();
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "rpo-git-review-"));
  const bare = join(dir, "remote.git"),
    alice = join(dir, "alice"),
    bob = join(dir, "bob");
  await git(dir, "init", "--bare", "--initial-branch=main", bare);
  await git(dir, "clone", bare, alice);
  for (const [key, value] of [
    ["user.name", "RPO Test"],
    ["user.email", "rpo-test@example.invalid"],
    ["commit.gpgsign", "false"],
  ])
    await git(alice, "config", key, value);
  const service = new GitService({ env });
  await writeFile(join(alice, "tracked.txt"), "base\n");
  await writeFile(join(alice, "other.txt"), "other base\n");
  await writeFile(join(alice, ".gitignore"), ".env\n");
  await service.stage(alice, {
    paths: ["tracked.txt", "other.txt", ".gitignore"],
  });
  await service.commit(alice, { message: "Initial fixture" });
  await service.push(alice);
  await git(dir, "clone", bare, bob);
  for (const [key, value] of [
    ["user.name", "RPO Other"],
    ["user.email", "rpo-other@example.invalid"],
    ["commit.gpgsign", "false"],
  ])
    await git(bob, "config", key, value);
  return { dir, bare, alice, bob, service };
}

test("real clones stage only selected files, commit only index, fetch/pull/push current branch", async () => {
  const { alice, bob, bare, service } = await setup();
  await writeFile(join(alice, "tracked.txt"), "new tracked\n");
  await writeFile(join(alice, "other.txt"), "uncommitted\n");
  await writeFile(join(alice, ".env"), "DO_NOT_STAGE_TEST\n");
  const status = await service.status(alice);
  assert.equal(status.files.length, 2);
  assert.equal(
    status.files.some((f) => f.path === ".env"),
    false,
  );
  assert.match(
    (await service.diff(alice, { path: "tracked.txt" })).text,
    /new tracked/,
  );
  await service.stage(alice, { paths: ["tracked.txt"] });
  assert.match(
    (await service.diff(alice, { path: "tracked.txt", staged: true })).text,
    /new tracked/,
  );
  await service.commit(alice, { message: "Only tracked change" });
  assert.equal(await git(alice, "show", "HEAD:other.txt"), "other base");
  assert.equal(
    await readFile(join(alice, "other.txt"), "utf8"),
    "uncommitted\n",
  );
  await service.push(alice);
  await service.fetch(bob);
  await service.pull(bob, { branch: "main" });
  assert.equal(
    await readFile(join(bob, "tracked.txt"), "utf8"),
    "new tracked\n",
  );
  assert.equal(
    await git(bare, "rev-parse", "refs/heads/main"),
    await git(alice, "rev-parse", "HEAD"),
  );
  await assert.rejects(() => service.pull(alice, { branch: "main" }), /未提交/);
  assert.equal(
    await readFile(join(alice, "other.txt"), "utf8"),
    "uncommitted\n",
  );
});

test("unstage preserves working contents including unborn index and renames", async () => {
  const { dir, alice, service } = await setup();
  await writeFile(join(alice, "tracked.txt"), "keep these changes\n");
  await service.stage(alice, { paths: ["tracked.txt"] });
  await service.unstage(alice, { paths: ["tracked.txt"] });
  assert.equal((await service.status(alice)).files[0].staged, false);
  assert.equal(
    await readFile(join(alice, "tracked.txt"), "utf8"),
    "keep these changes\n",
  );
  const unborn = join(dir, "unborn");
  await mkdir(unborn);
  await git(unborn, "init", "--initial-branch=main");
  await writeFile(join(unborn, "new.txt"), "first");
  await service.stage(unborn, { paths: ["new.txt"] });
  await service.unstage(unborn, { paths: ["new.txt"] });
  assert.equal((await service.status(unborn)).files[0].untracked, true);
  assert.equal(await readFile(join(unborn, "new.txt"), "utf8"), "first");
  await git(alice, "restore", "--", "tracked.txt");
  await git(alice, "mv", "other.txt", "renamed.txt");
  const file = (await service.status(alice)).files.find(
    (f) => f.path === "renamed.txt",
  );
  assert.equal(file.originalPath, "other.txt");
  await service.unstage(alice, { paths: ["renamed.txt"] });
  assert.equal(
    await readFile(join(alice, "renamed.txt"), "utf8"),
    "other base\n",
  );
});

test("branch mutations preserve dirty work, validate names and never change original root", async () => {
  const { alice, service } = await setup();
  await service.createBranch(alice, { name: "feature/review" });
  assert.equal((await service.status(alice)).branch, "feature/review");
  await service.switchBranch(alice, { name: "main" });
  assert.equal((await service.status(alice)).branch, "main");
  await writeFile(join(alice, "tracked.txt"), "dirty");
  await assert.rejects(
    () => service.switchBranch(alice, { name: "feature/review" }),
    /未提交/,
  );
  assert.equal(await readFile(join(alice, "tracked.txt"), "utf8"), "dirty");
  await git(alice, "restore", "--", "tracked.txt");
  await assert.rejects(() => service.createBranch(alice, { name: "--orphan" }));
  await assert.rejects(() => service.switchBranch(alice, { name: "@{-1}" }));
  assert.equal((await service.status(alice)).branch, "main");
});

test("diverged pull and non-fast-forward push fail without discarding commits", async () => {
  const { alice, bob, service } = await setup();
  await writeFile(join(alice, "tracked.txt"), "alice");
  await service.stage(alice, { paths: ["tracked.txt"] });
  await service.commit(alice, { message: "Alice" });
  await service.push(alice);
  await writeFile(join(bob, "tracked.txt"), "bob");
  await service.stage(bob, { paths: ["tracked.txt"] });
  await service.commit(bob, { message: "Bob" });
  const before = await git(bob, "rev-parse", "HEAD");
  await assert.rejects(() => service.pull(bob, { branch: "main" }));
  await assert.rejects(() => service.push(bob));
  assert.equal(await git(bob, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(bob, "tracked.txt"), "utf8"), "bob");
});

test("conflicts are exposed, unresolved commit denied, resolved staged merge can complete", async () => {
  const { alice, bob, service } = await setup();
  await writeFile(join(alice, "tracked.txt"), "alice\n");
  await service.stage(alice, { paths: ["tracked.txt"] });
  await service.commit(alice, { message: "Alice" });
  await service.push(alice);
  await writeFile(join(bob, "tracked.txt"), "bob\n");
  await service.stage(bob, { paths: ["tracked.txt"] });
  await service.commit(bob, { message: "Bob" });
  await service.fetch(bob);
  await assert.rejects(() => git(bob, "merge", "origin/main"));
  const state = await service.status(bob);
  assert.deepEqual(state.conflicts, ["tracked.txt"]);
  await assert.rejects(
    () => service.commit(bob, { message: "Not resolved" }),
    /冲突/,
  );
  await writeFile(join(bob, "tracked.txt"), "resolved\n");
  await service.stage(bob, { paths: ["tracked.txt"] });
  await service.commit(bob, { message: "Resolved merge" });
  assert.equal((await service.status(bob)).operation, null);
  assert.equal(
    (await git(bob, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")
      .length,
    3,
  );
});

test("busy provider prevents all mutations but allows read-only review; pathspec injection is literal", async () => {
  const { alice, service } = await setup();
  await writeFile(join(alice, ":(glob)*"), "literal filename");
  await writeFile(join(alice, "keep.txt"), "not selected");
  await service.stage(alice, { paths: [":(glob)*"] });
  const status = await service.status(alice);
  assert.equal(status.files.find((f) => f.path === "keep.txt").staged, false);
  const busy = new GitService({ env, isBusy: () => true });
  assert.ok(await busy.status(alice));
  await assert.rejects(
    () => busy.stage(alice, { paths: ["keep.txt"] }),
    /Agent/,
  );
  await assert.rejects(
    () => busy.commit(alice, { message: "blocked" }),
    /Agent/,
  );
  await assert.rejects(
    () => service.stage(alice, { paths: ["../outside.txt"] }),
    /仓库外/,
  );
  await assert.rejects(
    () => service.stage(alice, { paths: [".git/config"] }),
    /内部/,
  );
  await assert.rejects(
    () => service.stage(alice, { paths: ["*"] }),
    /状态已变化/,
  );
  const sub = join(alice, "sub");
  await mkdir(sub);
  await assert.rejects(() => service.status(sub), /根目录/);
});

test("NUL status parsing preserves spaces and newline names; untracked symlink does not read external target", async () => {
  assert.deepEqual(
    parseGitStatus("R  new name\0old name\0?? new\nfile\0").map((f) => [
      f.path,
      f.originalPath,
    ]),
    [
      ["new name", "old name"],
      ["new\nfile", undefined],
    ],
  );
  const { dir, alice, service } = await setup();
  const outside = join(dir, "outside-test.txt");
  await writeFile(outside, "do not preview external contents");
  await symlink(outside, join(alice, "external-link"));
  const diff = await service.diff(alice, { path: "external-link" });
  assert.equal(diff.text.includes("do not preview external contents"), false);
});
