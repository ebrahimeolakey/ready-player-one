import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyProjectCheckout,resolveProjectCheckoutSelection,projectWorkingDirectory,withinProject} from '../desktop/services/project-artifacts.mjs';
const binding={repository:'example/project',branch:'main',subPath:'docs'};
async function fixture(t){const dir=realpathSync(await mkdtemp(join(tmpdir(),'rpo-checkout-')));t.after(()=>rm(dir,{recursive:true,force:true}));const plain=join(dir,'TEST'),repo=join(dir,'repo');await mkdir(plain);await mkdir(repo);execFileSync('git',['init','-b','main',repo]);execFileSync('git',['-C',repo,'remote','add','origin','https://github.com/example/project.git']);await mkdir(join(repo,'docs'));return {dir,plain,repo};}
test('ordinary folder mode works for a repository-bound project without initializing Git or appending its subpath',async t=>{
 const {plain}=await fixture(t);await writeFile(join(plain,'plan.md'),'draft');
 assert.deepEqual(await resolveProjectCheckoutSelection(plain,binding,'folder'),{root:plain,directory:plain,mode:'folder'});
 assert.equal(await verifyProjectCheckout(plain,binding,'folder'),plain);
 assert.equal(projectWorkingDirectory(plain,binding,'folder'),plain);
 assert.equal(await readFile(join(plain,'plan.md'),'utf8'),'draft');
 await assert.rejects(readFile(join(plain,'.git/config')),{code:'ENOENT'});
});
test('legacy and explicit repository modes still reject ordinary folders and wrong branches with useful messages',async t=>{
 const {plain,repo}=await fixture(t);
 await assert.rejects(verifyProjectCheckout(plain,binding),/example\/project.*本地工作文件夹/);
 execFileSync('git',['-C',repo,'symbolic-ref','HEAD','refs/heads/feature']);
 await assert.rejects(verifyProjectCheckout(repo,binding,'repository'),/需要分支 main，当前是 feature/);
 assert.equal(execFileSync('git',['-C',repo,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim(),'feature');
});
test('bound subdirectory selection resolves once, with the same working directory as repository root selection',async t=>{
 const {repo}=await fixture(t);const root=await resolveProjectCheckoutSelection(repo,binding);
 assert.deepEqual(await resolveProjectCheckoutSelection(join(repo,'docs'),binding),root);
 assert.equal(root.directory,join(repo,'docs'));
 await mkdir(join(repo,'other'));await assert.rejects(resolveProjectCheckoutSelection(join(repo,'other'),binding),/请选择仓库根目录/);
});
test('wrong repositories and invalid modes remain rejected; folder mode keeps artifact path boundaries',async t=>{
 const {repo,plain,dir}=await fixture(t);
 execFileSync('git',['-C',repo,'remote','set-url','origin','https://github.com/example/other.git']);
 await assert.rejects(verifyProjectCheckout(repo,binding),/属于 example\/other/);
 await assert.rejects(verifyProjectCheckout(plain,binding,'typo'),/请选择/);
 await writeFile(join(dir,'outside.txt'),'outside');await symlink(join(dir,'outside.txt'),join(plain,'escape.txt'));
 assert.throws(()=>withinProject(projectWorkingDirectory(plain,binding,'folder'),'escape.txt'),/越过授权目录/);
});
