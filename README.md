# 头号玩家 · Ready Player One

**本地优先的中文 AI 协作工作台。**

在项目群里讨论，让本机 Codex / Claude 执行任务，在同一屏预览产物、评论和验收。

## 直接下载

Mac 项目协作预览：**0.5.0-beta.1** · Windows 保持 **0.4.7-beta.1** · Apache-2.0 · 下载无需登录

| 系统 | 安装包 |
| --- | --- |
| Mac · Apple Silicon（M 系列） | **[↓ 下载 Mac M 系列版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-arm64.zip)** |
| Mac · Intel | **[↓ 下载 Mac Intel 版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/Ready-Player-One-0.5.0-beta.1-mac-x64.zip)** |
| Windows 10 / 11 · x64 | **[↓ 下载 Windows 安装器](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64-setup.exe)** · [免安装 ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.7-beta.1/Ready-Player-One-0.4.7-beta.1-windows-x64.zip) |

Mac 解压后将「头号玩家.app」拖入「应用程序」。Windows 运行安装器，或完整解压 ZIP 后运行「头号玩家.exe」。无需另装 Node.js。

**未签名、未公证测试版。** 系统可能拦截首次启动，见 [Mac 安装指南](docs/BETA-TESTING.md#1-安装) / [Windows 安装指南](docs/WINDOWS.md)。AI 需要自己的账号及额度；Git 功能需要本机 Git。Codex 普通对话可在非 Git 文件夹运行。

[版本说明](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.5.0-beta.1) · [SHA256 校验](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.5.0-beta.1/SHA256SUMS-0.5.0-beta.1.txt) · [反馈问题](https://github.com/ebrahimeolakey/ready-player-one/issues)

## 可以用来做什么

| 场景 | 从一个共同任务开始 |
| --- | --- |
| 活动运营 | 讨论活动方案，维护执行清单，整理复盘笔记 |
| FDE / 客户交付 | 梳理客户需求，协作排障，记录交付决策 |
| 项目管理 | 拆解工作，共享 AI 进展，讨论并勾选待办 |
| 轻开发 | 修改脚本或页面，查看变更，与同事一起验收 |

Mac 新版提供项目群、任务和静态 HTML / Markdown 产物。专用模板、看板、截止日期、任意附件和办公软件集成尚未提供。

## 三步开始

1. **连接 AI**：左下角头像 → 设置 → 提供商，连接 Codex 或 Claude。可识别本机已有登录，也可安装并发起官方登录。
2. **创建项目**：左侧「项目群」→ 选择团队 → 新建项目 → 关联本机目录、添加 Agent。讨论后建任务或点击「整理任务」，由执行设备认领并开始。需要 GitHub 仓库时，先在设置中授权并克隆。
3. **一起验收**：成员 → 邀请，选择工作区范围和互联网。同事通过邀请加入后可看项目群；控制权由执行设备持有人单独授予。产物在右侧预览，评论后继续修改，再点击「验收」。

[项目群使用与边界](docs/PROJECT-COLLABORATION.md) · [Mac 同事内测指南](docs/BETA-TESTING.md)。

## Mac 新版包含

- **项目群与产物**：隔离团队、多级项目、仓库子目录绑定、持续群聊、负责人任务提案、DRI / Controllers、原子认领、HTML / Markdown 版本预览、评论与人工验收。

- **Agent Session Share**：原生 Codex / Claude 会话、流式输出、指导、队列、逐工具审批与断线补传。
- **团队协作**：会话限定邀请、任务认领/归还/转交、消息与代码差异评论、共享记忆与历史、快照同步、冲突处理、额度待接管、未知结果确认与 Agent MCP 独立子任务。
- **工作台**：文件编辑、可取消搜索、交互终端、独立 Codex/Claude CLI、内嵌浏览器、GitHub 建仓库/绑定、Git 暂存/提交/分支/同步、编辑器偏好与代码缩略图、VS Code 兼容设置/快捷键导入、JS/TS 补全和诊断、Node.js 调试、可编辑快捷键。
- **输入与账号**：长提示原文传递、本机 CLI 登录、GitHub 仓库授权、实际模型目录、成员模型共享与上下文用量、自定义兼容 API、可配置 ACP、图片输入、Mac 语音入口。
- **通用偏好**：深浅主题、协作者颜色、对话/编辑器布局、紧凑对话、隐藏空编辑器、分类通知、菜单栏图标和完成提示音；切换主题与布局保留未保存文件及终端。
- **本机保存**：应用会话、配置、文字图片草稿与补传记录加密，输入冲突保留备份；GitHub 下载更新与文件校验；Mac 兼容版本之间的启动健康检查和失败恢复。

## 测试版边界

- 公网共享使用临时通道，**房主需保持应用打开、电脑在线**；通道重启后需重新邀请。常驻房间与云端执行尚未部署。
- GitHub 仓库授权可以使用；**团队身份登录还需要自己的 OAuth 应用与固定 HTTPS 服务**，本测试版不预置这项外部服务。
- Mac 新版已限制本机 Git 写操作的成员角色；Windows 仍保留原 0.4.7 下载，本轮未更新。
- 产物仅静态 HTML / Markdown，默认禁用脚本和外部网络；不等于动态 localhost 应用共享或任意附件同步。
- 语言服务限 JS/TS，调试器限 Node.js JavaScript；不包含通用 VS Code 扩展兼容。
- 本轮 442 项回归、真实桌面模拟 Provider 闭环、Mac M 系列打包应用启动/重启已验证。新增闭环未冒充真实模型或双机测试；两台实体 Mac 跨公网、Intel 实机、新账号登录仍待验收。详见 [验证记录](docs/evidence/project-collaboration-0.5.0.json)。
- 公网经过 Cloudflare 中继，使用传输加密，非端到端加密。语音真实录入仍待验收；旧发布未声明更新健康协议时仅手动安装并保留备份，Windows NSIS 不提供上述自动恢复。

[功能与验证记录](docs/IMPLEMENTATION-TRACKER.md) · [公网测试](docs/INTERNET-VERIFICATION.md) · [房主离线架构](docs/HOSTING-DESIGN.md)

## 关于项目

当前主分支采用 Apache-2.0；已发布的 v0.3.0-beta.1 及更早版本保留发布时的 MIT 许可。第三方依赖遵循各自许可证。
