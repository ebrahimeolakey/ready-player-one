# Agent 配置工程方案（2026-09-27，本地审阅）

## 已完成和本轮真实验证

Cindy 在主代码中：`src/Cindy.tsx` → `collab.onboarding.*` → Hub `run.request` / `run.claim` → ProviderRuntime → 本机 Codex / Claude。模拟响应仅存在测试 fixture。

本轮重新构建 `release/mac-arm64/头号玩家.app`，检查 app.asar：包含 onboarding 后端和主应用入口，不含 scripts/tests/artifacts。构建及 ad-hoc 签名验证通过。未推送 GitHub、未发布。

在这个打包应用中，用已有本机 Codex 账号真实调用 Cindy。结果保存于 `artifacts/cindy-preview/real-result.json`。运行成功，Cindy 根据真实的「项目助手1Claude」和「准备项目第一版方案」返回配置复核搭档的卡片。原任务未启动。此次使用原本的独立本地开发数据目录，未覆盖已安装旧版的生产数据。测试生成了一个真正的 Cindy Agent 及其 Provider 会话。

## Raft 已核实行为

2026-09-27 查阅官方实时文档；文档与此前源码快照有差异时，以当前文档为准。比如 External Claude Code 已有接入说明，旧源码知识文档里的 coming soon 已过时。

- [Agent Basics](https://docs.raft.build/zh-cn/features/agents/)：持久成员身份，名称/描述、所属电脑、runtime；新会话与 Agent 身份是不同概念。
- [Runtime](https://docs.raft.build/features/agents/runtime/)：本机订阅，检测已安装运行时；可换 runtime/model，下次以新底层会话开始，保留身份/工作空间/记忆。
- [Computers](https://docs.raft.build/zh-cn/features/server/computers/)：电脑是执行位置，本机服务管理进程与消息，重启/诊断/升级，与团队服务器分开。
- [Workspace](https://docs.raft.build/features/agents/workspace/)：每 Agent 独立持久目录；会话重置不删除工作目录。作者/管理员可浏览内部文件。
- [Lifecycle](https://docs.raft.build/features/agents/lifecycle/)：消息、提及、提醒触发；停止、恢复、清空会话、完全重置含义不同。
- [Reminders](https://docs.raft.build/features/agents/reminders/)：绑定消息/线程的持久定时唤醒，可单次或重复、取消或推迟。
- [Server Management](https://docs.raft.build/features/server/management/)：团队指定或关闭入职引导 Agent；新 Agent 欢迎开关；成员角色与邀请、入群协议。
- [Channels](https://docs.raft.build/features/messaging/channels/)：频道成员资格决定消息投递，私密频道决定读取边界，不能仅靠前端隐藏。
- [External Agents](https://docs.raft.build/features/agents/external/)：托管型由 Computer 启动；外接型自己运行，通过设备授权+CLI/桥接加入。登录成功与真正连接是不同状态。当前文档包含 Hermes 与 Claude Code 路径。
- [Connected Apps](https://docs.raft.build/features/apps/)：团队安装外部应用与 Agent 独立授权；不是默认继承人的所有第三方账号。
- [投资团队教程](https://docs.raft.build/tutorials/investing-research-team/)：Walter / Clara / Marcus 是用户创建的示例角色（统筹、调研、风控复核），用 Codex CLI。不是必须购买的三个官方云 Agent。

源码快照 `05f7d8fd77d2535f993d5d90b85118438bc18216` 的 AgentDetailPanel 有 Profile、Activity、Chat、Reminders、Workspace、Apps、MCP；Profile 公共，其余内部页面限制访问。本方案参考行为，独立实现。

## 拟采用的数据关系

- TeamMember / AgentIdentity：稳定身份、拥有者、简介、头像、成员角色。
- AgentRuntimeBinding：电脑、运行时、模型、配置修订、默认执行范围。密钥仅本机存储，不进团队快照。
- AgentProjectMembership：加入哪些项目/群，能读哪些上下文。
- RuntimeSession：底层 Codex / Claude 会话，可继续、归档或重置；历史保留。
- TaskSession：任务看板卡片的共享协作空间，多位 Agent 各有独立执行通道。

沿用“创建独立会话可成为新 Agent”的入口，同时允许已有 Agent 重置底层会话而不丢身份。不要把每次恢复都误建为新成员。任务会话属于工作，Agent 身份属于成员；不再用项目冒充成员。

## 原分阶段方案

**2026-09-27 更新：核心管理与协作已落地。逐项实现、真实验证和边界见 [Agent 管理与协作](AGENT-MANAGEMENT.md)。下面保留设计背景，不作为功能完成声明；完整私密频道 ACL、各家第三方云应用、系统自动启动守护进程仍未实现。**

### 1. 统一配置面板与 Cindy 配置执行

点击任何 AI 成员打开侧栏：

- 概览：名称、头像、分工、持有人、电脑、实际状态。
- 运行：账号、runtime、模型、推理强度；在停止后切换 runtime，记录新配置修订，保留旧执行记录。
- 协作：参加的项目、可见范围、是否响应 @、是否订阅群聊、可接受的任务范围。
- 记忆与文件：独立 Agent 记忆和工作目录；项目共享上下文与共享产物另列，绝不把全部私有目录默认为团队文件。
- 高级：工具/MCP/外部连接、环境配置、提醒、诊断与重置。按能力显示真实已支持选项。

Cindy 使用同一份配置模型和表单，不再维护一套旁路。对话生成服务端保存的配置草稿；卡片显示最终机器/身份/模型/范围；点击后直接提交受权限校验的操作，返回创建结果并继续下一步。配置新成员不自动运行项目任务。不把未登录或未安装状态显示为完成。

把 Cindy 提升为团队级可选择的引导身份，支持关闭/替换；新加入的人进入自己的 onboarding 会话。实施私密引导前先完成服务端 ACL、事件过滤、上下文过滤、搜索/导出隔离和持有人同意的运行授权，不能只更改 UI 的“私密”标签。

验收：真实 Claude 与 Codex 各创建一个 Agent → 修改模型 → 重启应用配置仍在 → 重置会话身份/记忆不丢 → 另一成员无法改本机凭据或查看私密引导。

### 2. 群聊触发和自主协作

Hub 持久事件收件箱按成员资格投递 → Agent 运行策略判定 → 本机 worker 拉取并租约认领 → 真实 runtime 回答、认领/移交任务 → 共享任务会话汇总产物。

默认 @ 提及和任务指派触发；Agent 持有人可以开启“参与群讨论”和允许其在指定范围自动处理任务。授权持久保存，不要求每一句对话重新设置账号。不同人的 Agent 由各自的 worker 执行。人工暂停优先；不能因重连重复执行。

工程约束：事件去重、每 Agent 串行队列、跨电脑租约、防互相无限唤醒、并发/额度设置、失败可见、离线待处理、消息游标。补丁写入、外部发布沿用权限和 DRI 验收路径。

验收：A @ 自己 Agent → B 的 Agent 被邀请加入同一任务 → B 的真实 worker 执行 → 相互复核的消息在群里可见 → DRI 批准确切产物版本 → 主动发布 GitHub。断线后消息不丢、不会重复执行外部操作。

### 3. 独立电脑服务、定时与扩展接入

拆分可单独运行的本机 worker，提供启动/停止/诊断与电脑列表。关窗口与关电脑分别说明；电脑关机不承诺本机 Agent 继续工作。Hub 仍须有人托管，worker 不代替 Hub。

加入持久提醒和可观察的执行历史。再实现外部 Agent 设备授权与接入指引，逐个适配额外 runtime；不把全部 CLI 历史会话扫描后默认共享。工具/MCP 与应用授权按 Agent/团队范围配置，沿用 runtime 的真实能力检测。

## 产品表面

顶层继续保留项目群、任务看板与产物。群聊负责讨论与分工，任务卡负责共享执行和 IDE，产物页负责工作中的版本和验收。身份与运行配置收在 AI 成员面板；电脑服务与团队引导设置收在设置。避免另造一套平行导航。
