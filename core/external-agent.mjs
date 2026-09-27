// stdio MCP entry for an independently launched Claude Code / MCP-compatible agent.
import {readFileSync,writeFileSync,chmodSync,statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
const option=k=>process.argv[process.argv.indexOf(k)+1];
const loopback=raw=>{const u=new URL(raw);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw Error('外接桥只能连接本机 127.0.0.1');return u.origin;};
if(process.argv.includes('pair')){
 const url=loopback(option('--url')),code=option('--code'),path=resolve(option('--output')||'rpo-agent.json');
 const response=await fetch(url+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})}),data=await response.json();if(!response.ok)throw Error(data.error);
 writeFileSync(path,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});chmodSync(path,0o600);console.log('已接入 '+data.name+'；配置已保存，仅本人可读。');
}else{
 const path=option('--config');if(!process.argv.includes('--config')||!path)throw Error('请指定 --config /path/rpo-agent.json');
 if(process.platform!=='win32'&&(statSync(path).mode&0o077))throw Error('接入文件必须仅本人可读');
 const config=JSON.parse(readFileSync(path,'utf8')),url=loopback(config.url);
 const tools=[{name:'rpo_next',description:'领取此 Agent 的下一项待执行工作。无工作时返回 null。用自己的运行时执行，完成后调用 rpo_reply。',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'rpo_reply',description:'将当前执行结果交回项目。群聊工作按原请求的 JSON 格式回复。',inputSchema:{type:'object',properties:{runId:{type:'string'},text:{type:'string'}},required:['runId','text'],additionalProperties:false}},{name:'rpo_context',description:'读取当前执行的项目共享上下文。',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false}},{name:'rpo_contribute',description:'请求其他 Agent 在当前共享任务内承担分工。',inputSchema:{type:'object',properties:Object.fromEntries(['runId','agentId','goal','acceptance','requestKey'].map(k=>[k,{type:'string'}])),required:['runId','agentId','goal','requestKey'],additionalProperties:false}}];
 const input=createInterface({input:process.stdin});
 for await(const line of input){let q;try{q=JSON.parse(line);if(q.id===undefined)continue;let result;
 if(q.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'rpo-external-agent',version:'1.0.0'}};
 else if(q.method==='tools/list')result={tools};
 else if(q.method==='ping')result={};
 else if(q.method==='tools/call'){
 const t=tools.find(t=>t.name===q.params?.name);if(!t)throw Error('未知工具');const response=await fetch(url+'/'+t.name.slice(4),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+config.token},body:JSON.stringify(q.params.arguments||{})}),data=await response.json();result={content:[{type:'text',text:JSON.stringify(data)}],isError:!response.ok};
 }else throw Error('未知 MCP 方法');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q?.id??null,error:{code:-32000,message:e.message}})+'\n');}}
}
