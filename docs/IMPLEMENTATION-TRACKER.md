# Amoeba 对齐实施记录

2026-09-24。对标官方 0.1.38，基线差距见 [AMOEBA-GAPS](AMOEBA-GAPS.md)。此表记录 0.4.0 / 0.4.1 测试版实现及验证边界。

## 已发布

0.4.1-beta.1 继续提供四种 Mac / Windows 下载。完整回归 211 项通过，包内 49 个核心文件与发布提交逐一比对，Mac arm64 打包应用实际启动并恢复草稿。新增内容见下方 0.4.1 记录。

0.4.0-beta.1 提供同版本 Mac arm64 / x64 与 Windows x64 安装包，README 给出直接下载。完整回归 170 项通过；Mac arm64 打包应用已实际启动。Windows 真机安装、Intel 运行及跨平台双机测试尚未完成。历史 Windows 0.3.1 移植预览仍保留。

## 0.4.0-beta.1 进展

| 项目 | 当前实现与证据 | 仍需验收 |
| --- | --- | --- |
| 角色、任务认领与转交 | Viewer / Commenter / Editor / Owner 服务端权限、撤销与降级、两阶段计划转交，回归测试通过 | 双机完整界面流程 |
| 代码快照 | Git shadow refs、独立工作树、三方合并、冲突两版本选择；两个真实 clone 测试通过 | 正在运行的 Agent 期间暂缓文件应用；持续同步和跨网络体验继续验证 |
| 原生 Provider | Codex app-server、Claude 双向 stream-json、原生会话恢复、引导、逐工具审批；真实两种 CLI 已执行 | 更多工具权限形态与新账号首次使用 |
| 协调与恢复 | 真实 stdio MCP、队列、工具一次性审批、离线执行与事件补传、过期运行围栏 | 同机两客户端经公网通道的断线重连已通过；仍需双机验收 |
| 接管 | 停止并确认源执行、保留未提交成果、快照传递、接收账号新会话；第二 clone 服务测试通过 | 桌面双成员完整交互 |
| 子 Agent | 父任务持续、独立工作树、明确配置检查、候选 diff、合并后再检查及单次集成；真实 Git 测试通过 | 多人桌面验收 |
| 评论与共享记忆 | 代码行范围和内容 hash、过期检测、评论转任务、文件关联记忆及更新；文件/Git测试通过 | 实际编辑器行评论已通过；更多选区与记忆交互待验收 |
| 本机数据 | Hub、转录、客户端配置、执行补传队列、图片输入采用系统密钥保护的加密存储；草稿加密与旧数据迁移已接入；可设保留期 | 全路径回归与数据恢复演练；脱敏仅覆盖已识别凭据形式 |
| 输入与 Provider | 实际模型目录、模型/强度选择、兼容 API 与系统加密密钥、六种受审批工具、图片、macOS 本机语音 | 图片桌面发送、用户主动语音录入；语音目前仅做能力探测和构建验证 |
| PTY 与浏览器 | 真实交互 PTY 已在桌面回显，隔离 HTTP(S) 浏览器已加载本地页面；现接入原生内嵌视图 | 内嵌页面已在桌面显示；更多布局和切换状态待验收 |
| Git 工作流 | 暂存/撤暂存、diff、提交、fetch/pull/push、分支操作；两个真实 clone + bare remote 测试通过 | 桌面操作验收 |
| 更新 | 官方 GitHub release 匹配、SHA256 校验、显式安装/重启与回滚；真实 Mac ZIP 下载/解压/架构检查通过 | 新版安装包中的真实自更新闭环 |
| Mission Control | 执行/计划/活动文件汇总、审批/冲突/接管/受阻聚合入口已接 | 视觉及多人状态对照 |
| GitHub 团队身份 | OAuth 与可信签名身份已实现，模拟官方边界的本机服务测试通过；现有 CLI 仓库登录仍可用 | 需自己的 OAuth App、HTTPS callback 与部署配置，尚未实测团队登录 |
| 语言服务 | JS/TS 真正语言服务已实现，Worker 和打包 ASAR 测试通过；Node.js 调试已实现，真实子进程测试通过 | 不声称支持任意 VS Code 扩展、所有语言或调试器 |
| 平台与签名 | Mac/Windows 构建链；Linux 原生构建脚本和 Dockerfile；更新平台分支测试 | 本机无可用签名证书；无 Linux 执行环境；Windows/Linux 真机验证缺失 |

完整回归 **170 项全部通过，0 失败**，TypeScript / Vite 构建通过。真实桌面已验证非 Git 目录的 Codex 固定回复、加密迁移后历史可读、PTY 输入输出、原生模型目录及选择、内嵌浏览器、准确代码行评论、JS/TS 类型错误标记、Git 状态面板和 Node.js 断点（真实变量 20 / 42）。

仍不能称为与 Amoeba 全功能或全部 UI 1:1 完成。完整语言/调试/扩展兼容性、其他 Provider、所有页面状态、签名分发、两台实体电脑跨互联网使用均需继续处理或有外部条件。

## 房主离线方向

用户选择同时支持：**成员本机接力 + 可选云端执行**。协调房间常驻与 Agent 执行常驻分开；明确转交优先，自动接续需要执行权与副作用校验。设计见 [HOSTING-DESIGN](HOSTING-DESIGN.md)。未部署常驻协调或云端执行器，未购买云资源。

## 0.4.1-beta.1 进展

- ACP 配置与适配器：本机加密命令、参数及环境配置，模型目录、流式输出、工具审批、取消、会话恢复；OpenCode / Hermes 预设。真实 stdio fixture 回归通过，尚未安装这两种 CLI 做真实模型调用。只读模式需要明确映射，不能把 ACP 协议当成沙箱。见 [ACP-PROVIDERS](ACP-PROVIDERS.md)。
- 重叠检测：活动文件 TTL、文件/目录范围、计划关联、分支和跨会话提示，队列重检查及 MCP 查询。属于确定性提醒，不是语义 AI 判断。见 [OVERLAP-DETECTION](OVERLAP-DETECTION.md)。
- 输入恢复：文本、图片和恢复凭据统一加密写入；崩溃恢复 pending 文件；同一 Renderer 的并排通道共享草稿；跨窗口版本冲突保留双方并提供显式合并。失败指导可恢复且重复恢复不重复追加。
- Provider 与转录：原生 reasoning 增量、工具生命周期合并、消息复制、链接选择内嵌/系统浏览器、Esc 停止，自定义 API 显式配置支持的推理强度。
- Mac 更新：实际旧 bundle 副本升级、备份、启动新版并保留隔离数据目录，修复重启实例与环境参数。具体方法及限制见 [UPDATER-MAC-VALIDATION](UPDATER-MAC-VALIDATION.md)。

2026-09-24 本批完整测试 211 项通过；TypeScript / Vite 构建通过。桌面图片链路实际添加 64×64 纯蓝 PNG，发起只读审批，经本机 Codex 返回“蓝色”。这是实际账户调用，并非模拟回复。同一会话双分栏输入已验证双向同步，重启 0.4.1 打包应用后仍可恢复。

用户确认先发未签名测试版，Apple Developer 证书、GitHub OAuth 应用与固定 HTTPS 回调配置以后补。本节内容随 0.4.1-beta.1 发布；原 0.4.0 安装包保持不变。

## 0.4.2-beta.1 进展

- 上下文用量：原生 Codex / Claude、ACP 与兼容 API 统一口径，当前占用与累计分开、缺失值明确未知；共享、持久化和重传。真实 Codex 返回 `USAGE_OK`，UI 读数与 Hub 一致并跨重启保留。见 [PROVIDER-USAGE](PROVIDER-USAGE.md)。
- 成员模型：成员栏和通道标题显示模型；下次选择、本轮发送和 Provider 确认分开记录。真实 Codex `MODEL_OK` 已核对。见 [MODEL-SHARING](MODEL-SHARING.md)。
- 快捷键：七项动作可改、停用和恢复默认，校验冲突、系统保留键、输入法及终端焦点。Mac 真实修改与重启恢复已通过。见 [KEYBOARD-SHORTCUTS](KEYBOARD-SHORTCUTS.md)。
- 同步分支：绑定确切 linked worktree 分支，误切普通/其他 rpo/分离 HEAD 都暂停；旧会话显式确认绑定。真实桌面在本机 bare remote 成功同步，误切后暂停，切回后恢复。子任务应用前复核父分支。见 [SESSION-BRANCHES](SESSION-BRANCHES.md)。
- MCP：补齐计划分配、记忆更新、显式停用/恢复和限定工作区的记忆查询；保留实时权限与只读列表。子任务 MCP 本机桥仍未实现。见 [MCP-COORDINATION](MCP-COORDINATION.md)。
- 修复 macOS 调试停止时短暂僵尸进程组导致的 EPERM：等待系统确认退出，持续权限错误仍保留阻塞状态；ACP 缺程序报错中文化。

Windows 原生 CI 已验证实际 Electron、加密设置、PowerShell PTY、退出清理与 ZIP/NSIS 构建，见 [WINDOWS-NATIVE-CI](WINDOWS-NATIVE-CI.md)。仍未覆盖实体设备首次安装、真实账号 GUI 登录及两台实体机器公网协作。

本批发行源码隔离构建的完整回归 **247/247 通过**，TypeScript / Vite 构建通过。新增目录绑定保存校验：进入工作树或重新关联项目后，文件/Git 面板刷新，旧编辑内容不会写进新目录；草稿按真实目录隔离，旧草稿可明确预览并载入，载入本身不保存文件。


发行验证：Mac arm64 / x64 ZIP 完整性检查通过；两包 54 个核心/桌面/前端文件与发行源码逐字节一致。Mac arm64 安装包实际启动并恢复模型和上下文用量。旧草稿手动预览载入后磁盘文件 SHA256 未变；独立工作树创建后旧编辑缓冲区保留且保存禁用，选择保留草稿后新文件可打开，Git 面板显示新分支。Windows 同版本原生 CI **27/27 通过**并产出 ZIP/NSIS，平台验证边界见对应文档。四种包及校验清单随 0.4.2-beta.1 发布，旧资产不覆盖。

## 0.4.3-beta.1 进展

- A2：官方结构化限额/限流错误进入待接管、保留最近确认快照、暂停自动队列；其他错误单独处理。见 [PROVIDER-LIMITS](PROVIDER-LIMITS.md)。
- A3：中断结果证据卡、人工确认及只追加历史；原操作不自动重发，丢回执和版本冲突受保护。见 [UNKNOWN-OUTCOMES](UNKNOWN-OUTCOMES.md)。
- A4：本机 MCP 创建真实独立子任务工作树，显式预配置检查、两阶段发布审批，网络重试幂等，父执行保持运行。
- A7：文件搜索增量遍历并响应取消，分栏隔离；20,001 文件合成项目验证访问上限、取消及事件循环响应。见 [FILE-SEARCH](FILE-SEARCH.md)。

完整隔离源码回归 **277/277 通过**，TypeScript/Vite 构建通过。Mac 两包 59 个核心/桌面/前端文件与发行源码一致，ZIP 完整性通过；Apple Silicon 安装包实际启动、恢复确认记录、保存 Agent 子任务检查设置并搜索/清空文件。Apple 签名与团队 OAuth 外部配置继续按用户决定延期。

Windows 同版本原生 CI **28/28 通过**并构建 ZIP/NSIS；下载后的 SHA256 与 runner 记录一致。包内 59 个核心/桌面/前端文件与发行源码按 LF/CRLF 归一化比较一致。四种包及更新清单随 0.4.3-beta.1 发布，旧资产保持不变。


## 0.4.4-beta.1 进展

- A5：消息 ID/哈希评论、本机 diff 左右行/片段评论与只读历史定位；保存/Git/同步/子任务集成/接管后检查引用；记忆版本冲突保护及分页历史。见 [REFERENCES](REFERENCES.md)。
- A6：Commenter 归还步骤、Editor 会话限定邀请、Owner 删除范围预览与加密关联记录清理/重启恢复。会话邀请不授予其他会话或共享记忆权限；保留本机项目和缺少身份索引的草稿。见 [WORKSPACE-LIFECYCLE](WORKSPACE-LIFECYCLE.md)。
- A8：独立本机 Codex/Claude CLI，命令/目录/账号来源可见，参数数组启动、重复打开不重发、退出清理。见 [PROVIDER-CLI](PROVIDER-CLI.md)。
- A9：100,000 码点/400,000 UTF-8 字节的任务原文，协调摘要与附加上下文另限；原文通过 owner-only claim/read 传递，超限报错，断线与恢复不重跑。见 [LONG-PROMPTS](LONG-PROMPTS.md)。

干净发行源码 **319/319 回归通过**，TypeScript/Vite 构建通过。隔离构建发现并修复了可选群聊表缺失时的删除错误，新增无群聊模块的真实 Hub/磁盘回归。Mac arm64 / x64 包内 **71 个 core/desktop/dist 文件**与发行源码逐字节一致，108 个提交源码文件与构建目录一致；ZIP 完整性及内含 ASAR 哈希核对通过。

Mac arm64 包实际启动；合成项目通过界面保存了消息评论。消息定位、diff 评论、记忆历史的完整桌面/双机交互仍需继续验收，自动化通过不替代这些检查。Windows 原生运行和包验证见 [WINDOWS-NATIVE-CI](WINDOWS-NATIVE-CI.md)。Apple 签名/公证与团队 OAuth 继续延期；房主在线范围例外保持不变。A7 活跃文件聚合、完整视觉对照和更多真实环境验收仍未完成。

## 0.4.5-beta.1 进展

- 活动视图：聚合未过期的打开/变更/任务范围，按工作区去重并显示会话来源；区分文件、目录和未知范围。无活动时隐藏统计。见 [ACTIVITY-VIEW](ACTIVITY-VIEW.md)。
- GitHub：应用内审阅并创建仓库，显式克隆或绑定已有 Git 目录；持久化投递记录防止丢响应后重复创建，账号与协作身份变化时重新核对，不覆盖已有 origin。见 [GITHUB-REPOSITORY-CREATE](GITHUB-REPOSITORY-CREATE.md)。
- 编辑器：字体、字号、缩进、换行、空白、参考线与可导航代码缩略图；JSON 格式化和限定行尾清理默认关闭。保存过程中继续输入不会被格式化结果覆盖。见 [EDITOR-SETTINGS](EDITOR-SETTINGS.md)。
- Mac 更新：双阶段加密数据/真实 React 界面检查，检查前暂停执行和同步；兼容声明一致时启动失败恢复旧包，目标或备份改变时保留人工恢复。旧包无声明时明确二次确认手动安装。见 [UPDATE-HEALTH](UPDATE-HEALTH.md)。

真实 Electron 主进程测试确认与拒绝两条路径均通过，发现并修复 Electron ASAR 虚拟文件统计造成的校验误报。证据见 [桌面更新检查](UPDATE-HEALTH-DESKTOP-SMOKE.md)。这是实际启动门禁与模拟健康服务的验证，不等于已发布包之间的完整安装替换演练。

本机再次只读观察 Amoeba 设置页面，记录了尚未覆盖的通用偏好；见 [原版实测补充](UI-OBSERVATION-2026-09-24.md)。并未据此宣称所有 UI 1:1。

隔离发行源码完整回归 **361/361 通过**，TypeScript/Vite 构建通过；包含真实 Electron 编辑器测试，没有跳过项。Mac arm64/x64 安装包内 78 个 core/desktop/dist 文件与发行源码一致，121 个提交源码文件与构建目录一致；ZIP 完整性及内含 ASAR 哈希均通过。打包应用实际启动并恢复字号设置，GitHub 新建表单已目视复核；最终表单 CSS 修复另经 TypeScript/Vite 与界面验证，未改功能逻辑。Windows 证据见对应平台文档。
