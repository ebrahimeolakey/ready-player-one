import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  realpath,
  readdir,
  readFile,
  writeFile,
  stat,
  mkdir,
  access,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
const exec = promisify(execFile);
export const localEnv = () => ({
  ...process.env,
  PATH: [
    ...new Set([
      ...(process.env.PATH || "").split(":"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      join(homedir(), ".local/bin"),
      "/Applications/ChatGPT.app/Contents/Resources",
      "/Applications/Codex.app/Contents/Resources",
    ]),
  ].join(":"),
});
export async function git(cwd, args) {
  const r = await exec("git", args, {
    cwd,
    env: localEnv(),
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return r.stdout;
}
export async function inspectProject(path) {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw Error("请选择文件夹");
  let branch = "",
    remote = "";
  try {
    branch = (await git(root, ["branch", "--show-current"])).trim();
    remote = (await git(root, ["config", "--get", "remote.origin.url"]))
      .trim()
      .replace(/(https?:\/\/)[^/@]+@/g, "$1");
  } catch {}
  return { root, branch: branch || "未初始化 Git", remote };
}
export async function safePath(root, path) {
  const base = await realpath(root);
  const full = resolve(base, path || ".");
  const rel = relative(base, full);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).includes(".git")
  )
    throw Error("文件路径超出工作区或属于 Git 内部数据");
  const canonical = await realpath(full);
  const realRel = relative(base, canonical);
  if (
    realRel.startsWith("..") ||
    isAbsolute(realRel) ||
    realRel.split(/[\\/]/).includes(".git")
  )
    throw Error("符号链接指向工作区之外");
  return canonical;
}
export async function files(root, path = "") {
  const dir = await safePath(root, path);
  return (await readdir(dir, { withFileTypes: true }))
    .filter(
      (d) =>
        ![".git", "node_modules", ".DS_Store", "dist", "release"].includes(
          d.name,
        ) && !d.isSymbolicLink(),
    )
    .map((d) => ({
      name: d.name,
      path: path ? `${path}/${d.name}` : d.name,
      directory: d.isDirectory(),
    }))
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 500);
}
export const hash = (content) =>
  createHash("sha256").update(content).digest("hex");
export async function read(root, path) {
  const p = await safePath(root, path);
  if ((await stat(p)).size > 2e6) throw Error("暂不支持打开大于 2 MB 的文件");
  const content = await readFile(p, "utf8");
  if (content.includes("\0")) throw Error("这是二进制文件");
  return { content, hash: hash(content) };
}
export async function save(root, path, content, expectedHash) {
  const p = await safePath(root, path);
  const before = await readFile(p, "utf8");
  if (hash(before) !== expectedHash)
    throw Error("文件已被其他程序修改。请重新打开后合并，避免覆盖。");
  if (content.length > 2e6) throw Error("文件过大");
  await writeFile(p, content, "utf8");
  return { hash: hash(content) };
}
export async function changes(root) {
  try {
    const status = await git(root, ["status", "--porcelain=v1", "-z"]);
    const chunks = status.split("\0");
    const list = [];
    for (let i = 0; i < chunks.length; i++) {
      const row = chunks[i];
      if (!row) continue;
      list.push({ status: row.slice(0, 2), path: row.slice(3) });
      if (/R|C/.test(row.slice(0, 2))) i++;
    }
    let diff;
    try {
      diff = await git(root, ["diff", "HEAD", "--no-ext-diff", "--no-color"]);
    } catch {
      diff = await git(root, ["diff", "--no-ext-diff", "--no-color"]);
    }
    return {
      files: list,
      diff: diff.slice(0, 150000),
      branch: (await git(root, ["branch", "--show-current"])).trim(),
    };
  } catch (e) {
    return {
      files: [],
      diff: "",
      branch: "",
      error: "此目录尚未初始化 Git：" + e.message,
    };
  }
}
export async function worktree(root, sessionId, dataDir) {
  const target = join(dataDir, "worktrees", sessionId);
  try {
    await access(target);
    return target;
  } catch {}
  await mkdir(dirname(target), { recursive: true });
  await git(root, [
    "worktree",
    "add",
    "-b",
    `rpo/${sessionId.slice(0, 8)}`,
    target,
    "HEAD",
  ]);
  return target;
}
export async function providers() {
  return Promise.all(
    ["codex", "claude"].map(async (name) => {
      try {
        const { stdout } = await exec(name, ["--version"], {
          env: localEnv(),
          timeout: 5000,
        });
        return { id: name, available: true, version: stdout.trim() };
      } catch {
        return {
          id: name,
          available: false,
          version: "未检测到，请先安装 CLI",
        };
      }
    }),
  );
}
export function providerCommand(provider, mode) {
  if (provider === "codex")
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      mode,
      "-c",
      'approval_policy="never"',
      "-",
    ];
  if (provider === "claude")
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      mode === "read-only" ? "plan" : "acceptEdits",
      ...(mode === "read-only"
        ? [
            "--tools",
            "Read,Glob,Grep",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
          ]
        : []),
    ];
  throw Error("未知智能体");
}
export function normalizeEvent(provider, e) {
  if (provider === "codex") {
    if (e.type === "item.completed") {
      const it = e.item;
      if (it?.type === "agent_message")
        return { role: "assistant", text: it.text };
      if (it?.type === "command_execution")
        return {
          role: "tool",
          text: `$ ${it.command}\n${it.aggregated_output || ""}`,
        };
      if (it?.type === "file_change")
        return {
          role: "tool",
          text:
            "文件变更\n" +
            (it.changes || []).map((c) => `${c.kind}: ${c.path}`).join("\n"),
        };
    }
    if (e.type === "error" || e.type === "turn.failed")
      return {
        role: "system",
        text: e.message || e.error?.message || "Agent 执行失败",
      };
  } else {
    if (e.type === "assistant") {
      const blocks = e.message?.content || [];
      const t = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => `${b.name}\n${JSON.stringify(b.input, null, 2)}`)
        .join("\n");
      if (t || calls)
        return { role: t ? "assistant" : "tool", text: t || calls };
    }
    if (e.type === "result" && e.is_error)
      return {
        role: "system",
        text: e.result || (e.errors || []).join("\n") || "Agent 执行失败",
      };
  }
  return null;
}
export class AgentRunner {
  constructor() {
    this.running = new Map();
  }
  run({ key, provider, mode, cwd, prompt, onEntry, onEnd }) {
    if (this.running.has(key)) throw Error("通道已经运行");
    const child = spawn(provider, providerCommand(provider, mode), {
      cwd,
      env: localEnv(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(key, child);
    let buffer = "",
      ended = false,
      stopped = false,
      failed = false,
      stderr = "";
    const end = (code, error) => {
      if (ended) return;
      ended = true;
      if (buffer.trim()) line(buffer);
      this.running.delete(key);
      onEnd(
        stopped
          ? "interrupted"
          : error || failed || code !== 0
            ? "error"
            : "done",
        error?.message ||
          (stopped
            ? "执行已停止"
            : code === 0 && !failed
              ? "本次执行完成"
              : stderr.slice(-2000) || `进程结束 · 退出码 ${code}`),
      );
    };
    const line = (raw) => {
      try {
        const e = JSON.parse(raw);
        if (e.type === "turn.failed" || e.type === "error" || e.is_error)
          failed = true;
        const item = normalizeEvent(provider, e);
        if (item) onEntry(item);
      } catch {
        if (raw.trim()) onEntry({ role: "system", text: raw });
      }
    };
    child.stdout.on("data", (d) => {
      buffer += d.toString();
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
      }
      if (buffer.length > 1e6) {
        line(buffer.slice(0, 24000));
        buffer = "";
      }
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    child.on("error", (e) => end(null, e));
    child.on("close", (code) => end(code));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.stop = () => {
      stopped = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timer = setTimeout(() => {
        if (!ended)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
      }, 3000);
      timer.unref();
    };
    return child;
  }
  stop(key) {
    this.running.get(key)?.stop();
  }
  close() {
    for (const child of this.running.values()) child.stop();
  }
}
