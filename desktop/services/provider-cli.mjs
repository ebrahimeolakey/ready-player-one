import {access,readFile,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute,relative,win32} from 'node:path';
import {homedir} from 'node:os';
import {platformEnv} from '../../core/platform.mjs';

const nativeProviders=new Set(['codex','claude']);
export function displayCommand(command,args=[],platform=process.platform){
 const quote=v=>platform==='win32'?`"${String(v).replaceAll('"','\\"')}"`:`'${String(v).replaceAll("'", "'\\''")}'`;
 return [command,...args].map(quote).join(' '); // Display only: never executed as shell text.
}
async function findCommand(name,env,platform){
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path');
 const dirs=(env[key]||'').split(platform==='win32'?';':':').filter(p=>p&&isAbsolute(p));
 const extensions=platform==='win32'?['.exe','.com','.cmd','.bat']:[''];
 for(const dir of dirs)for(const ext of extensions){
  const candidate=join(dir,name+ext);
  try{if(!(await stat(candidate)).isFile())continue;await access(candidate,platform==='win32'?constants.F_OK:constants.X_OK);return candidate;}catch{}
 }
 throw Error(`未找到本机 ${name} CLI，请先在账号页安装`);
}
// npm's official shims delegate to these package.json bin entries. Never execute
// or interpolate the .cmd/.bat script, and never infer arbitrary shell commands.
export async function resolveNativeCLI(provider,env,platform=process.platform){
 if(!nativeProviders.has(provider))throw Error('此 Provider 没有已验证的交互 CLI 入口');
 const executable=await findCommand(provider,env,platform);
 if(platform!=='win32'||!/\.(cmd|bat)$/i.test(executable))return {command:executable,args:[],resolvedCommand:await realpath(executable),launcher:'native'};
 const packageName=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
 const packageRoot=join(dirname(executable),'node_modules',...packageName.split('/'));
 let info;
 try{info=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));}catch{throw Error('CLI 脚本入口不受支持，请在账号页安装官方原生 CLI');}
 const entry=typeof info.bin==='string'?info.bin:info.bin?.[provider];
 if(info.name!==packageName||typeof entry!=='string'||isAbsolute(entry)||win32.isAbsolute(entry)||entry.split(/[\\/]/).includes('..')||!/\.(?:c?js|mjs)$/.test(entry))throw Error('npm CLI 入口无法安全解析，请安装官方原生 CLI');
 const root=await realpath(packageRoot),file=await realpath(join(packageRoot,entry)),rel=relative(root,file);
 if(rel.startsWith('..')||isAbsolute(rel)||!(await stat(file)).isFile())throw Error('npm CLI 入口超出官方包目录');
 const node=await findCommand('node',env,platform);
 if(!/\.exe$/i.test(node))throw Error('npm CLI 需要本机 Node.js 原生可执行文件');
 return {command:node,args:[file],resolvedCommand:await realpath(node),launcher:'npm-node'};
}
export class ProviderCLIService {
 constructor({terminals,state,root,accounts=()=>[],env=()=>platformEnv(),resolveCommand=resolveNativeCLI,platform=process.platform,isBusy=()=>false}){
  Object.assign(this,{terminals,state,root,accounts,env,resolveCommand,platform,isBusy});this.pending=new Map();this.openingRoots=new Map();this.epoch=0;
 }
 async context(a){
  const state=this.state(),session=state?.sessions?.find(s=>s.id===a.sessionId&&s.workspaceId===a.workspaceId);
  if(!session||!state.me?.id)throw Error('CLI 会话不存在或无权访问');
  const role=state.me.roles?.[session.workspaceId]||(state.me.host?'owner':'viewer');
  if(!['owner','editor'].includes(role))throw Error('只有 Editor 可以打开 Provider CLI');
  const lane=session.lanes.find(l=>l.id===a.laneId&&l.ownerId===state.me.id);
  if(!lane)throw Error('只能打开本人通道的本机 CLI');
  if(!nativeProviders.has(lane.provider))throw Error('此 Provider 没有已验证的交互 CLI 入口');
  const cwd=await realpath(this.root(a));
  return {workspaceId:session.workspaceId,sessionId:session.id,laneId:lane.id,memberId:state.me.id,hubId:state.identity?.audience||'',provider:lane.provider,cwd};
 }
 async open(ownerId,a){
  const context=await this.context(a),key=JSON.stringify([ownerId,context.hubId,context.memberId,context.workspaceId,context.sessionId,context.laneId]);
  const previous=this.pending.get(key);if(previous)return previous;
  const promise=this.openContext(ownerId,a,context,key);this.pending.set(key,promise);
  try{return await promise;}finally{if(this.pending.get(key)===promise)this.pending.delete(key);if(this.openingRoots.get(context.cwd)===key)this.openingRoots.delete(context.cwd);}
 }
 async openContext(ownerId,a,context,key){
  const epoch=this.epoch;
  for(const record of this.terminals.terminals.values())if(record.ownerId===ownerId&&record.providerCLI?.key===key){
   if(record.providerCLI.cwd!==context.cwd||record.providerCLI.provider!==context.provider)throw Error('CLI 目录或 Provider 已变化，请先关闭原 CLI');
   return {id:record.id,contextId:record.contextId,cli:record.providerCLI.public,reused:true};
  }
  if(this.isBusy(context.cwd))throw Error('此目录正在执行 Agent 或 Git/调试操作，请先停止后打开 CLI');
  this.openingRoots.set(context.cwd,key);
  const env={...this.env()},launch=await this.resolveCommand(context.provider,env,this.platform);
  // No Hub identity/token, shared prompt, MCP bridge or native session ID is injected.
  for(const key of Object.keys(env))if(/^RPO_(?:HUB_|CLIENT_|IDENTITY_|SESSION_ID$|LANE_ID$|BRIDGE_|COORDINATION_)/.test(key))delete env[key];
  const account=this.accounts().find(v=>v.id===context.provider);
  const info={provider:context.provider,command:launch.command,args:launch.args,displayCommand:displayCommand(launch.command,launch.args,this.platform),resolvedCommand:launch.resolvedCommand,cwd:context.cwd,launcher:launch.launcher,
   account:account?.authenticated?account.label:'登录状态未确认，以 CLI 为准',accountSource:context.provider==='codex'?'本机 Codex CLI 配置与登录':'本机 Claude CLI 配置与登录',
   configDirectory:context.provider==='codex'?(env.CODEX_HOME||join(homedir(),'.codex')):(env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude')),
   credentialEnvironment:['OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'].filter(k=>env[k])};
  // Recheck after async command lookup: switching workspace mapping cannot redirect launch.
  const current=await this.context(a);
  if(epoch!==this.epoch||JSON.stringify(current)!==JSON.stringify(context))throw Error('CLI 目录或身份已变化，请重新打开');
  const opened=await this.terminals.openProgram(ownerId,{cwd:context.cwd,contextId:context.laneId,cols:a.cols,rows:a.rows,command:launch.command,args:launch.args,env,providerCLI:{...context,key,public:info}});
  const finalContext=await this.context(a).catch(()=>null);
  if(epoch!==this.epoch||JSON.stringify(finalContext)!==JSON.stringify(context)){this.terminals.close(ownerId,{id:opened.id});throw Error("CLI 目录或身份已变化，请重新打开");}
  return {...opened,cli:info,reused:false};
 }
 async authorize(ownerId,id){
  const record=this.terminals.get(ownerId,id),saved=record.providerCLI;
  if(!saved)return;
  const current=await this.context(saved);
  if(['cwd','provider','memberId','hubId'].some(k=>current[k]!==saved[k]))throw Error('CLI 目录或身份已变化，请关闭原 CLI 后重新打开');
 }
 closeAll(){this.epoch++;for(const record of this.terminals.terminals.values())if(record.providerCLI)this.terminals.close(record.ownerId,{id:record.id});}
 activeIn(root){return this.openingRoots.has(root)||[...this.terminals.terminals.values()].some(r=>r.providerCLI?.cwd===root&&!r.exited);}
}
