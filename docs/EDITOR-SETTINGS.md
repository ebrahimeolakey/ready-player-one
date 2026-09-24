# 编辑器设置

## 原版观察

2026-09-24，任务中直接查看 Amoeba **0.1.38** Settings → Editor。仅记录公开产品控件与值，不记录任何用户项目、文件或账号内容：

| 分组 | 原版控件与观察值 |
|---|---|
| FONT | font family：IBM Plex Mono；size：12.5；line height：1.6；ligatures：开启 |
| FORMATTING | indent width：2；insert spaces：开启；format on save：开启；trim trailing whitespace：开启 |
| DISPLAY | word wrap：off；render whitespace：关闭；indent guides：开启；minimap：开启 |

这是对当时界面的直接观察，不推断原版对所有语言的 formatter/插件支持。

## 本地实现与差异

`core/editor-settings.mjs` 导出完整默认值、严格白名单验证、读取容错及保存前文本变换。`settings.editor.get` 返回完整设置；`settings.editor.save {settings}` 验证并保存到本机加密配置 `editorSettings`，state.local.editorSettings 传给 EditorSettingsContext。

**formatOnSave 和 trimTrailingWhitespace 默认关闭**，避免新功能第一次保存就改动已有文件；其他默认与以上观察值一致。字体使用本机已安装字体，IBM Plex Mono 未安装时使用等宽后备字体，不声称捆绑了字体。

实际 CodeMirror 封装 `src/CodeEditor.tsx` 应用字号、行高、字体/连字、indentUnit、tabSize、换行、空白字符显示、可见行缩进参考线。设置变化会重新配置当前编辑器；不修改现有缩进内容，Tab/自动缩进之后遵循新配置。

缩略图无新增依赖：canvas 从当前文档绘制单色代码轮廓、显示当前可见区，支持点击/拖动及键盘定位。最多按画布像素高度抽样，每行最多 200 字符；不是语法着色或原版逐像素复刻。关闭设置/卸载编辑器时移除 DOM、observer、事件与绘制任务。

设置页使用持久配置值签名更新草稿；仅有新对象但值相同的 Hub 广播不会覆盖用户尚未保存的输入。真正保存新配置/恢复默认后才同步。

## 保存的安全边界

- 格式化只支持**严格 JSON**。先验证，再对原始词法 token 排版，不用 JSON.stringify 重写数值：保留大整数、指数写法、负零、重复键、字符串转义。保留 BOM、统一原有 CRLF 文件的行尾及原有最后换行。
- 超过 2×1024×1024 个 UTF-16 代码单元、超过 100 层嵌套、非法 JSON，均不格式化并返回明确 notice。JS/TS、JSONC、Markdown 等尚无可靠 formatter，本轮保留原文并提示，不能宣称已格式化。
- 行尾空白清理仅适用于有效严格 JSON 与 `.txt`。代码模板字符串、Markdown 硬换行、其他语言均不擅改。
- `prepareEditorSave({path,content,settings})` 返回 `{content,notices,formatted,trimmed}`。主进程在既有 hash/root 冲突保护之前转换；保存返回真实落盘 content、原有 hash 及 notices。
- 保存回包更新真实 baseline/hash；若用户在等待保存时继续输入，不覆盖新文本，继续显示未保存状态。没有绕过外部文件改动或目录切换保护。

## 验证

`tests/editor-settings.test.mjs` 覆盖白名单/原型键及 CSS 注入拒绝、默认逐字保留、JSON 原始数值/字符串/BOM/CRLF、非法或不支持语言保留与提示、行尾空白范围，并使用真实 CodeMirror EditorState、indentMore 验证缩进/tab facet、换行扩展。

`tests/editor-settings-view.test.mjs` 使用独立临时 Electron 页面、合成文件与模拟存储接口检查实际 DOM/CodeMirror：未保存设置不受同值广播重置、动态字号/连字/换行/空白/参考线、真实 canvas 绘制与定位、关闭缩略图、保存等待期间新输入及新 hash。没有调用真实模型或读写用户项目。无 DISPLAY 的 Linux 环境明确跳过这项需要图形环境的测试，其余纯逻辑测试仍执行。
