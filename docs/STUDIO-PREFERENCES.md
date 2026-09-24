# 会话布局与对话密度

通用设置由 `GeneralSettingsContext` 提供；会话通过 `useGeneralSettings()` 读取，不另存第二份配置。

- `layout: agent | editor`：上下布局分别默认把 62% / 28% 高度分配给 Agent／终端面板。用户仍可拖动分隔线；切换布局重置当前拖动比例。Editor 优先时保留会话、审批和终端入口。
- `autoHideEmptyEditor: true`：尚未打开文档时，收起编辑器空白区域，保留资源管理器和「显示编辑器」按钮。选择文件即恢复；已打开或未保存的文档不会被该偏好隐藏。Git、浏览器、调试视图不按空编辑器处理。手动显示空编辑器只在当前会话临时生效，切换此偏好后重新评估。
- `conversationDensity: detailed | compact`：详细模式默认展开工具和思考内容；紧凑模式默认折叠这些详情，用户仍可逐条展开。用户消息、最终回复和审批保持可见。手动开合在普通状态广播、流式内容更新期间保留；切换密度重置默认开合。长诊断日志继续默认折叠。
- 引用定位验证消息 SHA-256 后才展开并滚动至目标；内容变化的引用给出提示，不错误展开其他消息。

布局、空态显示和收起下方面板均不卸载编辑器／已打开的交互终端。实际关闭会话或明确关闭 Provider CLI 仍走既有清理。文件保存、草稿和运行权限不变。

## 验证

`node --test tests/studio-preferences-view.test.mjs tests/editor-settings-view.test.mjs`

隐藏的临时 Electron 页面加载真实 Studio、Panels.Editor、CodeMirror、AgentLane 和 InteractiveTerminal/Xterm。合成 RPC 提供临时测试数据，不读取用户项目、不启动真实 Provider。验证：

1. 两种布局实际尺寸不同；空区域归零、文件树和恢复入口可用。
2. 打开文件后修改，切换布局／密度／隐藏空编辑器，保持同一个编辑器实例及未保存输入。
3. 打开终端后收起并恢复，保留同一个 Xterm DOM，`terminal.open` 仅一次且没有调用 `terminal.close`。此项验证组件与 PTY 服务的生命周期边界，不声称执行了真实 shell。
4. 紧凑模式详情可展开且广播不重置；用户／最终回复／批准按钮仍显示。
5. 有效引用展开目标，无效哈希显示内容已变化。
6. 既有真实编辑器夹具继续验证保存回包期间新输入不被覆盖。

Linux 无 DISPLAY 时 Electron 视图测试明确跳过；Mac 隐藏窗口可运行。字体设置与主进程偏好持久化各有独立测试。
