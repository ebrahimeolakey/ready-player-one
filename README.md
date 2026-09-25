# 头号玩家 · Ready Player One

**本地优先的中文 AI 协作工作台。**

和同事在同一个任务中使用各自的 Codex / Claude，共享 AI 执行过程、清单和讨论。

## 直接下载

当前测试版：**0.4.6-beta.1** · Apache-2.0 · 下载无需登录

| 系统 | 安装包 |
| --- | --- |
| Mac · Apple Silicon（M 系列） | **[↓ 下载 Mac M 系列版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.6-beta.1/Ready-Player-One-0.4.6-beta.1-mac-arm64.zip)** |
| Mac · Intel | **[↓ 下载 Mac Intel 版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.6-beta.1/Ready-Player-One-0.4.6-beta.1-mac-x64.zip)** |
| Windows 10 / 11 · x64 | **[↓ 下载 Windows 安装器](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.6-beta.1/Ready-Player-One-0.4.6-beta.1-windows-x64-setup.exe)** · [免安装 ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.6-beta.1/Ready-Player-One-0.4.6-beta.1-windows-x64.zip) |

Mac 解压后将「头号玩家.app」拖入「应用程序」。Windows 运行安装器，或完整解压 ZIP 后运行「头号玩家.exe」。无需另装 Node.js。

**未签名、未公证测试版。** 系统可能拦截首次启动，见 [Mac 安装指南](docs/BETA-TESTING.md#1-安装) / [Windows 安装指南](docs/WINDOWS.md)。AI 需要自己的账号及额度；Git 功能需要本机 Git。Codex 普通对话可在非 Git 文件夹运行。

[版本说明](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.4.6-beta.1) · [SHA256 校验](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.6-beta.1/SHA256SUMS-0.4.6-beta.1.txt) · [反馈问题](https://github.com/ebrahimeolakey/ready-player-one/issues)

## 可以用来做什么

| 场景 | 从一个共同任务开始 |
| --- | --- |
| 活动运营 | 讨论活动方案，维护执行清单，整理复盘笔记 |
| FDE / 客户交付 | 梳理客户需求，协作排障，记录交付决策 |
| 项目管理 | 拆解工作，共享 AI 进展，讨论并勾选待办 |
| 轻开发 | 修改脚本或页面，查看变更，与同事一起验收 |

以上场景目前通过通用会话、清单和本机文本文件完成。专用模板、看板、截止日期、附件共享和办公软件集成尚未提供。

## 三步开始

1. **连接 AI**：左下角头像 → 设置 → 提供商，连接 Codex 或 Claude。可识别本机已有登录，也可安装并发起官方登录。
2. **开始任务**：打开本机文件夹，新建会话、添加 Agent，输入要做的事情。请求批准后在自己的电脑执行。需要 GitHub 仓库时，再到设置中授权并克隆。
3. **邀请同事**：分享 → 互联网 → 复制邀请链接。同事安装应用后，在工作区菜单选择「通过邀请加入」。首次共享需安装协作组件。

完整操作见 [Mac 同事内测指南](docs/BETA-TESTING.md)。

## 这个版本包含

- **Agent Session Share**：原生 Codex / Claude 会话、流式输出、指导、队列、逐工具审批与断线补传。
- **团队协作**：会话限定邀请、任务认领/归还/转交、消息与代码差异评论、共享记忆与历史、快照同步、冲突处理、额度待接管、未知结果确认与 Agent MCP 独立子任务。
- **工作台**：文件编辑、可取消搜索、交互终端、独立 Codex/Claude CLI、内嵌浏览器、GitHub 建仓库/绑定、Git 暂存/提交/分支/同步、编辑器偏好与代码缩略图、JS/TS 补全和诊断、Node.js 调试、可编辑快捷键。
- **输入与账号**：长提示原文传递、本机 CLI 登录、GitHub 仓库授权、实际模型目录、成员模型共享与上下文用量、自定义兼容 API、可配置 ACP、图片输入、Mac 语音入口。
- **通用偏好**：对话/编辑器布局、紧凑对话、隐藏空编辑器、分类通知、菜单栏图标和完成提示音；切换布局保留未保存文件及终端。
- **本机保存**：应用会话、配置、文字图片草稿与补传记录加密，输入冲突保留备份；GitHub 下载更新与文件校验；Mac 兼容版本之间的启动健康检查和失败恢复。

## 测试版边界

- 公网共享使用临时通道，**房主需保持应用打开、电脑在线**；通道重启后需重新邀请。常驻房间与云端执行尚未部署。
- GitHub 仓库授权可以使用；**团队身份登录还需要自己的 OAuth 应用与固定 HTTPS 服务**，本测试版不预置这项外部服务。
- 代码快照与冲突处理已实现；不等于所有文件或任意附件自动共享。共享前请检查项目内容。
- 语言服务限 JS/TS，调试器限 Node.js JavaScript；不包含通用 VS Code 扩展兼容。
- Mac 本机验收、同机双客户端公网协议测试及 [Windows 原生 CI](docs/WINDOWS-NATIVE-CI.md) 已通过；Mac M 系列 0.4.5→0.4.6 的 [实际界面升级](docs/PUBLISHED-UPGRADE-0.4.6.md) 已验证；两台实体电脑、新账号完整流程及其他平台安装升级仍需同事测试。Linux 安装包暂未提供。
- 公网经过 Cloudflare 中继，使用传输加密，非端到端加密。语音真实录入仍待验收；旧发布未声明更新健康协议时仅手动安装并保留备份，Windows NSIS 不提供上述自动恢复。

[功能与验证记录](docs/IMPLEMENTATION-TRACKER.md) · [公网测试](docs/INTERNET-VERIFICATION.md) · [房主离线架构](docs/HOSTING-DESIGN.md)

## 关于项目

当前主分支采用 Apache-2.0；已发布的 v0.3.0-beta.1 及更早版本保留发布时的 MIT 许可。第三方依赖遵循各自许可证。
