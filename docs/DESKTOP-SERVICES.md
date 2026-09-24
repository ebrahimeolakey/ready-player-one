# PTY 与隔离浏览器接入

## Main / preload

`TerminalService` 来自 `desktop/services/terminal.mjs`；`BrowserService` 来自 `desktop/services/browser.mjs`。

```js
const terminalService = new TerminalService();
const browserService = new BrowserService({ BrowserWindow, session, openExternal: url => shell.openExternal(url) });
for (const [service, channel] of [[terminalService, 'rpo:terminal'], [browserService, 'rpo:browser']]) {
  service.on('event', (ownerId, payload) => {
    const target = webContents.fromId(ownerId);
    if (target && !target.isDestroyed()) target.send(channel, payload);
  });
}
```

只接受主应用已验证的本地 renderer 发起 IPC，不能把能力暴露给浏览器的远程页面。ownerId 必须取 `event.sender.id`，不能由 renderer 提供。`terminal.open` 的 cwd 必须由 main 用现有 `localRoot(args)` 根据本机会话映射解析；禁止直接转发 renderer 提交的 cwd。

| invoke 名称 | 转发 |
| --- | --- |
| terminal.open | `terminalService.open(ownerId, { cwd: localRoot(args), contextId: args.sessionId, cols: args.cols, rows: args.rows })` |
| terminal.read/input/resize/close | `terminalService[动作](ownerId, args)` |
| browser.open/navigate/action/close/external | `browserService[动作](ownerId, args)` |

窗口关闭时调用两服务的 `closeOwner(ownerId)`；应用退出调用 `closeAll()`。终端和浏览器事件分别使用 `rpo:terminal` / `rpo:browser`，不要放入 `rpo:event` 状态广播。preload 增加 `subscribeTerminal(callback)` 和 `subscribeBrowser(callback)`，与已有 subscribe 一样返回取消订阅函数，不暴露原始 ipcRenderer。

## React

- `<InteractiveTerminal bridge={window.rpo} workspaceId={...} sessionId={...} />`：父容器需要非零高度；真实 PTY，自动随容器 resize。组件卸载关闭终端。
- `<BrowserPanel bridge={window.rpo} />`：输入网址、后退前进刷新、显示和关闭窗口、对弹出的 HTTP(S) 外链明确选择是否在系统浏览器打开。

两组件自带独立 bridge 类型；请给全局 `RPO` 类型添加两个 subscribe 方法。PTY 输出订阅带 sequence，初始读取快照与增量去重，避免创建时丢失提示符。

当前浏览器以独立 BrowserWindow 呈现；它是桌面应用内部隔离窗口，**尚未嵌入 Studio 分栏**。未来可复用策略改为 WebContentsView。每窗口使用非持久化 session，不共享应用会话、没有 preload、Node 禁用、sandbox 开启。顶层和 frame 只允许 HTTP(S)，新窗口先拦截后等用户决定；设备权限和下载默认拒绝。关闭清理浏览器存储。

## 原生依赖与测试

新增 node-pty 1.1、@xterm/xterm 6、@xterm/addon-fit 0.11。node-pty 1.1 提供 Node-API 预编译；Mac arm64/x64 与 Windows x64/arm64 可跨 Electron ABI 使用，不依赖特定 Node_MODULE_VERSION。

`npm install` 后项目 postinstall 运行 `scripts/prepare-native.mjs`，修复打包时缺失的 macOS spawn-helper 执行位。build 将 node-pty 从 ASAR 解包并关闭自动 native 重编，避免 Mac 主机构建 Windows 时错误重编。Linux 缺少预编译，需在 Linux 安装依赖时正常完成 node-pty 原生编译。

```sh
node --test tests/terminal.test.mjs tests/browser.test.mjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/terminal.test.mjs
```

实际 macOS PTY 检查：TTY、交互输入、resize、Ctrl-C、退出码及进程清理。浏览器策略检查覆盖权限/协议/所有者/外链显式决定；GUI 和 Studio 集成需要由主任务使用 CUA 继续验收。当前测试不能替代 Windows ConPTY 实机测试。

## 主分支内嵌浏览器接入

BrowserService 现在可注入 WebContentsView 与 getOwnerWindow；main使用原生子视图嵌入工作台，BrowserPanel通过browser.bounds同步区域。弹窗打开时隐藏浏览器视图，退出面板时关闭会话。独立BrowserWindow仍作为未注入视图的回退与单元测试适配；此项需真实桌面布局验收。
