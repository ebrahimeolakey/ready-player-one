# VS Code 设置导入

0.4.7 源码通过 `desktop/services/vscode-import-controller.mjs` 接入真实主进程 IPC；这些修改不属于 0.4.6。纯计划服务 `vscode-import.mjs` 不扫描目录、不读文件、不写配置；controller 只读取原生对话框选中的单个合成或用户文件，apply 后由主进程单次写入加密配置。不会安装扩展、调用 VS Code 或 Provider。

## API 合同

```js
const importer = new VSCodeImportService({
  platform: process.platform, // darwin / win32 / linux
  // 默认 ttlMs:300000；now 可注入以测试过期。
});
const current = {
  editorSettings: config.editorSettings || {},
  keyboard: config.keyboard || {},
};
// 由 main 提供稳定的本机设置存储作用域；不要用账号令牌。
const scope = canonicalDataDir;
const preview = importer.preview({
  settingsText,     // 可选：用户选择的 settings.json 文本
  keybindingsText,  // 可选：用户选择的 keybindings.json 文本
  current, scope,
});
// preview = {planId,expiresAt,changes,unsupported,availableTargets,warnings}
// changes = [{id,kind:'editor'|'keyboard',source,target,value,notes,requires,conflicts}]
// unsupported = [{source:'settings'|'keybindings',index,code,label}]
const {editorPatch,keyboardPatch} = importer.apply({
  planId: preview.planId,
  selectedIds, // 必须明确列出用户选择的 change id；不默认全部导入。
  current: {editorSettings:config.editorSettings||{},keyboard:config.keyboard||{}},
  scope: canonicalDataDir,
});
```

`preview` 不改变当前设置。`apply` 只返回经过现有 `validateEditorSettings` / `validateBindings` 验证的**部分补丁**，不执行写盘。主进程 controller 在无 await 的同步临界区内读取当前设置、调用 apply、合并补丁，再通过现有 saveConfig 一次写入加密配置；写入报错恢复原内存配置，包括恢复原对象引用或删除原本不存在的属性，并要求重新预览。不要对 renderer 回传的 value/target 直接写盘：apply 使用内存计划中冻结的安全候选，忽略外部篡改的展示数据。

scope 或当前有效设置改变时，该计划立即失效。计划默认 5 分钟，最多 8 个，超限淘汰最旧预览；apply 成功后一次性消耗。`discard(planId)` 供取消；退出调用 `dispose()`，清除全部预览。内存计划不跨重启持久化。

`changes.requires` 表示必须一起选的条目（像素行高依赖导入字号）；`conflicts` 提示当前键位或其他候选冲突。同一操作的多个候选可供用户选其一。apply 校验最终整体键位，因此允许用户明确选中两个互换键的候选，但拒绝只选一个而产生重复。未知/重复的 selectedIds 被拒绝。

## 支持的全局编辑设置

| VS Code 字段 | 本程序字段 | 边界 |
| --- | --- | --- |
| editor.fontFamily | fontFamily | 单个有效字体名称；有备用列表时只候选首个，并在 notes 明示；不检查系统是否安装该字体 |
| editor.fontSize | fontSize | 8–32 |
| editor.lineHeight | lineHeight | 倍数 1–3；像素值 ≥8 按预览字号换算，字号候选存在时必须一起选择；0 自动值不猜测 |
| editor.fontLigatures | ligatures | 仅 boolean，不支持 OpenType 特性字符串 |
| editor.tabSize | indentWidth | 整数 1–8 |
| editor.insertSpaces | insertSpaces | boolean |
| editor.wordWrap | wordWrap | 仅 on/off；bounded、wordWrapColumn 不近似导入 |
| editor.renderWhitespace | renderWhitespace | 仅 all/none；selection、boundary 等不近似导入 |
| editor.guides.indentation | indentGuides | boolean |
| editor.minimap.enabled | minimap | boolean；其他 minimap 子配置不导入 |
| editor.formatOnSave | formatOnSave | notes 明示本程序目前仅支持严格 JSON 格式化 |
| files.trimTrailingWhitespace | trimTrailingWhitespace | notes 明示本程序仅对严格 JSON/.txt 清理 |

`[javascript]`、组合语言覆盖等整项跳过，不把局部设置悄悄铺平成全局。终端配置、环境变量、账号、令牌、主题、自定义命令、扩展、语言服务器等均不导入。

## 快捷键支持范围

应用现有七种可配置操作仍只有既有能力，导入不新增命令。本批仅三个有明确等价关系的 VS Code command：

| VS Code command | 本程序操作 |
| --- | --- |
| workbench.action.quickOpen | searchFiles：查找文件 |
| workbench.action.files.save | saveFile：保存文件 |
| workbench.action.terminal.toggleTerminal | toggleTerminal：展开/收起终端 |

搜索会话、新建 Agent、发送任务、停止 Agent 保持原值。VS Code Chat 的新建/提交/取消等语义不同，不为了覆盖七个目标进行猜测映射。

任何 `when` 条件、`args`/其他附加属性、多段 chord、`-command` 移除规则均跳过，并显示固定原因；不解释条件、不执行宏、不转换成无条件全局快捷键。单个组合键转换为现有键编码，沿用本程序系统保留键、Esc 专用及重复组合校验。

`cmd` 在 Mac 映射 Meta，`ctrl` 映射 Control；不会把 Ctrl 悄悄换成 Command。非 Mac 上 cmd 不受支持。字母、数字、受支持的功能/方向键与 `[KeyA]` / `[Digit1]` 显式物理键可解析；本程序本就按 `KeyboardEvent.code` 匹配，notes 提醒非美式布局核对。系统级快捷键语义不被移植。

## 安全边界

- 现有生产依赖 TypeScript 的 scanner/JSON AST 用于读取 JSONC；显式仅接受 JSON 节点类型，支持注释、BOM、尾逗号。没有 eval、Function、脚本执行，也不采用普通对象赋值的 config 转换器。
- 单文件 UTF-8 256 KiB、扫描 token/转换节点 12000、嵌套 32 层上限，扫描阶段先拦过深内容再建 AST。main 文件读取仍须自己在读入之前检查字节数，避免先读任意巨文件再调用服务。
- 对象使用 null prototype；任意层级 `__proto__`、`constructor`、`prototype` 与重复属性名整份拒绝；单引号、标识符键、函数、undefined、数组空槽、非 JSON 数字等拒绝。
- 未知项只回传来源、零起始条目索引和固定原因；不回传未知键名、值、命令、when/args 或原文片段。计划只保留已经验证的支持字段及候选值，不保留输入文本/未知内容。字体字段也拒绝能由现有凭据脱敏器识别的凭据模式。
- 错误消息是固定安全文本，不携带解析器的原文错误片段。即使文件有账号设置，也不会回传或写入这些字段。
- VS Code 扩展运行时不兼容。预览明确说明不会安装、执行或迁移扩展，不声称完整 VS Code 配置兼容。

主要错误码：`IMPORT_INVALID_JSONC`、`IMPORT_TOO_LARGE`、`IMPORT_COMPLEXITY`、`IMPORT_SETTINGS_SHAPE`、`IMPORT_BINDINGS_SHAPE`、`IMPORT_CURRENT_INVALID`、`IMPORT_PLAN_EXPIRED`、`IMPORT_PLAN_STALE`、`IMPORT_SCOPE_CHANGED`、`IMPORT_SELECTION`、`IMPORT_CONFLICT`。冲突/选择错误可在仍有效的同一预览中调整后重试。

## 验证与官方依据

`node --test tests/vscode-import.test.mjs`：14 项合成 fixture，覆盖注释/尾逗号/BOM、语言覆盖、凭据不回显、原型/重复键/可执行语法拒绝、大小/深度/节点限额、像素行高依赖、三个确切命令、条件/chord/removal 拒绝、修饰键及平台规则、冲突互换、预览篡改、范围变化、过期/数量淘汰与一次性消费。没有读取真实用户的 VS Code 设置。

依据仅用于解释语义，运行时不联网：

- [VS Code 设置与语言覆盖](https://code.visualstudio.com/docs/configure/settings)
- [VS Code 快捷键条件、chord 与移除规则](https://code.visualstudio.com/docs/configure/keybindings)
- [VS Code 默认命令表](https://code.visualstudio.com/docs/reference/default-keybindings)
- [官方 editorOptions.ts 的 lineHeight/minimap 定义](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorOptions.ts)


## 真实 IPC 与文件读取边界

主进程现有可信主窗口/mainFrame 校验与更新健康门禁覆盖以下入口：

| IPC | renderer 参数 | 返回 |
| --- | --- | --- |
| `settings.vscode.preview` | `{kind:'settings'|'keybindings'}` | 原生单文件对话框；取消为 `null`，成功为上述 preview + kind |
| `settings.vscode.apply` | `{planId,selectedIds}` | `{imported:number}`；成功后主进程 emit，界面从 bootstrap/state 获取最新设置 |
| `settings.vscode.discard` | `{planId}` | `true`；删除该计划 |

renderer 不能传 path、配置文本、current 或 scope，未知参数会被拒绝。原生选择只允许一个文件，过滤器为 JSON/JSONC；controller 检查普通文件，拒绝直接符号链接/目录/设备文件。先检查 256 KiB 大小，再打开有界读取的 FD（多读至上限 +1 字节检测增长），验证 UTF-8。读取前后比较文件设备号、inode、长度、mtime/ctime，以及原路径真实目标；切换或写入中的文件不生成预览。

选择对话框单次进行；pending dialog 返回后若服务已关闭或设置作用域变更，不继续生成计划。退出 dispose 清理内存计划。原始路径不放进 renderer 预览，读取错误不回显路径或解析原文。

controller 对合并后的编辑器与快捷键再次校验，不覆盖未选择的设置、不修改其他配置。存储使用既有 SecureStore 临时文件校验及原子 rename；测试的提交前/rename 失败保留原加密文件。这里不把操作系统在 rename 已完成后的介质故障声称为可无条件撤销的事务。

额外错误码：`IMPORT_ARGUMENTS`、`IMPORT_KIND`、`IMPORT_BUSY`、`IMPORT_CLOSED`、`IMPORT_FILE_SELECTION`、`IMPORT_FILE_TYPE`、`IMPORT_FILE_CHANGED`、`IMPORT_FILE_ENCODING`、`IMPORT_FILE_READ`、`IMPORT_SAVE_FAILED`。

## 主进程与桌面验收（2026-09-26）

- `node --test tests/vscode-import.test.mjs tests/vscode-import-controller.test.mjs`：22/22，通过真实合成文件 I/O、实际 SecureStore 加密写入，以及写入故障/原引用回滚、直接路径注入拒绝、取消/多选、文件类型/大小/UTF-8、并发选文件、关闭/作用域变化及 stale plan 围栏。日志 `/tmp/rpo-vscode-import-ipc-tests.log`。
- `npm run build`：通过。
- `node scripts/vscode-import-desktop-smoke.mjs --run`：Mac 实际 Electron main/preload/React 启动，2 个真实进程阶段通过。通过编辑器/快捷键页面的真实“从 VS Code 导入”入口、checkbox 和 apply 按钮导入；验证预览默认不勾选、无选择不能应用、bootstrap 状态与 client.json.enc，第二进程验证恢复。额外真实 IPC 覆盖取消、discard、任意路径拒绝、修改设置后的 stale preview、以目录占据加密目标文件造成真实 rename 失败后的内存回滚。
- 文件选择结果由 Electron `dialog.showOpenDialog` stub 返回测试创建的文件，同时核对真实 BrowserWindow、单文件 properties 与过滤器。**没有声称手动操作了原生文件选择窗口**；实际用户选择交互需后续人工验收。
- 未读取真实 VS Code 配置、模型调用 0、未修改已安装应用。退出后删除隔离应用数据，仅保留 PNG/日志/证据。截图：`/var/folders/x9/znxmzx5x7b56cwz_dzsb54ch0000gn/T/rpo-import-desktop-51sjlv/settings-preview.png` 及同目录 `keybindings-preview.png`；综合日志 `/tmp/rpo-vscode-import-desktop-smoke.log`。


0.4.7 Apple Silicon 安装包另经原生文件选择器实际选择合成 JSONC，默认未勾选两项；明确勾选并导入后，界面显示“已导入 2 项”、字号 16 和关闭缩略图。该检查没有替换文件对话框实现，和上述自动化 stub 测试是不同证据。见 [包内审计](evidence/mac-package-0.4.7.json)。
