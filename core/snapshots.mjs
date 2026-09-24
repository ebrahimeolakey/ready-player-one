import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { platformEnv } from './platform.mjs';
const exec = promisify(execFile);
const gates = new Map();
const token = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error('无效快照标识');
  return value;
};
export function snapshotRef(sessionId, ownerId) {
  return `refs/rpo/snapshots/${token(sessionId)}/${token(ownerId)}`;
}
export function validateSnapshot(snapshot, sessionId) {
  if (!snapshot || !new RegExp(`^refs/rpo/snapshots/${token(sessionId)}/[a-zA-Z0-9_-]{1,100}$`).test(snapshot.ref) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(snapshot.commit)) throw Error('无效远程快照');
  return snapshot;
}
async function git(root, args, options = {}) {
  const result = await exec('git', args, {cwd: root, timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: {...platformEnv(), GIT_TERMINAL_PROMPT: '0', ...options.env}});
  return result.stdout.trim();
}
async function exclusive(root, fn) {
  const prior = gates.get(root) || Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  gates.set(root, next);
  try { return await next; } finally { if (gates.get(root) === next) gates.delete(root); }
}
export async function currentSessionBranch(root) {
  try { const ref = await git(root, ['symbolic-ref', '--quiet', 'HEAD']); return ref.startsWith('refs/heads/') ? ref.slice(11) : null; }
  catch (error) { if (error.code === 1) return null; throw error; }
}
function branchError(code, expectedBranch, actualBranch) {
  return Object.assign(Error(expectedBranch ? `代码同步已暂停：预期分支 ${expectedBranch}，当前为 ${actualBranch || '分离 HEAD'}。请切回预期分支后重试。` : '代码同步已暂停：此工作树尚未绑定会话分支，请先审阅并确认绑定。'), { code, expectedBranch:expectedBranch || null, actualBranch });
}
export async function assertExpectedBranch(root, expectedBranch) {
  const actual = await currentSessionBranch(root);
  if (!expectedBranch) throw branchError('RPO_SYNC_BRANCH_UNBOUND', null, actual);
  if (actual !== expectedBranch) throw branchError('RPO_SYNC_BRANCH_MISMATCH', expectedBranch, actual);
  return actual;
}
async function worktreePlace(root) {
  root = await realpath(root);
  const [gitDir, commonDir] = await Promise.all([git(root, ['rev-parse', '--absolute-git-dir']), git(root, ['rev-parse', '--git-common-dir'])]);
  if (await realpath(resolve(root, commonDir)) === await realpath(gitDir)) throw Error('请先为会话创建独立工作树，再开启代码同步');
  return {root, file:join(gitDir, 'rpo-session-binding.json')};
}
async function readBinding(place, sessionId) {
  let value;
  try { value = JSON.parse(await readFile(place.file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('会话分支绑定损坏，请保留原文件并检查'); }
  if (value.version !== 1 || value.root !== place.root || typeof value.branch !== 'string' || !value.branch.startsWith('rpo/')) throw Error('会话分支绑定无效或工作树位置已改变');
  if (value.sessionId !== sessionId) throw Error('工作树已绑定另一会话');
  return value;
}
export async function inspectSessionWorktree(root, {sessionId}) {
  token(sessionId);
  const place = await worktreePlace(root), binding = await readBinding(place, sessionId), actualBranch = await currentSessionBranch(place.root);
  return {root:place.root,sessionId,actualBranch,binding,status:!binding?'unbound':binding.branch===actualBranch?'bound':'paused'};
}
export async function bindSessionWorktree(root, {sessionId, expectedBranch, replaceExpectedBranch}) {
  const place = await worktreePlace(root);token(sessionId);
  return exclusive(place.root, async () => {
    if (typeof expectedBranch !== 'string' || !expectedBranch.startsWith('rpo/')) throw Error('只能绑定明确的 rpo/ 会话分支');
    await git(place.root, ['check-ref-format', `refs/heads/${expectedBranch}`]);
    await assertExpectedBranch(place.root, expectedBranch);
    const previous = await readBinding(place, sessionId);
    if (previous?.branch === expectedBranch) return previous;
    if (previous && previous.branch !== replaceExpectedBranch) throw branchError('RPO_SYNC_BRANCH_MISMATCH', previous.branch, expectedBranch);
    if (await git(place.root, ['status', '--porcelain', '--untracked-files=all'])) throw Error('绑定前请先提交或保存当前工作区和暂存区修改');
    await assertExpectedBranch(place.root, expectedBranch);
    const binding = {version:1,sessionId,root:place.root,branch:expectedBranch};
    const temporary = place.file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(binding), {mode:0o600}); await rename(temporary, place.file); }
    finally { await rm(temporary, {force:true}); }
    return binding;
  });
}
export async function assertSessionWorktree(root, {sessionId, allowConflicts=false}) {
  const state = await inspectSessionWorktree(root, {sessionId});
  await assertExpectedBranch(state.root, state.binding?.branch);
  if (!allowConflicts && await git(state.root, ['ls-files', '--unmerged'])) throw Error('请先解决当前代码冲突');
  return state.binding.branch;
}
const identity = {GIT_AUTHOR_NAME: 'Ready Player One', GIT_AUTHOR_EMAIL: 'snapshot@ready-player-one.local', GIT_COMMITTER_NAME: 'Ready Player One', GIT_COMMITTER_EMAIL: 'snapshot@ready-player-one.local'};
async function checkpoint(root, sessionId) {
  const branch = await assertSessionWorktree(root, {sessionId});
  const head = await git(root, ['rev-parse', 'HEAD']);
  const temp = await mkdtemp(join(tmpdir(), 'rpo-snapshot-'));
  const env = {...identity, GIT_INDEX_FILE: join(temp, 'index')};
  try {
    await git(root, ['read-tree', head], {env});
    await git(root, ['add', '-A', '--', '.'], {env});
    const tree = await git(root, ['write-tree'], {env});
    if (tree === await git(root, ['rev-parse', `${head}^{tree}`])) return head;
    const commit = await git(root, ['commit-tree', tree, '-p', head, '-m', 'RPO session checkpoint'], {env});
    // Only the dedicated session branch moves; the user's main checkout is untouched.
    await assertSessionWorktree(root, {sessionId});
    await git(root, ['update-ref', `refs/heads/${branch}`, commit, head]);
    await assertSessionWorktree(root, {sessionId});
    await git(root, ['read-tree', commit]);
    return commit;
  } finally { await rm(temp, {recursive:true, force:true}); }
}
export async function publishSnapshot(root, {sessionId, ownerId}) {
  root = await realpath(root);
  return exclusive(root, async () => {
    const ref = snapshotRef(sessionId, ownerId);
    const commit = await checkpoint(root, sessionId);
    await assertSessionWorktree(root, {sessionId});
    await git(root, ['update-ref', ref, commit]);
    await assertSessionWorktree(root, {sessionId});
    await git(root, ['push', 'origin', `${ref}:${ref}`]);
    return {ref, commit, at: new Date().toISOString()};
  });
}
export async function receiveSnapshot(root, {sessionId, snapshot}) {
  root = await realpath(root);
  return exclusive(root, async () => {
    validateSnapshot(snapshot, sessionId);
    await assertSessionWorktree(root, {sessionId});
    const incoming = `refs/rpo/incoming/${token(sessionId)}/${snapshot.commit}`;
    await git(root, ['fetch', '--no-tags', 'origin', `${snapshot.ref}:${incoming}`]);
    // A publishing lane may have advanced its ref since the announcement; never apply a different commit silently.
    const fetched = await git(root, ['rev-parse', incoming]);
    if (fetched !== snapshot.commit) return {status:'stale', commit:fetched};
    const ours = await checkpoint(root, sessionId);
    if (await git(root, ['rev-parse', `${ours}^{tree}`]) === await git(root, ['rev-parse', `${fetched}^{tree}`])) return {status:'current', commit:ours};
    try {
      await git(root, ['merge-base', '--is-ancestor', fetched, ours]);
      return {status:'current', commit:ours};
    } catch {}
    // Require a common history before attempting a three-way merge.
    await git(root, ['merge-base', ours, fetched]);
    await assertSessionWorktree(root, {sessionId});
    try {
      await git(root, ['-c', 'core.hooksPath=', 'merge', '--no-edit', '--no-gpg-sign', fetched], {env:identity});
      return {status:'synced', commit:await git(root, ['rev-parse', 'HEAD'])};
    } catch (error) {
      const conflicts = await conflictFiles(root);
      if (!conflicts.length) throw error;
      return {status:'conflict', ours, theirs:fetched, files:conflicts};
    }
  });
}
export async function conflictFiles(root) {
  const out = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return out.split('\0').filter(Boolean);
}
export async function conflictVersions(root, path) {
  if (!(await conflictFiles(root)).includes(path)) throw Error('此文件不在冲突列表');
  const read = async stage => {
    try { return (await exec('git', ['show', `:${stage}:${path}`], {cwd:root, maxBuffer:2*1024*1024})).stdout; }
    catch (e) { if (e.code === 128) return null; throw e; }
  };
  const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)]);
  return {path, base, ours, theirs};
}
export async function resolveConflict(root, {sessionId, path, choice}) {
  root = await realpath(root);
  return exclusive(root, async () => {
    await assertSessionWorktree(root, {sessionId, allowConflicts:true});
    if (!(await conflictFiles(root)).includes(path) || !['ours','theirs','edited'].includes(choice)) throw Error('无效冲突处理');
    if (choice !== 'edited') {
      const versions = await conflictVersions(root, path);
      if (versions[choice] === null) await git(root, ['rm', '--', path]);
      else await git(root, ['checkout', `--${choice}`, '--', path]);
    }
    await assertSessionWorktree(root, {sessionId, allowConflicts:true});
    await git(root, ['add', '-A', '--', path]);
    const remaining = await conflictFiles(root);
    if (remaining.length) return {status:'conflict', files:remaining};
    await assertSessionWorktree(root, {sessionId});
    await git(root, ['-c', 'core.hooksPath=', 'commit', '--no-gpg-sign', '--no-edit'], {env:identity});
    return {status:'synced', commit:await git(root, ['rev-parse', 'HEAD'])};
  });
}
