# 本机数据保护

Hub 与 standalone 已接入此模块，Hub 必须注入 SecureStore，不提供明文回退。Electron 在系统密钥可用后注入实例。它不改变公网通道的 TLS / Cloudflare 边界，也不提供网络端到端加密。

## 存储与密钥

`core/secure-store.mjs` 提供同步 `SecureStore`。数据库及每条转录记录使用 AES-256-GCM，独立 96 位随机 nonce、128 位认证 tag；AAD 绑定逻辑路径、JSONL 行序号，认证头包含记录数量。磁盘文件为 `hub.json.enc`、`transcripts/<lane>.jsonl.enc`。数据库整体加密，包括 hostToken、邀请凭据；不会把这些字段脱敏成不可用值。

Desktop 接入（在 `app.whenReady()` 后）：

```js
import { safeStorage } from 'electron';
import { loadDesktopDataKey } from './services/data-key.mjs';
import { SecureStore } from '../core/secure-store.mjs';
const key = loadDesktopDataKey({
  safeStorage,
  keyFile: join(appDataDir, 'data-key.wrapped.json'),
  dataDir: hubDir,
});
const store = new SecureStore({ dir: hubDir, key });
key.fill(0); // Store 已复制密钥；避免在其他对象保留副本。
store.migrateLegacy();
const hub = new Hub(hubDir, { store }); // 构造器也会校验并迁移遗留文件。
```

数据密钥由系统 `safeStorage` 封装，磁盘仅保存封装字节。保护不可用或 Linux `basic_text` 后端时停止，不回退为裸密钥。已有包装文件损坏时不覆盖；存在加密数据但包装文件丢失时不新建无效密钥。包装文件中断写入可从经过校验的 `.pending` 恢复。Windows 使用 DPAPI，macOS 使用系统 Keychain；被当前已登录用户控制的恶意进程不在此保护边界内。

独立服务可复用 `desktop/services/data-key.mjs` 的 `loadExternalDataKey`；该文件不 import Electron，因此可直接在 Node 服务使用：

```js
const key = loadExternalDataKey({ dataDir: hubDir });
const store = new SecureStore({ dir: hubDir, key });
key.fill(0);
store.migrateLegacy();
```

`RPO_DATA_KEY_FILE` 指向**数据目录之外**的密钥文件，内容为随机 32 字节密钥的 hex 或 base64 编码。模块不自行生成裸密钥，不把密钥和数据一起落盘。POSIX 要求当前用户拥有、文件权限不高于 0600、所在目录不能被组或其他用户写入；Windows 要验证 ACL，仅接受当前用户、SYSTEM 和 Administrators。拒绝符号链接和读取时文件替换。密钥由部署者在受控凭据目录创建并单独备份。没有此配置时 standalone 应明确失败，不偷偷创建明文数据。

## 精确 Store API

所有逻辑文件名相对 `dir`，使用正斜线；不要传绝对路径。服务采用单进程单写者，不提供跨进程数据库锁。

| API | 行为 |
| --- | --- |
| `new SecureStore({dir,key,maxFileBytes?,beforeCommit?})` | 默认文件上限 256 MiB；beforeCommit 仅用于故障注入测试 |
| `readJSON('hub.json')` | 解密对象；不存在抛 `ENOENT`；默认自动迁移该明文文件 |
| `writeJSON('hub.json', db)` | 原样加密完整 DB，不破坏鉴权值 |
| `exists(name)` | 检查明文或加密主文件是否存在 |
| `readJSONL(name)` | 解密并验证完整记录数组；默认迁移明文 |
| `appendJSONL(name, entry)` | 仅脱敏新条目并追加，旧历史保持原样，整个文件原子替换 |
| `writeJSONL(name, entries, {redact:true})` | 脱敏并替换日志；空数组仍保留认证文件 |
| `migrateLegacy()` | 迁移 hub.json 及 transcripts 中全部 .jsonl，返回迁移路径 |
| `recoverFile(name, 'json'/'jsonl')` | 无主文件时从最新可校验 pending 恢复；主文件存在时保留已提交状态和额外 pending |
| `cleanupTranscripts({days,now?,activeNames?})` | 清理超过保留期的转录，含可校验 pending 快照，返回文件/记录数和 cutoff |
| `destroy()` | 清零 Store 内存中的密钥；必须在所有保存工作结束后调用 |

`migrateLegacy` 和读取触发的迁移默认无损保留原始内容，只改变存储加密格式。`appendJSONL` 默认仅脱敏新条目，保留既有历史；`writeJSONL` 默认对传入的全部条目脱敏。确需原样加密新内容时可显式 `{redact:false}`，由产品策略决定。读取不会隐式改写历史，旧历史的显示和导出应显式调用 `redactRecord`。

Hub 接入时替换：构造器读取主 DB、`save()`、初始化日志、`entry()` 追加、流式 entry 更新追加及 `session.export` 的日志读取。移除这些路径的原生明文 fs 读写，保留旧路径名供 Store 映射 `.enc`。如某条日志缺失，可用当前 lane.entries 初始化；先调用 `recoverFile(name, 'jsonl')` 避免忽略中断文件。

## 迁移与异常恢复

1. 严格解析原明文，错误时原封不动保留。
2. 写新的加密 `.pending` 文件、fsync、读取并解密校验内容。
3. 原子 rename 为 `.enc`，同步父目录。
4. 再读加密文件核对，并确认源文件迁移期间未变化，最后删除明文。

中断时最多保留明文和已加密副本；下次迁移内容一致即可继续删除明文，不一致时停止并保留两份。密钥错误、认证失败、日志不完整均停止，不用空数据覆盖。普通更新在提交前失败时保留旧主文件以及新的加密 pending；主文件存在时不会默默采用未提交版本。`pending` 文件应随加密数据一起备份，恢复时保留全部候选文件。

这是文件系统级原子性与异常恢复，不是 SSD 安全擦除。迁移删除明文后，系统快照、备份和已释放磁盘块仍可能包含旧内容。应按既有备份策略处理，不能声称历史明文已不可恢复。

JSONL 当前每次追加会重新加密并原子替换整个文件，优先保证完整性。长会话会产生更多 I/O；默认单文件上限 256 MiB，达到上限会报错并保留原数据。后续可增加分段日志，不能改成失败后静默丢弃记录。

## 脱敏与流式输出

`redactText` / `redactRecord` 识别常见 GitHub / OpenAI token、JWT、Bearer、API key / password / secret 赋值、邀请 URL token，以及 PEM 私钥。不涵盖所有格式、编码、截图或人为拆散的秘密，也可能误遮普通配置值。

`StreamingRedactor.push(chunk)` **不返回未完成片段**；在一条逻辑消息完成后 `finish()` 对累计内容处理，因此可以识别跨 chunk 的凭据和 PEM。默认缓冲 256 KiB，超限整条隐藏，不放行未经扫描尾部。代价是开启该严格模式时，该条文字需要等逻辑记录完成才显示。

只对每个 chunk 分别做正则不能保证跨 chunk 识别。Hub 若要保持实时展示，可对完整累计文本重做显示用脱敏，但短前缀可能在识别前已显示；不得宣传为零泄露。**存储脱敏也不会自动保护已经广播的内容**：Hub 必须在 entry 广播及导出边界应用同一策略。旧 hub.json 里的 lane.entries 缓存也需在首次广播前清洗；不要对整个 db 使用 redactRecord，否则会破坏 hostToken 等真实认证字段。

## 保留期

`cleanupTranscripts` 依据 entry.at，保留时间未知的记录，跳过 activeNames 列出的正在运行日志。它只处理 transcripts 下 JSONL 主文件和加密 pending，不碰计划、记忆、评论、邀请或主数据库。

应在启动、每日定时及用户修改保留期后执行。主进程同时用 `retainedTranscriptEntries(lane.entries, cutoff)` 清理 DB 中的转录缓存后保存；否则缓存仍保留旧文字，甚至会重新填回日志。不要清空 session.plan、memories 或 comments。默认保留周期由产品配置决定，本模块不擅自启用清理。

测试覆盖真实 GCM 数据往返/篡改、路径绑定、JSONL 重排与截断、中断文件恢复、错误密钥/迁移冲突、明文保留、转录专属 TTL、跨 chunk 脱敏、系统密钥包装接口以及外部密钥权限。safeStorage 测试使用注入的封装器；真实系统 Keychain / DPAPI 的 UI 路径需主任务接入后验收。

## 已接入的 Hub 策略

- 默认永久保留（`retentionDays:null`）。本机房主可调用 `storage.retention {days:1..36500|null}` 设置保留天数或永久保留；standalone 可设置 `RPO_TRANSCRIPT_RETENTION_DAYS=30` 或 `forever`。
- 启动、修改设置和每天执行清理；运行中、待审批和待恢复的执行不清理。转录 DB 缓存同步清理；计划、评论和记忆保留。
- `state.storage` 返回加密状态、保留期和最近清理时间。定期清理失败发出 `storage-error` 事件。
- Hub 在私有内存累计整条流式文字，每次广播和保存前重新脱敏；已识别 token 的短前缀也遮盖。原始缓冲不写数据库，结束后清除。重启后无法重建的续片隐藏，等待完整消息覆盖。该实时策略不能保证识别任意格式的秘密，也不能宣传零泄露。
- 旧加密日志无损保留，显示缓存与导出脱敏。遗留 `hub.json.tmp` 也迁移为经过校验的加密副本，不自动覆盖主数据库。
- 自定义 Provider 通道仅保存 `custom-UUID` 和 `providerLabel` 短名称，不接受 API key、请求头或连接配置。真实凭据保留在本机 Provider 配置服务。

Hub 加密只证明 Hub 数据库和转录的存储边界；其他应用记录由各自组件接入安全存储。备份仍必须包含正确密钥包装文件及加密 pending 文件。
