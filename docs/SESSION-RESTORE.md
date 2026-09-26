# 启动时打开上次会话

状态：下一开发批次，未包含在 0.4.7-beta.1 安装包中。

通用设置「启动时打开上次会话」默认开启。新安装没有记录时停留在会话列表；该开关只恢复界面位置，不恢复 Provider 进程、不运行 Agent、不请求接管、不自动执行审批。

## 保存与恢复规则

- 只记忆用户主动打开的、当前在线房间可见且未归档的活动会话。创建会话但未打开、后台状态广播、系统自动恢复不产生新的记忆。归档历史的手动浏览不会替换活动会话记录。
- 在现有加密 `client.json.enc` 中保存一条 `lastOpenedSession`：version、scope、workspaceId、sessionId。没有文件内容、提示词或 Provider session ID。
- scope 是 room audience、成员身份 ID、当前连接本机 secret、会话限定邀请 scope、已绑定 GitHub 身份 ID 的 SHA-256；secret 本身不暴露到 renderer 或记忆条目。房间、身份或邀请范围变化不能复用记录，本机端口变化不影响同一房间身份。
- 默认启动仍连接本机房间。上次打开远端房间不导致自动重连或使用旧邀请；当前房间不匹配则回列表。之后手动加入远端房间也不会触发第二次启动恢复。
- renderer 在健康门禁通过、获得已认证的最新在线快照后，仅尝试恢复一次。主进程再次验证当前 scope、工作区可见性、会话范围及 active 状态，不能依靠 renderer 自报目标或离线缓存恢复。
- 用户在恢复响应回来前已经点击或键盘导航时，响应不抢回页面。主进程对发送的本地 state 分配递增 revision；晚到的旧 bootstrap 不会覆盖新快照；旧房间/身份的恢复响应也不会打开页面。
- 删除、归档、权限变化导致当前会话不可见时回到列表；匹配记录被清除。WS 1008 权限/策略拒绝及断线后认证失败会丢弃旧快照。HubClient 每次连接（包括自动重连后的新 socket）都经统一 `offline(code)` 事件传递关闭原因，撤权无需等待下一次认证失败；正常退出应用不清除记录。普通网络掉线不会因此自动执行或重开会话。
- 退出共享房间、撤销团队登录会清除记录并使旧导航响应失效。关闭开关时不恢复，也不写新的打开记录；原记录保留，重新开启后只在下次启动且仍通过权限验证时可恢复。

## 接线

`desktop/services/session-navigation.mjs` 的 SessionNavigation 只依赖当前 client/online/config/saveConfig，没有 Provider/runtime/连接创建依赖。

- `navigation.open({scope,workspaceId,sessionId})`：主动打开后记录，主线程校验。
- `navigation.restore({scope})`：返回复核后的 `{scope,workspaceId,sessionId}` 或 null。
- `local.navigation={scope,ready,epoch,revision}`：给 renderer 做身份变化、启动门禁和旧状态过滤；不携带凭据。

现有 coordinator 启动恢复逻辑不由本功能修改；此功能自身没有执行调用。离线房主常驻服务、Provider 原生会话续跑不是它的能力。

## 验证

- `tests/session-navigation.test.mjs`：真实 Hub/WebSocket 多成员、SecureStore 加密磁盘、同房不同身份、不同 audience/secret/会话限定范围、归档/删除、真实成员移除、自动重连后 1008 关闭原因、离线、关闭开关、登出和写入失败回滚。
- `tests/session-navigation-view.test.mjs`：真实 React main 在 Electron 中，验证无记录不跳转、仅一次恢复、用户先导航、不接收晚到旧 bootstrap、旧身份响应、权限快照撤回和关闭开关。记录所有调用并确认没有 run/lane/handoff/terminal/providers 执行调用。合成快照不含用户数据。
- `scripts/session-navigation-desktop-smoke.mjs`：实际 main/preload/React + 临时加密数据目录，五个真实进程验证首次打开、重启恢复、归档后的下一次启动回退、关闭后的启动回退，以及临时远端 Hub 正常重连后撤销成员：实际 main 必须在下一次认证尝试前清除快照、界面选择和导航 scope；无 Agent lane/审批、Provider runs=0，不改已安装应用。
- 通用设置校验、实际更新健康门禁 confirm/reject 两条路径回归通过；构建通过。未发布安装包。Mac 已验证；Windows/Linux 的真实桌面重启仍待平台验收。

隔离源码完整回归 **408/408 通过**，零跳过，TypeScript/Vite 构建通过（2026-09-26）。隔离树排除了其他任务的群聊和 ProjectContext 改动；此结果尚不等于发行包验收。
