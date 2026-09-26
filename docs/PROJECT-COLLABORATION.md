# 项目群与产物协作 · macOS 0.5.0-beta.1

2026-09-26。独立实现的首条闭环，不是 Raft 全功能完成声明。没有引入 Raft 的 FSL 实现代码。保留已有 Session Share、Provider、IDE、Git 和未提交的项目上下文基础；本轮不更新 Windows 分发。

## 使用

1. 在左侧打开「项目群」，选择或新建团队，再建项目。可选上级项目、GitHub `owner/repo`、分支和子目录；组织项目可以不绑定仓库。
2. 执行设备点击「关联本机目录」。绑定仓库时校验仓库身份、分支和子目录；无仓库项目可关联普通文件夹。
3. 添加团队 Agent，使用本机 Codex / Claude，或已有会话中的 Provider。Provider 登录仍在设置中完成，账号不会传给其他控制者。
4. 在项目群讨论，手动创建任务，或选择本机负责人 Agent 点击「整理任务」。负责人使用现有 Provider 执行只读整理，输出提案；提案不会自动执行。
5. 执行设备认领任务。需要多人控制时，设备持有人在「控制者」里勾选同事。负责人（DRI）与控制者分开；公司身份不自动产生任务操作权。
6. 点击「开始」。Agent 将 Markdown / HTML 写入任务指定的产物文件。完成时尝试登记版本，也可点击产物栏刷新按钮显式发布。右侧预览、左侧群聊同时保留。
7. 评论绑定版本和位置说明。点击「继续」时带入近期评论；同一任务保留 Session 和 Provider 会话，形成新 Run。确认当前版本后点击「验收」。不会自动提交或推送 Git。

## 数据与权限

- 本版复用 Workspace 作为团队的成员与邀请隔离边界，`teamId` 等于该 Workspace ID。原有工作区不会自动拆分、移动或改名。应用可切换团队；来自不同 Hub 的连接仍沿用现有连接切换方式，不是多 Hub 同时在线客户端。
- Project 有父项目、负责人、可选仓库绑定。项目群独立于 Session；即使没有活动 Session，也能从「项目群」访问。首版每个项目一个群，成员继承团队权限，没有独立的私密频道 ACL。
- Agent 是持久的团队名称、角色、Provider 和 Worker 绑定。任务首次认领后创建专用 Session/Lane，后续多轮复用。尚无完整的自主收件箱、跨任务专属 Agent 记忆和自动技能匹配。
- Task 是本闭环的状态事实来源；既有 Session plan/subtask 仍为原功能，没有复制一套自动同步的任务状态。任务状态为 proposed → ready → running → review → accepted，失败/停止可继续。旧会话中的清单/子任务没有自动迁移。
- 控制者可启动、补充要求、停止、验收；只有绑定 Worker 能领取实际执行、上报输出和发布产物。撤销控制者时会封禁当前 Run 的后续结果，已发生的外部副作用不会被撤回；离线设备是否停止不能即时确认。
- 启动使用请求幂等键，认领使用同步 Hub 内的 revision 校验和上下文序号。适用于单个 Hub 进程，不能据此声称支持多副本数据库事务或 Kubernetes 横向扩容。目标文字规范化后相同会提示复用；不是模型语义去重。
- Task/Run 记录 generation，旧 Run 不能覆盖新结果或停止新 Run。原始 run.request/queue/stop 不能绕过项目任务入口。DRI 本身不授予控制权。
- 本机 Checkout 保存于本机加密设置，按 Hub 身份、成员和项目隔离。执行前核对仓库/分支；子目录和产物路径检查 realpath，拒绝越界与 `.git`。这不是对所有 Provider 的 OS 沙箱保证，实际 Shell 能力仍取决于 Provider 的权限实现。

## 产物边界

- 首版仅静态 HTML、Markdown，单文件最多 300 KB，每任务最多 40 个版本。版本内容独立保存在 Hub 的加密 `artifacts/` 对象中，不随每次全量状态广播发送。
- 内容 hash 和版本不可变；读取时复核 hash。准备/已加载/失败分别记录，新预览失败保留旧版。HTML 使用无脚本、无同源授权的 iframe 与限制网络的 CSP；Markdown 支持安全的基本标题、段落、粗体和代码块。
- 「可预览」代表隔离 iframe 成功加载，不证明页面功能、视觉质量或验收条件正确。最后由人验收本轮明确版本；Agent 自报 done 只进入 review。
- 评论位置是人工填写的位置说明，不是点击坐标、DOM 选区或 PDF 区域锚点。旧版本评论会标出需要重新定位，继续执行时明确携带版本 ID。
- 没有动态 localhost 应用共享代理、任意附件预览、S3 集成或逐文件自动热更新。多人共享的是登记后的静态内容。
- 删除团队的预览包含项目、群聊、任务、产物与评论计数；提交删除后通过恢复日志清理对应加密对象，保留本机项目文件。

## 本轮验证

- `tests/project-collaboration.test.mjs`：真实 WebSocket 客户端，团队/会话邀请隔离，幂等、并发认领、冻结上下文，DRI 与控制者、撤销、旧代次，版本/评论/验收，负责人提案，磁盘恢复、删除和路径边界。
- `scripts/project-collaboration-desktop-smoke.mjs`：实际 Electron main/preload/React、真实 ProviderRuntime 与子进程；模拟 Codex 协议端点，无真实模型调用。通过 UI 发群消息、认领/开始，生成 HTML、自动登记、渲染、评论、Provider thread/resume、第二版验收；检查 1440 深色和 1080 浅色布局。
- 原有回归继续检查 Session、Git、权限、编辑器、终端、更新等；最终数量与截图见 `docs/evidence/project-collaboration-0.5.0.json`。

## 尚未完成的交付条件

- 两台实体 Mac 跨互联网全流程、真实新账号登录、Intel Mac 实机运行。
- 常在线 Hub 的生产部署、固定 HTTPS、备份恢复演练和 Worker 迁移/接力。Hub 在房主电脑时，房主关机仍会离线。
- GitHub 团队 OAuth 外部应用与固定回调、Apple Developer 签名/公证。现有 GitHub CLI 仓库授权不等于已部署团队 OAuth。
- 本闭环已接现有 Provider，但本轮新增桌面验收不冒充真实模型测试或双机测试。
