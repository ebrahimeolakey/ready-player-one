# A9 · 长提示完整投递

任务原文与协调摘要使用独立限制。普通任务、队列任务、执行中指导、评论转任务的自定义原文和子任务统一由 `core/prompt-limits.mjs` 校验；超过限制报错，不自动截断执行。

| 内容 | 上限与行为 |
| --- | --- |
| 可执行原文 | 100,000 Unicode 码点，同时最多 400,000 UTF-8 字节；保留首尾空白，拒绝空白任务与孤立 UTF-16 surrogate |
| 本机输入草稿 | 200,000 码点 / 800,000 UTF-8 字节；允许暂存超过发送限制的文本；再超限显示“草稿未保存”，不会覆盖之前保存的草稿 |
| 协调检查摘要 | 前 8,000 码点；返回 `kind / codePoints / utf8Bytes / limit / truncated / text / display`，显示“协调摘要”“非任务原文”，较长输入旁明确提示检查覆盖范围 |
| Provider 附加协作上下文 | 合计前 12,000 码点，包含共享计划、记忆和近期消息；独立标明摘要，然后附完整用户原文 |
| 未确认结果证据 | 先脱敏，再保存前 8,000 码点的明确摘要；不因原任务超过旧 20k 限制而丢弃未知结果记录 |

这里的码点不是 UTF-16 长度，也不是视觉字形数量：普通汉字和单个 emoji 通常各算一个码点，组合 emoji 可含多个。100,000 个四字节 emoji 恰好是 400,000 UTF-8 字节。合法原文 JSON 最坏转义仍低于 Hub 2 MiB 单请求上限；本机 MCP 与子任务 HTTP 桥为 1 MiB。图片另走现有本机附件机制和独立图片限额，不混入文本上限。

## 原文与脱敏通道

Hub 加密数据库保留原文，共享 snapshot 脱敏。Coordinator 不能把 snapshot 的脱敏 prompt 作为执行输入：`run.claim` 在校验通道所有者、执行许可和稳定 claimKey 后，将原文通过本次 RPC 返回；Coordinator 取 `data.approval.prompt` 拼装 Provider 输入。共享转录中的用户任务仅保存带标识的摘要。

指导同样不能从 snapshot 直接执行。新增 `run.steer.read({sessionId,laneId,runId,id})` 仅允许当前执行所有者读取 pending 指导原文。读响应丢失可以重读；一旦实际向 Provider 尝试投递，则只重传 durable ACK，不重复投递。

`run.steer.read({...restore:true})` 仅允许所有者读取 failed / unsupported / restored 的历史指导，供恢复本机输入草稿。恢复原文和图片在加密 ComposerStore 中一次原子保存，稳定恢复凭据避免重启后重复合并。原有 CAS 冲突草稿机制仍生效。

共享上下文里的 stale memory 带“已过期：核对或更新前不可当作现行事实”标记。协调检查只分析摘要覆盖的部分，尾部未检查不代表没有重叠；`coordination.check.promptSummary` 和重叠候选 `promptCoverage / candidatePromptCoverage` 返回这一边界。协调摘要不替代真正任务原文。

## 验证

`tests/long-prompts.test.mjs` 包含 8 项行为测试：

- 19,999 / 20,000 / 20,001 / 100,000 码点的汉字和 emoji；超限、非法 surrogate、UTF-8 字节及 JSON 包络。
- 摘要有标识与限额，过期记忆有提示，Provider 原文保持首尾空白及尾部要求。
- 真实 Hub WebSocket → owner claim → fake runtime：共享状态隐藏合成凭据形态，原文仍逐字到达；Codex / Claude 图文输入保留完整文本与图片。
- 队列提交、评论转任务、协调检查各自保留原文或明确摘要。
- 指导 raw read ACK 丢失与 Provider 投递 ACK 丢失分别模拟，只执行一次。
- 读取指导期间应用暂停 / 关闭，响应回来后不再投递；其他通道所有者不能读取恢复原文。
- 断线输出补传、加密 Coordinator 重启不重跑；失败指导及图片加密草稿重启恢复一次。
- 真实本机 HTTP 子任务桥和 MCP 携带超过旧 96 KiB 限额的中文 / emoji 请求；非法超限在创建前拒绝。

本轮不调用外部付费模型，测试 Provider 是捕获实际传入参数的 runtime fixture。外部模型自身的上下文窗口、费用、限流仍由该 Provider 决定，超出模型窗口会返回错误；应用不静默裁剪用户原文来规避它。另一个并行开发的群聊任务生成入口有独立限制，未在此批重定义。UI 文案 / 禁用按钮和 TypeScript 构建与服务层测试分开验收。
