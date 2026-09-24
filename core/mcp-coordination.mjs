import { PROMPT_LIMITS, validatePrompt } from "./prompt-limits.mjs";
// MCP 2025-06-18 stdio transport. No credentials are returned to tools or stdout.
import { pathToFileURL } from "node:url";
import { HubClient } from "./client.mjs";

const string = { type: "string" };
const promptString = { type: "string", maxLength: PROMPT_LIMITS.codePoints, description: "完整原文：最多100,000 Unicode码点/400,000 UTF-8字节。协调检查只分析前8,000码点并返回明确摘要覆盖信息；不会修改实际执行原文。" };
const ref = { type: "object", properties: { path: string, commit: string, hash: string }, required: ["path", "commit"], additionalProperties: false };
const scope = {type:"object",properties:{path:string,kind:{enum:["file","directory"]}},required:["path","kind"],additionalProperties:false};
const scopes = {type:"array",items:scope,maxItems:100};
const definitions = [
  ["context", "coordination.context", "读取当前会话、计划、成员、共享记忆、文件锁和 Agent 消息。", {}, []],
  ["plan_add", "plan.add", "在当前会话拆分一个可分配的计划步骤。", { text: string, assigneeId: string, fileScopes:scopes }, ["text"]],
  ["overlap_check", "coordination.check", "检查当前通道的文件/目录、计划和其他活动任务是否相交；结果为确定性建议，不阻止本机写入。", {prompt:promptString,fileScopes:scopes,planIds:{type:"array",items:string,maxItems:50},branch:string}, []],
  ["plan_claim", "plan.claim", "认领尚未由其他成员领取的步骤。", { id: string }, ["id"]],
  ["plan_assign", "plan.assign", "分配当前会话的已有步骤；进行中步骤仍需双方确认转交。", { id: string, assigneeId: string }, ["id", "assigneeId"]],
  ["plan_status", "plan.status", "更新步骤进度。", { id: string, status: { enum: ["todo", "in-progress", "blocked", "done"] } }, ["id", "status"]],
  ["plan_transfer", "plan.transfer", "将自己负责的步骤转交给工作区成员。", { id: string, assigneeId: string }, ["id", "assigneeId"]],
  ["message", "coordination.message", "给当前会话或指定 Agent 通道发送协调消息。", { text: string, laneId: string }, ["text"]],
  ["memory_add", "memory.add", "写入共享记忆，可绑定文件、commit 及文件内容哈希。", { title: string, text: string, files: { type: "array", items: ref, maxItems: 100 } }, ["title", "text"]],
  ["memory_list", "memory.list", "读取当前工作区记忆，可包含停用项；不会查询其他工作区。", { includeRetired: { type: "boolean" } }, []],
  ["memory_update", "memory.update", "更新当前工作区的已有记忆；引用应来自实际文件，不自动验证本机内容。", { id: string, title: string, text: string, files: { type: "array", items: ref, maxItems: 100 } }, ["id"]],
  ["memory_retire", "memory.retire", "明确停用或恢复当前工作区记忆，重复相同决定不会反转状态。", { id: string, retired: { type: "boolean" } }, ["id", "retired"]],
  ["subtask_spawn", "local.subtask.spawn", "从当前执行拆分子任务，在本机创建独立工作树，使用用户预配置检查，等待人工执行审批。requestId 使用 UUID，超时重试保留原值与相同内容。", { requestId: string, title: string, prompt: promptString }, ["requestId", "title", "prompt"]],
  ["lock_acquire", "lock.acquire", "申请建议性文件锁；冲突时返回持有人，不会强制阻止文件写入。", { path: string, kind:{enum:["file","directory"]}, ttlMs: { type: "integer", minimum: 1000, maximum: 1800000 } }, ["path"]],
  ["lock_renew", "lock.renew", "续期当前成员持有的建议性文件锁。", { id: string, ttlMs: { type: "integer", minimum: 1000, maximum: 1800000 } }, ["id"]],
  ["lock_release", "lock.release", "释放当前成员持有的建议性文件锁。", { id: string }, ["id"]],
];
export const coordinationTools = definitions.map(([name, , description, properties, required]) => ({ name: `rpo_${name}`, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: ["context","overlap_check","memory_list"].includes(name), destructiveHint: false, idempotentHint: ["context","overlap_check","memory_list","memory_retire","subtask_spawn"].includes(name), openWorldHint: false } }));

function valid(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === "array") return Array.isArray(value) && value.length <= (schema.maxItems ?? Infinity) && value.every(v => valid(v, schema.items));
  if (schema.type === "object") return value && typeof value === "object" && !Array.isArray(value) && (schema.required || []).every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(schema.properties, k) && valid(value[k], schema.properties[k]));
  return true;
}
export function createCoordinationMcp({ client, sessionId, laneId, spawnSubtask }) {
  let initialized = false;
  return async request => {
    if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    if (!Object.hasOwn(request, "id")) return null;
    const response = { jsonrpc: "2.0", id: request.id };
    if (request.method === "initialize") {
      initialized = true;
      return { ...response, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ready-player-one-coordination", version: "1.0.0" }, instructions: "这些工具仅协调当前会话。文件锁只是建议；执行命令与文件修改仍由宿主 Provider 的审批机制管理。" } };
    }
    if (request.method === "ping") return { ...response, result: {} };
    if (!initialized) return { ...response, error: { code: -32000, message: "Initialize first" } };
    if (request.method === "tools/list") return { ...response, result: { tools: coordinationTools } };
    if (request.method !== "tools/call") return { ...response, error: { code: -32601, message: "Method not found" } };
    const index = coordinationTools.findIndex(t => t.name === request.params?.name);
    if (index < 0) return { ...response, error: { code: -32602, message: "Unknown tool" } };
    const args = request.params.arguments || {};
    if (!valid(args, coordinationTools[index].inputSchema)) return { ...response, error: { code: -32602, message: "Invalid tool arguments" } };
    try {
      // Fetch current scope each time; removed sessions/role changes cannot use cached authorization.
      const context = await client.call("coordination.context", { sessionId });
      const method = definitions[index][1];
      if (args.prompt !== undefined && ["local.subtask.spawn", "coordination.check"].includes(method)) validatePrompt(args.prompt, { allowEmpty: method === "coordination.check" });
      if (method === "local.subtask.spawn") {
        if (!laneId || !spawnSubtask) throw Error("当前运行未配置本机子任务桥");
        const result = await spawnSubtask(args);
        return { ...response, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
      }
      if (["memory.update", "memory.retire"].includes(method)) {
        const memories = await client.call("memory.list", { sessionId, workspaceId: context.session.workspaceId, includeRetired: true });
        if (!memories.some(m => m.id === args.id)) throw Error("记忆不属于当前工作区");
      }
      if ((method.startsWith("lock.") || method === "coordination.check") && !laneId) throw Error("当前 MCP 未绑定 Agent 通道");
      if (["lock.renew", "lock.release"].includes(method) && !context.locks.some(l => l.id === args.id && l.laneId === laneId)) throw Error("只能操作当前 Agent 通道的文件锁");
      const result = method === "coordination.context" ? context : await client.call(method, { ...args, sessionId, workspaceId: context.session.workspaceId, ...((method.startsWith("lock.") || method === "coordination.check") ? { laneId } : {}) });
      return { ...response, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
    } catch (error) {
      return { ...response, result: { content: [{ type: "text", text: error.message }], isError: true } };
    }
  };
}

export async function runCoordinationMcp(env = process.env, input = process.stdin, output = process.stdout) {
  const url = new URL(env.RPO_HUB_URL || "ws://127.0.0.1:0");
  if (!["ws:", "wss:"].includes(url.protocol) || (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw Error("远程 MCP 协作连接必须使用 WSS");
  if (!env.RPO_HUB_TOKEN || !env.RPO_CLIENT_SECRET || !env.RPO_SESSION_ID) throw Error("缺少 MCP 协作连接配置");
  const client = new HubClient();
  try {
    await client.connect(url.href, { token: env.RPO_HUB_TOKEN, secret: env.RPO_CLIENT_SECRET, name: env.RPO_CLIENT_NAME || "Agent", identitySession: env.RPO_IDENTITY_SESSION });
    const spawnSubtask = localSubtaskClient(env);
    const dispatch = createCoordinationMcp({ client, sessionId: env.RPO_SESSION_ID, laneId: env.RPO_LANE_ID, spawnSubtask });
    input.setEncoding("utf8");
    let pending = "";
    // Sequential dispatch preserves claim/transfer order. Input size is bounded before JSON parsing.
    for await (const chunk of input) {
      pending += chunk;
      if (Buffer.byteLength(pending) > 1024 * 1024) throw Error("MCP 请求超过大小限制");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let response;
        try { response = await dispatch(JSON.parse(line)); }
        catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
        if (response) output.write(JSON.stringify(response) + "\n");
      }
    }
  } finally { client.close(); }
}
export function localSubtaskClient(env) {
  if (!env.RPO_COORDINATION_BRIDGE_URL && !env.RPO_COORDINATION_BRIDGE_TOKEN) return undefined;
  const url = new URL(env.RPO_COORDINATION_BRIDGE_URL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/subtasks" || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(env.RPO_COORDINATION_BRIDGE_TOKEN || "")) throw Error("本机子任务桥配置无效");
  return async args => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RPO_COORDINATION_BRIDGE_TOKEN}` }, body: JSON.stringify(args), redirect: "error", signal: AbortSignal.timeout(120000) });
    const value = await response.json();
    if (!response.ok || value.error) throw Error(value.error || "本机子任务创建失败；重试请保留 requestId");
    return value.result;
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCoordinationMcp().catch(error => { process.stderr.write(`协作 MCP：${error.message}\n`); process.exitCode = 1; });
}
