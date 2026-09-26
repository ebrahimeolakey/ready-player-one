# 外观主题与协作者颜色

本模块属于 0.4.6 冻结后的开发批次；没有修改其安装包或发布记录。

## 接线 API

```tsx
import {AppearanceProvider, useAppearance} from './Appearance';

<AppearanceProvider value={{theme: 'light', collaboratorColors: true}}>
  <App />
</AppearanceProvider>
```

- 导出 `AppearanceValue`、`AppearanceContext`、`AppearanceProvider`、`useAppearance()`。
- 值为 `{theme: 'dark' | 'light', collaboratorColors: boolean}`，缺省 `dark / true`。无效主题回退 dark，颜色只有显式 false 才关闭。
- 在应用顶层挂载一个 Provider，包含模态框与 portal 所属的 React 树。Provider 将 `html[data-theme]` 同步到主题；卸载时恢复原属性。不应嵌套多个负责同一 HTML 文档的 Provider。
- `AppearanceContext.Provider` 可用于纯组件消费，但不会独立同步 HTML 属性；完整应用应使用 `AppearanceProvider`。
- 通用设置的「界面」分组已加入主题选择与协作者颜色开关。`core/general-settings.mjs` 校验两字段，经既有 `settings.general.save` 存入加密 client 配置；旧配置补 dark / true，其他偏好保持。没有“跟随系统”模式。
- `main.tsx` 在 dataDir 已加载、更新健康门禁已通过后挂载 AppearanceProvider，包住应用和全部模态框。检查中/拒绝状态继续展示专用门禁 UI，不提前挂载应用。

## 已实现

独立 `theme.css` 逐项设置浅色表面、文本、边框、悬停、选中、焦点、警告和审批颜色。覆盖主导航、设置卡片及开关、会话与成员、消息/输入、文件树、编辑器、终端、模型菜单和通用模态框；不使用全局反色滤镜。

- CodeEditor 使用 CodeMirror 原生 `light` / `dark` 主题，缩进线与 Canvas 缩略图同步配色。优先应用 Appearance 的主题，覆盖调用方遗留的 `theme="dark"` 参数；通过重新配置扩展保留 EditorView、文档和选区。
- InteractiveTerminal 使用 Xterm 公共 `options.theme`，修改现有实例的文字、背景、ANSI 颜色、光标及选区；设置 `minimumContrastRatio: 4.5`。切换不重新打开 PTY，不清终端输出。
- Avatar 对 NFC 标准化姓名作稳定哈希，从六组配色选择；相同姓名始终同色。关闭多色后，所有头像使用当前主题的统一中性配色。保留姓名、头像字符、选中边线与焦点规则；颜色不是身份或权限判断，重复姓名和调色板碰撞仍依赖显示名称辨识。

## 验证

```sh
node --test tests/appearance-view.test.mjs tests/editor-settings-view.test.mjs tests/studio-preferences-view.test.mjs tests/editor-settings.test.mjs
```

本机 9/9 通过；`tsc --noEmit` 和 `git diff --check` 通过。外观专属测试通过真实 Electron 离屏页面挂载 Studio、GeneralSettings、EditorSettings、CodeMirror、Xterm、Avatar 和 Modal，使用合成 RPC / 文件内容：

- 深 → 浅 → 深主题切换，检查实际 CSS、CodeMirror darkTheme facet、缩略图与 Xterm 渲染表面。
- 主要浅色表面的正文及头像色彩对比度至少 4.5:1（不声称已审计每个语法 token 或禁用控件）。
- EditorView、未保存内容、选区及模态输入焦点保留。
- Xterm DOM 不替换；terminal.open 只有一次，切换不调用 terminal.close。
- 头像稳定配色、关闭多色、恢复配色；卸载恢复原 HTML 属性。
- 原有保存竞态、布局/密度与编辑器设置测试继续通过。

可选 `RPO_APPEARANCE_SCREENSHOT_DIR=/tmp/rpo-appearance-preview` 保存合成页面的 light.png / dark.png。截图使用离屏渲染并等待绘制帧，避免隐藏窗口的 capturePage 返回上一帧。已人工查看两种主题的截图，未使用真实项目、账户数据或模型。

实际桌面验证：`node scripts/general-settings-desktop-smoke.mjs` 使用隔离临时 RPO_DATA_DIR 启动真实 main / preload / React，通过控件选择浅色、关闭头像多色，验证广播不重置草稿、保存写入加密配置。第二个全新进程确认主题/中性头像恢复，再通过「恢复默认」切回 dark / true。两个阶段通过，且真实磁盘保存失败仍回滚原设置。`node scripts/update-health-desktop-smoke.mjs` 的通过/拒绝两条路径均通过；正常应用仅在健康检查成功后出现。未调用真实模型或修改已安装应用。

边界：验证的是源码桌面入口的实际进程重启，并未重新打包或发布安装包；不是原版浅色界面的像素级复刻。系统原生菜单/窗口装饰、系统登录对话框及嵌入的外部网页不由本 CSS 重新着色。已查看实际 Mac 通用设置浅色页面；仍需更多实际页面巡检及 Windows 视觉确认。Linux 无 DISPLAY 时真实 Electron 视图测试明确跳过。
