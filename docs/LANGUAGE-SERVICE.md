# JS / TS 项目语言服务

本模块使用随应用分发的 TypeScript LanguageService，提供 JavaScript、JSX、TypeScript、TSX、MJS/CJS/MTS/CTS 的类型诊断、补全和定义跳转。运行在独立 worker，不在 Electron 主线程进行类型分析。它不是完整 IDE：不支持任意 VS Code 扩展、其他语言服务器、DAP 调试、重构/重命名或自动导入编辑。

## 主进程接入

```js
import { LanguageService } from "./services/language.mjs";
const language = new LanguageService();
// root 必须由已授权的 workspaceId/sessionId 在主进程解析；不要接受 renderer 的任意绝对路径。
await language.diagnostics(root, { path: "src/main.ts", text, documentId });
await language.completions(root, {
  path: "src/main.ts",
  text,
  documentId,
  offset,
});
await language.definition(root, {
  path: "src/main.ts",
  text,
  documentId,
  offset,
});
await language.update(root, { path: "src/main.ts", text, documentId });
await language.closeDocument(root, { path: "src/main.ts", documentId });
// app before-quit
await language.dispose();
```

IPC 对应 `language.diagnostics/completions/definition/update/close`。最后一项调用 closeDocument。参数还带 workspaceId/sessionId，主进程移除并解析根目录。所有 offset/from/to 均为 UTF-16 索引，与 CodeMirror/TypeScript 一致；定义返回 `{path,offset,line,column}`，line/column 从 1 开始。诊断 `{from,to,severity,message,code}`；补全 `{label,kind,sortText,insertText,from?,to?}`。这些操作只读取文件/更新内存，不保存编辑、不执行项目代码、不进入 Hub。

```tsx
import { languageExtensions } from "./language-extension";
// 使用 useMemo，在 context/path 变化时重新创建，不在每次渲染重建。
const extensions = languageExtensions({
  call,
  context: { workspaceId, sessionId },
  path,
  onOpenDefinition: ({ path, offset }) => openFileAt(path, offset),
  onError: showError,
});
```

工厂提供 CodeMirror lint、TypeScript 补全、F12 / Mod-B / Cmd(Ctrl)+点击定义跳转。非 JS/TS 文件返回空扩展。须把 extensions 加到现有编辑器；不同时挂另一份 autocompletion override。定义有多个结果时当前回调打开第一项。点击打开目标后，集成方需等文件内容加载，再定位 offset。销毁编辑器会释放其 documentId 的内存快照。同一文件多个编辑器各自保留快照，以最新提交的快照分析。当前编辑器打字会重新 lint；其他编辑器变化后可由集成方调用 CodeMirror forceLinting 刷新当前诊断。

## 项目与边界

- 读取根目录 tsconfig.json（否则 jsconfig.json）；支持项目内 extends、include/exclude、baseUrl/paths。无配置时默认 strict/checkJs、ES2022、Node 模块解析，忽略常见产物目录。
- 不执行 tsconfig 插件；不自动安装依赖。只使用项目内依赖类型和随包 TypeScript 标准库。外部目录 extends、外部 node_modules、跨根目录 project references 不加载。工作区是 monorepo 时，应选包含共同源码的项目根目录。
- 文件内容只能来自选定根目录，另允许受信任的随包 TypeScript lib 提供标准库。外部 import 会产生缺少模块诊断，不读入外部源码。`.git`、`.rpo`、相对越界、绝对输入路径和通向外部的符号链接受限制。不会递归符号链接目录。
- 单文件读取/编辑快照最多 2 MB，快照总量 16 MB、128 份，项目最多 2000 个源文件/5000 个扫描目录、8 个活动项目。诊断最多 200 项、补全最多 250 项。大型项目可能因限制拒绝分析。
- 每次分析刷新配置和磁盘版本。worker 超过 20 秒会中止，后续请求重启；重启或项目淘汰会丢弃内存快照，打开编辑器在下次请求重新提交文本。
- 默认源码扫描使用随包 TypeScript 的 matchFiles 辅助函数；升级 TypeScript 时需要运行相关测试。

## 已验证

`node --test tests/language-service.test.mjs` 使用真实 worker 和真实 TypeScript，临时目录多文件项目验证：tsconfig 路径别名、导入符号跨文件定义、类型错误、成员补全、多个编辑器未保存快照、关闭快照恢复磁盘、JavaScript checkJs、外部文件/符号链接/配置继承边界。没有用模拟补全代替语言服务。CodeMirror 工厂通过 TypeScript 编译；应用内跳转和键盘交互需由集成后的桌面验收覆盖。
