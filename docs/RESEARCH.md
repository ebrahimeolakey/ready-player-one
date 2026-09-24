# Amoeba 调研与功能映射

调研日期：2026-09-24。目标是复刻 Agent Session Share 的交互与工作流，以独立中文实现替代云端依赖。

## 观察依据

本机安装：`/Applications/Amoeba.app`。product 元数据标示产品版本 0.1.38、VS Code 基础版本 1.130.0。安装目录包含 VS Code 工作台和 `amoeba-runtime` 下的 daemon、MCP、shared 等模块。

仅检查了软件包元数据、模块结构以及少量配置 / 事件接口文件，并观察实际界面；没有访问或复制用户的 Amoeba 登录凭据、私有会话数据库或云端内容。项目实现代码从零编写，没有直接分发原应用的 JavaScript bundle。

本机实际界面包含工作区与 Sessions / People 导航、文件编辑器、底部 Agent 面板、提供商选择及会话成员侧栏。

## 官方公开行为

- [核心概念](https://useamoeba.com/docs/concepts/workspaces)：workspace 包含代码仓库和成员；session 是共同任务、分支和计划；每个参与者拥有自己的 lane；Mission Control 聚合进度；Brain 提供共享记忆。
- [智能体工作流](https://useamoeba.com/docs/agents/providers)：成员在本机连接自己账号下的 Codex 或 Claude Code；提示、接力及并行子任务围绕共享会话组织。
- [协作](https://useamoeba.com/docs/collaboration/live-sessions)：实时通道、计划、评论、文件范围重叠提醒和任务交接。
- [Git 与代码](https://useamoeba.com/docs/git/repositories)：本机仓库和独立工作树，实时审阅与 Git 同步。
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)：本实现使用本机 `codex exec --json`，并以安装版本的 CLI 帮助核对 sandbox 和参数。

## 本地替代设计

| 观察到的结构 / 行为   | 头号玩家实现                                         |
| --------------------- | ---------------------------------------------------- |
| Amoeba 云端 Brain     | 本机 Hub 持久化共同计划、会话、审批、记忆            |
| 云端组织、GitHub 身份 | 工作区范围、限时随机邀请、本机成员身份               |
| 每个成员拥有 lane     | owner ID 绑定 Agent 通道，非所有者不能执行或伪造输出 |
| 本机 provider adapter | 独立编写的 Codex JSONL / Claude stream-json adapter  |
| 实时共享界面          | WebSocket 同步通道消息、计划、讨论、审批和 diff      |
| 文件重叠判断          | 对显式声明的文件路径做精确碰撞提示                   |
| 共享上下文接力        | 新通道执行带入其他通道最近对话、共同计划与记忆       |
| Git worktree          | 本机 Git 命令创建独立分支和工作目录                  |
| VS Code 工作台        | 独立 Electron + React + CodeMirror 中文桌面工作台    |

## 尚未达到原版等价的部分

云端组织、跨公网中继、精细成员角色、逐工具远程审批、提供商原生 session 接管、字符级多人编辑、自动代码快照同步、语义碰撞模型、完整 VS Code 生态。README 明确列出当前行为与边界，避免把核心复刻称作完整原版替代。
