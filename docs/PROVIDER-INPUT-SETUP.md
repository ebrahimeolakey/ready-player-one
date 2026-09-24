# Provider 配置、模型与图片输入

## 主进程集成

`core/provider-config.mjs` 提供 `ProviderConfigStore`：

```js
const configs = new ProviderConfigStore({
  path: join(app.getPath("userData"), "providers.private.json"),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
});
```

仅暴露以下 IPC；每次修改都在主进程验证：

- `providers.custom.list` → `configs.list()`
- `providers.custom.save` → `configs.save(args)`
- `providers.custom.remove` → `configs.remove(args.id)`
- `providers.images.pick` → `dialog.showOpenDialog({ properties:['openFile','multiSelections'], filters:[{name:'图片',extensions:['png','jpg','jpeg','webp']}] })`。取消返回 `[]`。读取前用 stat 检查大小，读取后用 Electron nativeImage 解码并限制尺寸，再交 `normalizeImages()` 验证和返回。

不开放“传任意路径读取图片”的 IPC。图片不写入 Hub state，Provider API Key 不写入 Hub、renderer state、日志和明文配置。配置文件以系统 safeStorage 加密的字节保存密钥；列表只返回 `hasKey`。加密不可用时拒绝保存密钥。保存留空保留已有密钥，`removeKey:true` 删除已有密钥。修改通过串行队列与临时文件替换提交，避免并发丢失。

`getRuntimeConfig(id)` **仅供主进程调用**，用于取得待发请求的明文凭据。例如注册兼容 API 时将 key 放入本次运行独立 `env`，不要写入进程全局环境变量：

```js
const selected = await configs.getRuntimeConfig(providerId);
registerOpenAICompatible(runtime, selected.id, {
  baseUrl: selected.baseUrl,
  model: selected.model,
  apiKeyEnv: "RPO_SELECTED_PROVIDER_KEY",
});
await runtime.start({
  ...runOptions,
  provider: selected.id,
  env: { RPO_SELECTED_PROVIDER_KEY: selected.apiKey },
});
```

自定义工具必须显式注册 `execute`，没有工具时只进行模型对话。只读运行只接受标记 `readOnly:true` 的自定义工具。

## React 组件

- `ProviderControls`：`value:{model,effort}`、`onChange`、`models?`、`loadModels?`、`disabled?`。原生模型目录用 `listProviderModels`，自定义模型用配置中的 `models`。提供可搜索下拉与模型支持的推理强度选择。
- `ProviderSetup`：`call`、`onChanged?`。提供配置添加、编辑、密钥更新/清除和删除。
- `ImageAttachments`：`images`、`onChange`、`call`、`disabled?`。按钮打开主进程图片选择器，展示预览与移除按钮。
- `DictationControl`：`supported`、`listening`、`busy?`、`onStart`、`onStop`、`error?`。没有可用原生语音组件时不展示空按钮。

图片形状为 `{name,mimeType,data}`，data 是 base64。最多 5 张，单张最多 8 MiB，合计最多 16 MiB；仅 PNG、JPEG、WebP。`runtime.start({images})` 与 `runtime.steer(runId,text,images)` 支持传递。Codex 使用原生 `image` data URL，Claude 使用原生 base64 `image` content block，兼容 API 使用 `image_url`。

## 真实验证

2026-09-24：用合成 32×32 红色 PNG 调用本机已登录 Codex 和 Claude，两者均通过原生图像协议正确回答 RED。没有使用用户私有图片作为测试数据。

配置自动测试注入真实 AES-GCM 加解密，验证磁盘无明文密钥、更新/删除/并发写、加密不可用拒绝保存及列表无密钥字段。这验证存储接口，不替代安装包内 Electron safeStorage 的系统钥匙串验收。
