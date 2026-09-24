import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const UPDATE_REPOSITORY = "ebrahimeolakey/ready-player-one";
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

export function compareVersions(a, b) {
  const parse = (value) => {
    const m =
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        value,
      );
    return m
      ? { core: m.slice(1, 4).map(Number), pre: m[4]?.split(".") || [] }
      : null;
  };
  const left = parse(a),
    right = parse(b);
  if (!left || !right) throw new Error("Invalid release version");
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i])
      return Math.sign(left.core[i] - right.core[i]);
  if (!left.pre.length || !right.pre.length)
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function pickRelease(
  releases,
  { version, platform, arch, includePrerelease = version.includes("-") },
) {
  const os = { darwin: "mac", win32: "windows", linux: "linux" }[platform];
  if (!os || !["x64", "arm64"].includes(arch)) return null;
  const candidates = [];
  for (const release of releases) {
    if (release.draft || (!includePrerelease && release.prerelease)) continue;
    try {
      if (compareVersions(release.tag_name, version) <= 0) continue;
    } catch {
      continue;
    }
    const next = release.tag_name.replace(/^v/, "");
    const name = `Ready-Player-One-${next}-${os}-${arch}${platform === "win32" ? "-setup.exe" : platform === "linux" ? ".AppImage" : ".zip"}`;
    const asset = (release.assets || []).find(
      (item) => item.name === name && item.state === "uploaded",
    );
    if (asset) candidates.push({ release, asset, version: next });
  }
  return (
    candidates.sort((a, b) => compareVersions(b.version, a.version))[0] || null
  );
}
export function checksumFor(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function machOHasArchitecture(header, arch) {
  if (header.length < 8) return false;
  const expected =
    arch === "arm64" ? 0x0100000c : arch === "x64" ? 0x01000007 : 0;
  if (!expected) return false;
  if (header.readUInt32LE(0) === 0xfeedfacf)
    return header.readUInt32LE(4) === expected;
  const magic = header.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = header.readUInt32BE(4),
    stride = magic === 0xcafebabf ? 32 : 20;
  if (count > 32 || header.length < 8 + count * stride) return false;
  for (let index = 0; index < count; index++)
    if (header.readUInt32BE(8 + index * stride) === expected) return true;
  return false;
}
async function smallText(response, maxBytes = 2 * 1024 * 1024) {
  let bytes = 0;
  const parts = [];
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > maxBytes) throw new Error("更新元数据过大");
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}
function officialAssetUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`) ||
    url.username ||
    url.password
  )
    throw new Error("安装包来源不符合官方仓库");
  return url.toString();
}

/** Explicit check -> verified download -> user-initiated install. No auto-install. */
export class UpdateService {
  constructor({
    version,
    platform = process.platform,
    arch = process.arch,
    cacheDir,
    execPath = process.execPath,
    isPackaged = false,
    appImagePath = process.env.APPIMAGE,
    fetch: fetchImpl = fetch,
    onState = () => {},
    quit = () => {},
    spawnInstaller = spawn,
  }) {
    this.options = {
      version,
      platform,
      arch,
      cacheDir,
      execPath,
      isPackaged,
      appImagePath,
    };
    this.fetch = fetchImpl;
    this.onState = onState;
    this.quit = quit;
    this.spawn = spawnInstaller;
    this.state = { status: "idle", currentVersion: version };
    this.selection = null;
    this.prepared = null;
    this.operation = null;
  }
  emit(patch) {
    this.state = { ...this.state, ...patch };
    this.onState({ ...this.state });
    return { ...this.state };
  }
  getState() {
    return { ...this.state };
  }
  async github(url, signal) {
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Ready-Player-One-Updater",
      },
      signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? "GitHub 请求频率受限，请稍后重试"
          : `GitHub HTTP ${response.status}`,
      );
    return response;
  }
  async asset(url, signal) {
    let current = officialAssetUrl(url);
    for (let i = 0; i < 6; i++) {
      const target = new URL(current);
      if (
        target.protocol !== "https:" ||
        !DOWNLOAD_HOSTS.has(target.hostname) ||
        target.username ||
        target.password
      )
        throw new Error("安装包跳转地址不受信任");
      const response = await this.fetch(current, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "Ready-Player-One-Updater" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("下载地址缺失");
        current = new URL(location, current).toString();
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
      return response;
    }
    throw new Error("下载跳转过多");
  }
  async check({ includePrerelease = this.options.version.includes("-") } = {}) {
    if (this.operation || this.installing) throw new Error("更新操作正在进行");
    this.operation = new AbortController();
    const timer = setTimeout(
      () => this.operation?.abort(new Error("检查更新超时")),
      20000,
    );
    this.emit({ status: "checking", error: null });
    try {
      const response = await this.github(
        `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=50`,
        this.operation.signal,
      );
      const releases = JSON.parse(await smallText(response));
      if (!Array.isArray(releases)) throw new Error("更新元数据格式错误");
      const selected = pickRelease(releases, {
        ...this.options,
        includePrerelease,
      });
      this.selection = selected;
      this.prepared = null;
      if (!selected)
        return this.emit({ status: "current", version: null, progress: 0 });
      officialAssetUrl(selected.asset.browser_download_url);
      if (
        !Number.isSafeInteger(selected.asset.size) ||
        selected.asset.size <= 0 ||
        selected.asset.size > MAX_DOWNLOAD
      )
        throw new Error("安装包大小不受支持");
      let hash = /^sha256:([a-f0-9]{64})$/i
        .exec(selected.asset.digest || "")?.[1]
        ?.toLowerCase();
      if (!hash) {
        for (const checksum of selected.release.assets.filter((asset) =>
          /^SHA256SUMS.*\.txt$/.test(asset.name),
        )) {
          const result = await this.asset(
            checksum.browser_download_url,
            this.operation.signal,
          );
          hash = checksumFor(
            await smallText(result, 1024 * 1024),
            selected.asset.name,
          );
          if (hash) break;
        }
      }
      if (!hash) throw new Error("此发布缺少 SHA256，不能自动安装");
      selected.sha256 = hash;
      return this.emit({
        status: "available",
        version: selected.version,
        assetName: selected.asset.name,
        size: selected.asset.size,
        releaseUrl: selected.release.html_url,
        progress: 0,
        error: null,
      });
    } catch (error) {
      this.emit({ status: "error", error: error.message });
      throw error;
    } finally {
      clearTimeout(timer);
      this.operation = null;
    }
  }
  async download() {
    if (this.operation || this.installing) throw new Error("更新操作正在进行");
    if (!this.selection?.sha256) throw new Error("请先检查更新");
    this.operation = new AbortController();
    const timer = setTimeout(
      () => this.operation?.abort(new Error("下载更新超时")),
      10 * 60 * 1000,
    );
    let directory;
    this.emit({ status: "downloading", progress: 0, error: null });
    try {
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.cacheDir, "rpo-update-"));
      const path = join(directory, this.selection.asset.name);
      const response = await this.asset(
        this.selection.asset.browser_download_url,
        this.operation.signal,
      );
      const file = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let received = 0,
        lastProgress = 0;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > MAX_DOWNLOAD || received > this.selection.asset.size)
            throw new Error("安装包大小与发布不一致");
          hash.update(chunk);
          await file.writeFile(chunk);
          if (Date.now() - lastProgress > 100) {
            lastProgress = Date.now();
            this.emit({
              progress: Math.min(
                99,
                Math.floor((received / this.selection.asset.size) * 100),
              ),
            });
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (
        received !== this.selection.asset.size ||
        hash.digest("hex") !== this.selection.sha256
      )
        throw new Error("SHA256 校验失败，安装包已丢弃");
      this.prepared = { path, directory, selection: this.selection };
      return this.emit({ status: "ready", progress: 100 });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      this.prepared = null;
      this.emit({ status: "error", error: error.message });
      throw error;
    } finally {
      clearTimeout(timer);
      this.operation = null;
    }
  }
  cancel() {
    this.operation?.abort(new Error("更新已取消"));
  }
  async install() {
    if (this.operation || this.installing) throw new Error("更新操作正在进行");
    if (!this.options.isPackaged) throw new Error("开发模式不能替换应用");
    if (!this.prepared) throw new Error("请先下载更新");
    this.installing = true;
    const prepared = this.prepared;
    this.emit({ status: "installing", error: null });
    try {
      if ((await sha256File(prepared.path)) !== prepared.selection.sha256)
        throw new Error("安装包已改变，请重新下载");
      if (this.options.platform === "win32") {
        await this.launch(prepared.path, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        this.quit();
        return { installing: true, method: "nsis" };
      }
      const plan =
        this.options.platform === "darwin"
          ? await this.prepareMac(prepared)
          : await this.prepareLinux(prepared);
      const script = join(prepared.directory, "apply-update.sh");
      await writeFile(script, INSTALL_SCRIPT, { mode: 0o700, flag: "wx" });
      await this.launch(
        "/bin/sh",
        [
          script,
          String(process.pid),
          plan.target,
          plan.next,
          plan.backup,
          this.options.platform,
        ],
        { detached: true, stdio: ["ignore", "ignore", "ignore"] },
      );
      this.quit();
      return { installing: true, method: plan.method };
    } catch (error) {
      this.installing = false;
      this.emit({ status: "error", error: error.message });
      throw error;
    }
  }
  launch(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, options);
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
  async prepareMac(prepared) {
    const target = dirname(dirname(dirname(this.options.execPath)));
    if (!target.endsWith(".app") || target.includes("/AppTranslocation/"))
      throw new Error("请先把应用移到“应用程序”再安装更新");
    await access(dirname(target), constants.W_OK);
    const entries = await exec("/usr/bin/unzip", ["-Z", "-1", prepared.path], {
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const item of entries.stdout.split("\n").filter(Boolean))
      if (
        item.startsWith("/") ||
        item.includes("\\") ||
        item.split("/").includes("..")
      )
        throw new Error("安装包包含不安全路径");
    const unpack = join(prepared.directory, "unpacked");
    await mkdir(unpack);
    await exec("/usr/bin/ditto", ["-x", "-k", prepared.path, unpack]);
    const apps = (await readdir(unpack, { withFileTypes: true })).filter(
      (item) => item.isDirectory() && item.name.endsWith(".app"),
    );
    if (apps.length !== 1) throw new Error("安装包中的应用不唯一");
    const source = join(unpack, apps[0].name);
    const plist = join(source, "Contents", "Info.plist");
    const id = (
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleIdentifier",
        plist,
      ])
    ).stdout.trim();
    if (id !== "com.readyplayerone.desktop")
      throw new Error("安装包不是头号玩家");
    const version = (
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        plist,
      ])
    ).stdout.trim();
    if (version !== prepared.selection.version)
      throw new Error("安装包版本与发布不一致");
    const binary = (
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleExecutable",
        plist,
      ])
    ).stdout.trim();
    if (binary.includes("/") || binary.includes("\\"))
      throw new Error("安装包启动路径无效");
    const executable = await open(
      join(source, "Contents", "MacOS", binary),
      "r",
    );
    const header = Buffer.alloc(4096);
    try {
      await executable.read(header, 0, header.length, 0);
    } finally {
      await executable.close();
    }
    if (!machOHasArchitecture(header, this.options.arch))
      throw new Error("Mac 安装包架构不正确");
    const suffix = randomUUID();
    const next = join(dirname(target), `.rpo-next-${suffix}.app`);
    const backup = join(dirname(target), `.rpo-backup-${suffix}.app`);
    await exec("/usr/bin/ditto", [source, next]);
    return { target, next, backup, method: "mac-replace" };
  }
  async prepareLinux(prepared) {
    if (!this.options.appImagePath)
      throw new Error("当前为解压版；请使用 AppImage 安装后启用原位更新");
    const target = resolve(this.options.appImagePath);
    await access(target, constants.W_OK);
    await access(dirname(target), constants.W_OK);
    const file = await open(prepared.path, "r");
    const header = Buffer.alloc(20);
    try {
      await file.read(header, 0, 20, 0);
    } finally {
      await file.close();
    }
    const expected = this.options.arch === "arm64" ? 183 : 62;
    if (
      !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
      header.readUInt16LE(18) !== expected
    )
      throw new Error("AppImage 架构不正确");
    const next = join(dirname(target), `.rpo-next-${randomUUID()}.AppImage`);
    const backup = `${target}.previous-${randomUUID()}`;
    await copyFile(prepared.path, next, constants.COPYFILE_EXCL);
    await chmod(next, 0o755);
    return { target, next, backup, method: "appimage-replace" };
  }
}

// All dynamic values arrive as positional args, never interpolated into shell source.
export const INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"; target="$2"; next="$3"; backup="$4"; platform="$5"
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 120 ]; then exit 20; fi
  sleep 1
done
if [ -e "$backup" ]; then exit 21; fi
mv "$target" "$backup"
if ! mv "$next" "$target"; then mv "$backup" "$target"; exit 22; fi
if [ "$platform" = "darwin" ]; then
  if ! /usr/bin/open "$target"; then mv "$target" "$next"; mv "$backup" "$target"; /usr/bin/open "$target"; exit 23; fi
else
  "$target" >/dev/null 2>&1 &
fi
`;
