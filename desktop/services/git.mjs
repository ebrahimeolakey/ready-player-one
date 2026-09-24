import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, access, lstat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { platformEnv } from "../../core/platform.mjs";
const exec = promisify(execFile);
const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const operationFiles = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
];
const redact = (text) =>
  String(text || "").replace(
    /(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g,
    "$1[credentials]@",
  );

export function parseGitStatus(output) {
  const parts = output.split("\0"),
    files = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry) continue;
    const code = entry.slice(0, 2),
      path = entry.slice(3);
    const originalPath = /[RC]/.test(code) ? parts[++index] : undefined;
    files.push({
      path,
      originalPath,
      index: code[0],
      worktree: code[1],
      untracked: code === "??",
      conflict: conflicts.has(code),
      staged: code[0] !== " " && code[0] !== "?",
      unstaged: code[1] !== " ",
    });
  }
  return files;
}
function validPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  )
    throw new Error("无效的仓库文件路径");
  const parts = path.replace(/\\/g, "/").split("/");
  if (
    parts.includes("..") ||
    parts.some((part) => part.toLowerCase() === ".git")
  )
    throw new Error("不能操作仓库外或 Git 内部文件");
  return path;
}

export class GitService {
  constructor({ env = platformEnv(), isBusy = () => false } = {}) {
    this.env = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      delete this.env[key];
    this.isBusy = isBusy;
    this.locks = new Set();
  }
  async command(root, args, { allowExit = [], timeout = 30000 } = {}) {
    try {
      const result = await exec(
        "git",
        [
          "--no-pager",
          "--literal-pathspecs",
          "-c",
          "core.quotepath=false",
          "-c",
          "color.ui=false",
          "-C",
          root,
          ...args,
        ],
        {
          env: this.env,
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
          windowsHide: true,
        },
      );
      return { ...result, code: 0 };
    } catch (error) {
      if (allowExit.includes(error.code))
        return {
          stdout: error.stdout || "",
          stderr: error.stderr || "",
          code: error.code,
        };
      throw new Error(
        redact(
          error.killed ? "Git 操作超时" : error.stderr || error.message,
        ).trim(),
      );
    }
  }
  async root(path) {
    const root = await realpath(path);
    const top = (
      await this.command(root, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    if ((await realpath(top)) !== root)
      throw new Error("请选择仓库根目录，避免操作其他目录");
    return root;
  }
  async inspect(root) {
    const files = parseGitStatus(
      (
        await this.command(root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
      ).stdout,
    );
    const current = (
      await this.command(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowExit: [1],
      })
    ).stdout.trim();
    const gitDir = (
      await this.command(root, ["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    let operation = null;
    for (const name of operationFiles)
      if (
        await access(join(gitDir, name)).then(
          () => true,
          () => false,
        )
      ) {
        operation = name;
        break;
      }
    return {
      root,
      branch: current || null,
      detached: !current,
      files,
      dirty: files.length > 0,
      conflicts: files.filter((file) => file.conflict).map((file) => file.path),
      operation,
    };
  }
  async status(path) {
    return this.inspect(await this.root(path));
  }
  async lock(path, action) {
    const root = await this.root(path);
    if (this.locks.has(root)) throw new Error("此仓库正在执行 Git 操作");
    this.locks.add(root);
    try {
      if (await this.isBusy(root))throw new Error("请先停止此仓库正在运行的 Agent");
      return await action(root);
    } finally {
      this.locks.delete(root);
    }
  }
  async clean(root) {
    const status = await this.inspect(root);
    if (status.operation || status.conflicts.length)
      throw new Error("请先完成当前合并、变基或冲突处理");
    if (status.dirty)
      throw new Error("请先处理未提交改动；此操作不会覆盖工作目录");
    if (!status.branch) throw new Error("当前处于分离 HEAD，请先创建分支");
    return status;
  }
  async selected(root, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 500)
      throw new Error("请选择要操作的文件");
    const status = await this.inspect(root);
    const changed = new Map(status.files.map((file) => [file.path, file]));
    const result = [];
    for (const path of paths) {
      validPath(path);
      const file = changed.get(path);
      if (!file) throw new Error(`文件状态已变化，请刷新：${path}`);
      result.push(path);
      if (file.originalPath) result.push(validPath(file.originalPath));
    }
    return [...new Set(result)];
  }
  async stage(path, { paths }) {
    return this.lock(path, async (root) => {
      const selected = await this.selected(root, paths);
      await this.command(root, ["add", "--", ...selected]);
      return this.inspect(root);
    });
  }
  async unstage(path, { paths }) {
    return this.lock(path, async (root) => {
      const selected = await this.selected(root, paths);
      const head = await this.command(root, ["rev-parse", "--verify", "HEAD"], {
        allowExit: [128],
      });
      await this.command(
        root,
        head.code === 0
          ? ["restore", "--staged", "--", ...selected]
          : ["rm", "--cached", "--ignore-unmatch", "--", ...selected],
      );
      return this.inspect(root);
    });
  }
  async diff(path, { path: file, staged = false } = {}) {
    const root = await this.root(path);
    const status = await this.inspect(root);
    let selected;
    if (file) {
      validPath(file);
      selected = status.files.find((value) => value.path === file);
      if (!selected) throw new Error("文件状态已变化，请刷新");
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
    if (staged) args.push("--cached");
    if (selected?.untracked && !staged) {
      const info = await lstat(join(root, file));
      if (info.isSymbolicLink())
        return {
          text: "未跟踪的符号链接；暂存后可查看链接差异",
          binary: false,
        };
      if (!info.isFile()) throw new Error("只能预览普通文件");
      if (info.size > 2 * 1024 * 1024)
        return { text: "文件较大，请在编辑器中查看。", binary: false };
      const output = await this.command(
        root,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          "/dev/null",
          file,
        ],
        { allowExit: [1] },
      );
      return {
        text: output.stdout,
        binary: /^Binary files .+ differ$/m.test(output.stdout),
      };
    }
    args.push("--");
    if (selected)
      args.push(
        selected.path,
        ...(selected.originalPath ? [selected.originalPath] : []),
      );
    const output = await this.command(root, args);
    return {
      text: output.stdout,
      binary: /^Binary files .+ differ$/m.test(output.stdout),
    };
  }
  async commit(path, { message }) {
    return this.lock(path, async (root) => {
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 20000
      )
        throw new Error("请输入提交说明");
      const status = await this.inspect(root);
      if (
        (status.operation && status.operation !== "MERGE_HEAD") ||
        status.conflicts.length
      )
        throw new Error("请先完成冲突处理");
      if (!status.files.some((file) => file.staged))
        throw new Error("没有已暂存的变更");
      await this.command(root, ["commit", "-m", message.trim()], {
        timeout: 120000,
      });
      return {
        commit: (await this.command(root, ["rev-parse", "HEAD"])).stdout.trim(),
        status: await this.inspect(root),
      };
    });
  }
  async remotes(root) {
    return (await this.command(root, ["remote"])).stdout
      .split("\n")
      .filter(Boolean);
  }
  async remote(root, name) {
    if (
      typeof name !== "string" ||
      !name ||
      name.startsWith("-") ||
      !(await this.remotes(root)).includes(name)
    )
      throw new Error("请选择已配置的远程仓库");
    return name;
  }
  async fetch(path, { remote = "origin" } = {}) {
    return this.lock(path, async (root) => {
      await this.command(
        root,
        ["fetch", "--", await this.remote(root, remote)],
        { timeout: 120000 },
      );
      return this.inspect(root);
    });
  }
  async pull(path, { remote = "origin", branch }) {
    return this.lock(path, async (root) => {
      const state = await this.clean(root);
      if (!branch || branch !== state.branch)
        throw new Error("只能拉取明确选中的当前分支");
      await this.command(
        root,
        [
          "pull",
          "--ff-only",
          "--no-rebase",
          "--",
          await this.remote(root, remote),
          branch,
        ],
        { timeout: 120000 },
      );
      return this.inspect(root);
    });
  }
  async push(path, { remote = "origin" } = {}) {
    return this.lock(path, async (root) => {
      const state = await this.inspect(root);
      if (!state.branch || state.operation || state.conflicts.length)
        throw new Error("请先完成分支或冲突处理");
      await this.command(
        root,
        [
          "push",
          "--set-upstream",
          "--",
          await this.remote(root, remote),
          `HEAD:refs/heads/${state.branch}`,
        ],
        { timeout: 120000 },
      );
      return this.inspect(root);
    });
  }
  async branches(path) {
    const root = await this.root(path);
    const output = (
      await this.command(root, [
        "for-each-ref",
        "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)",
        "refs/heads",
      ])
    ).stdout;
    return {
      branches: output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, current, upstream] = line.split("\0");
          return { name, current: current === "*", upstream: upstream || null };
        }),
      remotes: await this.remotes(root),
    };
  }
  async validateBranch(root, name) {
    if (
      typeof name !== "string" ||
      !name ||
      name === "HEAD" ||
      name.length > 200 ||
      name.startsWith("-") ||
      name.includes("\0")
    )
      throw new Error("无效的分支名");
    const checked = (
      await this.command(root, ["check-ref-format", "--branch", name])
    ).stdout.trim();
    if (checked !== name) throw new Error("请输入完整分支名，不使用引用表达式");
    return name;
  }
  async createBranch(path, { name }) {
    return this.lock(path, async (root) => {
      await this.clean(root);
      await this.validateBranch(root, name);
      await this.command(root, ["switch", "-c", name]);
      return this.inspect(root);
    });
  }
  async switchBranch(path, { name }) {
    return this.lock(path, async (root) => {
      await this.clean(root);
      await this.validateBranch(root, name);
      const branches = await this.branches(root);
      if (!branches.branches.some((branch) => branch.name === name))
        throw new Error("请选择本地已有分支");
      await this.command(root, ["switch", "--", name]);
      return this.inspect(root);
    });
  }
}
