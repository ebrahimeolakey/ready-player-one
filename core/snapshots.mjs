import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
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
async function assertSessionWorktree(root) {
  const [gitDir, commonDir, branch] = await Promise.all([
    git(root, ['rev-parse', '--absolute-git-dir']),
    git(root, ['rev-parse', '--git-common-dir']),
    git(root, ['symbolic-ref', '--short', 'HEAD']),
  ]);
  if (resolve(root, commonDir) === resolve(gitDir) || !branch.startsWith('rpo/')) throw Error('请先为会话创建独立工作树，再开启代码同步');
  if (await git(root, ['ls-files', '--unmerged'])) throw Error('请先解决当前代码冲突');
  return branch;
}
const identity = {GIT_AUTHOR_NAME: 'Ready Player One', GIT_AUTHOR_EMAIL: 'snapshot@ready-player-one.local', GIT_COMMITTER_NAME: 'Ready Player One', GIT_COMMITTER_EMAIL: 'snapshot@ready-player-one.local'};
async function checkpoint(root) {
  await assertSessionWorktree(root);
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
    await git(root, ['update-ref', 'HEAD', commit, head]);
    await git(root, ['read-tree', commit]);
    return commit;
  } finally { await rm(temp, {recursive:true, force:true}); }
}
export async function publishSnapshot(root, {sessionId, ownerId}) {
  return exclusive(root, async () => {
    const ref = snapshotRef(sessionId, ownerId);
    const commit = await checkpoint(root);
    await git(root, ['update-ref', ref, commit]);
    await git(root, ['push', 'origin', `${ref}:${ref}`]);
    return {ref, commit, at: new Date().toISOString()};
  });
}
export async function receiveSnapshot(root, {sessionId, snapshot}) {
  return exclusive(root, async () => {
    validateSnapshot(snapshot, sessionId);
    await assertSessionWorktree(root);
    const incoming = `refs/rpo/incoming/${token(sessionId)}/${snapshot.commit}`;
    await git(root, ['fetch', '--no-tags', 'origin', `${snapshot.ref}:${incoming}`]);
    // A publishing lane may have advanced its ref since the announcement; never apply a different commit silently.
    const fetched = await git(root, ['rev-parse', incoming]);
    if (fetched !== snapshot.commit) return {status:'stale', commit:fetched};
    const ours = await checkpoint(root);
    if (await git(root, ['rev-parse', `${ours}^{tree}`]) === await git(root, ['rev-parse', `${fetched}^{tree}`])) return {status:'current', commit:ours};
    try {
      await git(root, ['merge-base', '--is-ancestor', fetched, ours]);
      return {status:'current', commit:ours};
    } catch {}
    // Require a common history before attempting a three-way merge.
    await git(root, ['merge-base', ours, fetched]);
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
export async function resolveConflict(root, {path, choice}) {
  return exclusive(root, async () => {
    if (!(await conflictFiles(root)).includes(path) || !['ours','theirs','edited'].includes(choice)) throw Error('无效冲突处理');
    if (choice !== 'edited') {
      const versions = await conflictVersions(root, path);
      if (versions[choice] === null) await git(root, ['rm', '--', path]);
      else await git(root, ['checkout', `--${choice}`, '--', path]);
    }
    await git(root, ['add', '-A', '--', path]);
    const remaining = await conflictFiles(root);
    if (remaining.length) return {status:'conflict', files:remaining};
    await git(root, ['-c', 'core.hooksPath=', 'commit', '--no-gpg-sign', '--no-edit'], {env:identity});
    return {status:'synced', commit:await git(root, ['rev-parse', 'HEAD'])};
  });
}
