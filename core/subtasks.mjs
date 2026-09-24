import { currentSessionBranch, assertExpectedBranch } from "./snapshots.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, open, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { platformEnv } from "./platform.mjs";
const exec = promisify(execFile);
const identity = { GIT_AUTHOR_NAME: "Ready Player One", GIT_AUTHOR_EMAIL: "subtasks@ready-player-one.local", GIT_COMMITTER_NAME: "Ready Player One", GIT_COMMITTER_EMAIL: "subtasks@ready-player-one.local" };
const idValue = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error("无效子任务 ID");
  return value;
};
const hashValue = value => {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw Error("请指定完整快照 commit");
  return value;
};
async function git(root, args, options = {}) {
  return (await exec("git", ["-c", "core.hooksPath=", ...args], { cwd: root, timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...platformEnv(), ...identity, GIT_TERMINAL_PROMPT: "0", ...options.env } })).stdout.trim();
}
async function location(root, id) {
  root = await realpath(root);
  const common = resolve(root, await git(root, ["rev-parse", "--git-common-dir"]));
  const store = join(common, "rpo-subtasks"); await mkdir(store, { recursive: true, mode: 0o700 });
  return { root, store, file: join(store, `${idValue(id)}.json`), lock: join(store, `parent-${createHash("sha256").update(root).digest("hex").slice(0, 24)}.lock`) };
}
async function exclusive(place, fn) {
  let handle;
  for (let attempt = 0; attempt < 600; attempt++) {
    try { handle = await open(place.lock, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A crashed process cannot retain the local integration lock forever.
      try {
        const pid = Number(await readFile(place.lock, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") await rm(place.lock, { force: true }); }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!handle) throw Error("另一个子任务正在检查或集成，请稍后重试");
  await handle.writeFile(String(process.pid));
  try { return await fn(); } finally { await handle.close(); await rm(place.lock, { force: true }); }
}
async function save(place, state) {
  await writeFile(place.file + ".tmp", JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(place.file + ".tmp", place.file);
}
async function load(place) {
  const state = JSON.parse(await readFile(place.file, "utf8"));
  if (state.parentRoot !== place.root) throw Error("此子任务不属于当前父工作树");
  return state;
}
function checksConfig(checks) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 20) throw Error("必须明确配置至少一项本机检查");
  const seen = new Set();
  return checks.map(check => {
    const id = idValue(check.id);
    if (seen.has(id)) throw Error("检查 ID 重复"); seen.add(id);
    if (typeof check.command !== "string" || !check.command || check.command.length > 2000 || !Array.isArray(check.args) || check.args.some(a => typeof a !== "string" || a.length > 10000) || check.args.length > 100) throw Error("检查命令需要明确的 command 和 args，不能从候选结果推断");
    const timeoutMs = check.timeoutMs ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw Error("检查超时时间无效");
    return { id, command: check.command, args: [...check.args], timeoutMs };
  });
}
async function clean(root) {
  if (await git(root, ["status", "--porcelain", "--untracked-files=all"])) throw Error("父工作树存在未提交修改，请先保存为确认快照");
}
export async function createSubtask(parentRoot, { id, baseCommit, requiredChecks }) {
  const place = await location(parentRoot, id), commit = hashValue(baseCommit), checks = checksConfig(requiredChecks);
  return exclusive(place, async () => {
    try { await readFile(place.file); throw Error("子任务已经存在"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (await git(place.root, ["rev-parse", `${commit}^{commit}`]) !== commit) throw Error("快照不是有效 commit");
    const parentBranch = await currentSessionBranch(place.root);
    await assertExpectedBranch(place.root, parentBranch);
    const worktree = join(dirname(place.root), ".rpo-subtasks", idValue(id));
    await mkdir(dirname(worktree), { recursive: true });
    const branch = `rpo/subtask/${idValue(id)}`;
    await git(place.root, ["worktree", "add", "-b", branch, worktree, commit]);
    const state = { id, parentRoot: place.root, parentBranch, worktree, branch, baseCommit: commit, requiredChecks: checks, status: "working", at: new Date().toISOString() };
    await save(place, state); return state;
  });
}
export async function subtaskState(parentRoot, id) { return load(await location(parentRoot, id)); }
export async function captureCandidate(parentRoot, { id }) {
  const place = await location(parentRoot, id);
  return exclusive(place, async () => {
    const state = await load(place);
    if (state.status === "integrated") throw Error("子任务已经集成");
    if (await git(state.worktree, ["symbolic-ref", "--short", "HEAD"]) !== state.branch) throw Error("子任务分支已改变");
    if (await git(state.worktree, ["ls-files", "--unmerged"])) throw Error("子任务尚有未解决冲突");
    const temp = await mkdtemp(join(tmpdir(), "rpo-candidate-"));
    try {
      const head = await git(state.worktree, ["rev-parse", "HEAD"]);
      await git(state.worktree, ["merge-base", "--is-ancestor", state.baseCommit, head]);
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(state.worktree, ["read-tree", head], { env });
      await git(state.worktree, ["add", "-A", "--", "."], { env });
      const tree = await git(state.worktree, ["write-tree"], { env });
      const commit = tree === await git(state.worktree, ["rev-parse", `${head}^{tree}`]) ? head : await git(state.worktree, ["commit-tree", tree, "-p", head, "-m", `RPO subtask ${id} candidate`]);
      await assertExpectedBranch(state.worktree, state.branch);
      await git(state.worktree, ["update-ref", `refs/heads/${state.branch}`, commit, head]);
      await assertExpectedBranch(state.worktree, state.branch);
      await git(state.worktree, ["read-tree", commit]);
      state.candidateCommit = commit; state.status = "candidate"; delete state.checkedCandidate; delete state.checks;
      await save(place, state);
      return { ...state, diff: await git(place.root, ["diff", "--no-ext-diff", "--no-textconv", state.baseCommit, commit, "--"]) };
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}
export async function reviewCandidate(parentRoot, { id }) {
  const place = await location(parentRoot, id), state = await load(place);
  if (!state.candidateCommit) throw Error("子任务还没有候选结果");
  return { ...state, diff: await git(place.root, ["diff", "--no-ext-diff", "--no-textconv", state.baseCommit, state.candidateCommit, "--"]), files: (await git(place.root, ["diff", "--name-only", "-z", state.baseCommit, state.candidateCommit, "--"])).split("\0").filter(Boolean) };
}
async function runChecks(root, state, commit) {
  const temporary = await mkdtemp(join(tmpdir(), "rpo-checks-")), worktree = join(temporary, "worktree"), results = [];
  await git(root, ["worktree", "add", "--detach", worktree, commit]);
  try {
    for (const check of state.requiredChecks) {
      const startedAt = new Date().toISOString();
      let output = "", exitCode = 0, passed = false;
      try {
        const result = await exec(check.command, check.args, { cwd: worktree, timeout: check.timeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...platformEnv(), RPO_CHECK_COMMIT: commit, RPO_SUBTASK_ID: state.id }, windowsHide: true });
        output = result.stdout + result.stderr; passed = true;
      } catch (error) { output = String(error.stdout || "") + String(error.stderr || "") + "\n" + error.message; exitCode = typeof error.code === "number" ? error.code : -1; }
      // Checks may build ignored files, but cannot alter tracked results or create new tracked content.
      if (passed && (await git(worktree, ["rev-parse", "HEAD"]) !== commit || await git(worktree, ["status", "--porcelain", "--untracked-files=all"]))) { passed = false; exitCode = -1; output += "\n检查修改了候选文件，不能证明原始候选通过。"; }
      results.push({ id: check.id, commit, passed, exitCode, output: output.slice(-30000), startedAt, finishedAt: new Date().toISOString() });
      if (!passed) break;
    }
    return results;
  } finally {
    await git(root, ["worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
function passed(state, checks) { return state.requiredChecks.every(check => checks.some(result => result.id === check.id && result.passed && result.exitCode === 0)); }
export async function checkCandidate(parentRoot, { id, candidateCommit }) {
  const place = await location(parentRoot, id);
  return exclusive(place, async () => {
    const state = await load(place);
    if (!state.candidateCommit || (candidateCommit && candidateCommit !== state.candidateCommit)) throw Error("候选已经改变，请重新审阅");
    if (state.status === "integrated") return state;
    state.checks = await runChecks(place.root, state, state.candidateCommit);
    state.checkedCandidate = passed(state, state.checks) ? state.candidateCommit : null;
    state.status = state.checkedCandidate ? "checked" : "failed";
    await save(place, state); return state;
  });
}
export async function integrateCandidate(parentRoot, { id, candidateCommit, expectedParentCommit, beforeApply }) {
  const place = await location(parentRoot, id);
  return exclusive(place, async () => {
    const state = await load(place);
    await assertExpectedBranch(place.root, state.parentBranch);
    if (state.status === "integrated") return { ...state, alreadyIntegrated: true };
    if (!candidateCommit || candidateCommit !== state.candidateCommit || candidateCommit !== state.checkedCandidate || !passed(state, state.checks || [])) throw Error("候选未通过必需检查或已改变");
    const receipt = `refs/rpo/subtask-integrations/${idValue(id)}`;
    let previous;
    try { previous = await git(place.root, ["rev-parse", "--verify", receipt]); } catch {}
    if (previous) {
      try {
        await git(place.root, ["merge-base", "--is-ancestor", previous, "HEAD"]);
        Object.assign(state, { status: "integrated", integrationCommit: previous, integrationChecks: state.pendingIntegration?.checks || [] }); await save(place, state);
        return { ...state, alreadyIntegrated: true };
      } catch {}
    }
    await assertExpectedBranch(place.root, state.parentBranch);
    await clean(place.root);
    const parentCommit = await git(place.root, ["rev-parse", "HEAD"]);
    if (hashValue(expectedParentCommit) !== parentCommit) return { status: "stale", parentCommit };
    // Keep the user's checkout untouched while constructing and checking the merged tree.
    let mergeOutput;
    try { mergeOutput = await git(place.root, ["merge-tree", "--write-tree", parentCommit, candidateCommit]); }
    catch (error) { if (error.code === 1) return { status: "conflict", parentCommit, candidateCommit, details: String(error.stdout || error.message).slice(0, 30000) }; throw error; }
    const tree = mergeOutput.split("\n")[0];
    const integrationCommit = await git(place.root, ["commit-tree", tree, "-p", parentCommit, "-p", candidateCommit, "-m", `Integrate RPO subtask ${id}`]);
    const checks = await runChecks(place.root, state, integrationCommit);
    if (!passed(state, checks)) return { status: "failed", parentCommit, candidateCommit, checks };
    if (beforeApply) await beforeApply();
    await assertExpectedBranch(place.root, state.parentBranch);
    await clean(place.root);
    if (await git(place.root, ["rev-parse", "HEAD"]) !== parentCommit) return { status: "stale", parentCommit: await git(place.root, ["rev-parse", "HEAD"]) };
    // A durable ref and checked record let retry recover after an interrupted state-file write.
    state.pendingIntegration = { commit: integrationCommit, checks };
    await save(place, state);
    await git(place.root, ["update-ref", receipt, integrationCommit, previous || "0".repeat(parentCommit.length)]);
    // ff-only is a final compare-and-swap guard against concurrent parent commits.
    await git(place.root, ["merge", "--ff-only", "--no-edit", "--no-gpg-sign", integrationCommit]);
    Object.assign(state, { status: "integrated", integrationCommit, integrationChecks: checks, integratedAt: new Date().toISOString() });
    await save(place, state); return { ...state, alreadyIntegrated: false };
  });
}
// Read-only source checkpoint: child creation never moves the parent HEAD, index or files.
export async function checkpointSubtaskSource(root) {
  if (await git(root, ["ls-files", "--unmerged"])) throw Error("请先解决工作树冲突");
  const temp = await mkdtemp(join(tmpdir(), "rpo-parent-checkpoint-"));
  try {
    const head = await git(root, ["rev-parse", "HEAD"]), env = { GIT_INDEX_FILE: join(temp, "index") };
    await git(root, ["read-tree", head], { env }); await git(root, ["add", "-A", "--", "."], { env });
    const tree = await git(root, ["write-tree"], { env });
    if (tree === await git(root, ["rev-parse", `${head}^{tree}`])) return head;
    const commit = await git(root, ["commit-tree", tree, "-p", head, "-m", "RPO child-task checkpoint"]);
    return commit;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
