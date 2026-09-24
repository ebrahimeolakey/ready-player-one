# 成员可见的模型配置

此项为 0.4.1 发布后的源码增量。成员栏和 Agent 标题显示 `Provider · 模型`；模型的推理强度、下次选择、本轮发送参数及 Provider 确认值在模型文字的悬停说明中查看。未设置时显示“未设置”；运行中没有已知模型时显示“未报告”。没有用目录第一个模型、产品默认值或其他成员的配置猜测。

共享字段刻意分开：

- `lane.configuration = {model, effort, updatedAt}`：下次运行选择。`model` / `effort` 是字符串或 `null`。
- `lane.runConfiguration = {runId, requested, requestedAt, reported?}`：本轮实际发送给适配层的选项。`requested` 一旦写入不能改成另一组参数。运行中更换 `configuration` 不会改写它。
- `reported = {model, effort, sequence, at}`：本机 Provider 协议返回的确认值。未返回的字段为 `null`；不把发送选项冒充确认值。新执行 claim 清除旧本轮记录，旧会话不会凭空出现模型。

接口：

```js
// 通道本人，且仍有当前工作区 Editor/Owner 权限。
await client.call('lane.configure', {sessionId, laneId, model: model || null, effort: effort || null});
// 成功后桌面才持久化本机 laneOptions。运行中允许更新，仅代表下次选择。

// 以下由本机 RunCoordinator 写入持久 outbox；不从 Renderer/其他成员填报。
await client.call('run.configuration', {sessionId, laneId, runId, phase:'requested', model, effort});
await client.call('run.configuration', {sessionId, laneId, runId, phase:'reported', sequence:1, model, effort});
```

Hub 强制通道所有权、当前执行 ID、运行状态、停止/撤销围栏及实时角色。其他 Editor 或房主也不能改别人的通道配置。发送参数重复投递必须相同；确认值按递增序号处理，过期序号不覆盖较新值，相同序号不同内容报错。只保存 model/effort 等允许字段，不接收 API key、endpoint 或 runtimeConfig；名称有长度、控制字符及已知凭据模式校验。

确认来源：

| Provider | 实际读取的协议数据 | 明确边界 |
| --- | --- | --- |
| Codex | `thread/start` / `thread/resume` 的 `model` 和 `reasoningEffort`；见[官方响应 schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadStartResponse.json) | 显式设置本轮 effort 时，线程默认 effort 不代表 turn 已确认的 effort，因此确认字段保持未知，发送参数仍保留 |
| Claude | 顶层 `system/init.model`、assistant message / message_start 的 model | 忽略子 Agent 的 `parent_tool_use_id` 消息；未回报 effort 时不从命令行选项推断 |
| ACP | 完整配置返回的 `currentValue`，或显式启用的 legacy `currentModelId`；见[配置协议](https://agentclientprotocol.com/protocol/v1/session-config-options) | 已确认配置可更新；未声明的能力/字段保持未知 |
| 兼容 API | SSE chunk 中的 `model` | 每个相同 chunk 不重复广播；代理未回报模型或实际 effort 时保持未知，不把请求 alias 当作解析后的模型 |

Provider 和 Coordinator 均去重；断线后的确认事件随已有加密 outbox 恢复。主线程仅在本机配置明确存在时提供 custom/ACP 的默认 model 作为发送参数，原生 CLI 未知默认值不猜测。

验收：`tests/lane-configuration.test.mjs` 使用真实 WebSocket 双客户端确认选择可见性、所有权、角色降级、参数固定、确认序号、停止围栏、敏感字段拒绝和重启持久化；Provider 测试覆盖确认别名与请求不同、缺失字段、Claude 子 Agent 隔离、ACP 真实 stdio fixture、兼容流重复 chunk；Coordinator 测试覆盖离线确认回放。协议开发阶段未调用真实模型；随后集成验收已通过本机已登录 Codex 的真实只读调用：返回 `MODEL_OK`，Hub 保存 requested.model 和 reported.model 为 `gpt-6-astra`，requested.effort 为 medium、reported.effort 未提供保持 null，桌面标题和成员栏均显示模型，执行状态正确结束。该结果不等于其他 Provider 的真实模型或双实体机器均已验收。

本批验证（2026-09-24）：模型/Provider/Coordinator 五个测试文件 **42/42**；协调、MCP 及恢复三个文件 **46/46**，合计 **88 项通过**。`tsc --noEmit` 与相关文件 `git diff --check` 通过。现有 usage 上报与 `requestUsage` opt-in 保持通过，未扩大兼容 API 请求字段。
