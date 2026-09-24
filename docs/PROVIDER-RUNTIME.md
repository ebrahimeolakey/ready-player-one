# 原生 Agent 运行时

`core/providers/` 使用本机 Codex / Claude CLI 已有登录状态。账号凭据仍由各 CLI 管理，不读取或分享账号密钥。

## 集成接口

```js
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import { listProviderModels } from "../core/providers/catalog.mjs";

const runtime = new ProviderRuntime({ env: localEnv() });
const run = await runtime.start({
  runId: "local-lane-id",
  provider: "codex",
  cwd: projectFolder,
  prompt: "检查当前项目",
  sessionId: savedNativeSessionId,
  mode: "read-only",
  model: selectedModel,
  effort: selectedEffort,
  onEvent(event) {},
  // 返回 undefined 表示等待 UI 通过 respondApproval 回答。
  onApproval(request) {},
  onEnd({ status, message, sessionId }) {},
});
await runtime.steer("local-lane-id", "补充要求");
runtime.respondApproval("local-lane-id", approvalId, { allow: false });
await runtime.interrupt("local-lane-id");
const models = await listProviderModels("codex", {
  cwd: projectFolder,
  env: localEnv(),
});
await runtime.close();
```

`start` 等待 CLI 初始化和接收任务，不等待任务完成。`onEnd` 对每个 run 只触发一次。`done / error / interrupted` 表示真实终态。调用方应在本地按工作区、通道、Provider、执行者保存原生 `sessionId`，下次传回；不要把原生 sessionId 当作互联网成员身份或跨电脑会话迁移机制。

事件包括 `session`、`started`、`delta`、`message`、`tool`、`approval`、`approvalResolved`、`usage`、`error`。`message.streamed` 表示同一 `itemId` 已经收到增量，渲染时应更新完整文本，避免再追加一次。

审批项由 `approvalId` 关联到当前 run。重复、失效、已结束的审批不执行。未实现的服务器请求返回错误，不能默默同意。`question` 审批支持 `{ answers }`，MCP 表单支持 `{ allow, content }`；UI 须分别提供交互。

每次运行可指定 `env`。Codex 可通过 `codexConfig` 提供 `mcp_servers`；Claude 可通过 `mcpServers` 指定本次 `--mcp-config`、`disallowedTools` 指定禁用工具。不会写入用户 CLI 配置。只读 Claude 限定内置工具为 Read / Glob / Grep，额外 MCP 审批只接受 `readOnlyMcpTools` 中的工具名。MCP 服务自身也必须实施只读约束：本机既有允许规则可能影响是否触发 Provider 审批。

## 协议和权限

- Codex：本机 `codex app-server` JSONL 协议。`thread/start` / `thread/resume`、`turn/start` / `turn/steer` / `turn/interrupt`；原生命令、文件、权限请求桥接到 UI。使用 `approvalPolicy: untrusted` 和 `approvalsReviewer: user`，不使用 `never`。原生可信读取不一定弹窗；这是原生敏感动作审批，并非对每次读取强制审批。`read-only` 是原生沙箱范围，批准提升权限属于用户单独决定。
- Claude：双向 `--input-format stream-json --output-format stream-json`、增量消息、`--resume`、`manual` 权限模式、`--permission-prompt-tool stdio`。权限 `can_use_tool` 对应控制响应。执行中追加输入交给 CLI 排队，在 CLI 安全边界继续；不承诺正在运行的单个工具中途改变指令。
- 两者在任务终态关闭进程，下次使用 CLI 原生持久会话恢复。关闭和取消清理进程组；Windows 使用 `taskkill /T /F`。原生状态可恢复，不是长期占用空闲 CLI 进程。
- 模型目录从各 CLI 查询，不硬编码模型名称或账号资料。目录返回模型字段并丢弃握手中的账号信息。CLI 版本升级可能改变实验协议，兼容性错误应在界面展示。

协议依据：本机 Codex 0.153.4 `app-server generate-json-schema`，Claude Code 2.1.281 `--help`，以及 Anthropic 官方 [控制协议实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py) / [stdio 权限配置](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)。

## 自定义兼容 Provider

`registerOpenAICompatible(runtime, name, { baseUrl, model, apiKeyEnv, tools })` 可注册 Chat Completions-compatible 流式适配器。API key 仅从本机环境变量读取。端点要求 HTTPS，环回地址允许 HTTP。每个 `tools` 条目含 `name / description / parameters / execute`；所有工具执行都经过批准，默认不提供文件或终端访问。

此适配器返回本地对话 `history`，恢复时由调用方传回；它不伪装成远端 API 原生持久会话。对话会发送至用户配置的端点。尚未接入设置界面，未验证任何第三方供应商真实服务；协议测试覆盖流式解析和工具拒绝。

## 已验证与边界（2026-09-24）

真实本机验证：

- 两个 CLI 均完成原生握手、在临时非 Git 文件夹中执行纯文本任务，均产生真实增量和正常完成事件。
- Codex 执行中 `turn/steer` 改变回复；重启进程后原生 resume 正确记得补充指令。
- Claude 原生 resume 正确记得上一轮 token；连续输入两条消息分别完成，追加指令无需新会话。
- Codex 文件写入审批和 Claude Write 审批实际到达回调；拒绝后测试文件均不存在。
- 原生模型目录实际查询：Codex 5 个模型；Claude 目录见最新运行结果。

自动测试覆盖协议审批拒绝/取消/过期、会话恢复参数、流式去重标记、MCP 只读审批边界、真实子进程及后代清理、UTF-8 分片、超长/损坏消息、兼容 API 拒绝工具和中断边界。

尚未以新 Runtime 验收真实 Windows CLI、原生多层子 Agent 后台任务终态、跨机器原生会话移交。单元协议通过不等于这些能力已完成。主应用 UI/共享状态桥接的验收记录应由集成测试另行补充。

## 领取、恢复和退出的集成约定

`RunCoordinator` 在发送 `run.claim` 前加密保存 `prepared` 记录和随机 `claimKey`。同一进程收到超时后复用原 key 领取；Hub 同一 owner 的另一个进程持不同 key 不能重复执行。工具决定同样使用持久化派生 key。服务端已提交但响应丢失时可重新取得原结果，Provider 本地成功收到的决定不会再次投递。

Outbox scope 绑定 Hub 持久化 `identity.audience` 与当前身份，内置 Hub 随机端口变化不会丢失恢复关联。应用重启只补传已存事件并标记中断，不自动重跑未知外部动作。旧版 URL scope 只能由桌面宿主调用 `migrateLegacyLocalRecords({hubId,secret,verify})`，逐条检查自己的 Hub 数据库归属后迁移；不能相信远端返回的 ID 自动迁移。加密首次写入在 rename 前中断的 `.pending` 文件也会校验恢复。

追加指导的确认进入 outbox；丢失确认只重传确认，不再次送入 Provider。旧 run 的指导不送给新 run；未确认的投递要求检查记录，不自动重发。

`await coordinator.close()` 同步暂停新领取，再等待正在运行的 Provider 退出；切换连接认证成功后调用 `await coordinator.resume()`。退出应用不能 resume。`runtime.interrupt()` / `runtime.close()` 的 Promise 等待清理：原生进程等待所属进程组退出，兼容 Provider 等待正在执行的工具完成取消清理，随后才触发 `onEnd` 并从 `runtime.runs` 移除。仓库锁检查必须包含 `runtime.runs`，不能仅看 Hub 的显示状态。

本批回归在 Node 与 Electron 40 自带 Node 均 29 项通过，包括真实临时 CLI 的忽略 SIGTERM 后代持续写入测试，以及真实 workspace shell 取消清理测试。没有请求真实付费 API；Windows `taskkill` 路径尚未在 Windows 实机验证。
