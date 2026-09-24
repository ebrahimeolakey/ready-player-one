# ACP Provider 通道

## 与 Amoeba 的可证实差距

2026-09-24 查阅 [Amoeba 官方更新日志](https://useamoeba.com/changelog)：0.1.37 明确提到 Hermes 风格 ACP 模型目录与 OpenCode 跨平台命令启动。与此同时，[Provider 指南](https://useamoeba.com/docs/agents/providers)正文仍主要讲 Claude Code / Codex。因此本模块补齐有日志依据的 ACP 通道，不将任意 VS Code 扩展兼容或所有第三方 Agent 宣称为原版要求。

[OpenCode 官方 ACP 文档](https://opencode.ai/docs/acp/)确认启动命令为 `opencode acp`，通过 stdio JSON-RPC 交互。[Hermes 官方 ACP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)确认 `hermes acp` / `hermes-acp`，沿用本机现有 Provider 登录设置。当前机器未发现这两个 CLI；本批没有安装、自动下载或发起登录。

协议依据为 [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[prompt/取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[权限](https://agentclientprotocol.com/protocol/v1/tool-calls)、[配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options)与 [stdio 传输](https://agentclientprotocol.com/protocol/v1/transports)。实现使用换行分隔 JSON-RPC 2.0，明确协商 protocolVersion 1，不使用 MCP 协议代替 ACP。

## 主进程配置

独立 `ACPConfigStore` 使用 Electron safeStorage 加密整个启动配置，而非只加密 API key。文件通过原子替换保存、权限 600。环境变量值不通过 public list/save 返回，仍留在本机主进程；不能写入 Hub。

```js
import { ACPConfigStore, ACP_PRESETS } from "../core/acp-config.mjs";
import { registerACP, probeACP } from "../core/providers/acp.mjs";
const store = new ACPConfigStore({
  path: localConfigPath,
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
});
const entry = await store.save({
  name: "OpenCode",
  command: "opencode",
  args: ["acp"],
  env: {},
});
const config = await store.getRuntimeConfig(entry.id); // main only
const probe = await probeACP(config, { cwd: authorizedRoot, env: localEnv() });
registerACP(runtime, entry.id, config);
await runtime.start({
  runId,
  provider: entry.id,
  cwd: authorizedRoot,
  prompt,
  mode: "workspace-write",
  model,
  effort,
  images,
  sessionId: previousNativeSessionId,
  mcpServers,
  onEvent,
  onEnd,
});
```

`save` 字段：`id?`, `name`, `command`, `args:string[]`, `env?:Record<string,string>`, `removeEnv?`, `model?`, `modeId?`, `readOnlyModeId?`, `legacyModelApi?`。编辑时省略 env 会保留原值，`removeEnv:true` 清空；其他缺省字段保留已有配置。`list/save` 返回 `{id:'acp-UUID',name,kind:'acp',command,args,model?,modeId?,readOnlyModeId?,legacyModelApi,envNames,hasEnvironment,updatedAt}`。`remove(id)` 删除。参数是数组，不通过 shell 拼接；选择用户信任的本机可执行程序。若 Windows 安装器只提供 `.cmd` shim，需要用户选择实际 exe 或 `node.exe` + 脚本参数，本模块不把 shim 自动改成不安全的 shell 命令。

`ACP_PRESETS` 仅提供官方命令示例，不安装 Agent。Hermes preset 打开 `legacyModelApi`；OpenCode 默认使用稳定 configOptions。用户应把秘密放在加密 env 字段，command/args 会显示在本机设置页以便编辑。

`probeACP(config,{cwd,env,timeoutMs})` 只初始化并创建空会话获取目录，不发送 prompt，不调用 authenticate，不执行登录命令。返回 `{connected,requiresAuth,agentInfo,capabilities,models,modes,currentModelId,currentModeId,efforts}`。要求登录时返回 `requiresAuth:true` 和可供展示的 authMethods，交给用户在 Provider CLI 里登录。部分 Agent 可能保存空会话；ACP 没有统一无副作用的 model/list，不能声称探测完全不产生会话状态。

模型为 `{id,label,description,default,efforts,defaultEffort}`；支持分组 configOptions，以及 model / thought_level / mode 分类。用户指定的 model/effort 必须是实际目录值；找不到会明确报错，不静默忽略。`session/set_config_option` 返回的完整配置用于后续选择。

Hermes 官方 [server.py](https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/server.py) 和 [model_catalog.py](https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/model_catalog.py) 当前使用 `models.availableModels/currentModelId`。本模块仅在显式 legacyModelApi 开启且 Agent 真正返回该目录时，使用旧 `session/set_model` 兼容路径；它不是当前稳定 ACP v1 通用 API。稳定 configOptions 优先。旧接口可见 [ACP 官方 Java SDK 文档](https://github.com/agentclientprotocol/java-sdk/blob/main/acp-agent-support/README.md)。

## 运行事件和范围

- `initialize → session/new`，或仅在声明 loadSession 后调用 `session/load`；加载历史不重复写成新 turn 转录。不支持恢复会话时明确失败，不偷偷新建或拼接伪造历史。
- `session/prompt` 启动后返回 runtime handle，输出通过 delta/message 流入现有 RunCoordinator。Agent 的文字与思考分别为 role assistant / reasoning，结束时同 itemId 发送完整 final message，以支持 Hub 跨 chunk 脱敏。
- tool 事件为 `{type:'tool',phase,itemId,item}`，合并前后 title/name/kind/rawInput/status 等字段。支持 plan/usage 和目录更新事件；renderer 可按自己的支持范围展示。
- 权限请求接入现有审批桥；批准只选择 allow_once，拒绝只选择 reject_once，缺少相应选项则 cancelled，绝不把一次批准扩成 allow_always。取消任务时先取消所有待审批请求，再发 session/cancel；未响应则结束整个子进程组。
- 图片沿用 5 张 / 每张 8 MB / 总计 16 MB 限制，且只在 Agent 宣告 image capability 后发送。音频/嵌入资源本批未实现。
- MCP 仅支持本次会话显式传入的 stdio servers（可接受现有对象映射或 ACP 数组）；不改全局用户配置，不记录 MCP env 值。HTTP/SSE MCP 本批明确拒绝。
- ACP v1 没有通用运行中 steer。`steer` 返回 `{unsupported:true,message}`，调用方必须保留原稿供任务结束后发送，不能显示“已送达”。
- 不提供客户端 fs/terminal capability；Agent 请求这些方法时返回 -32601，不读取或执行任意外部路径。但 Agent 自带的 native tools 仍在它的进程里运行，ACP **不是 OS 沙箱**，也不保证每个工具都请求审批。
- `read-only` 在没有明确配置 readOnlyModeId 时，在启动子进程前拒绝。配置后先选择 Agent 实际公布的模式，并拒绝 edit/delete/execute/switch_mode/unknown 权限请求。该映射仍依赖受信任 Agent 正确执行自身模式，不等同内核级写保护；内置 preset 不猜测模式名称。

主进程还须将 acp-UUID Provider 标识纳入本地和 Hub lane 白名单（只分享 id/name，不分享启动配置），为 model picker 获取 probe 模型列表，并在运行前注册解密后的配置。此模块不修改 main/Studio/Panels。

## 测试与尚未验收部分

`node --test tests/providers-acp.test.mjs tests/providers-acp-config.test.mjs` 当前 **11 项通过**。测试启动真实 Node 子进程，双方经过真实 stdin/stdout JSON-RPC 交互，校验握手、配置/旧模型目录、MCP/图片、流式文本/思考、权限结果、会话加载、取消及拒绝 SIGTERM 的子进程终止。配置测试使用真实 AES-GCM 注入器校验密文、读写权限、CRUD 并发和无法解密时失败。

对端 `tests/fixtures/acp-peer.mjs` 是**合成协议 fixture**，不是 OpenCode/Hermes，也没有调用模型。不能把这些结果称为真实 Provider 登录/推理 E2E；这部分需要用户已安装和登录的 CLI 后再验收。没有改 package 版本或发布资产。
