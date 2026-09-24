import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function validateProviderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入完整 API 地址");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("API 地址不能包含密码、查询参数或片段");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("API 地址需要 HTTPS；本机服务可使用 HTTP");
  return url.toString().replace(/\/$/, "");
}
const publicConfig = (config) => ({
  id: config.id,
  name: config.name,
  baseUrl: config.baseUrl,
  model: config.model,
  models: config.models,
  efforts: config.efforts || [],
  updatedAt: config.updatedAt,
  hasKey: Boolean(config.encryptedKey),
});

/** Main-process only. Inject Electron safeStorage.encryptString/decryptString.
 * Do not expose getRuntimeConfig through renderer IPC or shared Hub state.
 */
export class ProviderConfigStore {
  constructor({ path, encrypt, decrypt, isEncryptionAvailable = () => true }) {
    this.path = path;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.isEncryptionAvailable = isEncryptionAvailable;
    this.queue = Promise.resolve();
  }
  async read() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("本机 Provider 配置损坏");
    }
    if (data.version !== 1 || !Array.isArray(data.providers))
      throw new Error("本机 Provider 配置版本不支持");
    return data.providers;
  }
  async list() {
    return (await this.read()).map(publicConfig);
  }
  mutate(action) {
    const result = this.queue.then(async () => {
      const configs = await this.read();
      const result = await action(configs);
      await this.write(configs);
      return result;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async write(configs) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temp,
        JSON.stringify({ version: 1, providers: configs }, null, 2),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  save(input) {
    return this.mutate(async (configs) => {
      if (!input || typeof input !== "object")
        throw new Error("无效的 Provider 配置");
      const old = input.id
        ? configs.find((config) => config.id === input.id)
        : undefined;
      if (input.id && !old) throw new Error("Provider 不存在");
      const name = String(input.name || "").trim();
      if (!name || name.length > 80) throw new Error("名称需要 1–80 个字符");
      const baseUrl = validateProviderUrl(input.baseUrl);
      const model = String(input.model || "").trim();
      if (!model || model.length > 200) throw new Error("请输入模型 ID");
      if (input.models !== undefined && !Array.isArray(input.models))
        throw new Error("模型列表格式不正确");
      const models = [model, ...(input.models || [])]
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (models.length > 100 || models.some((value) => value.length > 200))
        throw new Error("模型列表过长");
      const efforts = input.efforts ?? old?.efforts ?? [];
      if (
        !Array.isArray(efforts) ||
        efforts.length > 8 ||
        efforts.some(
          (v) =>
            ![
              "none",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultra",
            ].includes(v),
        )
      )
        throw Error("推理强度列表无效");
      let encryptedKey = old?.encryptedKey || null;
      if (input.removeKey) encryptedKey = null;
      if (input.apiKey) {
        if (typeof input.apiKey !== "string" || input.apiKey.length > 8192)
          throw new Error("API Key 格式不正确");
        if (!this.isEncryptionAvailable())
          throw new Error("系统加密不可用，无法保存 API Key");
        encryptedKey = Buffer.from(await this.encrypt(input.apiKey)).toString(
          "base64",
        );
      }
      const config = {
        id: old?.id || `custom-${randomUUID()}`,
        name,
        baseUrl,
        model,
        models: [...new Set(models)],
        efforts: [...new Set(efforts)],
        encryptedKey,
        updatedAt: new Date().toISOString(),
      };
      const index = configs.findIndex((value) => value.id === config.id);
      if (index < 0) configs.push(config);
      else configs[index] = config;
      return publicConfig(config);
    });
  }
  remove(id) {
    return this.mutate((configs) => {
      const index = configs.findIndex((value) => value.id === id);
      if (index < 0) throw new Error("Provider 不存在");
      configs.splice(index, 1);
      return { ok: true };
    });
  }
  async getRuntimeConfig(id) {
    const config = (await this.read()).find((value) => value.id === id);
    if (!config) throw new Error("Provider 不存在");
    let apiKey = "";
    if (config.encryptedKey) {
      if (!this.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法读取 API Key");
      try {
        apiKey = await this.decrypt(Buffer.from(config.encryptedKey, "base64"));
      } catch {
        throw new Error("无法解密 API Key，请重新保存");
      }
    }
    return { ...publicConfig(config), apiKey };
  }
}
