// Private per-Agent launch settings. Only the encrypted desktop store persists these.
import {validateACPConfig} from './acp-config.mjs';
export function validateAgentTools(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('工具配置须为对象');
 const {env}=validateACPConfig({command:'unused',env:input.env||{}});
 if(Object.keys(env).some(k=>/^(RPO_|ELECTRON_|NODE_OPTIONS$)/.test(k)))throw Error('不能覆盖协作服务环境变量');
 const servers=input.mcpServers||{};
 if(typeof servers!=='object'||Array.isArray(servers)||Object.keys(servers).length>20)throw Error('MCP 配置无效或数量过多');
 const mcpServers={};
 for(const [name,value] of Object.entries(servers)){
  if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/.test(name)||name==='rpo')throw Error('MCP 名称无效或占用内置名称');
  const v=validateACPConfig(value);mcpServers[name]={command:v.command,args:v.args,env:v.env};
 }
 return {env,mcpServers};
}
export function agentToolOptions(config,provider){
 const value=validateAgentTools(config||{});
 if(!['codex','claude'].includes(provider)&&Object.keys(value.mcpServers).length)throw Error('附加 MCP 当前仅适配 Codex / Claude Code');
 return {env:value.env,mcpServers:value.mcpServers,codexConfig:Object.fromEntries(Object.entries(value.mcpServers).map(([name,v])=>['mcp_servers.'+name,v]))};
}
