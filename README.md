# 头号玩家 · Ready Player One

**中文、本地优先的 Agent Session Share 桌面工作台。**

一个任务房间，一份共同计划；每个人在自己的电脑上运行 Codex / Claude Code，所有人实时查看 Agent 通道、讨论任务、审批执行、审阅变更。

本项目通过观察 Amoeba 0.1.38 的本机安装结构、界面和公开文档，独立实现其核心协作工作流。不是 Amoeba 官方版本；不包含它的打包代码、品牌素材、登录信息或云端服务。当前为可运行的 **v0.2.0-beta.1 同事内测版本**，并非原产品的完整功能等价替代。

## 直接使用

提供 **Apple Silicon 和 Intel Mac** 两种 ZIP。本机安装位置：`~/Applications/头号玩家.app`。完整步骤见 [Mac 同事内测指南](docs/BETA-TESTING.md)。

1. 解压应用并放入「应用程序」。需要 Git，无需 Node.js / Homebrew。
2. 首页点 **连接账号**，检测已有 Codex / Claude / GitHub 登录；新电脑可在设置里安装官方 CLI，随后在官方浏览器页面授权。
3. 点 **从 GitHub 打开**，选择有权限的仓库并克隆；也可打开已有本机项目。
4. **新建会话 → 共享工作区 → 互联网**。首次安装网络组件后，生成邀请发给同事。
5. 同事在自己的应用中 **加入伙伴**，关联 / 克隆自己的项目副本，进入同一会话，添加自己的 Agent 通道。
6. 输入任务，协作者批准后，在请求者电脑上使用请求者的账号执行；所有人实时查看结果、共同计划和评论。

公网协作使用 Cloudflare Quick Tunnel：加密传输，临时外网地址，房主保持在线，无需公网 IP / 路由器端口转发。邀请限定一个工作区、24 小时有效，撤销后受邀连接断开。通道重启需生成新邀请。此服务适合内测，不是具有可用性保证的常驻云端。

账号授权只在各自本机的官方 CLI 进行，应用不收集密码，不把账号详情或 Provider 凭据同步到房间。已授权状态不代表模型额度足够。网络组件与 Codex / GitHub CLI 从官方发布下载并校验 SHA-256；Claude 使用 Anthropic 官方安装程序。

## 已实现

| 能力                | 当前行为                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| Agent Session Share | 多客户端通过 WebSocket 实时同步同一房间的多条 Agent 通道                 |
| 账号授权            | 应用内发起 Codex / Claude / GitHub 官方登录，检测本机授权状态            |
| GitHub 项目         | 列出授权仓库、克隆到本机、为远程协作工作区关联副本                       |
| 公网协作            | Cloudflare 临时 WSS 加密通道，邀请范围校验与即时撤销                     |
| 本机执行            | Codex JSONL / Claude stream-json 适配，CLI 登录留在各自电脑              |
| 协作审批            | 执行前显示账号、任务、权限、文件范围；协作者批准，所属客户端原子领取一次 |
| 冲突提醒            | 对活跃通道声明的文件路径做精确重叠检查                                   |
| 共同计划与评论      | 计划勾选、负责人、会话讨论、文件位置备注实时同步                         |
| 上下文接力          | 新执行自动带入共同计划、共享记忆、各通道最近对话                         |
| 共享记忆            | 添加、停用、恢复，按工作区持久保存                                       |
| Git worktree        | 从本机 HEAD 创建独立 `rpo/<session>` 分支，不混入未提交变更              |
| 实时 diff           | 用户主动开启后每 3 秒共享已跟踪文件 diff；未跟踪文件只共享文件名         |
| 代码编辑            | 本机文件树、语法高亮、文件修改冲突检查                                   |
| 命令终端            | 本机逐条 zsh 命令，输出展示，60 秒超时；不是交互式 PTY                   |
| 历史与导出          | 会话归档、恢复、JSON 导出、本地持久化                                    |
| 本地协调服务        | Electron 内置 Hub；也能通过 `npm run hub` 单独运行                       |

## 开发与打包

需要 Node.js 22+、npm、Git。当前原生客户端以 macOS 为支持目标。

```sh
npm ci
npm test
npm start
```

```sh
npm run build       # TypeScript 检查 + Vite 生产构建
npm run desktop     # 打开已构建的桌面版本
npm run package     # 构建本机架构 .app
npm run distribute  # 构建 Apple Silicon + Intel Mac ZIP
npm run hub         # 无 UI 的本机协调服务，默认 127.0.0.1:47831
```

独立 Hub 对可信局域网开放：

```sh
RPO_SHARE=1 RPO_PORT=47831 npm run hub
```

默认数据目录是 `~/.ready-player-one/`。`client.json` 保存本机昵称、身份密钥、目录映射；`hub/hub.json` 保存共享会话、邀请、记忆和审批；`worktrees/` 保存独立工作树。**不要把这个目录提交到 Git。** 可用 `RPO_DATA_DIR` 为桌面指定独立数据目录，或用 `RPO_HUB_DIR` 为独立 Hub 指定目录。

## 测试

`npm test` 使用两个独立 WebSocket 客户端和临时 Git 仓库，验证实时协作、邀请范围、审批并发、通道所有权、撤销邀请、断线恢复、文件边界、外部修改保护及工作树隔离。

真实提供商冒烟测试（会调用本机账号）：

```sh
node scripts/smoke-provider.mjs --live
node scripts/smoke-provider.mjs --live --claude
```

公网通道实际验收：`node scripts/smoke-internet.mjs --live`（仅共享临时合成数据，测试后关闭通道）。

提供商测试只要求模型返回固定中文文本，不读写项目文件。验收记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 当前边界

- **本地协调 ≠ 模型离线推理。** Codex / Claude 默认仍调用它们自己的模型服务；本应用不需要 Amoeba 账号或 Amoeba 云端。
- 公网邀请使用 WSS，经 Cloudflare 中继，不是端到端加密；局域网使用 WS，仅用于可信网络 / VPN。未实现组织 SSO 或分级只读成员权限，邀请持有者可以参与该工作区的全部会话和审批。GitHub 账号并不自动赋予房间权限。
- 当前审批是每次 Agent 执行前的任务级审批。没有把提供商的每一次工具权限请求桥接到共享 UI。Codex 非交互模式明确指定 sandbox；Claude 写入模式使用 `acceptEdits`，需要额外权限的工具可能被 CLI 拒绝。
- 对话按提供商消息 / 工具事件同步，未实现逐字 token 同步。断线会停止本机正在执行的 Agent，防止旧执行和恢复后执行重复；不会自动重放有副作用的命令。
- 共享代码是显式发布的 Git diff，不是字符级协同编辑，不会自动将别人的代码写入本机。实际代码合并使用 Git 提交、推送、拉取及 PR。
- 接力通过新通道和共享上下文进行，不迁移提供商内部 session ID；长对话带入最近上下文，不保证全部历史进入模型。
- 工作树用于分开 Git 变更，不是操作系统沙箱。创建时要求仓库已有提交。本次版本没有自动合并或删除工作树。
- 不包含 VS Code 扩展市场、调试器、LSP 生态、云端组织管理、自动语义冲突判断。
- macOS 构建未做 Developer ID 签名和公证。当前 ZIP 用于知情同事内测，首次打开可能需要用户按 macOS 提示手动允许；正式公开分发前应完成签名、公证和跨设备验收。

每个通道的实时视图保留最近 600 条事件，完整事件流另存本机 JSONL，可通过会话导出读取；单条事件文本最多 24,000 字符。仓库提供 `docs/ci.example.yml` 持续集成模板，尚未启用 GitHub Actions。

更多设计与调研依据：[架构](docs/ARCHITECTURE.md) · [逆向调研与对应关系](docs/RESEARCH.md)
