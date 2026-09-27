import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentTools,agentToolOptions} from '../core/agent-tools.mjs';
test('Per-Agent MCP settings isolate server namespaces, credentials and provider configuration',()=>{
 const config={env:{MY_APP_TOKEN:'example-value'},mcpServers:{documents:{command:'/opt/tools/docs',args:['--stdio'],env:{TOKEN:'private'}}}};
 const options=agentToolOptions(config,'codex');assert.equal(options.codexConfig['mcp_servers.documents'].env.TOKEN,'private');assert.equal(options.env.MY_APP_TOKEN,'example-value');assert.ok(!('mcp_servers.rpo' in options.codexConfig));
 assert.throws(()=>validateAgentTools({env:{RPO_HUB_TOKEN:'override'}}),/不能覆盖/);
 assert.throws(()=>validateAgentTools({mcpServers:{rpo:{command:'fake'}}}),/名称/);
 assert.throws(()=>agentToolOptions(config,'acp-other'),/仅适配/);
 assert.throws(()=>validateAgentTools({mcpServers:{x:{command:'x',args:'shell string'}}}),/参数/);
});
