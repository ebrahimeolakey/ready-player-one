# 会话分支围栏

每个用于快照的 linked worktree 在自己的 Git 私有目录保存 `rpo-session-binding.json`：版本、会话 ID、工作树真实路径、确切分支名。它不进入工作区、index、快照或远端，也不修改用户的 Git 全局配置。新建会话工作树时绑定实际创建的分支；子任务工作树绑定其确切子任务分支。

发布、接收、冲突解决以及关键应用步骤会比较真实 `symbolic-ref HEAD`。切到普通分支、另一个 `rpo/*` 或分离 HEAD 都暂停；`rpo/` 前缀本身不再足以授权同步。不会自动 checkout、reset、stash 或覆盖当前文件。用户切回预期分支后点击立即同步，或等待已启用的自动同步，即可恢复。

旧会话没有绑定时安全暂停。同步面板读取并展示当前/原绑定分支，由用户点击确认绑定；必须是明确的 `rpo/*` 分支且工作区、index 干净。已存在的不同绑定仅在用户审阅后携带旧分支作比较并交换才能替换。UI 审阅后又切分支会被拒绝。同分支重复绑定幂等。改绑只改变绑定记录，不切分支、不搬迁代码；旧子任务仍保留创建时的父分支要求，不随改绑自动改变目标。

如果旧版本或崩溃留下工作树、但 config 尚未保存路径，`local.worktree` 会先验证它确实属于原仓库的 linked worktree，返回路径供确认界面使用。不会因此自动认领当前分支。其他仓库、另一会话的绑定或损坏绑定均拒绝。

子任务创建时额外保存 `parentBranch`，集成前以及异步检查/审批返回后再核对；即使两个分支的 HEAD commit 相同也不能绕过。子任务候选保存使用确定的 branch ref，写回 index 前复核。旧子任务记录没有 parentBranch 时拒绝集成，不能从当前分支猜测旧目标；保留候选供人工审阅，重新创建明确目标的子任务。

API：

- `inspectSessionWorktree(root,{sessionId})`：只读返回 root、actualBranch、binding、status（unbound / bound / paused）。
- `bindSessionWorktree(root,{sessionId,expectedBranch,replaceExpectedBranch?})`：显式确认；expectedBranch 必须与当前真实分支一致。已有不同绑定时 replaceExpectedBranch 必须匹配旧绑定。
- `assertSessionWorktree(root,{sessionId,allowConflicts?})`：校验绑定。同步状态检查可传 allowConflicts:true 后单独展示冲突，实际发布/接收仍拒绝未解决冲突。
- 未绑定抛 `RPO_SYNC_BRANCH_UNBOUND`；错分支抛 `RPO_SYNC_BRANCH_MISMATCH`，都附 expectedBranch / actualBranch（分离 HEAD 为 null），main 显示暂停。

本机验收：`tests/snapshots.test.mjs` 5 项、`tests/subtasks.test.mjs` 6 项、`tests/local.test.mjs` 6 项，17 项通过；另 `tests/task-coordination-service.test.mjs` 的创建/检查/集成、双 clone 接管、角色拒绝 3 项通过，共 20 项。使用两个真实 clone、bare remote、独立 worktree；比较错误分支操作前后 HEAD、分支、工作区内容、staged/unstaged diff、所有本机 refs 和远端 refs；覆盖普通/另一 rpo/分离 HEAD、显式旧会话绑定、脏工作拒绝改绑、路径恢复/外仓库拒绝、切回恢复，以及检查过程中切分支阻止子任务应用。不是双实体电脑或公网 Git E2E。

围栏与现有 main 的 Repository/Agent/调试锁一起使用；独立快照操作按 canonical root 串行。外部终端的任意 Git 命令不遵守应用锁：关键步骤会复核，但不宣称能够与不协作的外部 checkout 实现跨命令原子事务。当前测试覆盖操作开始前与受控异步检查期间的分支变化；不要在同步应用瞬间同时使用外部 Git 切换工作树。

真实 Mac 桌面也已验收：隔离项目通过 UI 开启自动同步，创建并绑定 `rpo/<session>`，快照成功推送到本机 bare remote；外部切到另一个 `rpo/*` 后点击同步，UI 显示“分支已暂停”及预期/当前分支，提供查看与确认入口。
