import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRun, ClaudeRun, ProviderRuntime } from '../core/providers/runtime.mjs';
import { registerOpenAICompatible } from '../core/providers/openai-compatible.mjs';
import { codexFailure,claudeFailure,compatibleFailure,acpFailure,validateFailure,isHandoffFailure,readErrorEvidence } from '../core/providers/failure.mjs';
class Transport extends EventEmitter {write(){}close(){return Promise.resolve();}}
const tick=()=>new Promise(r=>setImmediate(r));
const run=(Class,provider)=>{const ended=[];const transport=new Transport();const instance=new Class({runId:'run',provider,onEnd:r=>ended.push(r)},transport);return {instance,ended};};
test('only explicit account/rate evidence requests handoff, never arbitrary text or context/tool budget errors',()=>{
 for(const code of ['usageLimitExceeded','rateLimitExceeded'])assert.ok(isHandoffFailure(codexFailure({codexErrorInfo:code})));
 for(const code of ['contextWindowExceeded','sessionBudgetExceeded','unauthorized','sandboxError','serverOverloaded'])assert.equal(isHandoffFailure(codexFailure({codexErrorInfo:code})),false);
 for(const error of [{message:'insufficient_quota rate limit 429 balance zero'},{codexErrorInfo:'unknown rateLimitExceeded'},new Error('quota exhausted')])assert.equal(codexFailure(error),null);
 assert.equal(codexFailure({codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}}).kind,'rate_limit');
 assert.equal(codexFailure({codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}).kind,'network');
 assert.equal(claudeFailure({is_error:true},'billing_error').kind,'billing');
 assert.equal(claudeFailure({is_error:true,api_error_status:529},'rate_limit').kind,'server');
 assert.equal(claudeFailure({is_error:false,api_error_status:429},'rate_limit'),null);
 for(const error of [{code:-32603,message:'quota exhausted'},{code:-32001,data:{type:'limit'}},{stopReason:'max_tokens'},{stopReason:'max_turn_requests'}])assert.equal(acpFailure(error),null);
 assert.equal(acpFailure({code:-32000}).kind,'authentication');
});
test('canonical failures reject source spoofing, inconsistent code/kind, raw messages and invalid HTTP range',()=>{
 const f=codexFailure({codexErrorInfo:'usageLimitExceeded'});
 assert.deepEqual(validateFailure(f,'codex'),f);
 for(const bad of [{...f,kind:'authentication'},{...f,message:'credential'},{...f,code:'fabricated'}, {...f,httpStatus:429},{...f,httpStatus:NaN},{...f,httpStatus:999}])assert.throws(()=>validateFailure(bad,'codex'));
 assert.throws(()=>validateFailure(f,'claude'));
 assert.equal(compatibleFailure(429,{message:'balance zero'}).kind,'rate_limit');
 assert.equal(compatibleFailure(429,{code:'credit_balance_exhausted'}).kind,'usage_limit');
 assert.equal(compatibleFailure(500,{code:'credit_balance_exhausted'}).kind,'server');
 assert.equal(compatibleFailure(undefined,{message:'quota exceeded'}),null);
});
test('Codex terminal fixture carries exact failure, retried error cannot poison a successful completion',async()=>{
 for(const status of ['failed','completed']){
  const {instance,ended}=run(CodexRun,'codex');
  instance.receive({method:'error',params:{willRetry:true,error:{codexErrorInfo:'rateLimitExceeded',message:'retrying'}}});
  instance.receive({method:'turn/completed',params:{turn:{status,error:status==='failed'?{codexErrorInfo:'usageLimitExceeded',message:'limit'}:null}}});
  await tick();assert.equal(ended.length,1);assert.equal(ended[0].status,status==='failed'?'error':'done');assert.equal(ended[0].failure?.kind,status==='failed'?'usage_limit':undefined);
 }
});
test('Claude terminal fixtures isolate top-level structured failure from tools, subagents and recovered errors',async()=>{
 for(const scenario of ['rate','billing','auth','subagent','tool','recovered','http']){
  const {instance,ended}=run(ClaudeRun,'claude');instance.inflightMessages=1;
  if(scenario==='http')instance.receive({type:'result',is_error:true,api_error_status:429,errors:['limited']});
  else {
   instance.receive({type:'assistant',parent_tool_use_id:scenario==='subagent'?'sub':null,error:scenario==='billing'?'billing_error':scenario==='auth'?'authentication_failed':'rate_limit',message:{id:'one',content:[]}});
   if(['tool','recovered'].includes(scenario))instance.receive({type:'assistant',message:{id:'ok',content:[]}});
   if(scenario==='tool')instance.receive({type:'user',message:{content:[{type:'tool_result',is_error:true,content:'rate_limit quota exhausted'}]}});
   instance.receive({type:'result',is_error:scenario!=='recovered',errors:['failure']});
  }
  await tick();assert.equal(ended.length,1);
  assert.equal(ended[0].failure?.kind,{rate:'rate_limit',billing:'billing',auth:'authentication',http:'rate_limit'}[scenario]);
 }
});
test('compatible HTTP/SSE fixtures carry whitelisted evidence without upstream content, do not retry',async()=>{
 for(const scenario of ['quota','rate','auth','server','stream','unknown-stream','large']){
  const runtime=new ProviderRuntime();let calls=0;
  const status={quota:429,rate:429,auth:401,server:503,large:429}[scenario]||200;
  const body=scenario==='large'?'x'.repeat(65537):JSON.stringify({error:{code:scenario==='quota'||scenario==='stream'?'credit_balance_exhausted':'unknown',message:'PRIVATE_ERROR_BODY'}});
  registerOpenAICompatible(runtime,'custom-test',{baseUrl:'http://localhost/',model:'fixture',fetch:async()=>{calls++;return new Response(status===200?`data: ${body}\n\n`:body,{status});}});
  const ended=new Promise(resolve=>runtime.start({provider:'custom-test',runId:'run',cwd:process.cwd(),prompt:'synthetic',onEnd:resolve}));
  const result=await ended;assert.equal(result.status,'error');assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_BODY'),false);
  assert.equal(result.failure?.kind,{quota:'usage_limit',rate:'rate_limit',auth:'authentication',server:'server',stream:'usage_limit',large:'rate_limit'}[scenario]);
  await runtime.close();
 }
 assert.equal(await readErrorEvidence(new Response('not-json',{status:429})),null);
});

test('Codex rejected start RPC preserves structured error data through Requests and ends once',async()=>{
 class RPCTransport extends Transport {
  write(frame){queueMicrotask(()=>this.emit('message',{id:frame.id,...(frame.method==='turn/start'?{error:{code:-32000,message:'structured limit',data:{codexErrorInfo:'usageLimitExceeded'}}}:{result:frame.method==='thread/start'?{thread:{id:'thread'}}:{}})}));}
 }
 const runtime=new ProviderRuntime({transportFactory:()=>new RPCTransport()}),ended=[];
 await assert.rejects(runtime.start({provider:'codex',runId:'rpc',cwd:process.cwd(),prompt:'synthetic',onEnd:r=>ended.push(r)}),/structured limit/);
 assert.equal(ended.length,1);assert.equal(ended[0].failure.kind,'usage_limit');assert.equal(runtime.runs.size,0);
});
