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

const text = (value, label, max = 4096) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.length > max
  )
    throw new Error(`${label}格式无效`);
  return value;
};
export function validateACPConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("ACP 配置无效");
  const command = text(input.command, "ACP 程序");
  const args = input.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some(
      (v) => typeof v !== "string" || v.includes("\0") || v.length > 8192,
    )
  )
    throw new Error("ACP 参数须为字符串数组");
  const env = input.env ?? {};
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.keys(env).length > 100 ||
    Object.entries(env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        value.length > 32768,
    )
  )
    throw new Error("ACP 环境变量格式无效");
  const result = {
    command,
    args: [...args],
    env: { ...env },
    legacyModelApi: input.legacyModelApi === true,
  };
  for (const key of ["model", "modeId", "readOnlyModeId"])
    if (input[key]) result[key] = text(input[key], key, 500);
  return result;
}
export const ACP_PRESETS = Object.freeze([
  Object.freeze({
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    legacyModelApi: false,
  }),
  // Hermes currently returns models.availableModels in its official adapter source.
  Object.freeze({
    id: "hermes",
    name: "Hermes",
    command: "hermes",
    args: ["acp"],
    legacyModelApi: true,
  }),
]);

/** Local main-process CRUD. Encrypt the complete launch configuration using Electron safeStorage. */
export class ACPConfigStore {
  constructor({ path, encrypt, decrypt, isEncryptionAvailable = () => true }) {
    Object.assign(this, { path, encrypt, decrypt, isEncryptionAvailable });
    this.queue = Promise.resolve();
  }
  async read() {
    let data;
    try {
      data = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("本机 ACP 配置无法读取");
    }
    if (data.version !== 1 || !Array.isArray(data.providers))
      throw new Error("本机 ACP 配置版本不支持");
    return data.providers;
  }
  async decode(record) {
    if (!this.isEncryptionAvailable())
      throw new Error("系统加密不可用，无法读取 ACP 配置");
    try {
      return validateACPConfig(
        JSON.parse(
          await this.decrypt(Buffer.from(record.encryptedConfig, "base64")),
        ),
      );
    } catch {
      throw new Error("无法解密 ACP 配置，请重新保存");
    }
  }
  async public(record) {
    const { env, ...config } = await this.decode(record);
    return {
      id: record.id,
      name: record.name,
      kind: "acp",
      ...config,
      envNames: Object.keys(env),
      hasEnvironment: Object.keys(env).length > 0,
      updatedAt: record.updatedAt,
    };
  }
  async list() {
    return Promise.all(
      (await this.read()).map((record) => this.public(record)),
    );
  }
  mutate(action) {
    const result = this.queue.then(async () => {
      const records = await this.read(),
        result = await action(records);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, providers: records }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return result;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  save(input) {
    return this.mutate(async (records) => {
      if (!this.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法保存 ACP 配置");
      const name = text(input?.name, "名称", 80).trim();
      const old = input.id
        ? records.find((record) => record.id === input.id)
        : undefined;
      if (input.id && !old) throw new Error("ACP Provider 不存在");
      const previous = old ? await this.decode(old) : {};
      const config = validateACPConfig({
        ...previous,
        ...input,
        env: input.removeEnv ? {} : (input.env ?? previous.env),
      });
      const record = {
        id: old?.id || `acp-${randomUUID()}`,
        name,
        updatedAt: new Date().toISOString(),
        encryptedConfig: Buffer.from(
          await this.encrypt(JSON.stringify(config)),
        ).toString("base64"),
      };
      const index = records.findIndex((value) => value.id === record.id);
      if (index < 0) records.push(record);
      else records[index] = record;
      return this.public(record);
    });
  }
  remove(id) {
    return this.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error("ACP Provider 不存在");
      records.splice(index, 1);
      return { ok: true };
    });
  }
  async getRuntimeConfig(id) {
    const record = (await this.read()).find((record) => record.id === id);
    if (!record) throw new Error("ACP Provider 不存在");
    return { id: record.id, name: record.name, ...(await this.decode(record)) };
  }
}
