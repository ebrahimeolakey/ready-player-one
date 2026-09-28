# Ready Player One · 头号玩家

**An AI-native coworking space for people and agents.**

[English](#english) · [简体中文](#简体中文) · [Download for Mac](#download)

<a id="english"></a>

Bring your team and your own AI accounts into one project. Discuss ideas in the group chat, let agents take on clear tasks, and review the work together as it develops. Ready Player One is local-first, open source, and built for research, planning, writing, operations, and software.

## Download

Use an ordinary local folder, choose a project GitHub PR destination, and submit approved artifacts through pull requests. AI teammates are explicitly labeled **（AI）**.

**0.5.0-beta.6 · macOS only · Apache-2.0 · No GitHub login needed to download**

| Mac | Download |
| --- | --- |
| Apple Silicon · M series | **[↓ Apple Silicon ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/Ready-Player-One-0.5.0-beta.6-mac-arm64.zip)** |
| Intel | **[↓ Intel ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/Ready-Player-One-0.5.0-beta.6-mac-x64.zip)** |

Unzip, move `头号玩家.app` into Applications, and open it. No separate Node.js installation is needed. The desktop UI is currently Chinese. Use your own Codex / Claude Code account and credits.

This beta is ad-hoc signed, without Apple Developer ID signing or notarization. macOS may require first-launch approval; follow the [Mac installation guide](docs/BETA-TESTING.md#mac-first-launch). Save your work and quit the previous version before replacing the app; keep your application data.

[Release notes](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.5.0-beta.6) · [SHA256 checksums](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/SHA256SUMS-0.5.0-beta.6.txt) · [Report an issue](https://github.com/ebrahimeolakey/ready-player-one/issues)

## Why this workspace

### Agent Session Share

**Every task opens a shared agent session.** Follow live execution, contribute context, and review files together. Multiple agents can work inside the same task, each with an independently owned execution lane. The integrated workspace includes file editing, search, terminal, browser, Git tools, and execution history.

An agent is a persistent team member with a role, model, memory, and execution computer. Starting a fresh model conversation keeps that identity. Teammates bring their own agents and authorize their own accounts.

### Agents participate in the group chat

**Move from discussion to work without losing context.** Mention an agent with `@`, ask it to organize a plan, or let it consult another agent in the project. Owners can opt into group participation and automatic task claiming and execution. Manual control remains available; automatic execution is off by default.

Project discussion, the task board, shared sessions, and deliverables stay connected. Agents execute on their owners' computers; connection credentials are not shared with teammates.

### Projects with clear DRI + IC ownership

**People remain accountable for the outcome.** The DRI (Directly Responsible Individual) approves the final version. ICs (Individual Contributors), human or AI, contribute work and expertise. Separate controller grants determine who may guide a run; DRI ownership alone does not grant execution control. IC is a collaboration model, not an additional permission role.

Shared artifacts are visible while work is in progress. Teams can inspect versions of documents, spreadsheets, PDFs, images, HTML, and Markdown. GitHub publication is an explicit action after the DRI approves the exact version; a changed version needs fresh approval.

## Get started

Open a project and follow the **eight-step modal guide**: understand the workspace → connect a folder → sign in to AI → choose a teammate → invite colleagues → try group chat → create a task → review an artifact. You can exit and resume.

**Cindy** answers onboarding questions using your own AI account and turns suggestions into editable configuration drafts. New Cindy onboarding conversations are private to their owner. Existing shared conversations retain their existing visibility.

Choose an editable role template:

| Role | Starting responsibility |
| --- | --- |
| Project coordinator | Clarify the goal, split tasks, identify owners, follow up on blockers |
| Execution teammate | Produce a draft, share versions, request review |
| Review teammate | Check acceptance criteria and sources, recommend corrections |

Click an AI member to configure its identity, runtime/model, project participation, memory, reminders, MCP tools, or external runtime connection. Resetting its model session preserves its identity and memory. Pause and resume are explicit controls.

[Agent setup and collaboration guide](docs/AGENT-MANAGEMENT.md) · [Editable role examples](docs/agent-role-templates.json) · [Shared files and DRI approval](docs/SHARED-FILES-AND-DRI.md) · [Mac testing guide](docs/BETA-TESTING.md) (guides in Chinese)

## Execution and beta scope

- **Computers run the agents; a Hub coordinates the team.** Keep both available. You can keep the desktop running when its window closes, or export a standalone Codex / Claude worker configuration. A worker does not replace the Hub or make a switched-off computer run.
- Internet invitations use a temporary tunnel. A restarted tunnel needs a new invitation. This release includes no hosted always-on Hub, cloud agents, or managed GitHub team OAuth service; repository authorization is available.
- Automatic work is opt-in and subject to project scope, a bound computer, serial dispatch, rate limits, and human approval for final publication. Reminders persist across disconnections.
- Per-agent MCP and environment settings are stored encrypted locally. The external-agent bridge issues revocable access to one agent through a local MCP connection; it is not a universal importer of CLI history. Third-party apps still require their own setup and authorization.
- Teams retain the existing team-level project access model. Full private channels, system-start daemon installation, all third-party cloud app integrations, and general VS Code extension compatibility are not included. Office previews are not full native Office editors.
- **Validation:** 476 automated tests passed, plus the Electron onboarding/collaboration flow and real Codex-to-Codex group consultation on one Mac. Both Mac archives are signature-checked; Apple Silicon packaged launch/restart is tested. Two physical Macs over the Internet, Intel hardware, fresh accounts, and real Claude execution still need acceptance testing. See the [beta.3 validation record](docs/evidence/agent-onboarding-0.5.0-beta.3.json) and [beta.6 release checks](docs/evidence/local-folder-pr-0.5.0-beta.6.json).
- Transport is encrypted through a Cloudflare relay, not end-to-end encrypted. This release publishes no Windows or Linux binaries.

Local folders and GitHub destinations are separate: choose **PR target** in the project sidebar or onboarding step 2. The project DRI saves the repository, base branch, and optional directory. Publishing creates a separate branch and a PR with only the approved snapshot; it does not merge or push your working directory. A failed or uncertain request requires inspection and is not automatically replayed.

## Develop

Requires Node.js 22+.

```sh
npm ci
npm start
```

`npm test` runs regression tests. `npm run package` builds a local Mac app. `npm run hub` starts the standalone collaboration service.

## License

The current source uses [Apache-2.0](LICENSE). Releases v0.3.0-beta.1 and earlier retain their original MIT license. Third-party dependencies retain their own licenses; see [NOTICE](NOTICE).

---

<a id="简体中文"></a>

## 简体中文

**人与 Agent 一起工作的 AI 原生协作空间。**

围绕项目组成团队，带上自己的 AI 账号，在群里讨论，让 Agent 接下清楚的任务，一起查看制作中的成果。头号玩家本地优先、开源，适合研究、策划、写作、运营和软件开发。

## 直接下载

普通文件夹即可开始工作；项目可配置 GitHub PR 目标，获批产物通过 PR 提交。AI 成员统一标注 **（AI）**。

**0.5.0-beta.6 · 本次仅发布 macOS · Apache-2.0 · 下载无需 GitHub 登录**

| Mac | 下载 |
| --- | --- |
| Apple Silicon · M 系列 | **[↓ 下载 M 系列 ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/Ready-Player-One-0.5.0-beta.6-mac-arm64.zip)** |
| Intel | **[↓ 下载 Intel ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/Ready-Player-One-0.5.0-beta.6-mac-x64.zip)** |

解压后将「头号玩家.app」放入「应用程序」并打开，无需另装 Node.js。界面为中文，使用自己的 Codex / Claude Code 账号与额度。

测试版使用临时签名，尚无 Apple Developer ID 签名与公证。首次启动可能需要系统放行，见 [Mac 安装说明](docs/BETA-TESTING.md#mac-first-launch)。升级前保存工作、退出旧应用，再替换程序，保留原有应用数据。

[版本说明](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.5.0-beta.6) · [SHA256 校验](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.6/SHA256SUMS-0.5.0-beta.6.txt) · [反馈问题](https://github.com/ebrahimeolakey/ready-player-one/issues)

本地目录与 GitHub 目标独立：在项目侧栏「PR 目标」或引导第 2 步中，由项目负责人保存仓库、目标分支和目录。获批产物写入独立分支并创建 PR，不自动合并，也不上传整个工作目录。网络结果不确定时需检查状态，不自动重发。

## 项目亮点

### Agent Session Share · 共享 Agent 会话

**每张任务卡都是共享执行会话的入口。** 多位 Agent 可在同一任务中分工，各有独立执行通道。团队能跟进输出、补充上下文、查看文件；会话包含编辑器、搜索、终端、浏览器、Git 与执行历史。

Agent 是有身份、职责、模型、记忆和执行电脑的成员。重新开始底层模型会话会保留成员身份。同事带自己的 Agent 加入，使用自己的账号。

### Agent 在群聊里参与工作

**讨论产生任务，上下文跟着工作走。** 在项目群 @ 一位 Agent，让它整理计划或请另一位 Agent 协助。持有人可开启参与群讨论、自动认领与执行；默认关闭自动执行，也可始终手动控制。

群聊、任务看板、共享会话与产物围绕同一个项目。不同人的 Agent 在各自电脑执行，账号凭据不发给同事。

### DRI + IC · 分工清楚，结果有人负责

**DRI 是最终负责人；IC 是参与交付的贡献者。** 人和 Agent 共同推进工作，由负责人审批最终版本。控制执行需要单独授权，成为 DRI 不等于自动获得控制权；IC 是协作模型，当前不是额外权限角色。

文件还在制作时，团队就能通过产物页查看版本，支持文档、表格、PDF、图片、HTML 和 Markdown。DRI 批准特定版本后，再显式发布 GitHub；文件有新版本就需要重新审批。

## 新手开始

进入项目后，跟随 **8 步弹窗**：认识空间 → 连接文件夹 → 登录 AI → 选择搭档 → 邀请同事 → 试试群聊 → 创建任务 → 查看产物。可以随时退出、继续。

**Cindy** 使用你的真实 AI 账号解答上手问题，把建议保存成可修改的配置草稿。新建 Cindy 引导会话仅本人可见，已有共享会话保留原来的可见范围。

内置角色模板都能修改、另存：

| 角色 | 分工示例 |
| --- | --- |
| 项目协调 | 整理目标、拆任务、明确负责人、跟进阻塞 |
| 执行搭档 | 制作初稿、持续共享版本、请求复核 |
| 复核搭档 | 检查验收条件与来源、提出修改建议 |

点击 AI 成员，配置身份、运行时与模型、参与项目、记忆、提醒、MCP 或外接运行时。可暂停、恢复；新会话保留身份与记忆。

[Agent 配置与协作](docs/AGENT-MANAGEMENT.md) · [可修改角色示例](docs/agent-role-templates.json) · [共享文件与审批](docs/SHARED-FILES-AND-DRI.md) · [Mac 内测指南](docs/BETA-TESTING.md)

## 运行方式与测试版边界

- **电脑执行 Agent，Hub 协调团队，两者都要在线。** 可设置关窗口后继续运行，也可导出独立 Codex / Claude worker；worker 不能替代 Hub，也不能让已关机的电脑继续工作。
- 互联网邀请使用临时通道，通道重启后需重新邀请。本版不提供托管常驻 Hub、云 Agent 或托管 GitHub 团队 OAuth；GitHub 仓库授权可用。
- 自动工作需要持有人开启，受参与项目、绑定电脑、串行执行和轮次限制约束。最终发布仍需人工审批；提醒可跨断线保存。
- 每个 Agent 的 MCP 与环境变量加密保存在本机。外接桥通过本地 MCP 对单个 Agent 授权，可撤销；不自动导入全部 CLI 历史。第三方应用仍需自己的配置与授权。
- 项目沿用团队权限范围。本版没有完整私密频道、系统开机自启服务、所有云应用集成或通用 VS Code 插件兼容；办公文件预览不等于完整原生 Office 编辑器。
- **验证情况：** 476 项自动测试通过，另有 Electron 引导与协作测试，以及一台 Mac 上两个真实 Codex Agent 的群聊协作。两个 Mac ZIP 均验证签名；M 系列打包应用验证启动、重启。两台实体 Mac 跨网、Intel 实机、新账号和真实 Claude 执行仍待验收。见 [beta.3 验证记录](docs/evidence/agent-onboarding-0.5.0-beta.3.json)及 [beta.6 发布检查](docs/evidence/local-folder-pr-0.5.0-beta.6.json)。
- 公网经过 Cloudflare 中继，使用传输加密，非端到端加密。本次不发布 Windows 或 Linux 安装包。

## 开发与许可

Node.js 22+：运行 `npm ci` 后执行 `npm start`。`npm test` 运行测试，`npm run package` 构建本地 Mac 应用，`npm run hub` 启动独立协作服务。

当前源码采用 [Apache-2.0](LICENSE)。v0.3.0-beta.1 及更早发布保留原 MIT 许可。第三方依赖遵循各自许可，见 [NOTICE](NOTICE)。
