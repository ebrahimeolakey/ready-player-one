import { constants } from "node:fs";
import {
  realpath,
  lstat,
  stat,
  open,
  readdir,
  mkdir,
  readFile,
  rename,
  link,
  unlink,
  chmod,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { platformEnv, shellCommand, stopProcess } from "../platform.mjs";
const MAX_FILE = 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const abortError = () =>
  Object.assign(Error("工具执行已取消"), { name: "AbortError" });
function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}
function inputObject(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw Error("工具参数无效");
}
function writable(context) {
  checkAbort(context?.signal);
  if (context?.approved !== true) throw Error("此工具需要本次运行时审批");
  if (context.mode === "read-only")
    throw Error("只读模式不允许修改文件或执行命令");
}
function within(root, target) {
  const path = relative(root, target);
  return (
    !path.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    path !== ".." &&
    !isAbsolute(path)
  );
}
async function rootPath(context) {
  checkAbort(context?.signal);
  if (typeof context?.cwd !== "string" || !context.cwd)
    throw Error("未绑定本机工作目录");
  const root = await realpath(context.cwd);
  if (!(await stat(root)).isDirectory()) throw Error("工作目录无效");
  return root;
}
async function checkedPath(
  context,
  path = ".",
  { createParents = false } = {},
) {
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !path ||
    /[\0:]/.test(path) ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path
      .split(/[\\/]/)
      .some(
        (p) => p === ".." || p.replace(/[. ]+$/, "").toLowerCase() === ".git",
      )
  )
    throw Error("文件路径必须位于当前工作目录内，不能访问 Git 内部目录");
  const root = await rootPath(context),
    target = resolve(root, path.replace(/\\/g, "/"));
  if (!within(root, target)) throw Error("文件路径超出工作目录");
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    checkAbort(context.signal);
    current = join(current, parts[i]);
    let info;
    try {
      info = await lstat(current);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (i === parts.length - 1) return { root, target, exists: false };
      if (!createParents) throw Error("目录不存在");
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink())
      throw Error("工具不访问符号链接，避免逃逸工作目录");
    if (i < parts.length - 1 && !info.isDirectory())
      throw Error("父路径不是目录");
    if (!within(root, await realpath(current)))
      throw Error("文件路径超出工作目录");
  }
  return { root, target, exists: true };
}
async function readBounded(context, path) {
  const checked = await checkedPath(context, path);
  if (!checked.exists) throw Error("文件不存在");
  const file = await open(
    checked.target,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Error("这不是普通文件");
    if (info.size > MAX_FILE)
      throw Error("文件超过 1 MiB，请读取更小的文件或经审批使用命令");
    checkAbort(context.signal);
    const bytes = await file.readFile();
    if (bytes.length > MAX_FILE) throw Error("读取期间文件增长超过限制");
    if (bytes.includes(0)) throw Error("不支持读取二进制文件");
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { ...checked, bytes, content, info };
  } finally {
    await file.close();
  }
}
async function readWorkspaceFile(input, context) {
  inputObject(input, ["path", "startLine", "maxLines"]);
  const startLine = input.startLine ?? 1,
    maxLines = input.maxLines ?? 400;
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > 2000
  )
    throw Error("行范围无效");
  const file = await readBounded(context, input.path),
    lines = file.content.split("\n");
  const selected = lines
    .slice(startLine - 1, startLine - 1 + maxLines)
    .join("\n");
  const content = selected.slice(0, 128000);
  return {
    path: input.path,
    content,
    sha256: hash(file.bytes),
    startLine,
    totalLines: lines.length,
    truncated:
      content.length !== selected.length ||
      startLine - 1 + maxLines < lines.length,
  };
}
async function listWorkspaceDirectory(input, context) {
  inputObject(input, ["path"]);
  const path = input.path ?? ".",
    checked = await checkedPath(context, path);
  if (!checked.exists || !(await stat(checked.target)).isDirectory())
    throw Error("目录不存在");
  checkAbort(context.signal);
  const entries = await readdir(checked.target, { withFileTypes: true });
  const visible = entries
    .filter((e) => e.name !== ".git")
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    );
  return {
    path,
    entries: visible.slice(0, 1000).map((e) => ({
      name: e.name,
      type: e.isSymbolicLink()
        ? "symlink"
        : e.isDirectory()
          ? "directory"
          : e.isFile()
            ? "file"
            : "other",
    })),
    truncated: visible.length > 1000,
  };
}
async function writeWorkspaceFile(input, context) {
  inputObject(input, ["path", "content", "expectedHash"]);
  writable(context);
  if (
    typeof input.content !== "string" ||
    input.content.includes("\0") ||
    Buffer.byteLength(input.content) > MAX_FILE
  )
    throw Error("写入内容必须为不超过 1 MiB 的文本");
  const checked = await checkedPath(context, input.path, {
    createParents: true,
  });
  let before;
  if (checked.exists) {
    before = await readBounded(context, input.path);
    if (before.info.nlink > 1) throw Error("不覆盖硬链接文件");
    if (
      typeof input.expectedHash !== "string" ||
      input.expectedHash !== hash(before.bytes)
    )
      throw Error("文件已存在或已变更；先读取并传入匹配的 expectedHash");
  } else if (input.expectedHash != null)
    throw Error("文件不存在，不能使用旧 expectedHash 覆盖");
  const temporary = join(
    dirname(checked.target),
    `.rpo-write-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    checkAbort(context.signal);
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (before) await chmod(temporary, before.info.mode & 0o777);
    checkAbort(context.signal);
    const rechecked = await checkedPath(context, input.path);
    if (rechecked.target !== checked.target)
      throw Error("写入期间目录发生变化");
    if (before) {
      const current = await readBounded(context, input.path);
      if (hash(current.bytes) !== input.expectedHash || current.info.nlink > 1)
        throw Error("写入期间文件已被其他程序修改");
      await rename(temporary, checked.target);
    } else {
      // Hard-link publication is atomic and fails if another writer created the destination.
      await link(temporary, checked.target);
      await unlink(temporary);
    }
    return {
      path: input.path,
      bytes: Buffer.byteLength(input.content),
      sha256: hash(Buffer.from(input.content)),
      created: !before,
    };
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export async function runWorkspaceCommand(input, context) {
  inputObject(input, ["command", "timeoutMs", "maxOutputBytes"]);
  writable(context);
  if (
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 20000 ||
    input.command.includes("\0")
  )
    throw Error("命令无效");
  const timeoutMs = input.timeoutMs ?? 30000,
    maxOutputBytes = input.maxOutputBytes ?? 256 * 1024;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 120000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 1024 * 1024
  )
    throw Error("命令限制无效");
  const cwd = await rootPath(context);
  checkAbort(context.signal);
  const [program, args] = shellCommand(input.command);
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: platformEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [],
      stderr = [];
    let size = 0,
      reason = null,
      ended = false;
    const stop = (cause) => {
      if (ended || reason) return;
      reason = cause;
      stopProcess(child, "SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    timer.unref?.();
    const abort = () => stop("aborted");
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    const collect = (target) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - size);
      if (remaining) target.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (size > maxOutputBytes) stop("output-limit");
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const cleanup = () => {
      ended = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      resolveResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut: reason === "timeout",
        aborted: reason === "aborted",
        truncated: reason === "output-limit",
        reason,
      });
    });
  });
}
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
/** Executable tool definitions consumed by registerOpenAICompatible(config.tools).
 * context.cwd/approved/mode are host-owned runtime fields, never model arguments.
 */
export function createWorkspaceTools() {
  return [
    {
      name: "search_files",
      description:
        "Search workspace text files with a regex in an isolated worker. Returns bounded path/line/column matches; supports i/m/s/u flags, timeout and cancellation.",
      readOnly: true,
      parameters: object(
        {
          pattern: { type: "string" },
          path: { type: "string" },
          flags: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10000 },
          maxFileBytes: { type: "integer", minimum: 1, maximum: 1048576 },
        },
        ["pattern"],
      ),
      execute: searchWorkspaceFiles,
    },
    {
      name: "edit_file",
      description:
        "After approval, replace exactly one literal oldText occurrence. Requires expectedHash from read_file; rejects ambiguous matches and keeps the file mode.",
      readOnly: false,
      parameters: object(
        {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          expectedHash: { type: "string" },
        },
        ["path", "oldText", "newText", "expectedHash"],
      ),
      execute: editWorkspaceFile,
    },

    {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the current workspace, returning its SHA-256 for guarded edits.",
      readOnly: true,
      parameters: object(
        {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          maxLines: { type: "integer", minimum: 1, maximum: 2000 },
        },
        ["path"],
      ),
      execute: readWorkspaceFile,
    },
    {
      name: "list_directory",
      description:
        "List entries inside the current workspace. Symlinks are listed but never followed.",
      readOnly: true,
      parameters: object({ path: { type: "string" } }),
      execute: listWorkspaceDirectory,
    },
    {
      name: "write_file",
      description:
        "After approval, create or atomically update a workspace text file. Existing files require expectedHash from read_file.",
      readOnly: false,
      parameters: object(
        {
          path: { type: "string" },
          content: { type: "string" },
          expectedHash: { type: ["string", "null"] },
        },
        ["path", "content"],
      ),
      execute: writeWorkspaceFile,
    },
    {
      name: "run_command",
      description:
        "After approval, run a shell command starting in the workspace. This is not an OS sandbox: commands can access other files and the network. Enforces timeout and bounded output.",
      readOnly: false,
      parameters: object(
        {
          command: { type: "string" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 120000 },
          maxOutputBytes: { type: "integer", minimum: 1024, maximum: 1048576 },
        },
        ["command"],
      ),
      execute: runWorkspaceCommand,
    },
  ];
}

async function editWorkspaceFile(input, context) {
  inputObject(input, ["path", "oldText", "newText", "expectedHash"]);
  writable(context);
  if (
    typeof input.oldText !== "string" ||
    !input.oldText ||
    typeof input.newText !== "string" ||
    typeof input.expectedHash !== "string"
  )
    throw Error("精确编辑需要 oldText、newText 和 expectedHash");
  if (
    Buffer.byteLength(input.oldText) > MAX_FILE ||
    Buffer.byteLength(input.newText) > MAX_FILE
  )
    throw Error("替换文本超过 1 MiB");
  const file = await readBounded(context, input.path);
  if (hash(file.bytes) !== input.expectedHash)
    throw Error("文件已变化，请重新读取后编辑");
  const index = file.content.indexOf(input.oldText);
  if (index < 0) throw Error("oldText 在文件中不存在");
  if (file.content.indexOf(input.oldText, index + 1) !== -1)
    throw Error("oldText 匹配不唯一，请包含更多上下文");
  const content =
    file.content.slice(0, index) +
    input.newText +
    file.content.slice(index + input.oldText.length);
  return writeWorkspaceFile(
    { path: input.path, content, expectedHash: input.expectedHash },
    context,
  );
}
// Runs only in an isolated worker. No model input is evaluated as JavaScript.
function workspaceSearchWorker() {
  const { workerData: data, parentPort } = require("node:worker_threads");
  const fs = require("node:fs"),
    path = require("node:path");
  const inside = (target) => {
    const r = path.relative(data.root, target);
    return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
  };
  let visited = 0,
    bytesRead = 0,
    resultChars = 0,
    truncated = false;
  const matches = [],
    stack = [data.target];
  try {
    const regex = new RegExp(data.pattern, data.flags + "g");
    while (stack.length && matches.length < data.maxResults && !truncated) {
      const current = stack.pop();
      if (++visited > 20000 || bytesRead >= 16 * 1024 * 1024) {
        truncated = true;
        break;
      }
      let info;
      try {
        info = fs.lstatSync(current);
        if (info.isSymbolicLink() || !inside(fs.realpathSync(current)))
          continue;
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        const directory = fs.opendirSync(current);
        try {
          let entry;
          while ((entry = directory.readSync())) {
            if (++visited > 20000) {
              truncated = true;
              break;
            }
            if (
              ![".git", "node_modules", "dist", "release", ".rpo"].includes(
                entry.name,
              ) &&
              !entry.isSymbolicLink()
            )
              stack.push(path.join(current, entry.name));
          }
        } finally {
          directory.closeSync();
        }
        continue;
      }
      if (!info.isFile() || info.size > data.maxFileBytes) continue;
      let fd;
      try {
        fd = fs.openSync(
          current,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        if (!fs.fstatSync(fd).isFile()) continue;
        const buffer = Buffer.alloc(
          Math.min(data.maxFileBytes + 1, 16 * 1024 * 1024 - bytesRead + 1),
        );
        let size = 0,
          count;
        while (
          size < buffer.length &&
          (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) >
            0
        )
          size += count;
        bytesRead += size;
        if (bytesRead > 16 * 1024 * 1024) {
          truncated = true;
          break;
        }
        if (size > data.maxFileBytes || buffer.subarray(0, size).includes(0))
          continue;
        let text;
        try {
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(buffer.subarray(0, size));
        } catch {
          continue;
        }
        regex.lastIndex = 0;
        let match,
          cursor = 0,
          line = 1,
          lineStart = 0;
        while ((match = regex.exec(text))) {
          for (; cursor < match.index; cursor++)
            if (text[cursor] === "\n") {
              line++;
              lineStart = cursor + 1;
            }
          const end = text.indexOf("\n", match.index);
          const item = {
            path: path.relative(data.root, current).split(path.sep).join("/"),
            line,
            column: match.index - lineStart + 1,
            text: text
              .slice(lineStart, end < 0 ? text.length : end)
              .slice(0, 600),
            match: match[0].slice(0, 300),
          };
          resultChars += JSON.stringify(item).length;
          if (resultChars > 128000) {
            truncated = true;
            break;
          }
          matches.push(item);
          if (matches.length >= data.maxResults) {
            truncated = true;
            break;
          }
          if (!match[0].length) {
            if (regex.lastIndex >= text.length) break;
            regex.lastIndex +=
              data.flags.includes("u") &&
              text.codePointAt(regex.lastIndex) > 65535
                ? 2
                : 1;
          }
        }
      } catch (error) {
        if (!(
          error.code &&
          ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(error.code)
        ))
          throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    parentPort.postMessage({
      ok: true,
      result: { matches, truncated, visited, bytesRead },
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof SyntaxError ? "正则表达式无效" : "搜索文件失败",
    });
  }
}
async function searchWorkspaceFiles(input, context) {
  inputObject(input, [
    "pattern",
    "path",
    "flags",
    "maxResults",
    "timeoutMs",
    "maxFileBytes",
  ]);
  if (
    typeof input.pattern !== "string" ||
    !input.pattern ||
    input.pattern.length > 1000
  )
    throw Error("搜索表达式需为 1–1000 字符");
  const flags = input.flags ?? "",
    maxResults = input.maxResults ?? 100,
    timeoutMs = input.timeoutMs ?? 2500,
    maxFileBytes = input.maxFileBytes ?? MAX_FILE;
  if (
    typeof flags !== "string" ||
    !/^[imsu]*$/.test(flags) ||
    new Set(flags).size !== flags.length ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 200 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 10000 ||
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > MAX_FILE
  )
    throw Error("搜索参数无效");
  const checked = await checkedPath(context, input.path ?? ".");
  if (!checked.exists) throw Error("搜索目录或文件不存在");
  checkAbort(context.signal);
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(`(${workspaceSearchWorker.toString()})()`, {
      eval: true,
      workerData: {
        root: checked.root,
        target: checked.target,
        pattern: input.pattern,
        flags,
        maxResults,
        maxFileBytes,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      void worker
        .terminate()
        .finally(() => (error ? reject(error) : resolveResult(result)));
    };
    const timer = setTimeout(
      () => finish(Error("搜索超时，正则已在隔离线程停止")),
      timeoutMs,
    );
    const abort = () => finish(abortError());
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    worker.on("message", (message) =>
      finish(message.ok ? null : Error(message.error), message.result),
    );
    worker.on("error", () => finish(Error("搜索线程已停止，可能超过内存限制")));
    worker.on("exit", (code) => {
      if (!settled) finish(Error(`搜索线程提前退出（${code}）`));
    });
  });
}
