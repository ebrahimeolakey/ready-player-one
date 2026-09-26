# Agent 文件修改位置采集

本模块只采集可核验的位置。它不执行工具，不写项目文件，不解析 shell 输出，不持久保存文件内容。已接入主进程、Hub 和编辑器代码缩略图；授权与显示约束见文末。

## 接口

```js
import { AgentEditPositions } from '../desktop/services/agent-edit-positions.mjs';

const positions = new AgentEditPositions({
  onPositions: async (batch, context) => {
    // 使用当前授权连接提交 run.editPositions；服务不会提交网络请求。
    // context 是首次事件绑定的 root/workspaceId/sessionId/laneId，不含凭据。
  },
  onError: error => { /* 可选本机静态提示，不影响 Agent */ },
});
void positions.observe(
  {runId, provider, type:'tool', phase:'started', itemId, item},
  {root, workspaceId, sessionId, laneId},
);
// 所有该 run 的事件已按接收顺序入队后调用。
void positions.finish(runId, {root, workspaceId, sessionId, laneId});
// 连接/身份改变或退出时销毁整个实例，重新构造。
positions.dispose();
```

`observe` / `finish` 返回 Promise：位置发生变化时返回该批次，否则 null；异常被隔离。事件参数在入队前只拷贝支持字段，调用者后续修改对象不会改变采集目标。同一 run 串行处理；首次绑定上下文后，其他 root/workspace/session/lane 不能覆盖该 run。

回调是**整批替换**，包括撤回时的空数组：

```ts
{
  runId: string;
  sequence: number; // 同 run 已发布批次单调递增
  positions: Array<{
    path: string;   // 规范相对路径，使用 /
    hash: string;   // 实际完整 UTF-8 文件字节的 SHA-256
    startLine: number; // 1-based，包含端点
    endLine: number;
    phase: 'pending' | 'completed';
    toolId: string;
    source: 'codex' | 'claude';
  }>;
}
```

Hub 仍须独立验证 owner、当前 run、source、序号、TTL 与位置字段，不能信任 renderer 自报。异步网络回调超过 1 秒被隔离，底层已发出的回调不能被本模块撤销，因此接收端必须拒绝迟到的低序号批次。UI 只能在路径及编辑器**完整内容 hash**均匹配时显示，脏内容不得沿用旧行号。

## 真实事件依据和支持范围

本机 Codex app-server 生成的 v2 JSON Schema（`/tmp/rpo-codex-schema/codex_app_server_protocol.v2.schemas.json`，本机核对资料，不随应用分发）定义 `ThreadItem.fileChange`：`id/type/status/changes`；每项 change 为 `path/kind/diff`，kind 包含 add/delete/update 与可选 `move_path`；status 为 inProgress/completed/failed/declined。现有 `core/providers/runtime.mjs` 将 item/started、item/completed 原样投影为 tool 事件。

现有 Claude runtime 将 assistant 内容中的 `tool_use` 作为 started，将 user 内容中的 `tool_result` 作为 completed，并用 `tool_use_id` 关联。采集器只接受 `Edit` 的 `file_path/old_string/new_string/replace_all` 与 `Write` 的 `file_path/content`，不尝试兼容同名自定义 MCP 工具或其他工具。相关官方接口入口为 [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)；本轮网页抓取未能取得其完整工具类型，因此不把它写成这轮已逐字段在线复核的证据。

| 工具/阶段 | 核验与结果 |
| --- | --- |
| Codex fileChange started + inProgress | 仅严格 unified hunks；磁盘旧侧所有上下文/删除行必须匹配声明行号。只将实际删除/替换的旧行标为 pending。 |
| Codex fileChange completed + completed | 磁盘新侧所有上下文/新增行匹配；标实际新增/替换的新行为 completed。移动文件核验目标路径。 |
| Codex 新增 pending、删除 completed | 该侧没有存在的行，不猜锚点、不伪造第 1 行；没有位置或撤去旧标记。 |
| Claude Edit started | old_string 非空且唯一匹配，或明确 replace_all 且找到全部匹配；计算 pending 旧行。仅保留预期新全文 hash 和新行范围，不保留内容。 |
| Claude Edit completed | 必须关联之前支持的 started；tool_result 非 error 且磁盘完整文件 hash 等于预期，才标 completed。其他并发改动导致 hash 不同则不显示。 |
| Claude Write started | 没有 old_string，不能声称核对了旧内容的修改区间，因此不标 pending 旧行；仅记新内容 hash/范围。 |
| Claude Write completed | 成功关联后，实际完整 UTF-8 文件 hash 匹配 content 的 hash；以完整新文件范围标 completed。空文件没有文字范围。 |

失败、拒绝、未知格式、内容不匹配撤去对应尚未结束工具的位置。完成后的重复结果或迟到 started 不再次发布。完成前缺失 started 的 Claude 结果不会补猜参数；Codex completed 自带完整 change 信息，能独立验证新侧。`finish` 清除 pending，保留已验证 completed 供共享端 TTL 清理；不会声称 Agent 此刻仍在输入。

## 安全与资源边界

- 默认文件/单个 diff 预算 1 MiB（构造上限 2 MiB），严格 UTF-8、拒绝 NUL/二进制、非普通文件、越根、路径中的空组件/点/上级组件及符号链接。允许根内绝对工具路径，输出相对路径。
- 逐层 lstat 拒绝符号链接/junction，再由 realpath 得到规范目标并重新验证仍在原 canonical root 内。大小写别名只有在文件系统确认两种拼写 dev/inode/大小/mtime/ctime 一致时接受，输出规范相对路径；不自行转小写或猜另一文件。O_NOFOLLOW/O_NONBLOCK（平台具备时）打开规范目标，读取前后核对 fd、原请求路径与规范路径；别名指向或文件元数据变化时丢弃结果。这不是对恶意并发文件系统的 OS 沙箱替代，项目访问权限仍由主进程控制。
- 每 run 至多 64 个工具记录，保留至多 32 个位置；一个 Edit replace_all 超过 32 匹配时不截断冒充完整核验。默认最多 64 个 run（配置上限 128），全局最多 64 个等待/执行中的 observe；finish 可越过排队数量限制确保清 pending。
- finish 后默认 60 秒清除 run 内存（配置上限 5 分钟）；最近 256 个结束 run 有独立迟到事件围栏。超出该有限历史仍由 Hub 当前 run 围栏拒绝。活跃 run 达上限时新 run 不采集，正常 Agent 不受阻；调用方应始终 finish，切连接 dispose。
- 通知失败/超时或 onError 自身失败均不向 Provider 抛错。回调只含位置与 hash，静态错误不带路径/文件内容。dispose 使尚未执行的队列失效并清定时器；已进入用户回调的外部操作由调用方控制。

## 本轮验证和缺口

`node --test tests/agent-edit-positions.test.mjs`：15 项通过，使用实际临时文件与 runtime 形状的合成标准事件；没有真实模型调用、没有通过真实模型修改项目。日志 `/tmp/rpo-agent-edit-positions-tests.log`。

覆盖 old/new 核验、唯一/全部替换、多行偏移、中文空格路径、新文件 Write、Codex 增删移动、失败撤标、未知 diff、越根/符号链接/二进制/大小限制、输入对象突变、上下文围栏、重复/迟到事件、销毁时异步回调、队列/run 上限和 finish 清理。

大小写别名回归先探测实际卷：本机 darwin 的 `Directory/Case.txt` 与 `directory/case.txt` 返回相同 dev/inode，已实测 pending/completed 均输出 `Directory/Case.txt`；外部目录 symlink 及其大小写别名均无标记。若在大小写敏感卷运行，测试明确记录该条件并验证不存在/内容不同的别名不被猜测匹配，不声称运行了别名成功分支。本轮未运行真实 Windows；Windows junction 分支仍须 Windows CI 验证。

ACP、自定义 API、shell/apply-patch 文本输出、其他 Claude 工具、非 unified Codex diff、失去 started 的 Claude 工具仍无位置覆盖。没有实时逐字符编辑流；标记描述已收到请求或刚核验的磁盘写入，不是成员光标。真实 Provider→采集→共享→编辑器端到端验收须由整合阶段补齐。

## 共享与编辑器接线

Coordinator 将原始结构化工具事件交给采集器，保持 Provider 执行独立。采集失败、回调失败不会中断任务，也不会重试工具。主进程固定原始 canonical root 和连接，切换房间销毁采集器；发布前复核本人 lane、当前 run 和目录绑定，没有离线补传旧位置。

Hub `run.editPositions` 要求本人当前执行及 Editor/Owner 角色，校验 Provider、整批序号、最多 32 个相对路径/完整哈希/行号标记，不接收正文。乱序与相同序号重发不会回退内容或续期；相同序号不同内容拒绝。标记 60 秒过期，断开连接和 Hub 重启清除；新 run 不继承旧标记。结束后允许最后一次已核实完成的位置抵达，不能再发布待修改位置。

代码缩略图只读取当前授权 snapshot，按工作区、相对文件路径及编辑器当前内容完整 SHA256 匹配。文件内容改变、切换文件、失去权限、断网、到期或关闭缩略图时清除。目录重新绑定后，旧批次序号不重新显示，必须取得更新批次。悬停显示成员、行号和“待修改 / 已修改”；颜色沿用协作者偏好，不声称显示实时打字光标或没有结构化证据的 Shell 写入。

新增 `tests/edit-positions.test.mjs` 使用真实 Hub / 两客户端验证角色、会话范围、版本匹配、重发/乱序/撤权/过期/断线；`tests/edit-position-publisher.test.mjs` 使用真实 Coordinator → 磁盘 → 采集器 → Hub → 远端快照链路，Provider 事件是合成夹具，没有调用模型；`tests/edit-position-view.test.mjs` 使用真实 CodeMirror 验证显示、脏内容失配、目录换绑、到期、撤权和主题/缩略图切换，保留同一编辑器与文档。

此批尚未发布安装包；工具覆盖和跨实体设备验收仍需继续扩展。
