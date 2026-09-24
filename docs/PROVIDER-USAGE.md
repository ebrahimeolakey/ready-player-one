# Provider 用量口径与共享

`core/providers/usage.mjs` 将官方协议数据转换成 `UsageSnapshot`（类型见 `src/types.ts`）。adapter 发出 `{type:'usage',usageSnapshot}`；RunCoordinator 持久化 `run.usage`，Hub 加上 `runId / sequence / updatedAt` 保存为 `Lane.usage` 并广播。UI 可直接读取这份共享状态。

| 来源 | context.usedTokens | context.limitTokens | cumulative |
| --- | --- | --- | --- |
| Codex app-server | `tokenUsage.last.totalTokens` | `modelContextWindow` | `tokenUsage.total`，Provider 会话累计 |
| Claude stream-json | 最新顶层 assistant/message_start 的 input + cache read + cache creation | result.modelUsage 中与该条 assistant **完全相同 model ID** 的 contextWindow | modelUsage 各模型总计，包含子 Agent；缺失时仅 result.usage 的当前 turn、主 Agent |
| ACP v1 | usage_update.used | usage_update.size | 未报告，null；cost 是协议报告的会话累计费用 |
| OpenAI-compatible | 最后一次 HTTP 请求的 prompt_tokens | 标准响应没有此字段，null | 本次 run 内各请求的 usage 之和，按请求 ID 覆盖去重 |

context 与 cumulative 必须分开呈现。basis 为 `provider-context` 或 `last-request-input`，后者是最近一次请求的输入占用，不含之后新生成/输入的内容。累计 input 包含缓存，cachedInput/cacheWrite 是其中的子集；reasoningOutput 是 output 的子集，不能重复加到总数。context 可以在压缩后降低，不施加单调递增规则。

缺失、非法、超范围计数统一为 **null**，绝不填 0 或用模型名猜窗口。真实 0 保留。所有 counter 字段都显式可空；缺 usage 的 compatible 请求使相应累计字段变为未知，避免把不完整总计展示成完整数据。Claude 子 Agent 不覆盖主上下文；compact_boundary 清空当前占用等待下一条消息；crash 的 result 可能全为占位 0，忽略并保留先前读数。

Claude cost 标明 `kind:estimate`，ACP cost 标明 `kind:reported`；两者都不是账户账单校验。scope 明示 `provider-session / run / turn`。不按静态模型价格估算费用。Claude 原生 session 恢复返回的累计可能包含恢复前活动，不能再与前一个 run 相加。具体语义依据 [Claude SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) 与 [statusline context formula](https://code.claude.com/docs/en/statusline#context-window-fields)。

Codex 在本机执行 `codex app-server generate-json-schema` 核对 ThreadTokenUsageUpdatedNotification；当前 context 数量依据 [官方 TokenUsage 实现](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 的 tokens_in_context_window，直接使用 total_tokens，不减 reasoning、不套用 CLI 基线百分比。ACP 依据 [v1 UsageUpdate 定义](https://docs.rs/agent-client-protocol-schema/latest/src/agent_client_protocol_schema/v1/client.rs.html)。自定义 API 仅在提供商设置勾选“请求用量统计”后携带 `stream_options.include_usage:true`，旧配置默认关闭以保持兼容；接口主动返回的用量无论开关都可显示。协议使用 [官方 Chat Completions 流协议](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)。不支持该标准参数的兼容服务可能拒绝请求；不会偷偷重发可能已执行的模型请求。

共享服务仅收规范字段，剥离额外元数据；Token 必须是 0..10^12 安全整数，上限不能为 0，金额须有限非负且 ≤10^9，币种为三个大写字母。Hub 校验工作区 editor 权限、lane owner、Provider 来源、active run、停止/撤销 fencing；用量不能写入已结束或其他 run。序号范围 1..100000，旧序号幂等忽略，同序号不同内容拒绝；新序号替换完整快照，服务端不累加。新的 run.claim 清空前次读数，执行结束保留最后一份。上下文超过报告的上限仍保留原始计数，UI 可显示超限，不能截断为伪造数据。

断线期间写入现有持久化 outbox，恢复后先顺序交付 usage，再发送 run.finish；生产 outbox 与 Hub 使用已有加密存储。桌面已在模型选择旁接入占用比例及明细；没有余额或账户账单查询。

验证：Provider 协议 fixture 测试 34 项、Hub/RunCoordinator/recovery 27 项通过，`tsc --noEmit` 通过。包含 native Codex/Claude frame、真实 ACP 合成子进程、compatible SSE fixture、真实两 HubClient 的持久化/共享/越权/重传/撤销测试。上述自动化是协议与共享集成验证，不能替代真实 Provider 及账单核对。

真实 Mac 桌面验收：通过本机已登录 Codex，在隔离项目发送只读固定回复请求，得到 `USAGE_OK`。实际 Provider 报告 17,899 / 258,400 tokens，UI 显示 7%，展开后输入 17,892、输出 7、缓存输入 17,664，与加密 Hub 持久化记录一致。关闭并重启测试应用后回复、完成状态及用量保留。Claude、ACP、自定义 API 的真实用量与账户账单仍未实测。
