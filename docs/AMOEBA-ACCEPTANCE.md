# Amoeba 对齐：下一步开发与验收清单

配套 [当前差距表](AMOEBA-GAPS.md)，核对 0.4.1-beta.1（2026-09-24）。本清单是可执行的后续工作，不表示已经实现、承诺自动部署，或已经获准运行真实对外副作用。只在合成项目/独立测试目录中验收；模型调用、语音、真实账号及两台设备须按已获授权的实际条件执行并记录。

0.4.2 进度：A1 确切分支绑定、A10 模型共享已实现；A4 的计划分配/记忆 CRUD 查询、A8 可编辑键位、A9 用量链路已补齐。下面保留原始验收要求，相关剩余项仍须逐条处理；真实证据与边界见对应实现文档。

## A. 原始缺口与验收要求

| ID / 优先级 | 证据与准确缺口 | 最小实现方向 | 可验收的结果 |
| --- | --- | --- | --- |
| **A1 / 高：确切分支围栏** | [原版 Git](https://useamoeba.com/docs/git/repositories)描述切换分支后暂停；`core/snapshots.mjs::assertSessionWorktree` 只检查独立 worktree + `rpo/` 前缀。另一个 `rpo/*` 分支仍可能通过 | 创建/绑定会话时记录预期分支；publish/receive/集成前核对真实 symbolic-ref。分支不匹配只显示暂停，用户确认后显式重新绑定或切回；不自动 checkout/reset | 两 clone 场景：切到普通分支及另一个 `rpo/*` 都暂停；原 HEAD、工作区/暂存区及远端 refs 不被同步改写；切回恢复；与 Agent/Git/调试锁并存 |
| **A2 / 高：用量不足→等待接管** | [原版 Provider 恢复](https://useamoeba.com/docs/agents/providers)有额度停止状态。当前 Runtime 错误/结束进入通用 `error/interrupted`；未看到稳定 quota 分类和专用 Hub 状态 | 优先识别官方结构化 stop/error code，不用任意字符串猜测余额；仅明确限额故障进入“待接管”，保留最近已确认快照及时间；继续走现有安全接管 | fixture 分别发送限额、认证失败、网络超时、一般工具错误，只有限额分类进待接管；两个成员同时接管仅一人成功；离线未知改动需明确确认，不自动重跑外部动作 |
| **A3 / 高：未知结果记录** | [原版错误说明](https://useamoeba.com/docs/help/troubleshooting)有 Outcome unknown 卡及人工记录结论。`RunCoordinator.recover` 已不重跑、只标中断/blocked，缺单独证据状态与结论 API | 将已派发动作标识、审批、时间及最后输出绑定到未知结果记录；Editor 可提交“确认成功/确认失败/仍未知”及证据引用，追加审计记录。人工结论不自动触发重试 | 合成外部动作写入一次后断开回执：重启后计数仍为 1，显示确切动作和未知结论；两人并发记录由明确版本处理，不能静默覆盖；Viewer 不能决定；任何重试是新的明确操作 |
| **A4 / 中：MCP 协调闭环与子任务入口** | [原版 MCP](https://useamoeba.com/docs/help/troubleshooting)包括分配、拆分等。`core/mcp-coordination.mjs` 有 plan_add/claim/status/transfer、memory_add；没有既有步骤 assign、memory.update/retire、spawn。`TaskCoordination` 已有真实 Git 服务 | 计划/记忆新增工具调用已有 Hub 权限路径，并固定 session/workspace；子任务必须通过本机服务创建 worktree、绑定实际 checkpoint 与预配置检查，不能仅发布 Hub 状态或允许 Agent 自己编造检查命令 | MCP 真实 subprocess 可以分配既有步骤和更新当前 workspace 记忆，越权/跨 workspace 拒绝；spawn 生成真实独立 worktree，父 lane 持续运行；明确由用户配置的检查全部通过后才可集成一次；readonly MCP 白名单只增加确实只读的工具 |
| **A5 / 中：锚点与记忆生命周期** | `references`/Editor 已做行范围/hash；`MemoryPanel` 主要靠手动检查。[原版评论/记忆](https://useamoeba.com/docs/collaboration/live-sessions)和[概念](https://useamoeba.com/docs/concepts/workspaces)描述相关流程 | 为 transcript entry 建稳定 ID 锚点；在 diff 面板接已有 side/path/commit 能力及点击导航；成功 merge/sync 后批量重新检查受影响记忆/评论。标 stale 后由人或 Agent 明确更新，不自动改写事实 | 同一文件未提交修改、无关 commit、删除、rename 和 diff 两侧分别验收；旧评论打开正确位置或明确过期；仅受影响记忆变 stale；更新内容/引用须有写权限且保留旧变更证据 |
| **A6 / 中：成员/工作区完整操作** | `plan.transfer` 要求接收人，无专用 release；`invite.create` 只有 workspace Owner；无 workspace.delete。[原版角色](https://useamoeba.com/docs/admin/members)包含 Commenter 归还、Editor session 邀请与 Owner 删除 | 添加本人归还步骤；区分 session 邀请与 workspace 成员权限，不借 session 邀请扩大访问；Owner 删除提供具体范围预览、确认和可验证的关联记录处理 | 无 Agent 的 Commenter 可领取→归还→再次分配；Viewer 被拒绝；Editor session 邀请不能读另一会话/升级 workspace 权限；删除合成 workspace 后其他 workspace 不变，转录/邀请/锁/票据等按明确策略清理 |
| **A7 / 中：活跃视图、可取消搜索与视觉状态** | `MissionControl` 主要统计 `lane.files`；文件搜索 UI 仅忽略过时结果，`core/local.searchFiles` 无取消令牌；原版 [0.1.37 日志](https://useamoeba.com/changelog)提到取消搜索 | 聚合未过期 open/changed/declared 活动并展示来源；查询 ID + AbortSignal/取消 IPC 真正中断遍历；固定尺寸捕获角色、网络、冲突等状态，不以新增截图存在即算视觉一致 | 开/关文件、TTL 到期与另一个会话发布都正确反映；20,000 文件项目连续搜索后旧搜索停止、不阻塞新任务；无效/清空查询不显示旧结果；并排会话不串结果 |
| **A8 / 中：CLI 模式与快捷键** | [原版 Git/终端](https://useamoeba.com/docs/git/repositories)描述 native/terminal 模式；目前 PTY 是项目 shell，能手动输入 CLI。0.1.38 的快捷键说明与现有组合键不完全一致，0.1.40 才明确可编辑绑定 | 先列出动作表及本机/终端焦点规则；显式“打开此 Provider CLI”用本机 Provider 配置，不通过隐式文字推断执行。自定义键位作为 0.1.40 增量加入冲突检测和恢复默认 | 同一快捷键在普通输入、代码编辑器、原生 Agent 和 PTY 中行为明确；Shift+Tab 在 PTY 原样透传；切换会话不重发历史输入；启动命令和账号可见，不能把 shell 页面称为共享原生 Provider session |
| **A9 / 0.1.40 增量：usage 与长提示** | Runtime 已发 usage，`RunCoordinator.onEvent` 未转发它；composer 旁无已验证的上下文计数。`run.request` 限 20,000 字符，检查路径会截断 | 按 Provider 实际 schema 保存每 run 的 usage 和模型上下文上限，缺值显示未知；独立规定 Provider 原文与协调摘要上限，摘要截断需可见，不截断实际用户任务冒充完整送达 | 用结构化 usage fixture 与真实 Codex 对照分母/累计/本轮口径；切换 run 不继承旧值；20k 边界、中文、图片与超长上下文分别验证实际 Provider 收到的原文及协调摘要，不混为余额计费 |

| **A10 / 中：成员模型共享** | [原版 0.1.37 日志](https://useamoeba.com/changelog)明确成员可见 Provider/model；本机 `lane.options` 仅写 config，Hub lane 只共享 Provider | 增加 owner-only 的公开模型元数据更新；运行开始固定本轮模型，选择变化单列下次模型；仅传 model ID/显示名/effort，不传密钥、endpoint 凭据或账号令牌；不把配置默认值冒充 Provider 已确认模型 | 两个独立客户端：A 更换模型，B 收到本轮/下次模型的正确区别；重连保留；B 无法篡改 A 通道；角色撤销后更新拒绝；Provider 未报告实际模型时明确标示来源 |

以上是源码证据支持的开发方向。远端光标、完整视觉布局等仍需针对原版实际页面补观察；没有证据证明的任意 VS Code 扩展或通用 DAP 不列为验收门槛。

## B. 已实现，优先补真实端到端证据

| ID | 验收环境与动作 | 必须保留的证据 / 不足以替代的结果 |
| --- | --- | --- |
| **B1：两台 Mac 跨互联网** | 机器 A/B 使用各自 Provider 和 Git 凭据，处于不同网络；邀请→加入→另一人审批→各自 lane 执行→转录/计划同步→撤销 | 两台机器版本/架构、邀请范围、两个真正执行账号、远端审批和结果时间线；不得用同机两个进程代替 |
| **B2：双机快照/接管/子任务** | 可写 Git 测试 remote；先无冲突同步，再同时改同一行；明确接管和离线确认两种流程；独立子任务通过/失败检查及双击集成 | 双 clone HEAD/ref 与实际文件哈希；冲突两版本均保留；原 owner 停止证据；接收者新会话；失败检查时父树不变；单次集成 receipt |
| **B3：真实 Provider 权限与恢复** | Codex/Claude 已登录，最小临时项目：写入拒绝、命令批准、取消、断网补传、投递后掉回执、跨重启恢复 | 原生请求→人工决定→实际文件/进程结果、重连无重复执行；不能把协议 fixture 当真实 CLI，尤其不能推断所有工具都由本应用拦截 |
| **B4：ACP / 自定义 API** | 在用户已配置的 OpenCode/Hermes 与受信任兼容端点分别测试目录、模型、图片能力、只读映射、权限、取消和恢复 | 精确 CLI/协议版本、原生模型输出、实际操作结果；`tests/fixtures/acp-peer.mjs` 只证明适配层，未构成真实 Provider E2E |
| **B5：语音与平台权限** | 用户主动点开始，macOS 第一次授权→口述短中文→停止→编辑/发送；取消和权限拒绝再试 | 真正识别文字及开始/停止状态；不只保留 helper 构建、capability probe 或模拟文本；不在后台自动开启麦克风 |
| **B6：新版本 UI 更新闭环** | 隔离数据目录与应用副本，从真实已发布旧 UI 检查并安装后续测试版 | digest、旧包备份、新包哈希、进程重启和配置保留；[已有 Mac 实验](UPDATER-MAC-VALIDATION.md)已验证真实替换/启动，但不是 0.3 UI 点击更新。额外的启动后健康检测/崩溃回滚需先实现 |
| **B7：Windows / Intel / Linux** | Windows 安装器与便携包、Intel Mac、Linux 原生 runner 分别执行账户、PTY、文件编辑、Agent、进程树取消和更新 | 实际宿主、产物哈希、安装/运行结果。Windows/Linux 分支单测、交叉打包或 macOS 解压成功不足以替代；Linux 尚无本轮正式产物结论 |
| **B8：数据恢复和多窗口** | 合成历史明文迁移、错误 key/损坏密文、待提交 pending、异常退出、两个窗口并发编辑草稿、保留期 | 迁移后明文不残留、错误密钥不覆盖数据、双方草稿均可恢复、活动转录不被清理；确认本机备份需要哪些受保护密钥，不能以“有 AES”替代完整恢复流程 |
| **B9：UI 对照** | 固定分辨率/缩放，原版 0.1.38 与 0.4.1 同状态：空项目、成员/Viewer、未登录、审批、冲突、两栏、断线、设置/分享、错误态 | 每个状态的成对截图、键盘/焦点与实际操作；中文文字长度差异合理处理；视觉相似与功能真实分别验收。原版 0.1.40 界面变化单列 |

## C. 明确等待外部条件或属于范围例外

- **C1 Apple 签名/公证**：用户选择稍后配置。凭据齐备后对最终字节签名、公证、staple，再在新账号/新机器验证 Gatekeeper。
- **C2 GitHub 团队 OAuth**：部署者自己的 OAuth App、HTTPS callback、签名 seed 和可信公钥配置，随后做真实浏览器登录/用户名邀请/撤销。既有 `gh auth login` 不替代团队 OAuth。
- **C3 房主在线例外**：目前房主进程关闭时协调房间不常驻。未来固定 Hub 与可选云执行分开验收；无域名/服务器/执行器授权不能宣称已经部署。不得为了填平表格自动注册外部 App、购买云资源或发送邀请邮件。

## 每项完成时记录什么

记录源码提交/安装包版本、宿主/Provider 版本、合成数据范围、实际操作、输出或文件哈希、失败路径、尚未覆盖的条件。区分“自动化通过”“真实 Provider 通过”“真实桌面通过”“两台实体机通过”，不要把任一种证据扩大成另外一种。新的并行开发只有在合入/打包后才计入已发布版本；未提交的群聊/项目上下文等工作继续保留，不由本审计覆盖或删除。
