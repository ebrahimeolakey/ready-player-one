# 会话内 MCP 计划与记忆

本批为 0.4.1 发布后的源码增量，尚未另行发布。MCP 使用现有 stdio JSON-RPC 连接 Hub，固定启动时的 session/lane；不修改全局 CLI 配置；本机 Claude 的只读允许列表明确包含上下文、重叠查询与记忆列表。尚未新增子任务桥接。

| 工具 | 参数 | Hub 操作与权限 |
| --- | --- | --- |
| `rpo_plan_assign` | `id`, `assigneeId` | `plan.assign`，Editor/Owner；保留现有负责人限制，进行中步骤继续走双方确认，不直接夺取 |
| `rpo_memory_update` | `id`, 可选 `title` / `text` / `files` | `memory.update`，Editor/Owner；只允许当前工作区记忆，保留现有文字长度、文件路径和引用格式校验 |
| `rpo_memory_retire` | `id`, 必填布尔值 `retired` | `memory.retire`，Editor/Owner；`true` 停用，`false` 恢复，重复相同参数不反转 |
| `rpo_memory_list` | 可选布尔值 `includeRetired` | `memory.list`，Viewer 及以上；默认只返回未停用项，`true` 包含停用项，结果按已有规则脱敏 |

所有工具的参数 schema 拒绝 `workspaceId`、`sessionId` 等额外字段。每次调用重新读取固定会话的 `coordination.context`，不缓存角色授权；修改记忆前再从同工作区 `memory.list` 核对目标 ID。宿主即使有多个工作区权限，也不能借另一个工作区的记忆 ID 越过 MCP 范围。

Hub 独立实施范围检查：`memory.update` / `memory.retire` 的目标工作区必须与传入 session/workspace 一致；`memory.list` 必须提供有效 workspace 或 session，两者同时提供时必须一致。已有纯记忆 ID 的旧客户端仍由目标记忆推导授权范围。撤销成员后查询同样失败；降为 Viewer 后仍可查询，但不能修改/停用/分配。

Hub `memory.retire` 保留省略 `retired` 时的旧 UI toggle 行为；**该旧调用不是幂等接口**。MCP 必须显式传入布尔值，不接受缺失、字符串或数字。工具只验证引用格式，不能替代 `references` 本机文件检查；Agent 应从真实文件取得 commit/hash，不能将格式有效视为内容已验证。

`memory_list` 的只读 annotation 只是 MCP 描述，不会自动扩大 Provider 的允许列表。计划分配和记忆修改继续受 Hub 写权限约束。子任务 spawn 仍需要本机工作树服务与用户预配置检查，不能只暴露 Hub claim 冒充真实执行。

验收由 `tests/mcp-memory.test.mjs` 和 `tests/coordination.test.mjs` 覆盖：多工作区宿主的越界 ID/伪造范围、实时降权与移除、显式停用重试/恢复、旧 toggle 兼容、无效引用不写入、进行中分配保留同意流程、列表脱敏，以及真实 stdio 子进程通过 WebSocket Hub 完成新工具调用。该证据不等于真实模型已自主选择这些新工具。

2026-09-24 本批验证：`node --test tests/mcp-memory.test.mjs tests/coordination.test.mjs tests/hub.test.mjs` **46/46 通过**；`node --test tests/overlap.test.mjs tests/task-coordination-service.test.mjs` **13/13 通过**。相关文件 diff 空白检查通过。未执行发布。

后续源码已补 `rpo_subtask_spawn` 的本机桥、用户检查设置和真实工作树创建；它不直接调用 Hub claim。参数、身份绑定、幂等及验收边界见 [MCP-SUBTASKS](MCP-SUBTASKS.md)。
