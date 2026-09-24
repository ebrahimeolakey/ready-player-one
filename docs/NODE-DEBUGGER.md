# 本机 Node.js 调试

调试面板直接运行用户选中的 `.js`、`.mjs`、`.cjs` 文件。点击“启动”后，以本机 Node（桌面打包版使用 `ELECTRON_RUN_AS_NODE=1`）开启 `--inspect-brk=127.0.0.1:0`，通过真实 V8 Inspector WebSocket 协议暂停在入口。

支持：源码行断点、继续、暂停、单步跳过、进入函数、跳出函数、调用栈、局部/闭包/module 变量、未捕获异常暂停、标准输出和错误输出、停止。所有 Inspector 地址只在主进程保存，不发送给 renderer 或协作者；不开放远程 attach 入口。

## 操作

1. 打开当前工作区的调试面板，选择 JavaScript 文件。
2. 点击源码行号设置断点，再点“启动”。文件会在本机真正执行。
3. 使用“继续”到断点，选择调用栈查看局部变量，使用“单步 / 进入 / 跳出”逐步运行。
4. 点击“停止”结束进程树。离开面板或关闭窗口也会停止该面板的调试进程。

文件列表跳过隐藏目录、node_modules、dist、build、coverage 和符号链接，最多显示 1000 个文件。服务端独立校验真实路径，禁止 `..`、绝对路径和逃出工作区的符号链接。此校验不构成运行代码沙箱：所选 JavaScript 及其正常依赖按本机账号权限执行。

不会自动读取 launch.json、运行 npm scripts、执行调试表达式或条件断点，也不会执行 NODE_OPTIONS 中隐藏的 preload。局部变量通过 `Runtime.getProperties` 读取，不调用 getter、不执行 evaluate 或 callFunctionOn。对象仅显示类型/描述，不展开整个堆。

## 主进程接口

```js
import { DebuggerService, handlesDebugger } from './services/debugger.mjs';
const debuggerService = new DebuggerService({
  // 必须由主进程验证本窗口、workspace、本人 lane 及 editor 权限。
  // 不应直接信任 renderer 传来的 cwd/root。
  resolveContext: async (ownerId, args) => ({
    root: trustedLocalRoot(args),
    contextId: args.laneId || args.sessionId || args.workspaceId,
  }),
  // 只检查活动 Agent / Git 操作；服务已预留自己的启动锁。
  beforeStart: async (root, ownerId, args) => ensureNoAgentOrGitMutation(root),
});
const result = await debuggerService.invoke(webContents.id, method, args);
```

- `debug.files` → `{files,truncated}`。
- `debug.source {path}` → `{path,text}`，预览限制 512 KiB。
- `debug.start {path,breakpoints?:[{path?,line}]}` → state，行号从 1 开始。`path` 为工作区相对路径。
- `debug.read {id?}` → state 或 null；省略 id 返回当前窗口/工作区的记录。
- `debug.action {id,action}`，action 仅 `pause|resume|stepOver|stepInto|stepOut`。
- `debug.breakpoint.set {id,path,line}` / `debug.breakpoint.remove {id,breakpointId}` → state。
- `debug.variables {id,pauseId,frameId}` → `{pauseId,frameId,scopes}`；旧暂停位置拒绝读取。
- `debug.stop {id}` → 进程确认退出后的 state。

state 包含 `id/contextId/path/status/reason/pauseId/sequence/exitCode/error/frames/breakpoints/output`；调用栈和变量 ID 只在当前暂停中有效。`src/DebuggerPanel.tsx` 接收 `{bridge:{invoke},context}`，每 500 ms 读取状态，不需暴露 Inspector RPC 到 preload。

`isBusy(root)` 包含启动预留和尚未确认退出的进程树，不应只用 paused/running 文案判断。主进程应据此阻止 Git 改写和 Agent 新启动。`beforeStart` 不应再次询问同一 debuggerService 的 isBusy，否则会拦截自己的启动预留。`await closeOwner(webContents.id)` 和 `await closeAll()` 会停止并等待进程退出；退出超时不会假报空闲。

## 范围与验证

这是 Node.js JavaScript 调试器，不是通用 DAP 实现；不支持 TypeScript 编译、source maps、任意 VS Code 调试扩展、远程 attach、变量赋值、表达式求值、条件断点或自定义启动配置。源码预览来自磁盘，运行中修改代码后必须重新启动调试。

测试在临时目录启动真实 Node 子进程，不 mock Inspector：验证入口暂停、源码断点、调用栈、单步后局部变量 `5 → 7`、stepInto/stepOut、异常暂停、正常/异常退出、显式暂停、跨窗口拒绝、路径逃逸拒绝、旧暂停 ID 拒绝、进程树清理、启动关闭竞态和 NODE_OPTIONS preload 隔离。

macOS 上已执行这些测试。POSIX 使用独立进程组，并确认进程组消失；Windows 使用 `taskkill /T /F` 并等待返回及主进程退出，尚未在真实 Windows 主机完成本轮端到端验证。调试目标如果自行创建脱离进程组/父进程树的后台守护进程，不属于普通子进程树清理保证。

协议依据：[Node.js debugger](https://nodejs.org/api/debugger.html)、[V8 Debugger protocol](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/)、[V8 Runtime protocol](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)，以及当前依赖 `@types/node/inspector.generated.d.ts` 的相应协议类型。
