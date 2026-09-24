# Mac 更新安装与重启验收

2026-09-24，Mac arm64。当前源码 `UpdateService` 对官方 0.3.0-beta.1 应用副本实际完成了检查、下载、校验、旧版备份、原位替换和 0.4.0-beta.1 界面启动。

## 真实证据

- 旧版 ZIP SHA256：`a15c7c61726b7f2c151cd8d6707d1762075351a07e68d024ea2d839f66b31499`，与 GitHub Release 官方 digest 相同。
- 真实下载 [0.4.0-beta.1 arm64 ZIP](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.0-beta.1/Ready-Player-One-0.4.0-beta.1-mac-arm64.zip)，123,656,498 字节。SHA256：`88f13ae58508d37c95456654a4b8aa8d803a440a3c487bd2b801a5b81a3051d1`，同时与 GitHub digest 和 [官方 manifest](https://github.com/ebrahimeolakey/ready-player-one/releases/download/v0.4.0-beta.1/updates-0.4.0-beta.1.json) 相同。
- 测试目标为 `/tmp/rpo-updater-validation/old-copy/头号玩家.app`，数据目录为 `/tmp/rpo-updater-validation/data`；没有替换用户 Applications 目录中的应用。
- 安装脚本确实等待调用进程退出，创建 `.rpo-backup-*.app` 并替换目标。备份 app.asar 的 SHA256 与原版相同：`099cd941b970f5ef3076a228c95e33e0dc3dae7aa7b9c0cd98701c7aecf69abf`。
- 安装后的 app.asar 与官方新包解压内容相同：`f8f3889566922442fcfd17e7d1005057b92e20e75002ed3e391a7c7789d6e1e6`。
- 新应用真实启动，进程 PID 22735，Renderer 参数指向上述临时 bundle，并使用 `--user-data-dir=/tmp/rpo-updater-validation/data/electron`。
- CUA 读取新副本界面，通用设置显示 `应用更新 · 0.4.0-beta.1`、`已是最新版本`，旧配置昵称“更新隔离验收”保留；旧 plaintext client.json 已迁移成 client.json.enc。
- 验收后只关闭临时副本；用户现用应用 PID 38583 保持运行。

## 修复与测试

原安装脚本使用 `open "$target"`，会遗漏自定义数据目录，也可能激活已有同 bundle 实例。现改用 `open -n`，通过参数逐项继承 `RPO_DATA_DIR`、`RPO_IDENTITY_ISSUER`、`RPO_IDENTITY_PUBLIC_KEY_FILE`。白名单不会扩展到其他环境变量；含中文、空格及 `$(...)` 的路径按字面值传递。

`tests/updater.test.mjs` 共 12 项通过，覆盖真实 shell 参数处理、原位替换失败回滚和既有版本选择/哈希验证。Node 与 Electron 40 自带 Node 均通过。Mac 实际重启验收使用了 `RPO_DATA_DIR`；两个团队身份配置的传参由 shell 回归测试验证，本轮未配置外部 OAuth 服务。

## 明确边界

0.3.0 发布包没有更新入口。本次由当前源码的 UpdateService 在独立 Node 宿主中驱动原封不动的旧 bundle；不是旧版 UI 原生点击升级。安装、替换、重启命令和新应用窗口都是真实执行。

`open -n` 与环境白名单修复发生在 0.4.0-beta.1 发布之后，已随 0.4.1-beta.1 发布；没有覆盖原 0.4.0 Release 资产。0.4 的原始更新入口尚未通过未来版本验收。安装器只判断启动命令是否成功，不监测后续应用健康，也不能保证启动后崩溃时自动回滚。

Windows 仍仅有安装器参数替身测试，没有 Windows 真机升级通过结论。Linux 本轮未进行实机重启。
