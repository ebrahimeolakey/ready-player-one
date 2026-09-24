# 自定义 Provider 的本机工具

`createWorkspaceTools()`（`core/providers/workspace-tools.mjs`）返回可直接作为 `registerOpenAICompatible(runtime, name, {...config, tools})` 的六个工具：

| 工具 | readOnly | 用途 |
| --- | --- | --- |
| read_file | true | 读取 UTF-8 文件指定行段，返回完整文件 SHA-256 |
| list_directory | true | 列当前工作区目录，不跟随符号链接 |
| search_files | true | 隔离 worker 内运行正则，支持 i/m/s/u、行列位置与结果上限 |
| edit_file | false | 唯一 oldText 精确匹配与 expectedHash 校验，保留文件模式 |
| write_file | false | 新建或原子更新文本；覆盖已有文件必须提供读取时的 expectedHash |
| run_command | false | 逐次批准后运行平台 shell，带超时、输出上限、取消 |

运行时审批通过后才调用：

```js
await tool.execute(input, {
  cwd: options.cwd,
  signal: controller.signal,
  approved: true,
  mode: options.mode,
});
```

`cwd`、`approved` 和 `mode` 必须由主进程运行时提供，不能从模型传入的工具参数合并。参数 schema 不包含这些字段，工具还会拒绝未知字段。写文件与命令工具自身再次检查本次 approved=true；read-only 模式下即使误传批准也拒绝。

文件工具只接受工作目录内的相对路径，拒绝路径穿越、绝对路径、Git 内部目录及符号链接；覆盖硬链接文件也会拒绝。读取/写入上限 1 MiB，仅文本；读取返回分段内容和完整文件 hash。新文件用原子 link 发布，避免覆盖并发创建；已有文件通过 hash 再检查并原子 rename，保留文件模式。这是应用级路径检查和乐观并发控制，不是操作系统沙箱。

命令默认 30 秒，最长 120 秒；默认合计采集 256 KiB stdout/stderr，最高 1 MiB。超时、取消或输出超限都会终止进程树，返回 reason/timedOut/aborted/truncated；输出超限时不会让命令继续后台跑。取消前就已 aborted 则不会启动进程。macOS/Linux 使用独立进程组，Windows 使用 taskkill /T /F。

**shell 只设置起始 cwd，不限制命令只能访问该目录。** 每次批准前应展示完整命令；若需要强制限制文件/网络访问，必须另接系统沙箱，不应把此工具宣传为受限 shell。

当前适配器每个工具调用都会审批，不能把一次批准缓存为之后所有命令的批准。现有 adapter 若只给模型返回统一“工具执行失败”，模型无法区分 hash 冲突、缺失路径等；可给这些内置工具返回受控错误信息，但不要直接输出任意上游 HTTP 错误响应或凭据。

测试使用真实临时文件与 shell：创建/读行/修改/过期 hash、权限模式、符号链接逃逸、二进制/超大文件、审批门槛、只读限制、真实 cwd、stdout/stderr、超时、输出超限，以及确认后台子进程已启动后再 Abort 并验证其无法继续写文件。Windows ConPTY/进程树行为仍需 Windows 实机验收。


正则搜索默认 2.5 秒，最高 10 秒；整个表达式的编译和匹配都在独立 Worker，主进程只校验参数长度。Worker 有 64 MiB heap / 4 MiB stack 限制，超时/取消会直接终止；最多 200 条结果、128,000 字符结果预算、20,000 路径扫描预算和约 16 MiB 内容读取预算。忽略 Git、node_modules、dist、release、.rpo 目录与符号链接。超出预算返回 truncated，超时明确报错，不把不完整结果当完整搜索。

edit_file 是字面精确替换，oldText 必须非空且在文件中只出现一次（包括重叠匹配），并匹配当前完整文件 expectedHash；不会把 oldText 当正则。替换保留 BOM、CRLF 和普通权限模式。新增测试确认唯一匹配/缺失/过期 hash、文件可执行位、真实 regex 行列位置、零宽匹配，以及恶意回溯表达式不能阻塞主线程计时器并可取消。
