# Git 审阅与提交

`desktop/services/git.mjs` 提供 `GitService({env:localEnv(),isBusy:root=>boolean})`。所有方法首个参数是由主进程根据已授权本地工作区解析的仓库根目录，renderer 不能直接传任意根路径。

| IPC / 方法                                     | 参数              | 行为                                          |
| ---------------------------------------------- | ----------------- | --------------------------------------------- |
| `git.status` / `status(root)`                  | 无                | 分支、改动、暂存、冲突和进行中的 Git 操作     |
| `git.diff` / `diff(root,args)`                 | `path? / staged?` | 未暂存或已暂存差异；禁用外部 diff / textconv  |
| `git.stage` / `stage(root,args)`               | `paths`           | 只暂存指定且仍在改动列表中的文件              |
| `git.unstage` / `unstage(root,args)`           | `paths`           | 只撤回指定文件暂存，不改工作文件              |
| `git.commit` / `commit(root,args)`             | `message`         | 只提交已暂存内容，说明不能为空                |
| `git.fetch` / `fetch(root,args)`               | `remote`          | 获取已配置远程的对象与引用                    |
| `git.pull` / `pull(root,args)`                 | `remote / branch` | 仅干净工作区、明确当前分支、fast-forward-only |
| `git.push` / `push(root,args)`                 | `remote`          | 仅当前分支，设置 upstream，不使用 force       |
| `git.branches` / `branches(root)`              | 无                | 本地分支与远程名称，不返回带凭据 URL          |
| `git.createBranch` / `createBranch(root,args)` | `name`            | 干净工作区中创建并切换分支                    |
| `git.switchBranch` / `switchBranch(root,args)` | `name`            | 干净工作区中切换到已有本地分支                |

组件：`GitPanel({call,context:{workspaceId,sessionId},busy})`。主界面把该 context 映射为当前项目/工作树根目录，IPC 名字与上表一致。组件不直接持有文件系统能力。

所有修改调用按仓库加锁，并拒绝 `isBusy(root)`。主进程在启动 Agent 前也应检查 `service.locks.has(canonicalRoot)`，实现双向互斥。只读审阅在 Agent 运行中仍可使用。

路径采用 Git `--literal-pathspecs` 和参数数组，支持空格及特殊文件名；拒绝仓库外路径与 `.git` 内部文件。不使用 shell 拼接命令，不设置全局 Git 配置、不添加远程、不批量读取 repo secrets、不自动发布。已有提交 hooks 按 Git 原生行为运行。

冲突状态直接展示；未解决冲突不允许提交。用户在编辑器解决并暂存后，可提交完成普通 merge。变基 / cherry-pick 等多步骤操作由真实终端完成，不假装已支持完整可视化 sequencer。

## 真实行为测试

`tests/git-service.test.mjs` 为每个场景在临时目录创建一个真实 bare remote 和两个真实 clone，使用仅测试仓库的身份和配置，验证：

- 指定文件暂存与差异、仅提交 index、保留其他未提交文件。
- 文件 remote 的真实 push / fetch / fast-forward pull。
- 初始提交前撤销暂存、重命名撤销暂存不丢内容。
- 分支新建/切换，脏工作区拒绝变更。
- 分叉 pull / push 被拒绝而不丢本地提交。
- 真实 merge 冲突识别、解决后提交双父 merge。
- Agent busy 阻止修改、字面路径防 pathspec 注入、仓库根目录保护。
- 非跟踪 symlink 不读取仓库外目标。

不连接或修改用户的 GitHub 仓库。Windows/Linux 实机 Git 与凭据助手行为需要各平台另验，不能用本机 Mac 测试代替。
