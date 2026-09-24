import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {publishSnapshot, receiveSnapshot, conflictVersions, resolveConflict, validateSnapshot, bindSessionWorktree, inspectSessionWorktree} from '../core/snapshots.mjs';
const git = (cwd, ...args) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim();
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'rpo-sync-test-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const remote=join(dir,'origin.git'); await mkdir(remote);git(remote,'init','--bare');
 const a=join(dir,'a');git(dir,'clone',remote,a);await writeFile(join(a,'file.txt'),'base\n'); await writeFile(join(a,'.gitignore'),'.env\n');git(a,'add','.');git(a,'commit','-m','base');git(a,'push','origin','HEAD');
 const b=join(dir,'b');git(dir,'clone',remote,b);
 const aw=join(dir,'aw'),bw=join(dir,'bw');git(a,'worktree','add','-b','rpo/session-a',aw);git(b,'worktree','add','-b','rpo/session-b',bw);
 await bindSessionWorktree(aw,{sessionId:'s',expectedBranch:'rpo/session-a'});await bindSessionWorktree(bw,{sessionId:'s',expectedBranch:'rpo/session-b'});
 return {a,b,aw,bw,remote};
}
test('real Git remote snapshots merge independent edits and preserve main checkout and ignored files',async t=>{
 const {a,aw,bw}=await setup(t);
 await writeFile(join(aw,'file.txt'),'remote change\n');await writeFile(join(aw,'.env'),'secret');
 const snap=await publishSnapshot(aw,{sessionId:'s',ownerId:'a'});
 assert(!git(aw,'ls-tree','-r','--name-only',snap.commit).split('\n').includes('.env'));
 await writeFile(join(bw,'other.txt'),'local change\n');
 const result=await receiveSnapshot(bw,{sessionId:'s',snapshot:snap});assert.equal(result.status,'synced');
 assert.equal(await readFile(join(bw,'file.txt'),'utf8'),'remote change\n');assert.equal(await readFile(join(bw,'other.txt'),'utf8'),'local change\n');
 assert.equal(await readFile(join(a,'file.txt'),'utf8'),'base\n');
 assert.equal((await receiveSnapshot(bw,{sessionId:'s',snapshot:snap})).status,'current');
 await assert.rejects(()=>publishSnapshot(a,{sessionId:'s',ownerId:'a'}),/独立工作树/);
});
test('conflicting snapshots preserve both versions until explicitly resolved',async t=>{
 const {aw,bw}=await setup(t);await writeFile(join(aw,'file.txt'),'alice\n');await writeFile(join(bw,'file.txt'),'bob\n');
 const snapshot=await publishSnapshot(aw,{sessionId:'s',ownerId:'a'});
 const result=await receiveSnapshot(bw,{sessionId:'s',snapshot});assert.equal(result.status,'conflict');assert.deepEqual(result.files,['file.txt']);
 assert.deepEqual(await conflictVersions(bw,'file.txt'),{path:'file.txt',base:'base\n',ours:'bob\n',theirs:'alice\n'});
 const resolved=await resolveConflict(bw,{sessionId:'s',path:'file.txt',choice:'ours'});assert.equal(resolved.status,'synced');assert.equal(await readFile(join(bw,'file.txt'),'utf8'),'bob\n');
 assert.equal(git(bw,'show',`${snapshot.commit}:file.txt`),'alice');
});
test('snapshot metadata rejects cross-session refs and arbitrary revisions',()=>{
 assert.throws(()=>validateSnapshot({ref:'refs/rpo/snapshots/other/a',commit:'a'.repeat(40)},'s'));
 assert.throws(()=>validateSnapshot({ref:'refs/rpo/snapshots/s/a',commit:'HEAD~1'},'s'));
});

test('two real clones pause on ordinary, other rpo and detached branches without touching work/index/refs; switch back resumes',async t=>{
 const {aw,bw,remote}=await setup(t);
 await writeFile(join(aw,'remote.txt'),'shared\n');let snapshot=await publishSnapshot(aw,{sessionId:'s',ownerId:'a'});
 const capture=async root=>({head:git(root,'rev-parse','HEAD'),branch:git(root,'rev-parse','--abbrev-ref','HEAD'),index:git(root,'diff','--cached','--binary'),work:git(root,'diff','--binary'),status:git(root,'status','--porcelain'),refs:git(root,'show-ref'),remote:git(remote,'show-ref'),text:await readFile(join(root,'local.txt'),'utf8')});
 for(const [root,expected] of [[aw,'rpo/session-a'],[bw,'rpo/session-b']]){
  await writeFile(join(root,'local.txt'),root===aw?'alice staged\n':'bob staged\n');git(root,'add','local.txt');await writeFile(join(root,'local.txt'),root===aw?'alice working\n':'bob working\n');
  for(const branch of ['ordinary','rpo/different',null]){
   if(branch)git(root,'switch','-c',branch);else git(root,'switch','--detach','HEAD');
   const before=await capture(root);
   const mismatch=e=>e.code==='RPO_SYNC_BRANCH_MISMATCH'&&e.expectedBranch===expected&&e.actualBranch===branch;
   await assert.rejects(publishSnapshot(root,{sessionId:'s',ownerId:'test'}),mismatch);
   await assert.rejects(receiveSnapshot(root,{sessionId:'s',snapshot}),mismatch);
   await assert.rejects(resolveConflict(root,{sessionId:'s',path:'local.txt',choice:'edited'}),mismatch);
   assert.deepEqual(await capture(root),before);
   assert.equal((await inspectSessionWorktree(root,{sessionId:'s'})).status,'paused');
   git(root,'switch',expected);
  }
 }
 // Distinct files for the eventual merge, without discarding either local version.
 git(bw,'mv','local.txt','bob.txt');
 snapshot=await publishSnapshot(aw,{sessionId:'s',ownerId:'a'});
 assert.equal((await receiveSnapshot(bw,{sessionId:'s',snapshot})).status,'synced');
 assert.equal(await readFile(join(bw,'bob.txt'),'utf8'),'bob working\n');assert.equal(await readFile(join(bw,'local.txt'),'utf8'),'alice working\n');
});

test('legacy binding is explicit and branch-CAS guarded; rebinding cannot overwrite dirty work',async t=>{
 const {a,aw}=await setup(t),legacy=join(a,'..','legacy');git(a,'worktree','add','-b','rpo/legacy',legacy);
 assert.equal((await inspectSessionWorktree(legacy,{sessionId:'legacy'})).status,'unbound');
 await assert.rejects(publishSnapshot(legacy,{sessionId:'legacy',ownerId:'a'}),{code:'RPO_SYNC_BRANCH_UNBOUND'});
 await assert.rejects(bindSessionWorktree(legacy,{sessionId:'legacy',expectedBranch:'rpo/wrong'}),{code:'RPO_SYNC_BRANCH_MISMATCH'});
 await bindSessionWorktree(legacy,{sessionId:'legacy',expectedBranch:'rpo/legacy'});
 git(legacy,'switch','-c','rpo/reviewed');
 await assert.rejects(bindSessionWorktree(legacy,{sessionId:'legacy',expectedBranch:'rpo/reviewed'}),{code:'RPO_SYNC_BRANCH_MISMATCH'});
 await writeFile(join(legacy,'dirty.txt'),'preserve');
 await assert.rejects(bindSessionWorktree(legacy,{sessionId:'legacy',expectedBranch:'rpo/reviewed',replaceExpectedBranch:'rpo/legacy'}),/工作区和暂存区/);
 assert.equal(await readFile(join(legacy,'dirty.txt'),'utf8'),'preserve');await rm(join(legacy,'dirty.txt'));
 await bindSessionWorktree(legacy,{sessionId:'legacy',expectedBranch:'rpo/reviewed',replaceExpectedBranch:'rpo/legacy'});
 assert.equal((await inspectSessionWorktree(legacy,{sessionId:'legacy'})).binding.branch,'rpo/reviewed');
 await assert.rejects(bindSessionWorktree(aw,{sessionId:'other',expectedBranch:'rpo/session-a'}),/另一会话/);
});
