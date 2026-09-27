# Cindy 与 Agent 接入（本地开发版，2026-09-27）

本页保留早期开发验收背景。当前版本为 macOS 0.5.0-beta.3；独立实现，未复制 Raft 代码。

**更新：以下保留上一轮验收背景。本轮已增加 8 步弹窗、私人 Cindy 会话、持久配置草稿、群聊唤醒与完整成员配置入口。当前操作与边界以 [Agent 管理与协作](AGENT-MANAGEMENT.md) 为准。**

## 用户路径

1. 进入项目 → Cindy「上手与配置 Agent」。无 Agent 的项目显示「开始上手」入口。
2. 连接 Cindy：检测电脑执行服务，选择项目工作文件夹，安装/登录本机 Codex 或 Claude Code，选择模型、推理强度。
3. 新建名为 Cindy 的独立 Agent 会话。Cindy 不是项目，也不替换已有 Agent。接入前的文案明确为说明，并非模型回答。
4. 问 Cindy 项目目标、团队分工或产品用法。走真实 ProviderRuntime 协议和独立持续会话，包含当前项目/成员/任务状态。默认只读。
5. Cindy 的动作卡打开实际添加 Agent / 创建任务表单，或邀请、成员、讨论、产物页。模型输出不能直接获得创建、运行、发布权限；未知动作忽略。
6. 多个 Agent 可以使用同一个账号，各有独立会话、名称、职责和模型。已有本应用内自己的未注册会话也能接入。AI 成员面板可修改名称/职责，原始会话可调整模型。
7. 同事加入团队后，在自己的机器走同样接入流程，再通过共享任务参加协作；不能远程替别人登录或占用其账号。
8. 引导按用户和项目保存于 Hub。关闭/稍后继续后可重开。进度从真实电脑/Agent/任务/产物状态计算。已有任务不会被自动启动。

## 存储与边界

- 引导状态和用户提问存入现有加密 Hub 数据；每人只能读取自己的引导进度。
- Cindy 的原始共享会话、对话输出仍按现有团队权限可见，UI 明示“团队共享”，**不是 Raft 的私人 onboarding channel**。
- 账号登录、授权码沿用本机账号 UI，不经过 Cindy 对话。
- 发送去重绑定 requestKey + 原文；重试不重复启动；一次运行未结束不开始第二轮。
- 每次发送校验当前成员写权限、项目边界、Agent 持有人、运行目录和本机登录状态。
- 模型的操作卡仅预填白名单字段。创建 Agent / 任务仍走原有服务端授权。
- Cindy 停止按钮可停止本轮；工具权限等待/错误可在完整会话中处理。
- 已注册成功但后续模型配置失败时保留 Agent 标识，重试配置不会再次创建。

## Raft 官方文档核对

| 官方能力 | 本地实现与边界 |
| --- | --- |
| [Meet your Onboarding Agent](https://docs.raft.build/meet-your-onboarding-agent/)：电脑 → runtime / provider / model → Cindy 对话 | 桌面应用内置执行服务；本机 Codex / Claude Code 安装、登录、模型选择；实际 Cindy 会话与回答 |
| [Build your agent team](https://docs.raft.build/build-your-agent-team/)：名称/职责/runtime、多机器、多 Agent | 本机独立 Agent 会话、职责修改；同事自行接入机器，通过共享任务协作；未做远程托管电脑管理 |
| [Hand off your first task](https://docs.raft.build/hand-off-your-first-task/)：描述 → 任务 → 执行 → 复核 | Cindy 提案打开任务表单；现有看板、共享会话、独立协作通道和 DRI 验收 |
| [Bring in your teammates](https://docs.raft.build/bring-in-your-teammates/)：邀请同事 | 管理员邀请入口、受邀成员专用说明、实际角色检查 |

不宣称完整 Raft 平台功能对等。其他 runtime（Gemini、Cursor、OpenCode 等）不在此次向导内；没有新增官方托管模型、私密频道、自动跨 Agent 唤醒/值班、后台独立 Computer daemon、自动次日回访、通知/社区推荐步骤。项目任务、产物审批与 GitHub 发布沿用现有实现。上手主路径完整可操作，以上额外能力仍需单独实现。

## 验证

- `tests/project-collaboration.test.mjs`：真实 Hub + 多个成员，验证本机持有权、只读运行、幂等重试、进度隔离、状态续接、只读成员拒绝。
- `scripts/cindy-desktop-check.mjs`：真实 Electron / Hub / ProviderRuntime + 合成 Provider CLI 协议响应，连接 Cindy、实际回答展示、动作卡到独立 Agent、重开后保留对话。
- 测试不调用真实付费模型、不发邀请消息、不写 GitHub，不修改已安装正式版或用户现有任务。

## 真实运行补验（2026-09-27）

重新打包 `.app` 后，使用本机已登录 Codex 成功完成真实 Cindy 对话（非 fixture）。返回了基于现有项目/Agent/任务的“配置方案复核搭档”卡片。记录：`artifacts/cindy-preview/real-result.json`。应用包包含生产 onboarding 代码，未包含测试脚本。原示例项目的任务未启动。后续与 Raft 对齐的工程方案见 `RAFT-AGENT-CONFIG-PLAN.md`。
