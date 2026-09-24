# 开发、测试与技术边界

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

提供商测试只要求模型返回固定中文文本，不读写项目文件。验收记录见 [docs/VALIDATION.md](VALIDATION.md)。

## 当前边界

- **本地协调 ≠ 模型离线推理。** Codex / Claude 默认仍调用它们自己的模型服务；本应用不需要 Amoeba 账号或 Amoeba 云端。
- 公网邀请使用 WSS，经 Cloudflare 中继，不是端到端加密；局域网使用 WS，仅用于可信网络 / VPN。未实现组织 SSO 或分级只读成员权限，邀请持有者可以参与该工作区的全部会话和审批。GitHub 账号并不自动赋予房间权限。
- 当前审批是每次 Agent 执行前的任务级审批。没有把提供商的每一次工具权限请求桥接到共享 UI。Codex 非交互模式明确指定 sandbox；Claude 写入模式使用 `acceptEdits`，需要额外权限的工具可能被 CLI 拒绝。
- 对话按提供商消息 / 工具事件同步，未实现逐字 token 同步。断线会停止本机正在执行的 Agent，防止旧执行和恢复后执行重复；不会自动重放有副作用的命令。
- 共享代码是显式发布的 Git diff，不是字符级协同编辑，不会自动将别人的代码写入本机。实际代码合并使用 Git 提交、推送、拉取及 PR。
- 接力通过新通道和共享上下文进行，不迁移提供商内部 session ID；长对话带入最近上下文，不保证全部历史进入模型。
- 工作树用于分开 Git 变更，不是操作系统沙箱。创建时要求仓库已有提交。本次版本没有自动合并或删除工作树。
- 不包含 VS Code 扩展市场、调试器、LSP 生态、云端组织管理、自动语义冲突判断。
- macOS 构建未做 Developer ID 签名和公证。当前 ZIP 用于知情同事内测，首次打开可能需要用户按 macOS 提示手动允许；正式稳定版发布前应完成签名、公证和跨设备验收。

每个通道的实时视图保留最近 600 条事件，完整事件流另存本机 JSONL，可通过会话导出读取；单条事件文本最多 24,000 字符。仓库提供 `docs/ci.example.yml` 持续集成模板，尚未启用 GitHub Actions。

更多设计与调研依据：[架构](ARCHITECTURE.md) · [逆向调研与对应关系](RESEARCH.md)
