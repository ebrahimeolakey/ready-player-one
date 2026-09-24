# 头号玩家 · Ready Player One

**给运营、FDE 与轻开发团队的中文 AI 协作工作台。**

和同事在同一个任务中使用各自的 Codex / Claude，共享 AI 执行过程、清单和讨论。

## 下载 Windows 版

Windows 移植预发布：**0.3.1-beta.1-windows.1** · Windows 10 / 11 x64 · Apache-2.0

| 安装方式 | 下载 |
| --- | --- |
| 安装器 | **[↓ 下载 Windows 安装器](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.3.1-beta.1-windows.1/Ready-Player-One-0.3.1-beta.1-windows.1-windows-x64-setup.exe)** |
| 免安装 ZIP | **[↓ 下载 Windows ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.3.1-beta.1-windows.1/Ready-Player-One-0.3.1-beta.1-windows.1-windows-x64.zip)** |

完整解压 ZIP 后运行「头号玩家.exe」，或使用安装器。此版未签名，Windows 实机首次登录和跨平台双机验收待完成；新一轮 Amoeba 功能仍在开发。[Windows 安装指南](docs/WINDOWS.md) · [版本与校验](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.3.1-beta.1-windows.1)

## 下载 Mac 版

当前版本：**0.3.0-beta.1** · 免费下载 · 无需 GitHub 登录

| 你的 Mac | 安装包 |
| --- | --- |
| Apple Silicon · M 系列芯片 | **[↓ 下载 Apple Silicon 版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.3.0-beta.1/Ready-Player-One-0.3.0-beta.1-mac-arm64.zip)** |
| Intel 芯片 | **[↓ 下载 Intel 版](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.3.0-beta.1/Ready-Player-One-0.3.0-beta.1-mac-x64.zip)** |

不确定芯片？打开 Mac 的「关于本机」查看。下载后解压，将「头号玩家.app」拖入「应用程序」。无需安装 Node.js 或 Homebrew。

**这是未签名、未公证的测试版。** 首次打开可能被 macOS 拦截，请按[安装指南](docs/BETA-TESTING.md#1-安装)操作。Git 仓库功能需要本机 Git；当前 Codex 执行入口也要求目录已初始化 Git。AI 执行需要自己的 Codex 或 Claude 账号及可用额度。

[版本说明](https://github.com/ebrahimeolakey/ready-player-one/releases/tag/v0.3.0-beta.1) · [文件校验](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.3.0-beta.1/SHA256SUMS-0.3.0.txt) · [反馈问题](https://github.com/ebrahimeolakey/ready-player-one/issues)

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

## 现在已经有

- **共享 Agent 会话**：多人实时查看各自 AI 的执行过程，执行前审批。
- **共同清单与讨论**：勾选待办、评论、共享记忆、归档与导出。
- **自己的账号与电脑**：连接本机 Codex / Claude，支持 GitHub 官方授权。
- **跨互联网加入**：限时邀请，可随时撤销。
- **本机文件与轻开发**：文本编辑、文件搜索、命令终端、Git 变更查看。

## 测试版的边界

- 公网协作使用临时通道，**房主需保持应用打开、电脑在线**；通道重启后需重新邀请。暂不提供常驻云端房间。
- **共享会话不等于共享文件**：同事能看到对话和计划，文件仍在各自电脑；目前没有附件上传与跨设备文件同步。
- 暂无只读访客、企业成员管理或完整项目管理系统。当前界面仍保留编辑器和终端，运营场景的简化入口待补齐。
- 账号凭据保留在各自本机。模型通常仍需联网；公网数据经 Cloudflare 中继，使用传输加密，非端到端加密。
- 已提供两种 Mac 安装包；两台实体 Mac、不同网络以及新账号首次登录的完整同事验收仍待完成。

[尚未覆盖的场景与优先级](docs/PRODUCT-GAPS.md) · [技术边界与开发说明](docs/DEVELOPMENT.md) · [验收记录](docs/VALIDATION.md)

## 关于项目

头号玩家是受 Amoeba 协作工作流启发的独立实现，非 Amoeba 官方产品，尚未覆盖原版全部界面与功能。不包含原应用的打包代码或品牌素材。

[与 Amoeba 的功能差距](docs/AMOEBA-GAPS.md) · [界面对照](docs/UI-REFERENCE.md) · [架构](docs/ARCHITECTURE.md) · [Apache License 2.0](LICENSE)

当前主分支采用 Apache-2.0；已发布的 v0.3.0-beta.1 及更早版本保留发布时的 MIT 许可。第三方依赖遵循各自许可证。
