import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {GithubRepositoryService} from '../desktop/services/github-repository.mjs';
import {SecureStore} from '../core/secure-store.mjs';
const error=(status,message)=>Object.assign(Error(message),{stderr:`gh: ${message} (HTTP ${status})`});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-create-repo-')),root=join(dir,'已有 Git 项目');await mkdir(root);
 const key=randomBytes(32),store=new SecureStore({dir:join(dir,'settings'),key}),calls=[],remotes=new Map();
 const state={account:{id:1,login:'alice'},scope:'hub-a/member-a',postFailure:null,writeFailure:false,permission:true};
 const run=async(command,args,options)=>{
  assert.equal(command,'gh');if(args[0]==='auth'){assert.deepEqual(args.slice(0,5),['auth','token','--hostname','github.com','--user']);return {stdout:`fixture-token-${args[5]==='alice'?1:2}`};}assert.deepEqual(args.slice(0,3),['api','--hostname','github.com']);assert.equal(options.env.GH_PROMPT_DISABLED,'1');const effective=options.env.GH_TOKEN==='fixture-token-1'?{id:1,login:'alice'}:options.env.GH_TOKEN==='fixture-token-2'?{id:2,login:'bob'}:state.account;const method=args[4],path=args[5];calls.push({method,path,args});
  if(path==='user'){if(!state.account)throw error(401,'requires authentication');return {stdout:JSON.stringify(effective)};}
  if(path.startsWith('users/')){const login=path.slice(6);return {stdout:JSON.stringify({login,type:login==='team'?'Organization':'User'})};}
  if(path==='user/memberships/orgs/team')return {stdout:JSON.stringify({state:state.permission?'active':'pending'})};
  if(method==='GET'&&path.startsWith('repos/')){const repo=remotes.get(path.slice(6));if(!repo)throw error(404,'Not Found');return {stdout:JSON.stringify(repo)};}
  if(method==='POST'){
   if(state.postFailure==='denied')throw error(403,'Resource not accessible');
   const name=args.find(v=>v.startsWith('name='))?.slice(5),owner=path==='user/repos'?effective.login:path.split('/')[1],full_name=owner+'/'+name;
   assert(!remotes.has(full_name),'fixture detects duplicate create');const repo={id:100+remotes.size,full_name,private:args.includes('private=true'),permissions:{push:true}};remotes.set(full_name,repo);
   if(state.postFailure==='lost')throw Error('response timeout after committed creation');return {stdout:JSON.stringify(repo)};
  }
  throw Error('unexpected fixture route '+method+' '+path);
 };
 const make=options=>new GithubRepositoryService({store:()=>store,scope:()=>state.scope,run,...options});
 const service=make(),input={owner:'alice',name:'demo-project',visibility:'private'};
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const init=async()=>{git(['init']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.test']);await writeFile(join(root,'tracked.txt'),'original\n');git(['add','.']);git(['commit','-m','initial']);};
 t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,root,store,state,calls,remotes,service,make,input,git,init,run};
}

test('explicit review validates owner/name/visibility and account before any external mutation',async t=>{
 const f=await fixture(t);
 for(const value of [{...f.input,visibility:''},{...f.input,owner:'../alice'},{...f.input,name:'--evil'},{...f.input,name:'../escape'},{...f.input,name:'repo.git'}])await assert.rejects(f.service.preview(value));
 assert.equal(f.calls.length,0);await assert.rejects(f.service.preview({...f.input,owner:'someone-else'}),/只能在当前/);
 f.state.account=null;await assert.rejects(f.service.preview(f.input),/无法确认 GitHub 账号/);assert.equal(f.calls.filter(v=>v.method==='POST').length,0);
});

test('review creates nothing, confirmation creates once, and encrypted receipts survive replay and restart',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input);assert.equal(review.status,'prepared');assert.equal(f.remotes.size,0);
 const [first,second]=await Promise.all([f.service.create({id:review.id}),f.service.create({id:review.id})]);assert.equal(first.status,'created');assert.equal(second.repo.id,first.repo.id);
 assert.equal(f.calls.filter(v=>v.method==='POST').length,1);assert(f.calls.find(v=>v.method==='POST').args.includes('auto_init=false'));
 assert.equal((await f.make().create({id:review.id})).repo.id,first.repo.id);assert.equal(f.calls.filter(v=>v.method==='POST').length,1);
 const bytes=String(await readFile(join(f.dir,'settings','github-repositories.json.enc')));assert(!bytes.includes('demo-project'));assert(!bytes.includes('alice'));
 assert.equal((await f.make().history())[0].id,review.id);
});

test('lost creation response remains uncertain; restart only queries and never claims same-name proof of creation',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input);f.state.postFailure='lost';const result=await f.service.create({id:review.id});assert.equal(result.status,'unknown');assert.equal(f.remotes.size,1);
 const after=await f.make().create({id:review.id});assert.equal(after.status,'observed');assert.match(after.message,/不能据此确认/);assert.equal(f.calls.filter(v=>v.method==='POST').length,1);
 assert.equal((await f.make().preview(f.input)).id,review.id);
 f.remotes.get('alice/demo-project').id=999;const replaced=await f.make().lookup({id:review.id});assert.equal(replaced.status,'conflict');await assert.rejects(f.make().previewBind({id:review.id,path:f.root}),/先核实/);assert.equal(f.calls.filter(v=>v.method==='POST').length,1);
});

test('permission failure and an absent lookup never issue another POST; organization ownership is explicit',async t=>{
 const f=await fixture(t);f.state.permission=false;await assert.rejects(f.service.preview({...f.input,owner:'team'}),/有效成员/);
 f.state.permission=true;const review=await f.service.preview({...f.input,owner:'team',visibility:'public'});f.state.postFailure='denied';const result=await f.service.create({id:review.id});assert.match(result.message,/403/);
 const queried=await f.make().create({id:review.id});assert.match(queried.message,/尚未查询到/);assert.equal(f.calls.filter(v=>v.method==='POST').length,1);assert.equal(f.calls.find(v=>v.method==='POST').path,'orgs/team/repos');
 assert(f.calls.find(v=>v.method==='POST').args.includes('private=false'));
});

test('GitHub account and Hub identity changes cannot execute or expose another identity receipt',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input);f.state.account={id:2,login:'bob'};
 await assert.rejects(f.service.create({id:review.id}),/账号已切换/);await assert.rejects(f.service.lookup({id:review.id}),/账号已切换/);assert.deepEqual(await f.service.history(),[]);
 f.state.account={id:1,login:'alice'};f.state.scope='hub-b/member-a';await assert.rejects(f.service.create({id:review.id}),/协作身份/);assert.deepEqual(await f.service.history(),[]);assert.equal(f.calls.filter(v=>v.method==='POST').length,0);
});

test('explicit bind adds origin once and preserves HEAD, index and dirty files without push or commit',async t=>{
 const f=await fixture(t);await f.init();await writeFile(join(f.root,'tracked.txt'),'staged\n');f.git(['add','tracked.txt']);await writeFile(join(f.root,'tracked.txt'),'unstaged\n');await writeFile(join(f.root,'untracked.txt'),'keep me');
 const head=f.git(['rev-parse','HEAD']),index=f.git(['show',':tracked.txt']),status=f.git(['status','--porcelain']);
 const review=await f.service.preview(f.input);await f.service.create({id:review.id});const binding=await f.service.previewBind({id:review.id,path:f.root});assert.equal(binding.dirty,true);assert.equal(f.git(['remote']),'');
 assert.equal((await f.service.bind({bindingId:binding.bindingId})).bound,true);assert.equal((await f.make().bind({bindingId:binding.bindingId})).bound,true);
 assert.equal(f.git(['remote','get-url','origin']),'https://github.com/alice/demo-project.git');assert.equal(f.git(['rev-parse','HEAD']),head);assert.equal(f.git(['show',':tracked.txt']),index);assert.equal(f.git(['status','--porcelain']),status);assert.equal(await readFile(join(f.root,'tracked.txt'),'utf8'),'unstaged\n');assert.equal(await readFile(join(f.root,'untracked.txt'),'utf8'),'keep me');
 assert.equal(f.calls.filter(v=>v.method==='POST').length,1);
});

test('bind rejects existing origin, changed configuration, subdirectories, worktrees and no-write permission',async t=>{
 const f=await fixture(t);await f.init();const review=await f.service.preview(f.input);await f.service.create({id:review.id});
 f.git(['remote','add','origin','https://example.test/untouched.git']);await assert.rejects(f.service.previewBind({id:review.id,path:f.root}),/已有不同 origin/);assert.equal(f.git(['remote','get-url','origin']),'https://example.test/untouched.git');f.git(['remote','remove','origin']);
 const binding=await f.service.previewBind({id:review.id,path:f.root});f.git(['remote','add','upstream','https://example.test/upstream.git']);await assert.rejects(f.service.bind({bindingId:binding.bindingId}),/配置已变化/);assert.equal(f.git(['remote']),'upstream');
 const sub=join(f.root,'subdir');await mkdir(sub);await assert.rejects(f.service.previewBind({id:review.id,path:sub}),/根目录/);
 const worktree=join(f.dir,'worktree');f.git(['worktree','add','-b','linked',worktree]);await assert.rejects(f.service.previewBind({id:review.id,path:worktree}),/独立工作树/);
 f.remotes.get('alice/demo-project').permissions.push=false;await assert.rejects(f.service.previewBind({id:review.id,path:f.root}),/写入权限/);
});

test('durable marker failure prevents remote creation and repository lock rejection prevents local binding',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input),write=f.store.writeJSON.bind(f.store);let fail=true;f.store.writeJSON=(name,value)=>{if(fail&&value.operations.some(r=>r.status==='dispatching'))throw Error('synthetic disk write failure');return write(name,value);};
 await assert.rejects(f.service.create({id:review.id}),/disk write/);assert.equal(f.calls.filter(v=>v.method==='POST').length,0);fail=false;await f.service.create({id:review.id});await f.init();
 const binding=await f.service.previewBind({id:review.id,path:f.root});await assert.rejects(f.make({withRepository:async()=>{throw Error('Agent 正在执行');}}).bind({bindingId:binding.bindingId}),/Agent/);assert.equal(f.git(['remote']),'');
});

test('existing GitHub account/list/clone helpers pin github.com and pass paths without shell interpolation',async()=>{
 const {accountStatus,repositories,cloneRepository}=await import('../core/accounts.mjs');const calls=[];
 const run=async(command,args,options)=>{calls.push({command,args,options});return {stdout:args[0]==='--version'?'gh fixture':args.includes('user')?JSON.stringify({login:'alice',name:'Alice'}):'[]'};};
 assert.equal((await accountStatus('github',run)).label,'alice');await repositories(run);const target='/tmp/中文 and spaces/$(not-a-command)';await cloneRepository('alice/demo-project',target,run);
 for(const call of calls.filter(c=>c.args[0]==='api'))assert(call.args.includes('--hostname')&&call.args.includes('github.com'));
 const clone=calls.find(c=>c.args[0]==='repo');assert.deepEqual(clone.args,['repo','clone','https://github.com/alice/demo-project.git',target]);assert.equal(clone.options.env.GH_HOST,'github.com');
});

test('confirmation pins the reviewed credential even if gh active account changes immediately before POST',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input);
 const service=f.make({run:async(command,args,options)=>{if(args[0]==='api'&&args[4]==='POST'){f.state.account={id:2,login:'bob'};assert.equal(options.env.GH_TOKEN,'fixture-token-1');}return f.run(command,args,options);}});
 const result=await service.create({id:review.id});assert.equal(result.status,'created');assert.equal(result.repo.fullName,'alice/demo-project');assert.equal(f.remotes.has('bob/demo-project'),false);assert.equal(service.apiToken,undefined);
 assert(!String(await readFile(join(f.dir,'settings','github-repositories.json.enc'))).includes('fixture-token'));
 await assert.rejects(service.lookup({id:review.id}),/账号已切换/);
});

test('failed revalidation cannot leave a cached success usable for clone or bind',async t=>{
 const f=await fixture(t),review=await f.service.preview(f.input);await f.service.create({id:review.id});
 const failed=f.make({run:async(command,args,options)=>{if(args[5]?.startsWith('repos/'))throw error(503,'temporary unavailable');return f.run(command,args,options);}});
 const unknown=await failed.lookup({id:review.id});assert.equal(unknown.status,'unknown');
 assert.equal((await f.service.lookup({id:review.id})).status,'created');
 f.remotes.delete('alice/demo-project');assert.equal((await f.service.lookup({id:review.id})).status,'conflict');assert.equal(f.calls.filter(v=>v.method==='POST').length,1);
});
