// Public structured evidence only. Never classify free-form provider/tool messages.
const codexCodes = {
  usageLimitExceeded:'usage_limit',rateLimitExceeded:'rate_limit',
  contextWindowExceeded:'context_limit',sessionBudgetExceeded:'budget_limit',
  unauthorized:'authentication',serverOverloaded:'server',internalServerError:'server',
  badRequest:'invalid_request',sandboxError:'tool',
};
const claudeCodes = {rate_limit:'rate_limit',billing_error:'billing',authentication_failed:'authentication',invalid_request:'invalid_request',server_error:'server',unknown:'other'};
const usageCodes = new Set(['credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']);
const connectionCodes = new Set(['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']);
const httpKind = status => status===429?'rate_limit':[401,403].includes(status)?'authentication':status===402?'billing':[408,504].includes(status)?'network':status>=500?'server':'other';
const make = (source,kind,code,status) => ({version:1,source,kind,code,...(Number.isInteger(status)&&status>=400&&status<=599?{httpStatus:status}:{})});
export function codexFailure(error) {
  const info=error?.codexErrorInfo ?? error?.data?.codexErrorInfo;
  if(typeof info==='string' && Object.hasOwn(codexCodes,info))return make('codex',codexCodes[info],info);
  if(info && typeof info==='object')for(const code of connectionCodes)if(Object.hasOwn(info,code)){
    const status=info[code]?.httpStatusCode;
    return make('codex',status>=400&&status<=599?httpKind(status):'network',code,status);
  }
  return null;
}
export function claudeFailure(result,assistantError) {
  if(result?.is_error!==true)return null;
  const status=result.api_error_status;
  // A terminal HTTP status takes precedence over any earlier assistant error.
  if(Number.isInteger(status)&&status>=400&&status<=599)return make('claude',httpKind(status),'http_error',status);
  return Object.hasOwn(claudeCodes,assistantError)?make('claude',claudeCodes[assistantError],assistantError):null;
}
export function compatibleFailure(status,error) {
  const code=error?.code;
  if((!status||status===429)&&usageCodes.has(code))return make('openai-compatible','usage_limit',code,status);
  if((!status||status===429)&&(code==='slow_down'||error?.type==='rate_limit_error'))return make('openai-compatible','rate_limit',code==='slow_down'?'slow_down':'rate_limit_error',status);
  return Number.isInteger(status)&&status>=400&&status<=599?make('openai-compatible',httpKind(status),'http_error',status):null;
}
export function acpFailure(error) {return error?.code===-32000?make('acp','authentication','authentication_required'):null;}
export function failureSource(provider) {return ['codex','claude'].includes(provider)?provider:String(provider).startsWith('acp-')?'acp':'openai-compatible';}
export function validateFailure(value,provider) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['version','source','kind','code','httpStatus'].includes(k))||value.version!==1)throw Error('无效 Provider 错误证据');
  if(value.httpStatus!==undefined&&(!Number.isInteger(value.httpStatus)||value.httpStatus<400||value.httpStatus>599))throw Error('无效 HTTP 错误状态');
  let expected;
  if(value.source==='codex')expected=codexFailure({codexErrorInfo:connectionCodes.has(value.code)?{[value.code]:{httpStatusCode:value.httpStatus}}:value.code});
  if(value.source==='claude')expected=claudeFailure({is_error:true,...(value.code==='http_error'?{api_error_status:value.httpStatus}:{})},value.code);
  if(value.source==='openai-compatible')expected=compatibleFailure(value.httpStatus,{code:value.code,type:value.code==='rate_limit_error'?'rate_limit_error':undefined});
  if(value.source==='acp'&&value.code==='authentication_required')expected=acpFailure({code:-32000});
  if(!expected||expected.kind!==value.kind||expected.code!==value.code||expected.httpStatus!==value.httpStatus||(provider!==undefined&&expected.source!==failureSource(provider)))throw Error('Provider 错误来源或代码不匹配');
  return expected;
}
export function isHandoffFailure(value) {return value?.kind==='usage_limit'||value?.kind==='rate_limit';}
// Bounded parsing, discard all text/unknown fields; never expose the upstream response body.
export async function readErrorEvidence(response) {
  if(!response.body)return null;
  const reader=response.body.getReader();let bytes=0;const parts=[];
  const timer=setTimeout(()=>{void reader.cancel().catch(()=>{});},1000);
  try {while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536)return null;parts.push(value);}
    const data=JSON.parse(Buffer.concat(parts).toString('utf8'));return data?.error&&typeof data.error==='object'?{code:data.error.code,type:data.error.type}:null;
  }catch{return null;}finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
