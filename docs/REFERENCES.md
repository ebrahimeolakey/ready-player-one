# 评论锚点与共享记忆引用

## Main IPC

`desktop/services/references.mjs` 的三个函数接收主进程解析过的项目根目录，不接收 renderer 自报的绝对目录：

| invoke | Main 转发 |
| --- | --- |
| references.capture | `captureReference(localRoot(args), args)` |
| references.files | `fileReferences(localRoot(args), args)` |
| references.check | `checkReferences(localRoot(args), args)` |

`references.capture` 参数为 workspaceId/sessionId/path/startLine/endLine/expectedHash，返回 comment.add 可用的 location `{path,startLine,endLine,commit,hash,side}`。expectedHash 必须来自已加载磁盘文件；文件在外部变化时拒绝绑定。HEAD 可用时记录 HEAD，否则 commit 使用内容 hash，始终另外记录内容 hash。

`references.files` 参数 `paths: string[]`，最多 100 条，返回 `{path,commit,hash}[]`。服务真实读取当前磁盘文件，不让用户手填 hash。

`references.check` 参数 `references: {path}[]`，返回当前同类引用；已删除、不可读、二进制或越界符号链接返回全 0 hash/commit 与 unavailable=true，供 Hub 判定过期，不会读取符号链接指向的外部内容。实际捕获/更新引用时严格拒绝这些情况。

目录边界复用 core/local.safePath / read，Git HEAD 复用 local.git。服务仅提供文件事实；共享评论和记忆的写权限仍由 Hub 检查。

## Editor

仅修改 Panels.tsx 的 Editor 部分。CodeMirror 当前选择转换成准确的一基行范围（选区刚好结束于下一行开头时不算下一行）。显示当前行范围；「评论」打开短输入表单。未保存草稿时禁止提交，提交前服务再验证磁盘 hash。切换 session 后不把上个 session 的文件状态用于评论。

点击「检查评论」先读取磁盘当前引用，再调用 comment.check 更新共享评论的 stale。外部文件已变化时给出重新打开提示。Hub 的 location 需保留 hash，comment.check 按内容 hash 优先比较，HEAD 作为兼容旧锚点的回退；这部分由 collaboration_core 接入。

## MemoryPanel

`<MemoryPanel state={state} workspaceId={workspace} call={call} />` 替换原 memory 页面内容。包括新建、编辑、停用/恢复、关联文件、检查过期与更新引用。使用现有 Modal / 样式，无需新的全局状态。

- 新建/变更关联路径时，从 references.files 读取 hash/HEAD。
- 只编辑标题和内容而路径不变时不刷新引用，避免意外清除过期标记。
- 「检查」从 references.check 获取当前事实，再调用 memory.check。
- 「更新引用」表示确认记忆仍适用，调用 references.files + memory.update 更新基线；删除/不可读文件不能被更新成伪造的有效引用。
- 全部检查按 100 文件分批。默认隐藏停用项，可显示。
- viewer/commenter 仅阅读共享记忆；编辑操作由 UI 禁用并由 Hub 权限再次验证。

自动测试覆盖非 Git 行范围/内容 hash、磁盘外部修改、Git HEAD 与未提交内容独立变化、删除文件、路径穿越及符号链接边界。组件经 TypeScript 检查，真实 CodeMirror 选择和页面流程待主任务 CUA 集成验收。

## 0.4.4-beta.1

- 消息旁的评论按钮绑定会话、通道、消息 ID 与共享文本哈希。评论栏可定位并高亮消息；消息变化或超过保留期时明确提示，不复制整条消息延长其保留期。
- 本机 Git 审阅支持修改前/后的单行和片段评论。提交前重新读取差异并核验目录、diff 哈希和所选行；已暂存内容绑定 Git blob，未暂存内容绑定磁盘全文哈希。CRLF、重命名、删除、未跟踪文件均有真实 Git 回归。
- 点击文件评论打开只读窗口，依次核验当前内容、Git 历史、保存的原始片段；无法核实时显示不可用，不跳到错误的新代码。最多保存 8,000 字符片段，符号链接不作为代码引用。独立查看不覆盖编辑器草稿。
- 保存文件、Git 拉取/提交/切分支、快照同步、子任务集成和接管后，自动检查受影响引用。自动检查只标记过期，不自动消除需要复核的状态；读取与上报失败不重复已经完成的 Git 操作。
- 记忆更新支持版本冲突检查及独立分页历史。明确更新引用后重建基线，旧正文/文件引用/过期状态保存在受权限保护的历史中；历史正文不广播到普通 state。
- 远端成员共享的纯文本 diff 尚不具备可核验的左右文件对象，因此该视图仍只读。协作者可打开对应快照的本机 Git 审阅，或使用已有文件评论。

自动化证据：`tests/comment-anchors.test.mjs`、`tests/transcript-comments.test.mjs`、`tests/reference-refresh.test.mjs`。不把合成 Git/Hub 回归等同于双机桌面验收。
