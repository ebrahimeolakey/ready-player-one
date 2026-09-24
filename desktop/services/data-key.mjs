import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  lstatSync,
  realpathSync,
  readdirSync,
  fstatSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
function syncKeyDirectory(file) {
  let fd;
  try {
    fd = openSync(dirname(file), constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code))
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function parseKey(value) {
  const text = String(value).trim();
  const key = /^[a-f\d]{64}$/i.test(text)
    ? Buffer.from(text, "hex")
    : /^[A-Za-z0-9+/]{43}=$/.test(text)
      ? Buffer.from(text, "base64")
      : null;
  if (!key || key.length !== 32)
    throw Error("数据密钥文件必须包含 32 字节密钥的 hex 或 base64 编码");
  return key;
}
export function loadDesktopDataKey({ safeStorage, keyFile, dataDir }) {
  if (
    !safeStorage.isEncryptionAvailable() ||
    safeStorage.getSelectedStorageBackend?.() === "basic_text"
  )
    throw Error("系统凭据保护不可用，已停止打开加密数据");
  keyFile = resolve(keyFile);
  if (existsSync(keyFile)) {
    if (lstatSync(keyFile).isSymbolicLink())
      throw Error("密钥包装文件不能是符号链接");
    const envelope = JSON.parse(readFileSync(keyFile, "utf8"));
    if (
      envelope.v !== 1 ||
      envelope.type !== "electron-safeStorage" ||
      typeof envelope.wrapped !== "string"
    )
      throw Error("密钥包装文件损坏");
    return parseKey(
      safeStorage.decryptString(Buffer.from(envelope.wrapped, "base64")),
    );
  }
  const pending = keyFile + ".pending";
  if (existsSync(pending)) {
    const recovered = loadDesktopDataKey({ safeStorage, keyFile: pending });
    renameSync(pending, keyFile);
    syncKeyDirectory(keyFile);
    return recovered;
  }
  if (
    dataDir &&
    existsSync(dataDir) &&
    readdirSync(dataDir, { recursive: true }).some((name) =>
      /\.enc(?:\..*\.pending)?$/.test(String(name)),
    )
  )
    throw Error("加密数据存在但密钥包装文件丢失；请恢复原密钥，不能创建新密钥");
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(32),
    wrapped = safeStorage.encryptString(key.toString("base64"));
  const verified = parseKey(safeStorage.decryptString(wrapped));
  if (!timingSafeEqual(key, verified)) throw Error("系统密钥包装校验失败");
  verified.fill(0);
  const tmp = keyFile + ".pending";
  // A leftover wrapper may be the only key for existing data: recover it, never replace it.
  if (existsSync(tmp)) {
    const recovered = loadDesktopDataKey({ safeStorage, keyFile: tmp });
    renameSync(tmp, keyFile);
    syncKeyDirectory(keyFile);
    key.fill(0);
    return recovered;
  }
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        v: 1,
        type: "electron-safeStorage",
        wrapped: wrapped.toString("base64"),
      }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const recovered = loadDesktopDataKey({ safeStorage, keyFile: tmp });
  if (!timingSafeEqual(key, recovered)) throw Error("密钥文件写入校验失败");
  recovered.fill(0);
  renameSync(tmp, keyFile);
  syncKeyDirectory(keyFile);
  return key;
}
function windowsPermissions(file) {
  const script =
    "$p=$env:RPO_KEY_PERMISSION_PATH; $acl=Get-Acl -LiteralPath $p; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($me,'S-1-5-18','S-1-5-32-544'); foreach($r in $acl.Access){ if($r.AccessControlType -eq 'Allow'){ $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($allowed -notcontains $sid){ throw 'Key file grants access to another principal' } } }; 'OK'";
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, RPO_KEY_PERMISSION_PATH: file },
      windowsHide: true,
      timeout: 10000,
      encoding: "utf8",
    },
  );
  if (output.trim() !== "OK") throw Error("无法验证 Windows 密钥文件 ACL");
}
export function loadExternalDataKey({
  keyFile = process.env.RPO_DATA_KEY_FILE,
  dataDir,
  platform = process.platform,
  checkWindowsAcl = windowsPermissions,
} = {}) {
  if (!keyFile)
    throw Error(
      "独立服务必须设置 RPO_DATA_KEY_FILE，指向数据目录之外的私有密钥文件",
    );
  const candidate = resolve(keyFile),
    info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink())
    throw Error("密钥必须是普通文件，不能是符号链接");
  const file = realpathSync(candidate),
    root = existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir),
    rel = relative(root, file);
  if (
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    rel !== ".." &&
    !isAbsolute(rel)
  )
    throw Error("独立服务密钥不能放在数据目录内");
  if (platform === "win32") checkWindowsAcl(file);
  else {
    if (
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw Error(
        "密钥文件必须由当前用户拥有，且仅当前用户可读写（chmod 600）",
      );
    if ((lstatSync(dirname(file)).mode & 0o022) !== 0)
      throw Error("密钥所在目录不能允许组或其他用户写入");
  }
  if (info.size > 256) throw Error("密钥文件格式无效");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > 256 ||
      (platform !== "win32" &&
        ((opened.mode & 0o077) !== 0 || opened.uid !== info.uid))
    )
      throw Error("读取期间密钥文件发生变化");
    return parseKey(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
