# Ready Player One · 头号玩家

**An AI-native coworking space for people and agents.**

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

Bring your team, your AI accounts, and your work into one shared space. Discuss ideas, delegate tasks, share live agent sessions, and review the results together—with conversations and deliverables side by side.

Local-first. Open source. Built for planning, research, writing, operations, and building software.

## Download

Mac collaboration preview: **0.5.0-beta.1** · Windows: **0.4.7-beta.1** · Apache-2.0 · No sign-in required to download

| Platform | Download |
| --- | --- |
| Mac · Apple Silicon (M series) | **[↓ Download for Apple Silicon](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-arm64.zip)** |
| Mac · Intel | **[↓ Download for Intel Mac](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-x64.zip)** |
| Windows 10 / 11 · x64 | **[↓ Windows installer](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64-setup.exe)** · [Portable ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64.zip) |

On Mac, unzip and drag `头号玩家.app` into Applications. On Windows, run the installer or fully extract the ZIP and launch `头号玩家.exe`. No separate Node.js installation is required.

**Unsigned beta; the Mac app is not notarized.** Your system may block the first launch. See the [Mac installation guide](docs/BETA-TESTING.md#1-安装) or [Windows guide](docs/WINDOWS.md) (Chinese). The current desktop UI is Chinese. Bring your own AI accounts and credits; Git operations require Git installed locally. Regular Codex conversations can run in folders without a Git repository.

[Release notes](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.5.0-beta.1) · [Mac SHA256 checksums](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/SHA256SUMS-0.5.0-beta.1.txt) · [Report an issue](https://github.com/ebrahimeolakey/ready-player-one/issues)

## Work together, with AI

| Workflow | What happens in the space |
| --- | --- |
| Discuss | Keep people and agents in a persistent project conversation. |
| Delegate | Turn discussions into tasks, assign ownership, and choose who can control execution. |
| Collaborate | Share live Codex / Claude sessions, follow progress, and guide the work together. |
| Review | Preview HTML / Markdown deliverables, leave comments on a version, and accept the result. |

A plan, a research brief, a written draft, or a working page can all start in the same space. The shared workflow connects the conversation, the agent's work, and the team's review.

## Get started

1. **Connect your AI.** Open your avatar → Settings (`设置`) → Providers (`提供商`). Connect Codex or Claude using an existing local CLI login, or install the CLI and start its official login flow.
2. **Create a project.** Open Project Groups (`项目群`), choose a team, create a project, map a local folder, and add an agent. Create tasks from the discussion or select Organize Tasks (`整理任务`); the executing device claims and starts the task. For GitHub projects, authorize and clone the repository in Settings first.
3. **Invite and review.** Open Members → Invite, choose workspace scope and Internet access, and share the invitation. The executing device's owner grants control separately. Preview deliverables on the right, comment to request changes, and select Accept (`验收`) when ready.

[Project collaboration guide](docs/PROJECT-COLLABORATION.md) · [Mac beta testing guide](docs/BETA-TESTING.md) (Chinese)

## Inside the Mac preview

- **Shared projects:** isolated teams, nested projects, optional repository/subdirectory mapping, persistent chat, agent task proposals, task ownership, separate control permissions, and coordinated task claims.
- **Agent Session Share:** native Codex / Claude sessions, streaming output, steering, queues, per-tool approvals, and reconnect recovery. Session-scoped invitations, task handoffs, shared memory/history, snapshot synchronization, and conflict handling support collaboration.
- **Deliverables and feedback:** versioned static HTML / Markdown previews, comments tied to a version, and explicit human acceptance.
- **An integrated workspace:** file editing, search, terminals, an embedded browser, GitHub repository creation/linking, and Git staging, commits, branches, and synchronization. JS/TS language tools and Node.js debugging are available when the work needs code.
- **Your providers and preferences:** local CLI sign-in, GitHub repository authorization, model selection, custom compatible APIs, configurable ACP, image input, and a Mac voice entry point. Light/dark themes, layouts, shortcuts, and notification preferences keep the space adaptable.
- **Local persistence:** encrypted application sessions, settings, drafts, and replay records; file verification for GitHub downloads; startup health checks and failure recovery between compatible Mac releases.

## Beta scope

- **The host must keep the app open and the computer online.** Internet sharing uses a temporary tunnel; restarting it requires a new invitation. An always-on collaboration hub and cloud execution are not deployed.
- GitHub repository authorization is available. Team identity sign-in still requires your own GitHub OAuth app and a fixed HTTPS service; this beta does not include that hosted service.
- The new project workflow is in the Mac preview. Windows remains on 0.4.7-beta.1. The Mac preview enforces member roles for local Git write operations.
- Deliverables currently support static HTML / Markdown with scripts and external network access disabled by default. Dynamic localhost sharing, arbitrary attachment sync, dedicated workflow templates, Kanban boards, deadlines, and office-app integrations are not included.
- Language services cover JS/TS, and debugging covers Node.js JavaScript. General VS Code extension compatibility is not included.
- **Validation:** 442 regression checks passed, plus a desktop workflow using a simulated provider and packaged Apple Silicon launch/restart checks. The new workflow still needs real-model testing, two physical Macs collaborating over the Internet, Intel hardware testing, and fresh-account login validation. See the [validation record](docs/evidence/project-collaboration-0.5.0.json).
- Internet traffic passes through a Cloudflare relay with transport encryption, not end-to-end encryption. Actual voice capture remains unverified. Older releases without the update health protocol require manual installation with backups; Windows NSIS does not provide the Mac recovery mechanism.

[Implementation and validation](docs/IMPLEMENTATION-TRACKER.md) · [Internet testing](docs/INTERNET-VERIFICATION.md) · [Host-offline architecture](docs/HOSTING-DESIGN.md) (Chinese)

## License

The current main branch uses [Apache-2.0](LICENSE). Releases v0.3.0-beta.1 and earlier retain their original MIT license. Third-party dependencies retain their respective licenses.

---

<a id="简体中文"></a>

## 简体中文

**人与 Agent 一起工作的 AI 原生协作空间。**

把团队、自己的 AI 账号和正在做的事放进同一个空间。一起讨论、分配任务、共享 Agent 实时会话，并排查看对话与产物，共同完成验收。

本地优先，开源。用于策划、研究、写作、运营，也用于开发软件。

## 直接下载

Mac 协作预览版：**0.5.0-beta.1** · Windows：**0.4.7-beta.1** · Apache-2.0 · 下载无需登录

| 系统 | 安装包 |
| --- | --- |
| Mac · Apple Silicon（M 系列） | **[↓ 下载 Mac M 系列版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-arm64.zip)** |
| Mac · Intel | **[↓ 下载 Mac Intel 版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-x64.zip)** |
| Windows 10 / 11 · x64 | **[↓ 下载 Windows 安装器](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64-setup.exe)** · [免安装 ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64.zip) |

Mac 解压后将「头号玩家.app」拖入「应用程序」。Windows 运行安装器，或完整解压 ZIP 后运行「头号玩家.exe」。无需另装 Node.js。

**未签名测试版，Mac 尚未公证。** 系统可能拦截首次启动，见 [Mac 安装指南](docs/BETA-TESTING.md#1-安装) / [Windows 安装指南](docs/WINDOWS.md)。当前桌面界面为中文。AI 需要自己的账号及额度；Git 功能需要本机 Git。Codex 普通对话可在非 Git 文件夹运行。

[版本说明](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.5.0-beta.1) · [Mac SHA256 校验](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/SHA256SUMS-0.5.0-beta.1.txt) · [反馈问题](https://github.com/ebrahimeolakey/ready-player-one/issues)

## 和 AI 一起协作

| 工作方式 | 在空间里做什么 |
| --- | --- |
| 讨论 | 人与 Agent 在持续的项目群聊里共享上下文。 |
| 分工 | 把讨论变成任务，明确负责人，决定谁能控制执行。 |
| 协作 | 共享 Codex / Claude 实时会话，跟进进展，共同指导工作。 |
| 验收 | 预览 HTML / Markdown 产物，针对具体版本评论，确认结果。 |

一份方案、一篇调研、一版文稿，或者一个能用的页面，都可以从这里开始。讨论、Agent 执行和团队验收连在同一个工作流程里。

## 三步开始

1. **连接 AI**：左下角头像 → 设置 → 提供商，连接 Codex 或 Claude。可识别本机已有 CLI 登录，也可安装并发起官方登录。
2. **创建项目**：左侧「项目群」→ 选择团队 → 新建项目 → 关联本机目录、添加 Agent。讨论后建任务或点击「整理任务」，由执行设备认领并开始。需要 GitHub 仓库时，先在设置中授权并克隆。
3. **邀请与验收**：成员 → 邀请，选择工作区范围和互联网，分享邀请。控制权由执行设备持有人单独授予。产物在右侧预览，评论后继续修改，再点击「验收」。

[项目群使用指南](docs/PROJECT-COLLABORATION.md) · [Mac 同事内测指南](docs/BETA-TESTING.md)

## Mac 预览版包含

- **共享项目**：隔离团队、多级项目、可选仓库及子目录绑定、持续群聊、Agent 任务提案、任务负责人、独立控制权限与协同认领。
- **Agent Session Share**：原生 Codex / Claude 会话、流式输出、指导、队列、逐工具审批与断线补传。支持会话限定邀请、任务交接、共享记忆与历史、快照同步及冲突处理。
- **产物与反馈**：静态 HTML / Markdown 版本预览、绑定具体版本的评论，以及明确的人工验收。
- **一体化工作区**：文件编辑、搜索、终端、内嵌浏览器、GitHub 建仓库与绑定、Git 暂存、提交、分支和同步。需要编写代码时，可使用 JS/TS 语言工具和 Node.js 调试。
- **自己的提供商与偏好**：本机 CLI 登录、GitHub 仓库授权、模型选择、自定义兼容 API、可配置 ACP、图片输入和 Mac 语音入口。支持深浅主题、布局、快捷键与通知设置。
- **本机保存**：应用会话、配置、草稿与补传记录加密；GitHub 下载文件校验；兼容 Mac 版本之间的启动健康检查和失败恢复。

## 测试版边界

- **房主需保持应用打开、电脑在线。** 公网共享使用临时通道，重启后需重新邀请。常驻协作服务与云端执行尚未部署。
- GitHub 仓库授权可以使用；团队身份登录还需要自己的 GitHub OAuth 应用与固定 HTTPS 服务，本测试版不预置这项外部服务。
- 新项目协作流程在 Mac 预览版中提供，Windows 保持 0.4.7-beta.1。Mac 预览版已限制本机 Git 写操作的成员角色。
- 产物仅支持静态 HTML / Markdown，默认禁用脚本和外部网络。尚不支持动态 localhost 共享、任意附件同步、专用工作流模板、看板、截止日期和办公软件集成。
- 语言服务限 JS/TS，调试器限 Node.js JavaScript；不包含通用 VS Code 扩展兼容。
- **验证情况**：442 项回归通过，已验证模拟 Provider 的桌面流程和 Mac M 系列打包应用启动、重启。新增流程的真实模型、两台实体 Mac 跨公网、Intel 实机和新账号登录仍待验收。详见 [验证记录](docs/evidence/project-collaboration-0.5.0.json)。
- 公网经过 Cloudflare 中继，使用传输加密，非端到端加密。语音真实录入仍待验收；旧发布未声明更新健康协议时需手动安装并保留备份，Windows NSIS 不提供上述 Mac 自动恢复机制。

[功能与验证记录](docs/IMPLEMENTATION-TRACKER.md) · [公网测试](docs/INTERNET-VERIFICATION.md) · [房主离线架构](docs/HOSTING-DESIGN.md)

## 许可证

当前主分支采用 [Apache-2.0](LICENSE)；已发布的 v0.3.0-beta.1 及更早版本保留发布时的 MIT 许可。第三方依赖遵循各自许可证。
