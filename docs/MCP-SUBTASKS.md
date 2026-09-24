# MCP 子任务本机桥

本批为 0.4.2 发布后的源码增量，尚未另外发布或调用真实模型。Agent 使用 `rpo_subtask_spawn` 后，会通过本机服务创建真实 Git 工作树；不会仅写一个 Hub 状态来冒充子任务已建立。

先打开会话的「接力与子任务 → Agent 子任务检查」，勾选允许拆分，并明确填写至少一条检查命令。设置保存在本机加密配置，绑定当前连接身份、工作区及 Git 仓库；不共享命令到 Hub。新仓库或另一个身份需要重新配置。关掉允许拆分会阻止新的 Agent 请求。

工具参数只有：

```json
{
  "requestId": "147f59c6-d86f-4474-a97e-6ded28d572e1",
  "title": "补充登录测试",
  "prompt": "完成子任务要求"
}
```

`requestId` 为 UUID。超时重试须使用相同 ID 和内容；相同 ID 改标题或任务会拒绝。工具不接受 owner/session/lane/run、cwd、Provider、检查命令、`worktreeReady` 或伪造检查结果。子任务沿用父通道的 Provider，在本人账号的新通道运行。创建回执返回 task/lane/approval ID、基准 commit 和检查 ID；重试返回原创建回执，当前进度从共享 context/界面读取。

## 身份与真实执行顺序

1. 主线程为每次原生执行创建专属随机凭据，仅注入该次 MCP 子进程环境。HTTP 桥只监听 `127.0.0.1` 的随机端口，拒绝浏览器 Origin、错误 Host、其他路径/方法和无效凭据；MCP 客户端也拒绝外网地址及重定向。
2. 凭据绑定当前 Hub/本机连接身份、owner、workspace、session、parent lane 和 run。每次请求及创建阶段之间重新核对角色、当前执行、停止围栏、真实本机 runtime 和检查设置。只读执行不能创建子任务工作树。连接切换、执行结束或应用退出撤销凭据。
3. 本机加密 journal 固定请求、检查方案和 checkpoint。读取父工作区当前文件到独立 Git index，生成真实 commit；不移动父 HEAD、index 或修改父文件，也不停止父 Agent。
4. `subtask.request` 按 owner + parent lane + source run + requestId 幂等，响应丢失重试仍找到同一任务。真实 `createSubtask` 从该 commit 建立独立工作树并绑定预期分支。
5. `subtask.claim {deferRun:true, claimKey}` 先准备 child lane，**不创建执行审批**。本机持久化 `config.lanePaths[childLaneId]` 后才调用 `subtask.start {claimKey}` 生成一次 pending approval。两步丢响应都按持久 key 幂等恢复，不能用不同 key 重复领取。手动「拆分子任务」也改用这个顺序，避免远端提前批准后子 Agent 错用父目录。
6. 子 Agent 执行仍需要成员批准。完成后由人打开「审阅成果 → 运行检查 → 集成成果」。MCP 桥没有检查、批准或集成接口，模型不能替换用户预配置命令。候选与合并结果实际执行所有必需检查，失败或冲突时父工作树不变；父 Agent 仍运行时不能集成。

## 接入接口

- `desktop/services/coordination-bridge.mjs::CoordinationBridge({client,runtime,taskCoordination})`：`issue({workspaceId,sessionId,laneId,runId})` 返回本机 URL/token 环境变量；`revokeRun`、`revokeAll` 和异步 `close` 管理生命周期。
- `taskCoordination.invoke('tasks.settings.get', {sessionId})` / `tasks.settings.save {sessionId,enabled,checkCommands}`：只通过本机界面调用，Editor/Owner 校验；设置中不含模型生成命令的自动导入流程。
- `taskCoordination.spawnFromAgent(binding,args,validateLease)`：仅本机桥调用；身份 binding 不来自 MCP 参数。实际 Git、加密 journal 和用户检查方案位于 `subtask-agent.mjs`。
- `core/mcp-coordination.mjs`：工具只通过 `localSubtaskClient` 调用白名单桥入口，不将请求退回为原始 Hub `subtask.claim`。旧版本或无桥环境会明确提示未配置。

如果检查设置、项目映射或权限在创建过程中改变，会停止后续步骤。已经生成的 reservation/工作树会保留以便核对，不删除可能存在的成果；不因为一次超时改用新的 requestId 自动重做。Git 进程在“工作树已创建、状态文件尚未落盘”的极小崩溃窗口可能需要人工检查原工作树，本批不会猜测删除/重建它。应用重启后原父 Provider 不再运行时，旧凭据/请求不能启动新的执行。

本机检查设置和请求 journal 存入现有加密 client store；Hub 仅保存协调元数据、commit、检查 ID 及 claim key 的不可逆摘要，不接收本机桥 token 或检查命令。既有 Git 子任务状态文件仍按原 `core/subtasks.mjs` 的本地权限保存，未改为新的云端存储。

## 验收证据

`tests/subtask-bridge.test.mjs` 使用真实 MCP stdio 子进程、HTTP 桥、WebSocket Hub 和临时 Git 仓库：

- 未配置检查拒绝；模型提供命令/身份字段、浏览器 Origin、错误凭据、只读父执行及降权均拒绝。
- 模拟 request/claim/start 均已提交但回执丢失，最终仅一个子任务、一个子工作树和一个执行审批；父执行继续，父 HEAD/index/未提交内容保持。
- 真实候选检查先失败、再修正通过；父运行时拒绝集成，停止并确认父修改后只集成一次。
- 并发相同请求共享一次创建；改变内容、检查设置或连接身份不能另起同一请求。
- 手动流程也验证本机 lane 映射持久化先于 pending approval；加密回执经新服务实例读取后重试不重复创建；重新绑定仓库拒绝旧请求。
- 在 reservation 后立即撤销角色，不能生成子 lane 或可执行审批。

这些证据不等同真实 Codex/Claude/ACP 已自主选择该工具或两台实体电脑验收；本批没有模型调用、发布、外部服务部署或自动集成。

2026-09-24 本批验证：`node --test tests/subtask-bridge.test.mjs tests/task-coordination-service.test.mjs tests/coordination.test.mjs tests/mcp-memory.test.mjs tests/subtasks.test.mjs` **50/50 通过**，其中桥接新增 6 个场景。`tsc --noEmit`、主线程语法检查与相关文件 diff 空白检查通过。日志为 `/tmp/rpo-mcp-spawn-validated.log`。代码在这组验证后冻结，交由发行流程完成真实桌面集成验收。

0.4.3 Mac Apple Silicon 打包应用已实际打开“Agent 子任务检查”，在合成项目中启用并保存 `git diff --check`，界面显示已启用。真实模型自行选择 MCP 工具仍待验收；不把配置保存等同于模型调用。
