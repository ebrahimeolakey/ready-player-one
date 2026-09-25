# 桌面通知、完成声音与菜单栏

`desktop/services/desktop-notifications.mjs` 封装 Electron 原生能力，通过依赖注入可测试。没有网络调用，不读取项目/账号凭据，不把提示文案写入协作记录。

## 设置与语义

使用 `core/general-settings.mjs` 的 `resolveGeneralSettings`：

| 字段 | 默认 | 行为 |
| --- | --- | --- |
| `notificationsEnabled` | true | 系统通知总开关；不影响独立完成声音 |
| `notifyApprovals` | true | 新 pending 执行/工具审批 |
| `notifyHandoffs` | true | Hub 中真实 `needs_handoff`，且 `handoffNeeded.runId === activeRunId` |
| `notifyUnknownOutcomes` | true | Hub 中真实 `outcomes[].status === 'unknown'` |
| `trayIcon` | false | 创建或移除菜单栏/系统托盘图标 |
| `completionSound` | false | 可信本机 onFinish 的 `status === 'done'` 播放一次系统 beep |

系统通知仅在窗口未聚焦时显示，统一 `silent:true`，避免系统默认音效绕过完成声音开关。完成声音独立于通知总开关及窗口焦点；error/interrupted 不响、不发泛化“执行结果”通知，交由 Hub 的接管/结果待确认分类，避免重复及绕过分类关闭。

通知文案仅含类别与数量，不包含提示词、输出、路径、错误正文或令牌。每份 snapshot 同类新增事件汇总一条。点击通知仅显示并聚焦窗口，不执行审批、接管或外部操作。

首次完整快照只记录基线；不开历史通知/完成声音。被焦点、偏好或健康门禁抑制的事件仍记为已见，之后不补发。通知去重按审批类型+id、会话/lane/runId、outcome id+version；用户明确将一个结果新版本重新记录为 unknown 会再次提示。

## 集成 API

需在 Electron `app.ready` 后才启用菜单栏设置；可以提前构造 `active:false`：

```js
const notices = new DesktopNotifications({
  Notification, Tray, Menu, nativeImage, active:false,
  beep: () => shell.beep(),
  showWindow: () => { win?.show(); win?.focus(); },
  quit: () => app.quit(),
  isFocused: () => !win || win.isDestroyed() || win.isFocused(),
  onError: error => { notificationError = error.message; emit(); },
});
```

- `setPreferences(resolvedSettings)` 应在配置成功持久化后调用。原生 Tray/Notification 错误通过 `onError` 和 `getState().lastError` 报告，不把已成功保存的设置变成 IPC 失败。`getState()` 返回 `{active,trayActive,lastError}`；`trayActive` 是实际创建状态，不是用户偏好值。
- `observeSnapshot(snapshot,{connection:hubClient,active})` 对 HubClient 对象及 `snapshot.me.id` 隔离；连接对象或身份改变时，关闭旧通知并清除去重。`active` 可省略，保留当前门禁状态。同一连接断线重连保留已见记录。
- `resetConnection()` 在主进程切换连接开始时调用，避免关闭旧运行过程中发出跨 Hub 尾部通知。
- `finish(result,{connection,identityId,active})` 只能从主进程可信 RunCoordinator 的 onFinish 调用，不能通过 renderer IPC 或凭 snapshot 推断结束。`identityId` 默认取 `connection.state.me.id`，检查当前连接/身份及非空 `sessionId/runId`，按一次真实结束去重；无需等待对应运行快照，以免漏掉快 run。主线程先以执行记录的持久化 scope 与当前 coordinator scope 比较，再调用。
- `setActive(false)` 关闭通知、移除菜单栏、禁止声音，只收集基线；适用于更新健康确认/失败页面。验证通过后依次 `setPreferences(...)`、`setActive(true)`、`observeSnapshot(current,{connection})`，再 resume；恢复后首快照是新基线。
- `dispose()` 用于 before-quit：关闭所有原生通知、清除定时器及监听器、销毁托盘、释放连接与去重记录。可重复调用。

现有接入位置：

```js
// RunCoordinator.onFinish；这是 Provider 原生结束后的可信本机回调。
if (client && coordinator.records.get(result.runId)?.scope === coordinator.scope(client)) {
  notices.finish(result,{connection:client});
}

// connect: 替换旧 notifiedApprovals Set 与 new Notification 循环。
notices.resetConnection();
next.on('state', () => {
  if (client !== next) return;
  notices.observeSnapshot(next.state,{connection:next});
});

// before-quit
notices.dispose();
```

状态证据来自当前代码：`core/hub.mjs` 的 `run.finish` 在结构化 usage/rate limit 时设定 `needs_handoff` 与对应 runId；`core/outcomes.mjs` 的 `outcome.report/resolve` 保存 unknown 状态与递增 version。这里只消费这些明确状态，不根据错误文案猜测。

## 资源和平台边界

托盘内嵌 18 点、2x PNG，无外部图片依赖；macOS 使用 template image。点击激活窗口，菜单包含“显示窗口”和“退出头号玩家”。关闭设置会销毁原生对象；旧菜单回调在销毁或切换后失效。通知对象最长保留两分钟，最多同时保留 32 个，即使 OS 不回调关闭也会清理。

去重 Set 在同一连接内保留已见事件和完成记录，直到连接/身份切换或退出时清空；大量长期运行会增加这部分内存，本批未用简单淘汰换取旧事件重播。

系统权限、专注模式、系统音量、桌面环境以及托盘支持可能阻止实际显示/发声。`Notification.isSupported()` 不是已获用户许可的证明。Linux 不同托盘实现的激活行为可能不同；本轮不声称 Windows/Linux 原生显示实测通过。服务不会主动改系统通知权限。

## 验证记录

- `node --test tests/desktop-notifications.test.mjs`：12 项，覆盖历史基线、分类/总开关、焦点抑制、聚合去重、独立声音、快 run、Hub/身份围栏、更新门禁、菜单回调、原生错误、资源上限及销毁。Electron 能力在这些回归中为注入 fixture，不能冒充实际通知显示。
- 2026-09-24，macOS、Electron 40.10.6，独立临时进程实际创建/移除/重建/销毁原生 Tray，PNG 解码成功，click 事件回调触发聚焦函数。没有请求系统通知许可、没有显示测试系统通知、没有播放测试提示音，也没有操作其他应用。临时进程退出，数据目录已清理。
- 该原生检查验证创建与生命周期及事件处理；没有声称用户手动点击系统菜单或真实终端用户听到音效。
