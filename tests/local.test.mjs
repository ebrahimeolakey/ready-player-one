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
test("project file search finds nested paths and excludes ignored and external trees", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "auth.ts"), "test");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "auth.ts"), "private dependency");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "auth"), "private git");
  await symlink("/etc", join(root, "external"));
  const rows = await local.searchFiles(root, "AUTH");
  assert.deepEqual(
    rows.map((r) => r.path),
    ["src/auth.ts"],
  );
  assert.deepEqual(await local.searchFiles(root, "external"), []);
  assert.deepEqual(await local.searchFiles(root, ""), []);
});

test('existing unbound worktree recovers its path without adopting current branch; foreign repository is rejected',async t=>{
 const {inspectSessionWorktree}=await import('../core/snapshots.mjs');
 const dir=await fixture(t),root=join(dir,'repo'),data=join(dir,'data');await mkdir(root);
 await local.git(root,['init','-b','main']);await local.git(root,['config','user.name','Test']);await local.git(root,['config','user.email','test@local']);
 await writeFile(join(root,'a.txt'),'base');await local.git(root,['add','.']);await local.git(root,['commit','-m','base']);
 const wt=await local.worktree(root,'recovery-session',data);const gitDir=(await local.git(wt,['rev-parse','--absolute-git-dir'])).trim();await rm(join(gitDir,'rpo-session-binding.json'));
 await local.git(wt,['switch','-c','ordinary']);await writeFile(join(wt,'a.txt'),'staged');await local.git(wt,['add','.']);await writeFile(join(wt,'a.txt'),'working');
 const before=[await local.git(wt,['diff']),await local.git(wt,['diff','--cached'])];
 assert.equal(await local.worktree(root,'recovery-session',data),wt);
 assert.equal((await inspectSessionWorktree(wt,{sessionId:'recovery-session'})).status,'unbound');
 assert.deepEqual([await local.git(wt,['diff']),await local.git(wt,['diff','--cached'])],before);
 const other=join(dir,'other');await local.git(dir,['clone',root,other]);const target=join(data,'worktrees','foreign-session');await local.git(other,['worktree','add','-b','rpo/foreign',target]);
 await assert.rejects(local.worktree(root,'foreign-session',data),/不属于当前项目仓库/);
});

test('editor save fences canonical opened root across a new worktree and project remap even when hashes match',async t=>{
 const dir=await fixture(t),root=join(dir,'repo'),remap=join(dir,'remap');await mkdir(root);await mkdir(remap);
 await local.git(root,['init','-b','main']);await local.git(root,['config','user.name','Test']);await local.git(root,['config','user.email','test@local']);
 await writeFile(join(root,'same.txt'),'identical\n');await writeFile(join(remap,'same.txt'),'identical\n');await local.git(root,['add','.']);await local.git(root,['commit','-m','base']);
 const opened=await local.readBound(root,'same.txt'),wt=await local.worktree(root,'editor-root-session',join(dir,'data'));
 for(const destination of [wt,remap]){
  assert.equal((await local.readBound(destination,'same.txt')).hash,opened.hash);
  await assert.rejects(local.saveBound(destination,'same.txt','old root draft',opened.hash,opened.canonicalRoot),/项目目录已改变/);
  assert.equal(await readFile(join(destination,'same.txt'),'utf8'),'identical\n');
 }
 await assert.rejects(local.saveBound(root,'same.txt','unguarded',opened.hash),/项目目录已改变/);
 assert.equal(await readFile(join(root,'same.txt'),'utf8'),'identical\n');
 const alias=join(dir,'alias');await symlink(root,alias);
 assert.equal((await local.readBound(alias,'same.txt')).canonicalRoot,opened.canonicalRoot);
 const saved=await local.saveBound(alias,'same.txt','old root draft',opened.hash,opened.canonicalRoot);
 assert.equal(saved.canonicalRoot,opened.canonicalRoot);assert.equal(await readFile(join(root,'same.txt'),'utf8'),'old root draft');
 assert.equal(await readFile(join(wt,'same.txt'),'utf8'),'identical\n');assert.equal(await readFile(join(remap,'same.txt'),'utf8'),'identical\n');
});
