import { AgentRunner, git } from "../core/local.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!process.argv.includes("--live"))
  throw Error("此检查调用本机账号。确认后添加 --live，默认使用 Codex。");
const provider = process.argv.includes("--claude") ? "claude" : "codex";
const dir = await mkdtemp(join(tmpdir(), "rpo-provider-"));
await git(dir, ["init"]);
const runner = new AgentRunner();
let response = "";
const result = await new Promise((resolve) => {
  const timer = setTimeout(() => runner.stop("smoke"), 60000);
  runner.run({
    key: "smoke",
    provider,
    mode: "read-only",
    cwd: dir,
    prompt:
      "这是桌面客户端连接测试。不要读取文件，不要使用工具。只回复：头号玩家连接成功",
    onEntry: (e) => {
      if (e.role === "assistant") response += e.text;
    },
    onEnd: (status, message) => {
      clearTimeout(timer);
      resolve({ provider, status, message, response });
    },
  });
});
await rm(dir, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
if (result.status !== "done" || !response.includes("头号玩家连接成功"))
  process.exitCode = 1;
