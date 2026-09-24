# 归还步骤、会话邀请与删除工作区

本批源码增加 A6，尚未作为已发布安装包或双电脑互联网验收证据。

官方依据：[角色与成员](https://useamoeba.com/docs/admin/members)列出 Commenter 归还本人工作、Editor 邀请成员加入会话、Owner 删除工作区；[实时会话](https://useamoeba.com/docs/collaboration/live-sessions)说明可带备注归还工作；[工作区](https://useamoeba.com/docs/concepts/workspaces)说明共享记忆属于工作区。下述数据结构、预览确认和清理日志是本项目实现，不声称为原版内部协议。

## 归还

`plan.release {sessionId,id,note}`：Viewer 被拒绝；Commenter/Editor/Owner 也只能归还**当前由自己负责**的步骤。备注必填，最多 2,000 字符。归还后未分配、待开始、未完成；待确认的转交变为 cancelled。history 保存操作者、时间、备注、原负责人及原状态。重复归还不反转，也不追加假历史。UI 在本人步骤显示“归还”，展开填写备注。

## 邀请与权限

- `invite.create {workspaceId,role,githubLogin?}` 保留 Owner 工作区邀请；`sessionId` 存在时变为 Editor 可创建的会话邀请，角色只允许 Viewer/Commenter/Editor。
- 界面默认分享当前会话；Owner 可明确选整个工作区。远端 Editor 使用当前已连接的 Hub 地址生成邀请，不启动自己电脑的中继。
- 服务器从验证过的邀请设置 peer.sessionId，并将成员写入独立 sessionMembers。客户端传入 sessionId、role 或宿主身份声明不会改变此范围。已有工作区角色与新会话角色分开；通过会话邀请连接时仍受该连接范围限制。
- 快照、会话导出、coordination.context、run.claim、接管上下文及 ID 目标操作均执行范围检查；仅会话成员的 memories 始终为空，memory.*、工作区创建/删除/成员管理一律拒绝。其他会话的审批、工具、子任务、锁及重叠说明不会返回。跨会话文件占用仍可能导致 acquired:false，但不暴露占用详情。
- `invite.revoke {workspaceId,sessionId?,id?}`：Owner 可撤销该工作区指定/全部邀请；Editor 只能撤销自己创建的当前会话邀请。连接立即关闭，重连需要新的有效邀请。其他会话邀请和工作区不受会话撤销影响。
- `member.role/remove {workspaceId,sessionId?,memberId,...}`：Owner 管理具体会话授权时附 sessionId。角色变更立即生效且重连保留；不能把会话成员升级为工作区 Owner。移除工作区身份也阻止该身份改用会话邀请绕回。
- GitHub 用户名邀请仍使用已配置的身份验证服务；本批不注册或部署 OAuth App。

## 删除

`workspace.delete.preview {workspaceId}` 仅 Owner。返回各关联表数量、会话名称、转录逻辑文件名、阻塞执行、保留范围、5 分钟有效 previewId。确认使用 `workspace.delete {workspaceId,previewId,confirmation:完整工作区名称}`。确认必须由预览的同一身份执行，服务端重新核对完整数据指纹。内容变化必须重新预览；当前运行、等待审批或仍为 claimed 的执行（包括离线/中断但未确认结束）都阻止删除，不会直接杀掉执行后假设已结束。

共享房间数据包括 sessions、members/sessionMembers、memories/memoryHistory、approvals、outcomes、toolApprovals、handoffs、subtasks、locks、messages、groupMessages/groupTasks、invites。删除同时去掉该工作区身份挑战；只清理已无其他工作区/会话授权的非房主身份票据。另一个工作区的身份和票据不受影响。

先原子保存元数据删除及精确转录清理日志，再删除相应 `.jsonl.enc`、遗留 `.jsonl`、同名 `.pending`。`SecureStore.removeFile` 不递归目录、不跟随符号链接，路径限于安全存储目录。中途失败时房间不复活，重启完成日志清理。最小删除收据只保存工作区 ID、previewId、原操作者和时间，不保留内容；`workspace.delete.status` 只允许原操作者获得对应已提交状态，用于丢响应恢复。

桌面额外列出当前 Hub audience + 本机 secret 身份 scope、workspaceId 精确匹配的 `outbox/<runId>.json.enc`。有 runtime、领取/补传过程、未结束、pending 消息、未投递未知结果时阻止删除。共享删除确认成功后才清已结束恢复文件、这些 runId 的附件及同 connectionKey/owner/workspace 的子任务配置和 receipt。清理日志支持磁盘失败和确认响应丢失后续接。删除期间暂停领取并锁定对应本机项目操作；不调用项目文件删除 API。

**保留范围必须在确认界面可见：**

- 项目文件、`.git`、会话/子任务工作树全部保留。
- Provider 自身原生历史、外部导出/备份保留。
- 其他成员电脑上的离线缓存/副本不能由房主声称已经物理删除。
- 旧输入草稿、文件草稿、composer、项目路径和模型映射仅有裸 UUID，没有可信 Hub 身份索引，因此保留，不猜测来源后擦除。
- 远端 Owner 删除后旧邀请会失效；若恰好丢失确认且不能重新连接，保留本机待确认清理日志及恢复副本，直到同一身份能验证删除收据。不会把“服务器不可访问”当成删除成功。

## 验证证据

`tests/workspace-access.test.mjs` 使用真实 WebSocket 多客户端：Commenter 领取/转交/归还/再次领取；Editor 会话邀请不能提升 Owner/工作区权限；memory/history 和跨会话 ID 拒绝；快照/context/claim 隔离；降权重连保留、撤销只影响对应会话；预览操作者/名称/过期内容/活动执行检查；合成目录实际删除加密转录、旧副本和恢复副本，另一工作区及 `.git/HEAD`、项目文件字节保持；删除中断后重启恢复。

`tests/workspace-cleanup.test.mjs` 使用真实 Hub/存储及恢复记录：同 workspace UUID 不同 Hub 身份的 outbox 保留；未投递 unknown 与实际 runtime 阻止；确认后磁盘失败恢复；删除响应丢失通过原 owner 收据续清；无来源草稿/路径映射保留。无真实项目删除或模型调用。
