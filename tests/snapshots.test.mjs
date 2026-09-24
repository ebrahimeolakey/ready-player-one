import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {publishSnapshot, receiveSnapshot, conflictVersions, resolveConflict, validateSnapshot} from '../core/snapshots.mjs';
const git = (cwd, ...args) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim();
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'rpo-sync-test-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const remote=join(dir,'origin.git'); await mkdir(remote);git(remote,'init','--bare');
 const a=join(dir,'a');git(dir,'clone',remote,a);await writeFile(join(a,'file.txt'),'base\n'); await writeFile(join(a,'.gitignore'),'.env\n');git(a,'add','.');git(a,'commit','-m','base');git(a,'push','origin','HEAD');
 const b=join(dir,'b');git(dir,'clone',remote,b);
 const aw=join(dir,'aw'),bw=join(dir,'bw');git(a,'worktree','add','-b','rpo/session-a',aw);git(b,'worktree','add','-b','rpo/session-b',bw);
 return {a,b,aw,bw};
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
 const resolved=await resolveConflict(bw,{path:'file.txt',choice:'ours'});assert.equal(resolved.status,'synced');assert.equal(await readFile(join(bw,'file.txt'),'utf8'),'bob\n');
 assert.equal(git(bw,'show',`${snapshot.commit}:file.txt`),'alice');
});
test('snapshot metadata rejects cross-session refs and arbitrary revisions',()=>{
 assert.throws(()=>validateSnapshot({ref:'refs/rpo/snapshots/other/a',commit:'a'.repeat(40)},'s'));
 assert.throws(()=>validateSnapshot({ref:'refs/rpo/snapshots/s/a',commit:'HEAD~1'},'s'));
});
