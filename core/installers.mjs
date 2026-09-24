import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  copyFile,
  readdir,
  rm,
  rename,
  lstat,
  cp,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localEnv } from "./local.mjs";
import { binaryName } from "./platform.mjs";
const exec = promisify(execFile);
export function assetSpec(
  id,
  arch = process.arch,
  platform = process.platform,
) {
  if (platform === "win32") {
    if (arch !== "x64")
      throw Error("Windows 安装助手当前支持 x64；ARM 设备请使用 x64 应用");
    if (id === "codex")
      return {
        repo: "openai/codex",
        match: (n) => n === "codex-package-x86_64-pc-windows-msvc.tar.gz",
        binary: (n) => n === "codex.exe",
        bundle: true,
      };
    if (id === "github")
      return {
        repo: "cli/cli",
        match: (n) => /^gh_[\d.]+_windows_amd64\.zip$/.test(n),
        binary: (n) => n === "gh.exe",
      };
    if (id === "cloudflared")
      return {
        repo: "cloudflare/cloudflared",
        match: (n) => n === "cloudflared-windows-amd64.exe",
        direct: true,
      };
    throw Error("未知安装组件");
  }
  if (platform !== "darwin") throw Error("当前安装助手支持 macOS 和 Windows");
  const arm = arch === "arm64";
  if (!arm && arch !== "x64") throw Error("仅支持 Apple Silicon 或 Intel Mac");
  if (id === "codex")
    return {
      repo: "openai/codex",
      match: (n) =>
        n === `codex-${arm ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`,
      binary: (n) => n === `codex-${arm ? "aarch64" : "x86_64"}-apple-darwin`,
    };
  if (id === "github")
    return {
      repo: "cli/cli",
      match: (n) =>
        new RegExp(`^gh_[\\d.]+_macOS_${arm ? "arm64" : "amd64"}\\.zip$`).test(
          n,
        ),
      binary: (n) => n === "gh",
    };
  if (id === "cloudflared")
    return {
      repo: "cloudflare/cloudflared",
      match: (n) => n === `cloudflared-darwin-${arm ? "arm64" : "amd64"}.tgz`,
      binary: (n) => n === "cloudflared",
    };
  throw Error("未知安装组件");
}
export function verifyDigest(data, digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest || ""))
    throw Error("官方发布缺少 SHA-256 校验信息，请稍后重试");
  if ("sha256:" + createHash("sha256").update(data).digest("hex") !== digest)
    throw Error("下载文件校验失败，已停止安装");
}
export async function getURL(url, { limit = 350e6, timeout = 180000 } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "ReadyPlayerOne/0.2" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error(`官方下载失败：HTTP ${response.status}`);
  const size = Number(response.headers.get("content-length"));
  if (size > limit) throw Error("下载文件超过大小限制");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw Error("下载文件超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function installTool(
  id,
  dir,
  onProgress = () => {},
  arch = process.arch,
) {
  if (!["darwin", "win32"].includes(process.platform))
    throw Error("当前安装助手支持 macOS 和 Windows");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(dir, ".install-"));
  try {
    if (id === "claude") {
      onProgress("正在下载 Anthropic 官方安装程序……");
      const windows = process.platform === "win32";
      const url = windows
        ? "https://claude.ai/install.ps1"
        : "https://claude.ai/install.sh";
      const script = await getURL(url, { limit: 1e6 });
      if (
        windows
          ? !script.toString().trimStart().startsWith("param(")
          : !script.toString().startsWith("#!")
      )
        throw Error("官方安装程序响应格式不正确");
      const path = join(temp, windows ? "install.ps1" : "install.sh");
      await writeFile(path, script, { mode: 0o600 });
      onProgress("正在运行官方 Claude Code 安装程序……");
      await exec(
        windows ? "powershell.exe" : "/bin/bash",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path,
            ]
          : [path],
        {
          env: localEnv(),
          windowsHide: true,
          timeout: 240000,
          maxBuffer: 2e6,
        },
      );
      return { command: "claude", source: url };
    }
    const spec = assetSpec(id, arch);
    onProgress("正在查询官方发布版本……");
    const release = JSON.parse(
      (
        await getURL(
          `https://api.github.com/repos/${spec.repo}/releases/latest`,
          { limit: 5e6, timeout: 30000 },
        )
      ).toString(),
    );
    const asset = release.assets?.find((a) => spec.match(a.name));
    if (!asset) throw Error("没有找到适用于此电脑的官方安装包");
    if (
      !asset.browser_download_url.startsWith(
        `https://github.com/${spec.repo}/releases/download/`,
      )
    )
      throw Error("发布下载地址不匹配");
    onProgress(`正在下载 ${release.tag_name}……`);
    const bytes = await getURL(asset.browser_download_url);
    verifyDigest(bytes, asset.digest);
    const archive = join(temp, asset.name);
    await writeFile(archive, bytes);
    const name = binaryName(id === "github" ? "gh" : id);
    const target = join(dir, name);
    if (spec.direct) {
      await writeFile(target + ".new", bytes);
      await rename(target + ".new", target);
      onProgress(`${release.tag_name} 安装完成`);
      return {
        command: target,
        version: release.tag_name,
        source: asset.browser_download_url,
      };
    }
    const tar = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";
    const { stdout } = await exec(tar, ["-tf", archive], { windowsHide: true });
    if (
      stdout
        .split("\n")
        .some(
          (p) => /^([/\\]|[a-z]:)/i.test(p) || p.split(/[/\\]/).includes(".."),
        )
    )
      throw Error("安装包路径异常");
    const extracted = join(temp, "files");
    await mkdir(extracted);
    await exec(tar, ["-xf", archive, "-C", extracted], {
      windowsHide: true,
      timeout: 30000,
    });
    const all = await readdir(extracted, { recursive: true });
    let source;
    for (const p of all) {
      if (
        spec.binary(basename(p)) &&
        (await lstat(join(extracted, p))).isFile()
      ) {
        source = join(extracted, p);
        break;
      }
    }
    if (!source) throw Error("安装包中没有找到可执行文件");
    if (spec.bundle) {
      // Codex Windows sandbox helpers must stay beside the main executable.
      for (const p of await readdir(extracted, { recursive: true })) {
        const from = join(extracted, p);
        if ((await lstat(from)).isSymbolicLink())
          throw Error("安装包包含非预期符号链接");
      }
      const packageDir = join(dir, "codex-package");
      await cp(extracted, packageDir, { recursive: true, force: true });
      onProgress(`${release.tag_name} 安装完成`);
      return {
        command: join(packageDir, "bin", "codex.exe"),
        version: release.tag_name,
        source: asset.browser_download_url,
      };
    }
    await copyFile(source, target + ".new");
    await chmod(target + ".new", 0o755);
    await rename(target + ".new", target);
    onProgress(`${release.tag_name} 安装完成`);
    return {
      command: target,
      version: release.tag_name,
      source: asset.browser_download_url,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
