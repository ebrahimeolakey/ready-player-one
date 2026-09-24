# 未签名测试版打包核查（2026-09-24）

本次为发布前核查，未修改 package 版本、现有发布资产、用户数据，也未重新进行公网测试。0.4.0-beta.1 最终产物应由统一发布步骤重新构建。

| 项目         | 配置/源资产核查                                                              | 最终包应包含                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用         | build.files 包含 dist、desktop、core、package.json                           | app.asar 中对应运行文件                                                                                                                       |
| 许可证       | 根目录 LICENSE 为 Apache 2.0；NOTICE 存在，二者显式包含在 build.files        | app.asar/LICENSE、app.asar/NOTICE                                                                                                             |
| JS/TS        | typescript 为生产依赖；language.mjs、language-worker.mjs 在 desktop/** 范围  | 两个模块、node_modules/typescript/lib/typescript.js 和标准类型库                                                                              |
| 正则搜索     | workspace-tools.mjs 在 core/**；搜索 Worker 使用 eval:true 内联代码          | core/providers/workspace-tools.mjs，无独立 regexWorker 文件                                                                                   |
| Mac PTY      | node-pty 1.1.0 两架构预构建文件有效；spawn-helper 权限均 755                 | 对应架构 pty.node、spawn-helper（app.asar.unpacked）                                                                                          |
| Windows PTY  | x64 原生文件经 file 确认为 PE x86-64                                         | pty.node、conpty.node、conpty_console_list.node、winpty.dll、winpty-agent.exe、conpty/OpenConsole.exe、conpty/conpty.dll（app.asar.unpacked） |
| Mac 语音     | release/native/rpo-dictation 经 file 确认为 arm64+x86_64 universal，权限 755 | Contents/Resources/rpo-dictation                                                                                                              |
| Windows 语音 | extraResources 只配置在 mac；服务明确返回 Windows 不支持                     | 不需要 Swift 可执行文件；源码可能随 desktop/** 存在                                                                                           |

## Worker / ASAR 实测

使用当前 Electron **40.10.6**，在临时目录创建包含语言模块和完整 TypeScript 生产包的 app.asar；由独立 Electron CJS 探针动态导入 ASAR 中语言服务，在 worker 内分析临时 `const value: number = "invalid";` 项目。真实返回 TypeScript **2322** 类型错误，探针退出码 **0**，临时文件随后清理。

因此当前 Electron/TypeScript 组合下，`language-worker.mjs` 和 TypeScript 不需要增加 asarUnpack。此结论基于 Mac arm64 Electron 实测；Windows/x64 实际安装包仍应检查启动和诊断。

正则搜索 Worker 通过 `new Worker(source, {eval:true, workerData})` 启动，源码是内联字符串，只访问经过验证的工作区目录，未从 ASAR 加载独立入口文件，因此无需新增解包配置。

现有 `asarUnpack: ["node_modules/node-pty/**"]` 应保留；原生动态库和独立 spawn-helper 必须位于可真实访问的解包路径。`npmRebuild:false` 使用已附带的 Node-API 预构建资产；本次只核验文件架构/权限，不将其表述为 Windows 实体环境 PTY 运行验收。

## 更新资产命名

统一 release tag 应为 `v0.4.0-beta.1`，包内版本 `0.4.0-beta.1`。构建配置、`scripts/release-manifest.mjs` 及 `UpdateService.pickRelease` 对应一致：

- `Ready-Player-One-0.4.0-beta.1-mac-arm64.zip`
- `Ready-Player-One-0.4.0-beta.1-mac-x64.zip`
- `Ready-Player-One-0.4.0-beta.1-windows-x64.zip`（手动解压下载）
- `Ready-Player-One-0.4.0-beta.1-windows-x64-setup.exe`（Windows 更新服务选择此文件）
- Linux 将来若构建：`Ready-Player-One-0.4.0-beta.1-linux-{arch}.AppImage`（更新服务选择）、同名 `.zip`（手动下载）。本批不因存在配置就声称 Linux 包已构建。

等计划发布的平台文件**全部生成后**运行 `node scripts/release-manifest.mjs release 0.4.0-beta.1`。它输出 `updates-0.4.0-beta.1.json` 和 `SHA256SUMS-0.4.0-beta.1.txt`，采用 `wx` 避免覆盖旧清单。不要在只完成 Mac 包时先生成最终清单，否则之后新增 Windows 包不会自动补入现有清单。更新器使用 GitHub asset digest，缺失时读取 SHA256SUMS；JSON manifest 用于构建资产目录，当前不是更新器唯一元数据源。

## 旧资产不能复用

核查时 `release/mac`、`release/mac-arm64` 的 app.asar 版本仍为 0.3.0-beta.1，实际没有 LICENSE、NOTICE、本批语言服务模块、TypeScript 包或 workspace-tools。这些是旧构建产物，不代表当前源配置遗漏；发布本批功能必须重新构建。

最终 0.4 包生成后还需直接检查其 ASAR 文件清单、app.asar.unpacked PTY 文件和权限、Mac 外置语音 helper、包内版本，并从产物启动执行桌面冒烟。Swift helper 在此核查中仅确认架构/资源位置，未触发录音权限或实际录音。未签名/未公证状态应在测试版下载说明中如实标明。
