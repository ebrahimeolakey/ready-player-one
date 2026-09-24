# Mission Control 活动范围

本批源码补 A7 活跃文件聚合；不包含整套原版视觉一致性或双电脑验收结论。

`core/activity-view.mjs` 仅读取当前授权 snapshot 的 workspaces、sessions、approvals。调用方给出的 sessionIds 只是筛选 ID，不提供额外会话内容；已撤销/隐藏/归档的会话不会由旧 UI 参数重新引入。Viewer 不需要编辑权限即可查看已授权活动。主页面原有筛选范围保持一致。

来源有三种：

- **任务范围**：running 的 activeRunId 对应 claimed 审批；awaiting 的最新审批必须 pending/approved。Hub 将审批按新到旧保存，不能跳过已结束的新审批去找旧 pending。fileScopes 优先，空数组不会回退成旧文件。仅在完全没有该通道审批和 activeRunId 的旧数据中兼容 lane.files，标记未知范围/旧通道未确认。
- **打开**：lane.activity.fileScopes，expires 必须是有限数字且严格大于当前时间。关闭文件后最新空列表立即替换旧活动。
- **变更**：lane.changedFiles，changesExpires 满足同一有效期要求。仅使用实际发布的变更列表，不把 session 的旧 diff 文件列表当成实时活动。

路径按工作区 ID + 规范相对路径去重，保留所有会话、通道、成员及来源。只规范路径分隔符/目录末尾斜线，不猜操作系统大小写规则、不合并目录与其子文件。文件、目录、未知范围分开计数；同一路径同时被明确标为文件和目录时按未知范围展示，不伪装成一个确定文件。

无执行、无活动、无待处理项时不显示统计条，不重复卡片上的计划进度。非零活动用简短入口展示；默认折叠的活动清单显示路径、工作区、会话、成员和来源，点击来源进入其会话。没有新 Hub 广播时，组件按最近的有效期边界重算，窗口恢复焦点/可见时也重算。定时器关闭与组件卸载会清理；系统提前唤醒时按当前墙钟继续等待。声明来源仅随当前执行/审批状态消失，不编造 TTL。

## 验证

`tests/activity-view.test.mjs` 覆盖同工作区两个会话同路径合并、不同工作区相同路径分开、文件与目录/未知类型计数、关闭文件仅移除 open 来源、清空 diff、严格 TTL 边界、无新 snapshot 的实际调度回调、提前唤醒/取消、非有限有效期、归档、旧审批/上一轮 lane.files 排除、撤销后的旧 selection ID、真实 Hub WebSocket Viewer 会话邀请隔离与编辑拒绝。没有伪造生产活动、扫描用户文件或调用模型。

仅自动化与 TypeScript 构建检查通过，不将此文档视作 CUA、跨电脑或完整视觉对照证据。
