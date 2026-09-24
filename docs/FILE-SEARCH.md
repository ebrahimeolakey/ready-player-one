# 可取消的项目文件搜索

每个 Editor 持有随机 `viewId`，每轮输入持有新的 `queryId`。180 ms 防抖结束后通过 `file.search` 发送查询；改词、清空、关闭搜索、隐藏/卸载编辑器、切换会话或工作目录时发送精确的 `file.search.cancel`。并排 Editor 即使属于同一个 lane，也拥有不同 viewId。未保存草稿、文件打开与根目录保存保护不受影响。

## IPC 与服务

- `file.search({workspaceId, sessionId, laneId?, viewId, queryId, query})` 返回 `{queryId, results, cancelled}`。
- `file.search.cancel({workspaceId, sessionId, laneId?, viewId, queryId})` 只取消同一发送窗口、视图、上下文和 queryId 的请求；过期取消返回 false。
- `FileSearchService.start(owner, args)` 在校验当前会话和本机 lane 权限、解析目录之后，才取消同视图的旧查询。其他 owner / view 不受影响；重复同 ID 同内容返回同一 Promise，ID 用于不同内容会拒绝。
- 服务只允许最多 32 个同时运行的视图查询；查询完成、失败或取消均释放记录。应用退出调用 `closeAll()`。

`owner` 来自主进程验证过的 webContents，不接受 renderer 指定 owner。取消旧会话请求不依赖旧会话仍存在；它只作用于已经记录的精确归属，不会开始新的磁盘访问。

## 遍历范围与取消边界

`core/local.searchFiles(root, query, {signal})` 使用增量 `opendir` 遍历，沿用 safePath 边界，跳过符号链接、`.git`、node_modules、dist、release、.DS_Store。最多访问 20,000 个目录项、返回 100 个文件，最多进入 19 层子目录；不会再因为资源树每目录 500 项的显示限制而提前漏掉其余文件。

每次文件系统等待前后与每个目录项都会检查 AbortSignal，每 64 项主动让出事件循环。取消使遍历抛出 AbortError 并关闭目录句柄，服务转成 `cancelled: true` 响应；它会停止真实工作，而非只丢弃 UI 结果。操作系统已经发出的单次目录读取不能回退，但读取返回后不继续处理、排队或遍历。

## 验证

`tests/file-search-cancellation.test.mjs` 创建 20,001 个真实文件，6 项行为测试覆盖：20,000 项访问/100 结果上限及定时器运行、真实取消后访问计数停止、替换查询、过期取消、跨窗口/并排视图/上下文隔离、非法请求和 ID 复用、文件系统错误与 owner 关闭。

2026-09-24：新增 6 项与原有 local 7 项，Node 与 Electron 40 run-as-node 均 **13/13** 通过；`npm run build` 通过。这里是服务和构建验证，不声称已完成 Windows 实体机大目录交互测试。
