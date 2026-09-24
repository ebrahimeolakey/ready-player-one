# Windows 测试版

适用于 **Windows 10 / 11 x64**。当前版本 0.4.3-beta.1，与 Mac 同版；Amoeba 功能补齐仍在开发。

## 安装

- 安装器：运行 `Ready-Player-One-0.4.3-beta.1-windows-x64-setup.exe`，按提示安装到当前用户目录。
- 免安装 ZIP：完整解压，再运行文件夹内的 `头号玩家.exe`。请保留旁边的所有文件，不能只拷贝 EXE。
- 此版没有 Windows 代码签名。SmartScreen 可能显示未知发布者；请从本仓库 Release 获取并核对 SHA-256，组织电脑按所在组织的软件安装策略操作。

不需要 Node.js、Homebrew 或 WSL。Git 仓库操作和 Claude Code 请先安装 [Git for Windows](https://git-scm.com/download/win)，使用默认 PATH 选项。已有 Git 时可直接使用。

## 连接账号

设置 → 提供商，选择 Codex 或 Claude，安装并完成官方登录。设置 → GitHub 可安装 GitHub CLI 并打开官方授权。

应用的安装助手使用官方原生 Windows 发行包：Codex 完整 Windows package（含 sandbox 工具）、GitHub CLI、cloudflared，以及 Claude 官方 PowerShell 安装器。下载 GitHub 资产时核验发行方提供的 SHA-256。登录凭据由各家 CLI 保存在本机。

终端使用 PowerShell。公网分享方法与 Mac 一致：分享 → 互联网 → 复制邀请；房主需保持应用和电脑在线。

## 数据与排障

- 本机数据：`%USERPROFILE%\.ready-player-one`。
- 应用内下载的组件：该目录下的 `bin`。
- Claude 由官方安装器放入 `%USERPROFILE%\.local\bin`，应用会自动识别。
- 若 Git 未识别，安装 Git for Windows 后关闭并重新启动应用。
- 若 Claude 报找不到 Bash，先确认 Git for Windows 已安装。自定义安装路径可按 [Claude 官方说明](https://code.claude.com/docs/en/setup) 配置 `CLAUDE_CODE_GIT_BASH_PATH`。
- 公司网络可能阻断 GitHub、模型提供商或 Cloudflare，请使用公司允许的连接方式。

## 当前验证范围

0.4.3 已在 GitHub Windows 2022 runner 上原生构建 ZIP / NSIS，并通过 28 项回归、真实 Electron 启动、加密设置、PowerShell PTY 输入输出/尺寸/取消/退出清理。源码提交和产物 SHA256 均已核对，见 [Windows 原生 CI 证据](WINDOWS-NATIVE-CI.md)。

**仍需实体 Windows 首次安装、新账号 GUI 授权、真实 Agent 执行和 Mac–Windows 公网双机验收。** 原生 CI 不替代这些同事实测。

## 从源码构建

Node.js 22 或更高版本：

```sh
npm ci
npm run distribute:windows
```

Windows 主机和 macOS 主机均可交叉生成 Windows x64 安装包。构建产物输出在 `release/`，不包含用户账号、聊天数据或预置授权。
