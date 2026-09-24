# 重叠提醒：规则、输入与边界

核对日期：2026-09-24。Amoeba 的[官方说明](https://useamoeba.com/blog/stop-ai-agents-editing-same-file)和[协作文档](https://useamoeba.com/docs/collaboration/live-sessions)描述：比较分支、打开的文件、计划路径和任务描述，在运行前报告重叠或相邻工作，并带上队友与会话信息；文件锁属于协调建议，不是操作系统写入屏障。官方材料没有公布具体相邻识别算法，不能据此断言采用了语义模型。

本实现使用确定性规则 `deterministic-v1`，不调用语义模型。原有目录前缀比较被保留，并补齐了以下输入和解释。

## 实际参与比较的信息

- 同一工作区中的活动会话，排除归档会话、已移除成员和当前通道自身。
- 当前待审批/执行的请求范围。执行中只使用 `activeRunId` 对应审批，不拿旧 claimed 请求代替当前任务。
- 当前通道发布的打开文件和实际分支，默认 120 秒有效；新一次发布替换旧的打开文件列表。
- 最近发布的真实 Git 变更路径，120 秒有效。超过期限且没有其他活动依据的记录不会继续充当活动文件。
- 未完成的关联计划：显式 `planIds`，或兼容旧调用时关联当前负责人的步骤；计划可声明结构化路径，也会从文本中提取明确相对路径。
- 新提示词、其他任务提示词、会话标题/描述和关联计划中的相同关键词。英文有停用词过滤；中文目前只比较相同连续词串，不做分词、同义推断或语义相似度判断。
- 当前工作区尚未过期的建议性路径锁。

`file` 只与同一文件或包含它的 `directory` 相交；`directory` 在路径段边界匹配后代，例如 `src/auth` 包含 `src/auth/token.ts`，不包含 `src/authentication.ts`。旧版 `files:["src/auth"]` 没有种类信息，保留前缀兼容并标记 `unknown`；精确的调用方应使用 `fileScopes`。目录末尾的 `/` 或 Windows 分隔符会标准化。没有 glob 解释或文件系统真实占用判断。

同路径跨分支也会提醒，但明确说明是后续集成风险。仅关键词相近时只在同分支给出 `adjacent` 建议，不把分支相同本身当作冲突。显式关联同一步计划会保留该计划 ID。锁的冲突判断仍是本应用工作区范围的协调约定，不阻止写入，也不强制阻止一个已被独立审批的任务启动。

## 接口

`coordination.activity {sessionId,laneId,branch?,fileScopes?,files?,planIds?,ttlMs?}`：仅通道本人且具有 Editor 权限可发布。`ttlMs` 为 1 秒至 5 分钟，默认 120 秒。主进程应读取实际 Git 分支；UI 每 45 秒更新打开文件。Hub 不会把客户端声明当作已验证的磁盘事实。关闭文件时发布空列表；停止心跳则自动过期。

`coordination.check {sessionId,laneId,prompt?,branch?,fileScopes?,files?,planIds?}`：同样校验本人权限，无状态变更，返回：

```js
{
  algorithm: 'deterministic-v1', advisory: true, checkedAt,
  details: [{
    sessionId, sessionTitle, laneId, ownerId, owner,
    kind: 'overlapping' | 'adjacent' | 'lock',
    confidence: 'high' | 'advisory',
    currentBranch, otherBranch,
    branchRelation: 'same' | 'different' | 'unknown',
    files, planIds, evidence, reason,
    algorithm: 'deterministic-v1', advisory: true
  }]
}
```

`evidence` 保留两端的路径、种类及来源（`declared/open/changed/prompt/plan/lock`），计划 ID、共同关键词或同一步骤依据。`high` 表示有明确路径/锁证据，不表示冲突概率或必然发生代码冲突。前端保留旧的 `reason/confidence/files` 消费方式即可显示详情。

`plan.add` 接收 `files` / `fileScopes`；`run.request` 和 `run.queue` 接收 `fileScopes/planIds/branch`。队列出队完整保留这些字段；关联计划已经完成或不存在时请求会拒绝，队列不会静默丢失范围。审批允许和首次领取前重新计算提醒，避免仅保留请求创建时的旧观察。新提醒仍然是建议，不隐式改变既有工具审批。

Agent MCP 提供 `rpo_overlap_check`，固定到启动时绑定的会话/通道，不能通过工具参数替换工作区身份。`rpo_plan_add` 可写入结构化计划范围，`rpo_lock_acquire` 可声明 file/directory 种类。

## 验证与限制

Hub 测试覆盖不同成员、不同分支、不同工作区、同名邻接目录、精确文件与目录范围、文件替换/过期、Git 变更过期、计划路径与步骤关联、已完成计划、错误成员操作、TTL、旧运行排除、审批刷新、建议锁不阻止已批准执行、队列保留范围和 MCP 作用域约束。测试通过真实 Hub 的权限与状态操作触发，不仅直接比较工具函数输出。

输入缺失、分支过旧、未声明路径、离线成员或自然语言没有相同关键词时仍可能没有提醒。某些被引用的文件并不实际会写入，因此也可能提示过多。它不替代 Git 三方合并、diff 审阅、测试或成员之间的确认，也不证明与 Amoeba 未公开的内部算法等价。
