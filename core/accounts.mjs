import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { localEnv } from "./local.mjs";
import { stopProcess } from "./platform.mjs";
const exec = promisify(execFile);
export const ACCOUNT_IDS = ["codex", "claude", "github"];
const commands = { codex: "codex", claude: "claude", github: "gh" };
export function loginCommand(id, device = false) {
  if (id === "codex")
    return ["codex", ["login", ...(device ? ["--device-auth"] : [])]];
  if (id === "claude") return ["claude", ["auth", "login"]];
  if (id === "github")
    return [
      "gh",
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
      ],
    ];
  throw Error("未知账号类型");
}
export function sanitizeLog(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(
      /\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
      "[凭据已隐藏]",
    )
    .replace(
      /(access_token|refresh_token|id_token|authorization)\s*[:=]\s*[^\s,}]+/gi,
      "$1=[凭据已隐藏]",
    );
}
export function safeAuthUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      [
        "auth.openai.com",
        "chatgpt.com",
        "claude.ai",
        "platform.claude.com",
        "console.anthropic.com",
        "github.com",
      ].includes(u.hostname) &&
      !u.username &&
      !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
export async function accountStatus(id, run = exec) {
  const command = commands[id];
  if (!command) throw Error("未知账号类型");
  let version;
  try {
    version = (
      await run(command, ["--version"], { env: localEnv(), timeout: 6000 })
    ).stdout
      .trim()
      .split("\n")[0];
  } catch {
    return {
      id,
      available: false,
      authenticated: false,
      status: "missing",
      label: "尚未安装",
      version: "",
    };
  }
  try {
    if (id === "codex") {
      const r = await run(command, ["login", "status"], {
        env: localEnv(),
        timeout: 10000,
      });
      const message = sanitizeLog(r.stdout + " " + r.stderr).trim();
      return {
        id,
        available: true,
        authenticated: /logged in/i.test(message),
        status: /logged in/i.test(message) ? "connected" : "signed-out",
        label: /ChatGPT/i.test(message)
          ? "ChatGPT 账号"
          : /API key/i.test(message)
            ? "API Key"
            : "Codex 账号",
        version,
      };
    }
    if (id === "claude") {
      const r = await run(command, ["auth", "status", "--json"], {
        env: localEnv(),
        timeout: 10000,
      });
      const info = JSON.parse(r.stdout);
      return {
        id,
        available: true,
        authenticated: info.loggedIn === true,
        status: info.loggedIn ? "connected" : "signed-out",
        label: info.email || info.authMethod || "Claude 账号",
        plan: info.subscriptionType || "",
        version,
      };
    }
    const r = await run(
      command,
      ["api", "user", "--jq", "{login: .login, name: .name}"],
      { env: { ...localEnv(), GH_PROMPT_DISABLED: "1" }, timeout: 15000 },
    );
    const info = JSON.parse(r.stdout);
    return {
      id,
      available: true,
      authenticated: true,
      status: "connected",
      label: info.login,
      displayName: info.name || info.login,
      version,
    };
  } catch (e) {
    return {
      id,
      available: true,
      authenticated: false,
      status: e.killed ? "unreachable" : "signed-out",
      label: e.killed ? "连接超时，请检查网络" : "未登录或授权失效",
      version,
    };
  }
}
export class AccountManager extends EventEmitter {
  constructor({ spawnProcess = spawn, status = accountStatus } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.status = status;
    this.accounts = [];
    this.jobs = new Map();
    this.processes = new Map();
  }
  snapshot() {
    return { accounts: this.accounts, authJobs: [...this.jobs.values()] };
  }
  async refresh() {
    this.accounts = await Promise.all(ACCOUNT_IDS.map((id) => this.status(id)));
    this.emit("change");
    return this.accounts;
  }
  start(id, device = false) {
    const [command, args] = loginCommand(id, device);
    if (this.processes.has(id)) return this.jobs.get(id);
    const job = {
      id,
      kind: "login",
      status: "running",
      log: "正在启动官方登录流程……",
      url: null,
      at: Date.now(),
    };
    this.jobs.set(id, job);
    const child = this.spawnProcess(command, args, {
      env: { ...localEnv(), NO_COLOR: "1", CLICOLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.processes.set(id, child);
    let ended = false,
      continued = false;
    const timer = setTimeout(() => {
      this.cancel(id, "登录超时，请重新发起");
    }, 10 * 60e3);
    timer.unref?.();
    const update = (data) => {
      job.log = sanitizeLog(job.log + "\n" + data.toString()).slice(-12000);
      for (const match of job.log.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
        const url = safeAuthUrl(match[0]);
        if (url) job.url = url;
      }
      if (
        id === "github" &&
        !continued &&
        /press enter|按.*回车/i.test(job.log)
      ) {
        continued = true;
        child.stdin.write("\n");
      }
      this.emit("change");
    };
    child.stdout.on("data", update);
    child.stderr.on("data", update);
    child.stdin.on("error", () => {});
    const end = async (code, error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.processes.delete(id);
      if (job.status === "running") {
        job.status = code === 0 && !error ? "done" : "error";
        if (error) job.log += "\n" + sanitizeLog(error.message);
      }
      if (code === 0 && id === "github") {
        try {
          await exec("gh", ["auth", "setup-git", "--hostname", "github.com"], {
            env: localEnv(),
            timeout: 10000,
          });
        } catch {
          job.log += "\nGit 凭据助手未配置，可稍后重新授权。";
        }
      }
      await this.refresh();
      this.emit("change");
    };
    child.on("error", (e) => end(null, e));
    child.on("close", (code) => end(code));
    this.emit("change");
    return job;
  }
  cancel(id, message = "已取消登录") {
    const child = this.processes.get(id);
    const job = this.jobs.get(id);
    if (job && child) {
      job.status = "cancelled";
      job.log += "\n" + message;
      stopProcess(child);
      this.processes.delete(id);
      this.emit("change");
    }
  }
  submit(id, code) {
    const child = this.processes.get(id);
    if (
      !child ||
      typeof code !== "string" ||
      !code.trim() ||
      code.length > 4096 ||
      /[\r\n]/.test(code)
    )
      throw Error("授权码无效或登录已结束");
    child.stdin.write(code.trim() + "\n");
    return true;
  }
  close() {
    for (const id of this.processes.keys()) this.cancel(id);
  }
}
export async function repositories() {
  const { stdout } = await exec(
    "gh",
    [
      "api",
      "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      "--jq",
      "[.[] | {fullName: .full_name, name: .name, private: .private, description: .description, defaultBranch: .default_branch}]",
    ],
    {
      env: { ...localEnv(), GH_PROMPT_DISABLED: "1" },
      timeout: 20000,
      maxBuffer: 2e6,
    },
  );
  return JSON.parse(stdout);
}
export function validateRepo(repo) {
  if (
    typeof repo !== "string" ||
    !/^[-\w.]+\/[-\w.]+$/.test(repo) ||
    repo.split("/").some((p) => p.startsWith("-") || p === ".." || p === ".")
  )
    throw Error("仓库应为 owner/repository 格式");
  return repo;
}
export async function cloneRepository(repo, target) {
  validateRepo(repo);
  await exec("gh", ["repo", "clone", repo, target], {
    env: { ...localEnv(), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 180000,
    maxBuffer: 3e6,
  });
  return target;
}
