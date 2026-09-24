# 应用内创建 GitHub 仓库

仓库选择面板新增“创建新仓库”。用户填写所属用户 / 组织、仓库名和明确的私有 / 公开范围，先“审阅创建”，查看实际 `gh` 账号和目标，再按“确认创建私有 / 公开仓库”。组织创建还检查当前账号的组织成员状态，最终创建权限由 GitHub 响应决定；权限不足直接显示错误，不扩展 token scope。

创建的是空仓库，不初始化 README、提交、推送或上传本机文件。远端创建后，用户再单独选择“克隆到新目录”或“绑定已有 Git 项目”。绑定先选择目录、查看路径和 origin URL，再“确认绑定”。

## 接口与持久化

`desktop/services/github-repository.mjs` 导出 `GithubRepositoryService({store,scope,withRepository,run?})`。`store()` 是现有加密 SecureStore；`scope()` 是当前 Hub audience 与成员身份组成的稳定标识；`withRepository` 复用应用仓库锁。

| IPC | 服务方法 | 行为 |
| --- | --- | --- |
| `github.create.preview` | `preview({owner,name,visibility})` | 校验账号、归属和名称，保存待审阅票据，不创建 |
| `github.create` | `create({id})` | 重新核对账号与身份，保存 dispatch 标记后只发一次 POST |
| `github.create.lookup` | `lookup({id})` | 只 GET 查询现状，不重发创建 |
| `github.create.history` | `history()` | 仅当前 Hub 身份和当前 GitHub account.id 的最近记录 |
| `github.bind.preview` | `previewBind({id,path})` | 主进程弹目录选择器后读取 Git，返回绑定审阅卡 |
| `github.bind.confirm` | `bind({bindingId})` | 重核权限 / 路径 / Git 远端配置，在共享仓库锁内添加 origin |

`github.clone` 的新建仓库入口同时传 `creationId`，主进程核对创建票据及仓库后才允许进入既有克隆流程。普通克隆不需要创建票据。创建、账号状态、列表和克隆均固定 `github.com`，避免本机 `GH_HOST` 指向其他站点时发生错配。

票据保存于加密 `github-repositories.json.enc`。其中只有账号 ID / login、仓库、作用域、状态与本地绑定证据，不保存 token。账号或 Hub 身份改变不能继续操作原票据。确认时通过 `gh auth token --hostname github.com --user <审阅账号>` 读取现有授权，仅在本次串行操作内存中锁定该 token，再核对 API 用户 ID；操作结束即释放引用，避免确认到 POST 之间切换活跃 gh 账号把仓库建到错误用户下。不新增或提升授权。首次 POST 前存储失败不发请求；已保存 dispatch marker 的记录即使重启也只查询。

## 不确定结果与本地保护

- POST 超时、网络中断或响应不完整显示“创建结果待核实”。再次点击或重启后恢复该记录不会重新 POST。
- 查询发现同名仓库只能显示“已找到同名仓库”，不能证明原请求创建成功。仓库 ID 后来改变，或名称 / 可见范围不符，停止关联并提示核实。
- 未查到仓库也不代表未创建，不能自动重建。用户需在 GitHub 核实；本工具不会绕过这一记录再次创建同名仓库。
- 审阅期间如果仓库已由其他操作创建，则显示已存在，由用户明确选择下一步。
- 绑定必须是既有主 Git 仓库根目录。子目录、独立工作树和不同 origin / push URL 被拒绝；不自动 init，也不覆盖其他远端。
- 绑定审阅后远端配置变化须重新审阅。HEAD、暂存区、未提交与未跟踪文件保持原状，不自动 commit / push，也不自动改变工作区目录映射。
- 绑定写入也先存 dispatch 标记。重试仅确认 origin 是否已是目标；未知且未生效的写入不自动重发。

## 验证与范围

`tests/github-repository.test.mjs` 使用模拟 gh 与临时真实 Git 仓库，覆盖 11 项行为：参数与账号、确认前无副作用、重复 / 并发 / 加密重启、POST 已提交但 ACK 丢失、组织 / 权限错误、跨账号与 Hub 身份隔离、Git 内容保全、origin / 工作树 / 配置竞态保护、持久化与仓库锁失败、固定 GitHub host 与带中文空格路径参数，确认期间 gh 活跃账号切换，以及重新查询失败不会保留可继续关联的缓存成功状态。连同既有 accounts 测试共 19 项通过。

没有创建真实外部测试仓库；真实 GitHub 权限、组织规则、网络和 GUI 登录环境须在用户实际使用时由官方响应确认。当前仅 github.com，不宣称支持企业自托管 GitHub。

API依据：[GitHub 仓库 REST API](https://docs.github.com/en/rest/repos/repos)、[GitHub CLI gh api](https://cli.github.com/manual/gh_api)。创建使用明确的 `private` 布尔值和 `auto_init=false`，命令采用参数数组，不经过 shell 插值。

创建组件 history 仅挂载时读取，call 函数重建不触发 gh API；父组件以 Hub / 成员 / GitHub 身份组成的 identityKey 重挂载，清空上一身份的审阅与历史。
