# Git 审阅按钮位置

状态：下一开发批次，未包含在 0.4.7-beta.1 安装包中。

通用设置新增「Git 审阅按钮」：路径栏 / 浮动条，字段 `reviewControlLocation: 'breadcrumb' | 'floating'`，默认路径栏。旧配置获得默认值；使用现有加密通用设置保存，重启恢复。它不改变会话布局、编辑器草稿或终端实例。

## 原版证据与本项目映射

原版 0.1.38 的 General 中存在 Review control location；初次观察见 [剩余偏好证据](AMOEBA-REMAINING-PREFERENCES.md)。后续界面核对补足了点击循环的两个字面值 Breadcrumb / Floating island。本项目中文选择控件表达这两个位置；没有声称原版实际按钮行为已经 1:1 验证。

本项目现有真实操作是文件级 `git.stage` / `git.unstage`。选中文件后，该文件在当前已暂存或未暂存分组中的按钮移至 diff 路径栏或底部浮动条，列表对应按钮不再重复；其他文件仍可从列表操作。切换位置只改 CSS 排列，同一按钮与 diff 评论组件保持挂载，不发出 Git 或其他 RPC。浮动条随滚动保持在审阅区域内。按钮明确写「暂存」或「取消暂存」，不是接受/拒绝代码片段，不执行提交。

- 当前文件、staged 状态、workspace/session/lane 均沿用实际 diff 上下文。
- 加载中、读取失败及无文本且非二进制差异不显示选中文件审阅按钮；无选中文件时没有空浮动条。二进制变更仍可进行文件级暂存。空文件或无法预览时保留文件列表原有按钮，避免失去暂存入口。
- 迟到的旧文件预览不得启用当前文件按钮；切换会话清除旧选择。
- Editor/Owner 可使用写操作；Viewer/Commenter 可读 diff，不出现暂存按钮，分支/远端/提交写操作禁用。Agent 忙碌时沿用禁用规则。
- 浅色和深色主题均有明确背景、边框与对比度；路径很长时换行，窄窗口不把按钮推到区域外。

## 主进程授权

此前 GitPanel 的写按钮没有相应主线程工作区角色门。本批新增 `desktop/services/git-access.mjs`，在 `desktop/main.mjs` 的全部 `git.*` IPC 分支调用。每次读取当前在线连接的最新 Hub state，再验证同一连接仍在线、workspace/session 可见且匹配、会话限定邀请范围、可选 lane 属于本人成员。未知方法和上下文外的参数一律拒绝，不接受 renderer 提供 root、命令或环境变量。

- 只读白名单：status、branches、diff。
- 写入白名单：stage、unstage、commit、fetch、pull、push、createBranch、switchBranch；要求目标工作区 Editor/Owner。
- 路径仍由现有本机 workspace/session/lane 映射解析；GitService 的相对文件路径校验、忙碌检查、仓库锁继续生效。该门不将协作角色转换为操作系统权限。
- GitHub 创建/绑定是独立的本机账号与审阅 receipt 流程，不接受这里的 workspace/session 上下文；本批未重新定义它的权限。用户明确选取目录后的 remote 绑定也不属于这里新增的 `git.*` 门。

## 验证

- `tests/git-access.test.mjs`：真实 Hub 多客户端 + 临时真实 Git 仓库，Viewer/Commenter 不能改 index、Editor 可暂存/取消、Owner 合法本人 lane、即时降权/移除、跨工作区/会话与他人 lane、方法与参数注入、离线/连接替换。拒绝操作后检查真实 index 未改变。
- `tests/git-review-view.test.mjs`：真实 Electron/React 组件，控制器的 Git 响应为合成数据；验证两种位置、长 diff 滚动、380 像素窄窗口、浅深主题、切换无 RPC、相同 DOM 与未发送评论保留、单次正确文件操作、staged/unstaged、迟到旧预览、空 diff、只读及切换会话。
- `tests/studio-preferences-view.test.mjs`：切换位置及其他偏好后，实际 CodeMirror DOM 与未保存内容保持，实际 xterm DOM 不重建、不关闭 PTY。
- `scripts/general-settings-desktop-smoke.mjs`：真实 main/preload/React 两次进程，界面保存浮动条至加密配置，重启读取浮动条，恢复默认返回路径栏，失败写盘回滚。Mac 验证；未执行真实模型、未修改已安装应用。

这不是逐 hunk 接受/拒绝功能，也不增加自动暂存、自动提交、拖动浮动条或自动 Git 操作。Windows/Linux 真实桌面视觉与重启仍需对应平台验收。

隔离源码完整回归 **411/411 通过**，零跳过，TypeScript/Vite 构建通过（2026-09-26）。隔离树排除了其他任务的群聊与 ProjectContext，包含已提交的会话恢复；尚未发行安装包。

真实 Electron 合成界面视觉复核覆盖 900px / 380px、深浅主题及 diff 实际滚动 240 / 900px；按钮均仅一套，无页面横向溢出。修正了浅色 Git 列表对比度与空冲突列表显示多余“0”，修后定向 UI 回归及构建通过。见 [测量数据](evidence/git-review-evidence.json)、[浅色浮动条](evidence/git-review-narrow-light-floating.png)、[窄屏路径栏](evidence/git-review-narrow-dark-breadcrumb.png)。仅调用合成 Git 响应，不代表原版对照或真实 Git 端到端截图。
