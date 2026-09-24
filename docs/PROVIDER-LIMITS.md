# Provider 限额与人工接管

A2 使用 Provider 的结构化错误证据。没有读取余额接口，没有按自然语言报错、模型名称或工具输出猜测余额；不调用真实模型耗尽额度进行测试。

## 公开合同

Runtime 的 terminal `onEnd` 保留 `status: "error"`，可增加：

```ts
failure: {
  version: 1;
  source: "codex" | "claude" | "acp" | "openai-compatible";
  kind: "usage_limit" | "rate_limit" | "authentication" | "billing" |
    "network" | "server" | "context_limit" | "budget_limit" |
    "invalid_request" | "tool" | "other";
  code: string; // 只允许协议/HTTP 白名单代码
  httpStatus?: number; // 整数 400–599
}
```

`RunCoordinator` 将同一证据持久化到加密 outbox 的 `run.finish`，按已有顺序重连补传。Hub 检验当前通道所有者、权限、run ID、撤销围栏，以及 Provider/source/code/kind/status 一致性；未知字段和原始错误体不能进入此结构。已接受的重复结束通知不改变先前结果。

只有 terminal error 且 kind 为 `usage_limit` / `rate_limit` 才置 `lane.status = "needs_handoff"`（待接管），并保存 `lane.handoffNeeded = {runId, reason: failure, at, lastConfirmedSnapshot}`。快照是当时已有 `lane.snapshot` 的 `{ref, commit, at}` 副本；不存在则为 null，不能证明尚未同步的本机修改已获保存。后续发布新快照不会改写这份故障时证据，实际接力仍要求来源最近已发布快照。

自动出队在待接管以及相同 activeRunId 的 handoffNeeded 存在时暂停；即使交接确认把源状态改为 interrupted，也不自动继续旧队列。用户明确创建并审批新任务、领取新 run 后才清除该 run 的故障标记。接管继续使用已有的单接收者请求 → 原执行者安全确认（或明确确认离线未同步风险）→ 同步确认快照 → 新账号/新原生会话/新审批流程，绝不自动重试未知结果的动作。

## 来源及边界（2026-09-24 核对）

- Codex：本机 `/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema --out <临时目录>` 导出的 `v2/TurnCompletedNotification.json` / `v2/ErrorNotification.json`。终止 turn 的 `codexErrorInfo.usageLimitExceeded` / `rateLimitExceeded` 分别映射用量限制/限流；结构化 connection variant 的 HTTP429 同样标限流。`contextWindowExceeded`、`sessionBudgetExceeded` 分别是上下文/会话预算错误，不称账户余额不足。重试中的 error notification 不覆盖成功结束结果。启动 RPC 的结构化 error.data 同样保留分类。
- Claude：[官方 Agent SDK types.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py) 和 [message_parser.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/message_parser.py)。只使用顶层 assistant.error 的精确枚举，并要求最终 result.is_error；忽略子 Agent / tool_result 的文字错误。新版 result.api_error_status 优先于早先 assistant 错误。`rate_limit` / HTTP429 是限流；`billing_error` 是付款问题，与账户用量耗尽分开，保持普通失败。成功的后续顶层 assistant 清除先前候选错误。参考[官方 API 错误说明](https://platform.claude.com/docs/en/api/errors)。
- OpenAI-compatible：[官方 API error codes](https://developers.openai.com/api/docs/guides/error-codes)。HTTP429 本身只表明用量/速率限制，不能证明余额为零；只有精确的 `credit_balance_exhausted`、`organization_spend_limit_exceeded`、`project_spend_limit_exceeded`、`organization_usage_limit_exceeded` 才细分为 usage_limit。HTTP401/403、402、5xx 分别保留认证/付款/服务端错误。HTTP 错误体最多读 64 KiB、最多等 1 秒，只提取已知 code/type，不回传消息正文。SSE 中 error 会结束为失败；未知 error 不默认为成功或额度不足。不会自动重发 HTTP 请求。
- ACP：[官方 v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)。标准无统一账户 quota code，`-32000` 只明确认证必需；`max_tokens`、`max_turn_requests`、任意 `-32603` 文字和 `_meta` 均不推断额度。尚未实现供应商私有额度扩展，因此 ACP 的未知限额仍是普通失败，可由用户显式请求接力。

HTTP429 没有附带重置时间或余额时，UI 不编造恢复倒计时、额度数值或余额。没有可验证结构化依据的网络断开和其他普通错误继续显示原有失败；不能凭其消息中的 “429 / quota” 升级为待接管。

## 验证

`tests/providers-failure.test.mjs` 覆盖原生 JSON 帧、启动 RPC、Claude 错误隔离、HTTP/SSE 非重试与正文不泄漏、代码/HTTP 范围白名单；`tests/providers-acp.test.mjs` 通过真实 stdio 子进程运行合成 ACP peer，验证认证、max_tokens 与一般错误边界，不能等同真实供应商账号额度验收。

`tests/quota-handoff.test.mjs` 覆盖真实 Hub 状态机的权限、旧 run/fenced run、重复结果、快照副本、无快照、两接收者竞争和接管审批；`tests/run-coordinator.test.mjs` 用真实本机 WebSocket Hub + 合成 Provider 验证断线持久补传与队列不重跑。没有向同事发送消息，也没有执行真实付费请求。
