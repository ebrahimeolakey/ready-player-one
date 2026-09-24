# Windows 原生 CI 验证

工作流：`.github/workflows/windows-native.yml`。运行环境为 GitHub Actions `windows-2022` x64 虚拟机，源码基线为 `bf0039e`（0.4.1-beta.1 发布后的文档提交）。不覆盖 GitHub Releases 资产。

验证脚本 `scripts/windows-native-smoke.mjs` 使用安装的 Electron 原生 Windows 可执行文件，导入实际 `desktop/main.mjs`，启动本地 Hub、系统加密密钥、preload 与 React 界面。所有数据写入 runner 临时目录 `RPO 原生测试 data`，有意包含中文和空格。脚本检查实际界面控件、禁止 renderer Node、preload bridge，并保存桌面截图。

同一 Electron 进程加载实际 `node-pty` 二进制，通过真实 PowerShell 会话检查输入输出、控制台 TTY、尺寸变化、Ctrl-C、退出码以及窗口所有者清理。匹配的输出标记在命令中拆分，避免仅匹配输入回显造成假通过。成功退出走应用自身的异步 `before-quit` 清理，测试超时或失败使用非零退出码。

工作流先运行 24 项平台、账号边界、图片、加密草稿和断线补传回归，之后进行上述桌面验证，再构建 unsigned x64 ZIP / NSIS。仅将日志、JSON、截图和 SHA256 上传为 Actions artifacts；测试安装包保留 7 天。

## 2026-09-24 实际结果

[Windows native verification #4](https://github.com/ebrahimeolakey/ready-player-one/actions/runs/35973983566) **success**，验证源码 `7e0dcf3ff7cb28e4fb40db05a5b4104f66f8cd86`。24/24 回归通过，真实 Electron / PTY 冒烟通过，ZIP / NSIS 均构建完成。未修改已发布安装包。

运行时为 Electron **40.10.6**、Node **24.15.0**、win32 x64；实际渲染 10 个按钮，本地 Hub 已连接。终端记录包含 `RPO_PTY_OK`、`RPO_TTY_True`、`RPO_SIZE_109_37`、`RPO_INTERRUPTED`，随后正常退出码为 7；第二个终端由 closeOwner 关闭后确认 PowerShell PID 不再存在。应用正常走自身退出流程，日志包含 `WINDOWS_NATIVE_SMOKE_OK`。

![Windows runner 实际应用截图](evidence/windows-native-0.4.1.png)

[运行证据 artifact](https://github.com/ebrahimeolakey/ready-player-one/actions/runs/35973983566/artifacts/10796704871) 包含截图、运行时 JSON、终端输出和完整 stdout/stderr；[独立测试包 artifact](https://github.com/ebrahimeolakey/ready-player-one/actions/runs/35973983566/artifacts/10797800699) 包含本次构建文件（需要登录 GitHub，保留 7 天）。这些是 CI 测试包，不是 Releases 已发布资产。

| 文件 | 本次 CI 的 SHA256 |
| --- | --- |
| `Ready-Player-One-0.4.1-beta.1-windows-x64-setup.exe` | `3285d49bd63a8de39570e2e5e0d84b61ef9ba539a4ad0e4a0aa53d416d9541e6` |
| `Ready-Player-One-0.4.1-beta.1-windows-x64.zip` | `1a0f13ab2ea5e6ae34ebd49bcea1cf28c3c093ca397aaa5d3f8ffe778b27f65f` |

本轮只修正验证本身：macOS 下载资产单测显式选择 darwin；Electron 测试入口不使用顶层 await app.whenReady，以免阻塞入口加载。不包含产品逻辑更改。

## 仍需同事验收

- GitHub Actions 虚拟机不等于 Windows 10/11 实体电脑兼容矩阵。
- 未用真实账号完成 Codex / Claude / GitHub 的交互登录，未调用付费模型。
- 未验证跨公网两台实体电脑的完整协作流程。
- ZIP / NSIS 构建通过不等于安装向导、SmartScreen、卸载或自更新闭环通过。
- 此分支基于已发布 0.4.1 源码，不包含主工作区此后未提交的群聊改动。


## 0.4.2-beta.1 原生验证

[成功运行](https://github.com/ebrahimeolakey/ready-player-one/actions/runs/35976364396)，准确源码提交 `c5f2c4abdaa28b4ad4bfc9b48728791cb05a27c2`。

- Windows 2022 x64：**27/27 回归通过**，Renderer 构建通过。
- Electron 40.10.6 真正启动主入口、Hub、加密设置、preload 与 React；真实 PowerShell PTY 输入输出、TTY、109×37 resize、Ctrl-C、退出码及进程清理通过。
- ZIP / NSIS 原生构建成功；下载后的 SHA256 与 runner 一致。
- 包内 51 个 core/desktop 源文件与发行源码比较，仅 Windows CRLF / LF 行结束符不同；编译后的 JS/CSS 一致。未混入另一批群聊与项目上下文开发。

![0.4.2 Windows 原生启动](evidence/windows-native-0.4.2.png)

仍未覆盖实体 Windows 首次安装、SmartScreen/安装向导、真实账号 GUI 登录、全部 Provider 及两台实体机器公网流程。

## 0.4.3-beta.1 原生验证

[成功运行](https://github.com/ebrahimeolakey/ready-player-one/actions/runs/35978675952)，准确源码提交 `2314066ab13f28d332a2f188edc40a67b89c66d8`。

Windows 2022 x64：**28/28 回归通过**，Renderer 构建、实际 Electron 40.10.6 主入口/Hub/加密设置、真实 PowerShell PTY 的输入输出/尺寸/Ctrl-C/退出清理全部通过。ZIP 与 NSIS 在同一 runner 构建成功。

![0.4.3 Windows 原生启动](evidence/windows-native-0.4.3.png)

本批本机完整源码回归 277/277；Windows 使用现有平台回归清单，没有把全部 277 项在 Windows 重跑。实体机器首次安装、真实账号登录和双机公网仍需同事验收。

下载后已核对 runner SHA256；Windows ASAR 内 59 个 core/desktop/dist 文件与发行源码一致（仅允许 CRLF/LF 差异）。ZIP 完整性通过。本轮安装器 SHA256 `155266ff231e20747051ee87379cd07ee7c19dcf1907bfeceb7501a390e8c3f4`；便携 ZIP SHA256 `0b2d5f304919f8f406a896664750c61e97dece77881ef1ab2329f2d61ec8cad0`。
