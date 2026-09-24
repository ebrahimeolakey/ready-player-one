import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Hub} from './helpers/secure-hub.mjs';
import {ReferenceRefreshService} from '../desktop/services/reference-refresh.mjs';
import {fileReferences} from '../desktop/services/references.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'rpo-reference-refresh-')),root=join(dir,'真实 Git 项目');await mkdir(root);
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init']);git(['config','user.name','Reference Fixture']);git(['config','user.email','reference@example.test']);
 await writeFile(join(root,'a.txt'),'alpha\n');await writeFile(join(root,'b.txt'),'beta\n');git(['add','.']);git(['commit','-m','initial']);
 const hub=new Hub(join(dir,'hub')),owner={id:'owner',name:'Owner',host:true};
 const workspace=hub.act(owner,'workspace.create',{name:'References'}),session=hub.act(owner,'session.create',{workspaceId:workspace.id,title:'Review'});
 const scope={workspaceId:workspace.id,sessionId:session.id},act=(method,args={})=>hub.act(owner,method,{...scope,...args});
 const refs=await fileReferences(root,{paths:['a.txt','b.txt']});
 const memories=refs.map(file=>act('memory.add',{title:file.path,text:'Initial '+file.path,files:[file]}));
 const comments=refs.map(file=>act('comment.add',{text:'Check '+file.path,location:{...file,startLine:1,endLine:1}}));
 const calls=[],issues=[];let hook=async()=>{};
 const client={ws:{readyState:1},async call(method,args={}){calls.push({method,args:structuredClone(args)});await hook(method,args);if(this.ws.readyState!==1)throw Error('协作连接已断开');return structuredClone(method==='state'?hub.snapshot(owner):act(method,args));}};
 let active=client;const service=new ReferenceRefreshService({client:()=>active,onIssue:issue=>issues.push(issue)});
 const refresh=(args={})=>service.refresh({root,...scope,reason:'测试文件更新',...args});
 const memory=index=>hub.db.memories.find(m=>m.id===memories[index].id),comment=index=>hub.db.sessions.find(s=>s.id===session.id).comments.find(c=>c.id===comments[index].id);
 t.after(async()=>{await hub.close();await rm(dir,{recursive:true,force:true});});
 return {root,git,hub,owner,scope,act,refs,memories,comments,client,service,refresh,calls,issues,memory,comment,setHook:fn=>{hook=fn;},setClient:c=>{active=c;}};
}

test('unrelated real Git commit changes HEAD but leaves equal-content memory and comment anchors current',async t=>{
 const f=await fixture(t),initial=f.git(['rev-parse','HEAD']);
 await writeFile(join(f.root,'unrelated.txt'),'unrelated');f.git(['add','unrelated.txt']);f.git(['commit','-m','unrelated']);assert.notEqual(f.git(['rev-parse','HEAD']),initial);
 assert.deepEqual(await f.refresh(),{checked:2});
 for(let i=0;i<2;i++){assert.equal(f.memory(i).stale,false);assert.equal(f.comment(i).stale,undefined);assert(f.memory(i).checkedAt);assert(f.comment(i).checkedAt);assert.equal(f.memory(i).files[0].commit,initial);}
 assert.equal(f.issues.at(-1).message,null);
});

test('path-scoped refresh only checks affected references and automatic checks never clear prior stale state',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'a.txt'),'alpha changed\n');await writeFile(join(f.root,'b.txt'),'beta changed\n');
 assert.deepEqual(await f.refresh({paths:['a.txt']}),{checked:1});
 assert.equal(f.memory(0).stale,true);assert.equal(f.comment(0).stale,true);assert.equal(f.memory(1).checkedAt,undefined);assert.equal(f.comment(1).checkedAt,undefined);
 for(const call of f.calls.filter(c=>['memory.check','comment.check'].includes(c.method)))assert.deepEqual(call.args.files.map(file=>file.path),['a.txt']);
 const checks=f.calls.filter(c=>c.method.endsWith('.check')).length;assert.deepEqual(await f.refresh({paths:['not-referenced.txt']}),{checked:0});assert.equal(f.calls.filter(c=>c.method.endsWith('.check')).length,checks);
 await writeFile(join(f.root,'a.txt'),'alpha\n');await f.refresh({paths:['a.txt']});assert.equal(f.memory(0).stale,true);assert.equal(f.comment(0).stale,true);
 const refreshed=await fileReferences(f.root,{paths:['a.txt']});f.act('memory.update',{id:f.memory(0).id,expectedVersion:0,files:refreshed});
 assert.equal(f.memory(0).stale,false);assert.deepEqual(f.memory(0).staleFiles,[]);assert.equal(f.memory(0).version,1);
 const history=f.act('memory.history',{id:f.memory(0).id});assert.equal(history.items.length,1);assert.equal(history.items[0].stale,true);assert.deepEqual(history.items[0].files,[f.refs[0]]);
 f.act('comment.check',{files:refreshed});assert.equal(f.comment(0).stale,false);
});

test('automatic expectedVersion rejects a stale refresh result after an explicit memory update',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'a.txt'),'new current content\n');let raced=false;
 f.setHook(async(method)=>{if(method==='memory.check'&&!raced){raced=true;await writeFile(join(f.root,'a.txt'),'newer explicitly validated content\n');f.act('memory.update',{id:f.memory(0).id,expectedVersion:0,text:'New validated fact',files:await fileReferences(f.root,{paths:['a.txt']})});}});
 assert.deepEqual(await f.refresh({paths:['a.txt']}),{checked:1});assert.equal(raced,true);assert.equal(f.memory(0).version,1);assert.equal(f.memory(0).stale,false);assert.equal(f.memory(0).checkedAt,undefined);
 const request=f.calls.find(c=>c.method==='memory.check');assert.equal(request.args.expectedVersions[f.memory(0).id],0);
 assert.equal(f.act('memory.history',{id:f.memory(0).id}).items[0].text,'Initial a.txt');
 const oldComment=structuredClone(f.comment(1));f.act('comment.check',{automatic:true,expectedVersions:{[oldComment.id]:99},files:[{...f.refs[1],hash:'0'.repeat(64)}]});assert.deepEqual(f.comment(1),oldComment);
 assert.throws(()=>f.act('memory.update',{id:f.memory(0).id,expectedVersion:0,text:'stale overwrite'}),/已由其他成员更新/);assert.equal(f.memory(0).historyCount,1);
});

test('memory history paginates stable versions, redacts credential-shaped values and stays workspace scoped',async t=>{
 const f=await fixture(t);const id=f.memory(0).id;
 for(let version=0;version<13;version++)f.act('memory.update',{id,expectedVersion:version,text:`version ${version+1}\napi_key=synthetic_history_secret_${version}_abcdef123456`});
 const first=f.act('memory.history',{id});assert.deepEqual(first.items.map(v=>v.version),[12,11,10,9,8,7,6,5,4,3]);assert.equal(first.nextBefore,3);
 const second=f.act('memory.history',{id,beforeVersion:first.nextBefore});assert.deepEqual(second.items.map(v=>v.version),[2,1,0]);assert.equal(second.nextBefore,null);assert.equal(new Set([...first.items,...second.items].map(v=>v.version)).size,13);
 assert(!JSON.stringify(first).includes('synthetic_history_secret'));assert(JSON.stringify(first).includes('凭据已隐藏'));assert.equal(f.memory(0).historyCount,13);assert.equal(f.memory(0).version,13);
 const foreign=f.act('workspace.create',{name:'other'});assert.throws(()=>f.hub.act(f.owner,'memory.history',{workspaceId:foreign.id,id}),/不属于/);
 assert.throws(()=>f.act('memory.history',{id,beforeVersion:-1}),/历史版本无效/);
});

test('disconnect during evidence report returns an issue without repeating the successful local mutation',async t=>{
 const f=await fixture(t);let mutations=0;const mutation=async()=>{mutations++;await writeFile(join(f.root,'a.txt'),'mutation applied once\n');return f.refresh({paths:['a.txt']});};
 f.setHook(async method=>{if(method==='memory.check')f.client.ws.readyState=3;});
 const result=await mutation();assert.equal(result.checked,0);assert.match(result.error,/断开/);assert.match(f.issues.at(-1).message,/断开/);
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(mutations,1);assert.equal(await readFile(join(f.root,'a.txt'),'utf8'),'mutation applied once\n');assert.equal(f.calls.filter(c=>c.method==='memory.check').length,1);assert.equal(f.calls.filter(c=>c.method==='comment.check').length,0);
});

test('already offline refresh surfaces an issue and never attempts RPC or local mutation replay',async t=>{
 const f=await fixture(t);f.client.ws.readyState=3;const result=await f.refresh({paths:['a.txt']});assert.equal(result.checked,0);assert.equal(f.calls.length,0);assert.match(f.issues.at(-1)?.message||'',/断开|未连接|未上报/);
});
