# 本机 Provider CLI（A8）

本人 Codex / Claude 通道的下方面板提供“打开此 Provider CLI”。点击后在当前通道的真实目录启动原生交互程序，次序沿用现有本机目录映射：lane 工作树 → session 工作树 → workspace 项目。窗口显示实际启动命令、目录、本机账号快照及账号配置来源；展开命令可查看实际文件路径、配置目录、可能影响认证的环境变量名称（不显示值）。账号快照可能滞后，以 CLI 实际登录状态为准。

此入口是本机独立交互会话。不会注入共享任务历史、prompt、已有 Provider session ID、共享 Hub token 或协调 MCP 桥，也不会把终端文本传成 Hub Agent 转录。CLI 使用本机已有的登录/config 和交互审批；现有 ACP server 启动命令与自定义 API endpoint 不提供假冒 CLI 入口。

## 启动与权限

`terminal.provider.open({workspaceId,sessionId,laneId,cols,rows})` 只接受当前协作上下文中自己的原生 Provider 通道，要求 Editor/Owner。可执行文件沿用账号管理和 native runtime 的 `local.localEnv()` PATH（含应用安装目录）；不接受 renderer 自行传入 command、args、cwd 或环境变量。

- macOS/Linux：找到可执行 Codex/Claude 文件后，用 `node-pty.spawn(command, args, {cwd,env})` 参数数组直接启动。命令中没有 shell 拼接，也没有默认提示词或 resume 参数。
- Windows：优先当前 PATH 目录中的原生 `.exe/.com`。若为常见 npm `.cmd/.bat` 入口，读取其相邻官方包名 `@openai/codex` / `@anthropic-ai/claude-code` 的 package.json bin，限制真实 JS 文件位于该包目录内，以找到的原生 `node.exe` 加 `[入口路径]` 参数启动。不执行 shim 文本，不进行 shell 引号转义推断；包名/路径不匹配或无 Node 时提示安装原生 CLI。当前覆盖全局 npm 安装布局；其他 shim 布局明确拒绝。

界面上显示的引号仅便于识别参数，不用于执行。相同 Electron window owner + Hub/member/workspace/session/lane 的重复/并发点击复用同一 PTY；已退出的 CLI 显示退出记录，必须关闭后再次明确点击才会新开。启动期间目录/身份切换会取消并清理启动，运行后的输入/读取/resize 重新核对身份与原目录；不能把旧终端悄悄重定向到新目录。

同目录的 native Agent、Git 修改/同步或调试与活跃 CLI 相互排斥。终端隐藏再显示时不发送任何历史输入；切换会话卸载面板会关闭该 PTY，重新选择会话不会自动恢复 CLI。切换协作连接也会关闭原 CLI。关闭按钮和应用退出清理 PTY；应用不会借此冒充共享原生 session 迁移。

## 按键

xterm 原样发送 onData 字节，Shift+Tab 为 `ESC [ Z`。现有全局快捷键通过 `.xterm` 焦点排除，不拦截 PTY 中的快捷键。原生 CLI 如何解释按键由 CLI 决定。外层应用快捷键与代码编辑器维持现有动作表，详见键位设置。

## 协议依据与验证边界

2026-09-24 已只读运行本机 Codex / Claude `--help`：两者均明确无子命令时进入交互 CLI，`exec` / `--print` 才是非交互模式。官方参考：[Codex CLI reference](https://developers.openai.com/codex/cli/reference/)（当日重定向官方 Developer commands）、[Claude CLI reference](https://code.claude.com/docs/en/cli-reference)。使用 OpenAI Docs 技能核对文档；未登录新账号、未发送真实模型请求。

`tests/provider-cli.test.mjs` 在真实 macOS node-pty 内启动合成 Node CLI，验证 TTY、中文/空格/引号/命令替换字符的 cwd/argv 原样到达、Shift+Tab 字节、权限与目录围栏、重复点击不重发、退出码、父子进程关闭与启动竞态。`tests/terminal.test.mjs` 验证真实 shell 的 resize/Ctrl-C/owner 清理。

Windows npm/native 解析有跨平台文件 fixture；本轮没有 Windows 机器，因此不能称 Windows ConPTY 实机验收。合成 CLI 测试不是 Codex/Claude 登录后的真实付费交互测试。
