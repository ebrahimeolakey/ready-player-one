import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  resolve,
  relative,
  dirname,
  join,
  isAbsolute,
  basename,
} from "node:path";
const HIDDEN = "[凭据已隐藏]";
export function redactText(value) {
  return String(value)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      HIDDEN,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\b/g,
      HIDDEN,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, HIDDEN)
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1" + HIDDEN)
    .replace(
      /([?&](?:token|access_token|refresh_token|api_key|key)=)[^&#\s]+/gi,
      "$1" + HIDDEN,
    )
    .replace(
      /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|authorization|token|secret|secret_access_key)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      '$1"' + HIDDEN + '"',
    );
}
export function redactRecord(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|authorization|token|secret|secret_access_key)$/i.test(
          k,
        )
          ? HIDDEN
          : redactRecord(v),
      ]),
    );
  return value;
}
// Never emit a prefix that could be part of a credential. Finish at a logical transcript-entry boundary.
export class StreamingRedactor {
  constructor({ maxChars = 256 * 1024 } = {}) {
    this.maxChars = maxChars;
    this.buffer = "";
    this.overflow = false;
  }
  push(chunk) {
    if (this.overflow) return "";
    this.buffer += String(chunk);
    if (this.buffer.length > this.maxChars) {
      this.buffer = "";
      this.overflow = true;
    }
    return "";
  }
  finish() {
    const result = this.overflow
      ? "[转录内容超过脱敏缓冲上限，已隐藏]"
      : redactText(this.buffer);
    this.buffer = "";
    this.overflow = false;
    return result;
  }
}
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw Error("数据密钥必须为 32 字节");
}
function crypt(key, value, aad) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}
function decrypt(key, text, aad) {
  const e = JSON.parse(text);
  if (
    e.v !== 1 ||
    typeof e.nonce !== "string" ||
    typeof e.tag !== "string" ||
    typeof e.ciphertext !== "string"
  )
    throw Error("加密数据格式无效");
  const nonce = Buffer.from(e.nonce, "base64"),
    tag = Buffer.from(e.tag, "base64");
  if (nonce.length !== 12 || tag.length !== 16) throw Error("加密数据参数无效");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(e.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
function same(a, b) {
  const x = Buffer.from(JSON.stringify(a)),
    y = Buffer.from(JSON.stringify(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function syncDir(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (e) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(e.code)) throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function missing(path) {
  const e = Error(`数据不存在：${path}`);
  e.code = "ENOENT";
  return e;
}
export function retainedTranscriptEntries(entries, cutoff) {
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return !Number.isFinite(at) || at >= cutoff;
  });
}
export class SecureStore {
  constructor({
    dir,
    key,
    maxFileBytes = 256 * 1024 * 1024,
    beforeCommit,
  } = {}) {
    assertKey(key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = realpathSync(dir);
    this.key = Buffer.from(key);
    this.maxFileBytes = maxFileBytes;
    this.beforeCommit = beforeCommit;
  }
  path(name, encrypted = true) {
    if (
      typeof name !== "string" ||
      !name ||
      /[:\0]/.test(name) ||
      isAbsolute(name) ||
      name.split(/[\\/]/).some((p) => p === ".." || !p)
    )
      throw Error("存储路径无效");
    const file = resolve(this.dir, name + (encrypted ? ".enc" : ""));
    const rel = relative(this.dir, file);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw Error("存储路径超出数据目录");
    let current = this.dir;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw Error("数据目录中不允许符号链接");
    }
    return file;
  }
  bytes(file) {
    if (statSync(file).size > this.maxFileBytes)
      throw Error("数据文件超过读取上限");
    return readFileSync(file, "utf8");
  }
  encode(name, value, kind) {
    if (kind === "json") return crypt(this.key, value, `rpo:json:${name}`);
    if (!Array.isArray(value)) throw Error("JSONL 内容必须是数组");
    return (
      [
        crypt(this.key, { count: value.length }, `rpo:jsonl:${name}:header`),
        ...value.map((entry, i) =>
          crypt(this.key, entry, `rpo:jsonl:${name}:${i}`),
        ),
      ].join("\n") + "\n"
    );
  }
  decode(name, text, kind) {
    if (kind === "json") return decrypt(this.key, text, `rpo:json:${name}`);
    const lines = text.trimEnd().split("\n"),
      header = decrypt(this.key, lines.shift(), `rpo:jsonl:${name}:header`);
    if (!Number.isSafeInteger(header.count) || header.count !== lines.length)
      throw Error("加密转录记录数量不匹配");
    return lines.map((line, i) =>
      decrypt(this.key, line, `rpo:jsonl:${name}:${i}`),
    );
  }
  write(name, value, kind) {
    return this.#commitFile(name, value, kind, this.path(name));
  }
  #commitFile(name, value, kind, file) {
    const parent = dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const serialized = this.encode(name, value, kind);
    if (Buffer.byteLength(serialized) > this.maxFileBytes)
      throw Error("加密数据超过文件上限");
    const temp = `${file}.${randomUUID()}.pending`;
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!same(this.decode(name, this.bytes(temp), kind), value))
      throw Error("加密写入校验失败，原数据已保留");
    this.beforeCommit?.({ file, temp, kind });
    renameSync(temp, file);
    syncDir(parent);
    return true;
  }
  recoverFile(name, kind = "json") {
    const file = this.path(name),
      parent = dirname(file);
    if (existsSync(file)) {
      this.decode(name, this.bytes(file), kind);
      return { restored: false };
    }
    if (!existsSync(parent)) return { restored: false };
    const candidates = readdirSync(parent)
      .filter(
        (n) => n.startsWith(basename(file) + ".") && n.endsWith(".pending"),
      )
      .map((n) => join(parent, n))
      .filter((p) => lstatSync(p).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const invalid = [];
    for (const candidate of candidates) {
      try {
        this.decode(name, this.bytes(candidate), kind);
      } catch {
        invalid.push(basename(candidate));
        continue;
      }
      renameSync(candidate, file);
      syncDir(parent);
      return { restored: true, invalid };
    }
    if (candidates.length)
      throw Error(
        "发现未完成加密写入但无法校验；文件已保留，请检查密钥或从备份恢复",
      );
    return { restored: false };
  }
  exists(name) {
    return existsSync(this.path(name)) || existsSync(this.path(name, false));
  }
  read(name, kind, { migrate = true, redact = false } = {}) {
    this.recoverFile(name, kind);
    const legacy = this.path(name, false),
      file = this.path(name);
    if (migrate && existsSync(legacy)) this.migrateFile(name, kind, { redact });
    if (!existsSync(file)) throw missing(name);
    return this.decode(name, this.bytes(file), kind);
  }
  readJSON(name, options) {
    return this.read(name, "json", options);
  }
  writeJSON(name, value) {
    return this.write(name, value, "json");
  }
  readJSONL(name, options) {
    return this.read(name, "jsonl", options);
  }
  writeJSONL(name, entries, { redact = true } = {}) {
    return this.write(
      name,
      redact ? entries.map(redactRecord) : entries,
      "jsonl",
    );
  }
  appendJSONL(name, entry, { redact = true } = {}) {
    let entries;
    try {
      entries = this.readJSONL(name);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      entries = [];
    }
    entries.push(redact ? redactRecord(entry) : entry);
    return this.writeJSONL(name, entries, { redact: false });
  }
  migrateFile(name, kind = "json", { redact = false } = {}) {
    const legacy = this.path(name, false),
      encrypted = this.path(name);
    if (!existsSync(legacy)) return false;
    const source = this.bytes(legacy);
    let value =
      kind === "json"
        ? JSON.parse(source)
        : source
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
    if (redact) value = redactRecord(value);
    if (existsSync(encrypted)) {
      if (!same(this.decode(name, this.bytes(encrypted), kind), value))
        throw Error(`明文与加密副本不一致，已保留两份：${name}`);
    } else this.write(name, value, kind);
    if (!same(this.decode(name, this.bytes(encrypted), kind), value))
      throw Error("迁移校验失败，明文已保留");
    // Do not erase a legacy file another writer changed during migration.
    if (this.bytes(legacy) !== source)
      throw Error("迁移期间原文件已变更，已保留两份");
    unlinkSync(legacy);
    syncDir(dirname(legacy));
    return true;
  }
  migrateLegacy({ database = "hub.json", transcriptDir = "transcripts" } = {}) {
    const migrated = [];
    if (this.migrateFile(database, "json")) migrated.push(database);
    const folder = this.path(transcriptDir, false);
    if (existsSync(folder))
      for (const file of readdirSync(folder)) {
        if (
          file.endsWith(".jsonl") &&
          this.migrateFile(`${transcriptDir}/${file}`, "jsonl")
        )
          migrated.push(`${transcriptDir}/${file}`);
      }
    return migrated;
  }
  cleanupTranscripts({
    days,
    now = Date.now(),
    transcriptDir = "transcripts",
    activeNames = [],
  }) {
    if (
      !Number.isFinite(days) ||
      days < 1 ||
      days > 36500 ||
      !Number.isFinite(now)
    )
      throw Error("转录保留周期无效");
    const cutoff = now - days * 86400000,
      folder = this.path(transcriptDir, false),
      skipped = new Set(activeNames),
      result = { files: 0, removedEntries: 0, cutoff };
    if (!existsSync(folder)) return result;
    const names = new Set(
      readdirSync(folder)
        .filter((f) => /\.jsonl(?:\.enc)?$/.test(f))
        .map((f) => `${transcriptDir}/${f.replace(/\.enc$/, "")}`),
    );
    for (const name of names) {
      if (skipped.has(name)) continue;
      const entries = this.readJSONL(name),
        kept = retainedTranscriptEntries(entries, cutoff);
      if (kept.length === entries.length) continue;
      this.writeJSONL(name, kept, { redact: false });
      result.files++;
      result.removedEntries += entries.length - kept.length;
    }
    // Pending encrypted transcript snapshots also obey retention; preserve the recovery file itself.
    for (const file of readdirSync(folder)) {
      const match = file.match(/^(.+\.jsonl)\.enc\..+\.pending$/);
      if (!match) continue;
      const name = `${transcriptDir}/${match[1]}`;
      if (skipped.has(name)) continue;
      const pending = join(folder, file);
      if (!lstatSync(pending).isFile()) throw Error("转录恢复文件类型异常");
      const entries = this.decode(name, this.bytes(pending), "jsonl");
      const kept = retainedTranscriptEntries(entries, cutoff);
      if (kept.length === entries.length) continue;
      this.#commitFile(name, kept, "jsonl", pending);
      result.files++;
      result.removedEntries += entries.length - kept.length;
    }
    return result;
  }
  destroy() {
    this.key.fill(0);
  }
}
