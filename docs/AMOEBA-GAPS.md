# 与 Amoeba 的功能差距

核对日期：2026-09-24。基线：Amoeba 官方发布日志的 0.1.38，以及头号玩家 0.3.0-beta.1 的实际源码。仅比较原产品功能，不按特定行业重新规划。

证据范围：原版核心界面曾在本机观察；下表其余原版行为来自官方文档和发布日志，并非所有功能都经过双机实测。官网部分概念页落后于发布日志，例如配额计费界面已在 0.1.34 移除，因此不将其列为待补功能。此表取代旧调研中的笼统缺口列表。

## 核心协作

| 项目 | 原版公开描述 | 头号玩家目前 | 尚需补齐 |
| --- | --- | --- | --- |
| 代码同步 | 会话分支通过 Git remote / shadow refs 同步快照，冲突保留两个版本 [来源](https://useamoeba.com/docs/git/repositories) | 每 3 秒显式发布 diff；不会更新同事的文件 | 快照提交与传输、三方校验、冲突查看及恢复 |
| 执行中引导与接管 | 运行中追加指令、安全检查点接管、更换承担执行的账号 [来源](https://useamoeba.com/docs/agents/providers) | 每次启动新的 CLI 执行，拼接部分最近上下文；运行中拒绝新请求 | 引导、队列、接管状态机、上下文与代码交接、用量不足后的接力 |
| 并行子 Agent | 主通道继续，子任务在独立 worktree 中运行，通过检查后一次性集成 [来源](https://useamoeba.com/docs/agents/providers) | 可以手动开多个通道和工作树 | 父子任务关系、子任务进度、候选成果检查和合并 |
| 工具审批 | 对具体命令、网络或写入动作单独授权，执行端落实 [来源](https://useamoeba.com/docs/admin/members) | 一次任务启动前审批，未桥接 Provider 的每个工具权限请求 | 原生权限事件适配、逐动作审批、一次性执行授权 |
| Agent 协调 | CLI hooks / MCP 读取实时上下文、认领步骤、拆分任务、互相发消息和写记忆 [来源](https://useamoeba.com/docs/help/troubleshooting) | 启动时将计划、记忆和最近对话拼入提示词 | 持续可调用的协作工具与实时状态回读 |
| 重叠检测 | 结合分支、活动文件、计划与任务描述；提供建议性文件锁 [来源](https://useamoeba.com/blog/stop-ai-agents-editing-same-file) | 只比较用户声明文件路径是否完全相同 | 相邻任务识别、提示的上下文、文件锁获取与释放；原版的锁也不是操作系统写入屏障 |
| 断线恢复 | 协调不可用时本机继续，重连恢复；中断动作不盲目重试 [来源](https://useamoeba.com/docs/agents/providers) | 连接恢复存在，但断线会停止本机 Agent | 单机继续模式、事件补传、快照新鲜度、执行结果未知的处理流程 |

## 会话、账号与界面

| 项目 | 原版公开描述 | 头号玩家目前 | 尚需补齐 |
| --- | --- | --- | --- |
| 计划与评论 | 步骤负责人和状态、转交；评论锚定代码范围或 diff，并可发起 Agent [来源](https://useamoeba.com/docs/collaboration/live-sessions) | 创建者 + 勾选清单、文本评论与简单锚点 | 分配与接收工作、步骤转交、精确锚定、评论转任务 / Agent、过期锚点提示 |
| 共享 Brain | 记忆绑定文件和 commit，代码变化后标记过期并更新 [来源](https://useamoeba.com/docs/concepts/workspaces) | 手动添加、停用、恢复普通文字记忆 | 文件和版本关联、Agent 写入、失效检测及更新 |
| Mission Control | 聚合任务进度、活动文件、执行账号和待处理事项 [来源](https://useamoeba.com/docs/concepts/workspaces) | 会话卡片、状态、成员、搜索及基础审批 | 一处处理接管 / 冲突 / 审批，完整进度及活动汇总 |
| 团队身份与角色 | GitHub 登录和用户名邀请；Viewer / Commenter / Editor / Owner [来源](https://useamoeba.com/docs) · [角色](https://useamoeba.com/docs/admin/members) | GitHub 只用于仓库授权，协作采用本机身份与临时邀请 | 账号绑定的团队成员、角色服务端校验、只读观看、稳定邀请与移除成员 |
| 托管协调与数据 | Brain 保存协作记录；转录脱敏、加密存储及保留周期 [来源](https://useamoeba.com/docs/admin/members) | 房主本机 JSON / JSONL、临时 Cloudflare 通道；凭据不入房间 | 常驻协调、稳定身份和地址、转录脱敏、静态加密、保留与清理策略；TLS 传输不等于静态加密 |
| Provider 与输入 | 发布日志包含自定义兼容 API、模型目录与推理强度、队列、语音、图片预览和未完成输出流 [来源](https://useamoeba.com/changelog) | Codex / Claude 基础登录执行、文本输入、部分消息 / 工具事件 | 模型选择及持久化、自定义 API、语音 / 图片、队列、更细的流式输出 |
| 编辑器与终端 | 完整桌面编辑体验，原生 Agent 与 CLI 终端两种入口 [来源](https://useamoeba.com/docs/git/repositories) | CodeMirror 文本编辑、搜索、单条命令终端（60 秒） | 交互式 PTY、CLI 快捷键透传、更完整 Git 提交 / 审阅流程；完整语言服务、调试与扩展兼容性仍需逐项验收 |
| 其他界面与分发 | 内置浏览器、系统通知、自动更新、签名公证、Windows / Linux 发布 [来源](https://useamoeba.com/changelog) | 核心页面布局近似；Mac 两架构未签名 ZIP | 浏览器、通知、更新、签名公证、跨平台适配及全部页面 / 状态的视觉对照 |

## 已具备的基础

本地 Codex / Claude 登录、GitHub 仓库授权和克隆、多通道会话、实时对话共享、任务级审批、共同清单和评论、普通共享记忆、基础 worktree、显式 diff 发布、临时公网邀请、归档和导出。

这些是核心流程的初步实现，并不等于对应原版功能全部完成。尤其「实时对话」不等于代码实时同步，「多通道」不等于子 Agent 编排，「新执行带上下文」不等于安全接管。

## 建议补齐顺序

1. 代码快照同步与冲突处理。
2. 持续会话、执行中引导、安全接管、逐工具审批。
3. MCP / hooks 协调与子 Agent 工作树集成。
4. 团队角色、常驻协调及完整恢复机制。
5. Provider / 模型、编辑器 / 终端、全部 UI 状态与正式分发。

这是按接近 Amoeba 核心协作体验排序的建议，不是已经承诺或完成的功能。企业 SSO、端到端加密、无冲突保证、Provider 内部 session ID 跨机器迁移，没有充分证据证明原版提供，不能当成它已实现的对标项目。
