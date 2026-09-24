// MCP 2025-06-18 stdio transport. No credentials are returned to tools or stdout.
import { pathToFileURL } from "node:url";
import { HubClient } from "./client.mjs";

const string = { type: "string" };
const ref = { type: "object", properties: { path: string, commit: string, hash: string }, required: ["path", "commit"], additionalProperties: false };
const definitions = [
  ["context", "coordination.context", "读取当前会话、计划、成员、共享记忆、文件锁和 Agent 消息。", {}, []],
  ["plan_add", "plan.add", "在当前会话拆分一个可分配的计划步骤。", { text: string, assigneeId: string }, ["text"]],
  ["plan_claim", "plan.claim", "认领尚未由其他成员领取的步骤。", { id: string }, ["id"]],
  ["plan_status", "plan.status", "更新步骤进度。", { id: string, status: { enum: ["todo", "in-progress", "blocked", "done"] } }, ["id", "status"]],
  ["plan_transfer", "plan.transfer", "将自己负责的步骤转交给工作区成员。", { id: string, assigneeId: string }, ["id", "assigneeId"]],
  ["message", "coordination.message", "给当前会话或指定 Agent 通道发送协调消息。", { text: string, laneId: string }, ["text"]],
  ["memory_add", "memory.add", "写入共享记忆，可绑定文件、commit 及文件内容哈希。", { title: string, text: string, files: { type: "array", items: ref, maxItems: 100 } }, ["title", "text"]],
  ["lock_acquire", "lock.acquire", "申请建议性文件锁；冲突时返回持有人，不会强制阻止文件写入。", { path: string, ttlMs: { type: "integer", minimum: 1000, maximum: 1800000 } }, ["path"]],
  ["lock_renew", "lock.renew", "续期当前成员持有的建议性文件锁。", { id: string, ttlMs: { type: "integer", minimum: 1000, maximum: 1800000 } }, ["id"]],
  ["lock_release", "lock.release", "释放当前成员持有的建议性文件锁。", { id: string }, ["id"]],
];
export const coordinationTools = definitions.map(([name, , description, properties, required]) => ({ name: `rpo_${name}`, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: name === "context", destructiveHint: false, idempotentHint: name === "context", openWorldHint: false } }));

function valid(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "integer") return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === "array") return Array.isArray(value) && value.length <= (schema.maxItems ?? Infinity) && value.every(v => valid(v, schema.items));
  if (schema.type === "object") return value && typeof value === "object" && !Array.isArray(value) && (schema.required || []).every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(schema.properties, k) && valid(value[k], schema.properties[k]));
  return true;
}
export function createCoordinationMcp({ client, sessionId, laneId }) {
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
      if (method.startsWith("lock.") && !laneId) throw Error("当前 MCP 未绑定 Agent 通道");
      if (["lock.renew", "lock.release"].includes(method) && !context.locks.some(l => l.id === args.id && l.laneId === laneId)) throw Error("只能操作当前 Agent 通道的文件锁");
      const result = method === "coordination.context" ? context : await client.call(method, { ...args, sessionId, workspaceId: context.session.workspaceId, ...(method.startsWith("lock.") ? { laneId } : {}) });
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
    const dispatch = createCoordinationMcp({ client, sessionId: env.RPO_SESSION_ID, laneId: env.RPO_LANE_ID });
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCoordinationMcp().catch(error => { process.stderr.write(`协作 MCP：${error.message}\n`); process.exitCode = 1; });
}
