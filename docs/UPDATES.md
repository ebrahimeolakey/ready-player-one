# 应用更新

`desktop/services/updater.mjs` 是独立更新服务，官方仓库固定为 `ebrahimeolakey/ready-player-one`。它实际下载并校验安装包，不把打开网页算作更新。

## 主进程集成

```js
const updates = new UpdateService({
  version: app.getVersion(),
  cacheDir: join(app.getPath("cache"), "rpo-updates"),
  execPath: process.execPath,
  isPackaged: app.isPackaged,
  appImagePath: process.env.APPIMAGE,
  onState: (state) => {
    localUpdateState = state;
    sendLocalState();
  },
  quit: () => app.quit(),
});
```

IPC：`updates.state` → `getState()`；`updates.check` → `check()`；`updates.download` → `download()`；`updates.cancel` → `cancel()`；`updates.install` → `install()`。安装 IPC **只能由用户点击“安装并重启”触发**，检查或下载不会执行安装器。开发模式拒绝替换应用。

React `UpdatePanel({call,state})` 接收上述本机更新状态。通过本机 state 订阅推送进度，不进入共享 Hub。Beta 版本默认包含预发布；正式版默认只看正式发布。可按需 `check({includePrerelease:true})`。

## 来源与完整性

- 从 GitHub Release 列表选择高于当前版本且匹配 OS / 架构的资产。Windows-only 发布不会被选为 Mac 更新。
- 优先使用 GitHub 官方 release asset 的 SHA256 digest；缺失时读取该发布的 `SHA256SUMS*.txt`。缺少校验值时拒绝自动安装。
- 下载仅接受本仓库 release URL 和 GitHub 官方资产重定向域名；不传本机登录 token。
- 限制下载大小，计算流式 SHA256；不符即删除临时文件。安装前再次计算 SHA256，拒绝下载后被修改的文件。
- `npm run release:manifest` 为本次已构建资产生成 `updates-VERSION.json` 和 `SHA256SUMS-VERSION.txt`。文件以独占创建写入，不覆盖既有资产或清单。将两份文件和安装包一同上传新的 Release。现有手工发布无需改写，GitHub asset digest 已可直接使用。

SHA256 的信任来源是官方仓库与 HTTPS；这不是独立开发者代码签名，不能替代 Mac / Windows 签名和公证。

## 安装流程

- **Mac ZIP**：检查归档路径、应用 bundle ID、版本和 Mach-O 架构；复制到应用目录旁的新位置；用户确认后由独立脚本等待当前进程退出，保留旧应用备份、原位替换并用 `open -n` 重新启动指定副本。重启仅显式继承 `RPO_DATA_DIR`、`RPO_IDENTITY_ISSUER`、`RPO_IDENTITY_PUBLIC_KEY_FILE` 三个配置项，不泛传凭据环境。替换或启动命令失败时恢复旧应用。不依赖用户安装 Xcode。临时挂载的 App Translocation 应用先要求移入应用程序目录。
- **Windows**：下载匹配架构的 NSIS setup.exe，验证后才启动安装器并退出应用。由 Windows 安装器完成替换与最终启动步骤；不静默强制安装。
- **Linux AppImage**：验证 ELF 架构、写入权限；退出后原位替换并重启，保留旧文件。解压 ZIP 运行方式不会擅自覆盖整个目录，需要先改用 AppImage。

应用备份位于原安装目录旁，更新下载位于专用缓存目录。当前实现保留备份供故障恢复，尚未添加备份自动轮替/清理 UI。

## 验证边界

自动测试覆盖平台筛选、版本排序、校验失败丢弃、第三方重定向拒绝、安装前重新校验、未点击不执行安装器、Windows 启动参数、Linux ELF 架构、含空格/特殊字符路径以及替换失败回滚。Windows 安装调用使用替身进程测试；不等于 Windows 机器上完成升级。

Mac 官方包实际网络下载和校验结果由本轮验证记录补充。安装替换测试只操作临时目录，没有升级或替换用户当前安装的应用。Mac 当前源码安装器已完成官方包的隔离替换与界面重启验收，详见 [Mac 更新验收](UPDATER-MAC-VALIDATION.md)。Windows 和 Linux 实机更新仍需对应平台验收。

2026-09-24 真实网络验证：使用服务检查旧版本 `0.2.0-beta.1`，正确跳过 Windows-only 发布并选中官方 `Ready-Player-One-0.3.0-beta.1-mac-arm64.zip`，完整下载后 SHA256 为 `a15c7c61726b7f2c151cd8d6707d1762075351a07e68d024ea2d839f66b31499`，与官方 digest 一致。临时下载已删除；没有执行安装或替换当前应用。

同日还用真实 v0.3.0-beta.1 Mac ZIP 在完全隔离的临时目录完成解压、bundle ID、版本、Mach-O 架构和更新暂存验证，返回 `mac-replace` 计划；随后删除测试目录。没有对用户应用目录执行替换。

重启环境白名单及 `open -n` 是 v0.4.0-beta.1 发布后的源码修复，已随 v0.4.1-beta.1 发布，原 v0.4.0 Release 资产保持不变。
