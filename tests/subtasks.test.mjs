import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSubtask, captureCandidate, reviewCandidate, checkCandidate, integrateCandidate, subtaskState } from "../core/subtasks.mjs";
const exec = promisify(execFile);
const git = async (root, args) => (await exec("git", args, { cwd: root })).stdout.trim();
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "rpo-subtasks-test-")), root = join(dir, "parent"); await mkdir(root);
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Test"]); await git(root, ["config", "user.email", "test@local"]);
  await writeFile(join(root, "value.txt"), "base\n"); await writeFile(join(root, "stable.txt"), "stable\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, base, dir };
}
const checks = [{ id: "validate", command: process.execPath, args: ["-e", "const f=require('node:fs'); if(!f.readFileSync('stable.txt','utf8').includes('stable')) process.exit(1)"] }];
test("subtask starts from exact snapshot, checks real candidate and integrates once while parent continues", async t => {
  const { root, base } = await setup(t);
  const task = await createSubtask(root, { id: "one", baseCommit: base, requiredChecks: checks });
  assert.equal(await git(task.worktree, ["rev-parse", "HEAD"]), base);
  await writeFile(join(task.worktree, "value.txt"), "child result\n");
  await writeFile(join(root, "parent.txt"), "parent continues\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "parent advances"]);
  const parentHead = await git(root, ["rev-parse", "HEAD"]);
  const candidate = await captureCandidate(root, { id: "one" });
  assert.equal(await git(root, ["rev-parse", "HEAD"]), parentHead);
  assert.match((await reviewCandidate(root, { id: "one" })).diff, /child result/);
  await assert.rejects(integrateCandidate(root, { id: "one", candidateCommit: candidate.candidateCommit, expectedParentCommit: parentHead }), /未通过/);
  const checked = await checkCandidate(root, { id: "one", candidateCommit: candidate.candidateCommit });
  assert.equal(checked.checks[0].exitCode, 0);
  const results = await Promise.all([integrateCandidate(root, { id: "one", candidateCommit: candidate.candidateCommit, expectedParentCommit: parentHead }), integrateCandidate(root, { id: "one", candidateCommit: candidate.candidateCommit, expectedParentCommit: parentHead })]);
  assert.equal(results.filter(r => r.alreadyIntegrated === false).length, 1);
  assert.equal(results.filter(r => r.alreadyIntegrated === true).length, 1);
  assert.equal(await readFile(join(root, "value.txt"), "utf8"), "child result\n");
  assert.equal(await readFile(join(root, "parent.txt"), "utf8"), "parent continues\n");
  assert.ok(results[0].integrationChecks.every(c => c.passed && c.commit === results[0].integrationCommit));
});
test("real required-check failure and merge conflicts leave parent commit, index and files unchanged", async t => {
  const { root, base } = await setup(t);
  const task = await createSubtask(root, { id: "failure", baseCommit: base, requiredChecks: [{ id: "reject", command: process.execPath, args: ["-e", "process.stderr.write('invalid');process.exit(9)"] }] });
  await writeFile(join(task.worktree, "value.txt"), "failed child\n");
  const candidate = await captureCandidate(root, { id: "failure" });
  const failed = await checkCandidate(root, { id: "failure" });
  assert.equal(failed.status, "failed"); assert.equal(failed.checks[0].exitCode, 9);
  await assert.rejects(integrateCandidate(root, { id: "failure", candidateCommit: candidate.candidateCommit, expectedParentCommit: base }), /未通过/);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), base); assert.equal(await git(root, ["status", "--porcelain"]), "");
  const conflictTask = await createSubtask(root, { id: "conflict", baseCommit: base, requiredChecks: checks });
  await writeFile(join(conflictTask.worktree, "value.txt"), "child value\n"); const c = await captureCandidate(root, { id: "conflict" }); await checkCandidate(root, { id: "conflict" });
  await writeFile(join(root, "value.txt"), "parent value\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "parent changes same line"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const conflict = await integrateCandidate(root, { id: "conflict", candidateCommit: c.candidateCommit, expectedParentCommit: head });
  assert.equal(conflict.status, "conflict"); assert.equal(await git(root, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(root, ["status", "--porcelain"]), ""); assert.equal(await readFile(join(root, "value.txt"), "utf8"), "parent value\n");
});
test("checks rerun on merged code and reject integration when individually valid changes fail together", async t => {
  const { root, base } = await setup(t);
  const task = await createSubtask(root, { id: "interaction", baseCommit: base, requiredChecks: [{ id: "interaction-check", command: process.execPath, args: ["-e", "const f=require('node:fs');if(f.existsSync('parent.txt')&&f.existsSync('child.txt'))process.exit(3)"] }] });
  await writeFile(join(task.worktree, "child.txt"), "new child"); const candidate = await captureCandidate(root, { id: "interaction" });
  assert.equal((await checkCandidate(root, { id: "interaction" })).status, "checked");
  await writeFile(join(root, "parent.txt"), "new parent"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "parent new"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const result = await integrateCandidate(root, { id: "interaction", candidateCommit: candidate.candidateCommit, expectedParentCommit: head });
  assert.equal(result.status, "failed"); assert.equal(result.checks[0].exitCode, 3);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), head); assert.equal(await git(root, ["status", "--porcelain"]), "");
});
test("stale candidate, stale parent and dirty parent cannot overwrite current work", async t => {
  const { root, base } = await setup(t), task = await createSubtask(root, { id: "stale", baseCommit: base, requiredChecks: checks });
  await writeFile(join(task.worktree, "value.txt"), "first"); const first = await captureCandidate(root, { id: "stale" }); await checkCandidate(root, { id: "stale" });
  await writeFile(join(task.worktree, "value.txt"), "second"); const second = await captureCandidate(root, { id: "stale" });
  await assert.rejects(integrateCandidate(root, { id: "stale", candidateCommit: first.candidateCommit, expectedParentCommit: base }), /未通过/);
  await checkCandidate(root, { id: "stale" });
  await writeFile(join(root, "uncommitted.txt"), "keep me");
  await assert.rejects(integrateCandidate(root, { id: "stale", candidateCommit: second.candidateCommit, expectedParentCommit: base }), /未提交/);
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "save"]);
  assert.equal((await integrateCandidate(root, { id: "stale", candidateCommit: second.candidateCommit, expectedParentCommit: base })).status, "stale");
  assert.equal(await readFile(join(root, "uncommitted.txt"), "utf8"), "keep me");
});
test("commands only come from explicit creation config; checks that alter candidate fail", async t => {
  const { root, base } = await setup(t);
  await assert.rejects(createSubtask(root, { id: "bad", baseCommit: base, requiredChecks: [] }), /明确配置/);
  await assert.rejects(createSubtask(root, { id: "../bad", baseCommit: base, requiredChecks: checks }), /ID/);
  const task = await createSubtask(root, { id: "mutation", baseCommit: base, requiredChecks: [{ id: "mutates", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('value.txt','tampered')"] }] });
  await writeFile(join(task.worktree, "value.txt"), "new"); await captureCandidate(root, { id: "mutation" });
  const result = await checkCandidate(root, { id: "mutation", requiredChecks: checks });
  assert.equal(result.status, "failed"); assert.match(result.checks[0].output, /修改了候选/);
  assert.equal((await subtaskState(root, "mutation")).requiredChecks[0].id, "mutates");
});

test('integration fences exact parent branch even at same commit and rechecks after approval/checks',async t=>{
 const {root,base}=await setup(t),task=await createSubtask(root,{id:'branch-fence',baseCommit:base,requiredChecks:checks});
 await writeFile(join(task.worktree,'child.txt'),'checked child\n');const candidate=await captureCandidate(root,{id:task.id});await checkCandidate(root,{id:task.id,candidateCommit:candidate.candidateCommit});
 const args={id:task.id,candidateCommit:candidate.candidateCommit,expectedParentCommit:base};
 for(const branch of ['ordinary','rpo/other']){
  await git(root,['switch','-c',branch]);await writeFile(join(root,'dirty.txt'),'staged');await git(root,['add','dirty.txt']);await writeFile(join(root,'dirty.txt'),'unstaged');
  const before=[await git(root,['show-ref']),await git(root,['diff','--cached']),await git(root,['diff'])];
  await assert.rejects(integrateCandidate(root,args),e=>e.code==='RPO_SYNC_BRANCH_MISMATCH'&&e.expectedBranch==='main');
  assert.deepEqual([await git(root,['show-ref']),await git(root,['diff','--cached']),await git(root,['diff'])],before);
  await git(root,['restore','--staged','dirty.txt']);await rm(join(root,'dirty.txt'));await git(root,['switch','main']);
 }
 await assert.rejects(integrateCandidate(root,{...args,beforeApply:()=>git(root,['switch','-c','rpo/mid-check'])}),{code:'RPO_SYNC_BRANCH_MISMATCH'});
 assert.equal(await git(root,['rev-parse','HEAD']),base);await assert.rejects(git(root,['show-ref','--verify',`refs/rpo/subtask-integrations/${task.id}`]));
 await git(root,['switch','main']);assert.equal((await integrateCandidate(root,args)).status,'integrated');
});
