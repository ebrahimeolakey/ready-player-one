import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  shell,
  Menu,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { Hub } from "../core/hub.mjs";
import { HubClient } from "../core/client.mjs";
import * as local from "../core/local.mjs";
import {
  AccountManager,
  repositories,
  cloneRepository,
  validateRepo,
  safeAuthUrl,
} from "../core/accounts.mjs";
import { installTool } from "../core/installers.mjs";
import { Tunnel, parseInvitation, makeInvitation } from "../core/tunnel.mjs";
const base = dirname(fileURLToPath(import.meta.url));
app.setName("头号玩家");
const dir = process.env.RPO_DATA_DIR || join(homedir(), ".ready-player-one");
mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.RPO_BIN_DIR = join(dir, "bin");
const accounts = new AccountManager();
const tunnel = new Tunnel();
const installations = new Map();
let accountLoading = true;
let config;
try {
  config = JSON.parse(readFileSync(join(dir, "client.json"), "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  config = {
    name: userInfo().username,
    secret: randomBytes(32).toString("hex"),
    paths: {},
    sessionPaths: {},
  };
}
const saveConfig = () =>
  writeFileSync(join(dir, "client.json"), JSON.stringify(config), {
    mode: 0o600,
  });
saveConfig();
let win,
  hub,
  client,
  remote = false,
  online = false,
  providerList = [],
  shutting = false;
const terminals = new Set();
const stopTerminal = (p) => {
  try {
    process.kill(-p.pid, "SIGTERM");
  } catch {}
};
const runner = new local.AgentRunner(),
  claimed = new Set(),
  stops = new Map();
const state = () => ({
  ...(client?.state || {
    workspaces: [],
    sessions: [],
    memories: [],
    approvals: [],
    members: [],
  }),
  local: {
    paths: config.paths,
    sessionPaths: config.sessionPaths,
    providers: providerList,
    online,
    remote,
    dataDir: dir,
    name: config.name,
    ...accounts.snapshot(),
    installations: [...installations.values()],
    tunnel: {
      ...tunnel.state,
      installed: existsSync(join(dir, "bin", "cloudflared")),
    },
    accountLoading,
    appVersion: app.getVersion(),
    platform: process.arch,
  },
});
const emit = () => {
  if (win && !win.isDestroyed()) win.webContents.send("rpo:event", state());
};
accounts.on("change", () => {
  providerList = accounts.accounts
    .filter((a) => a.id !== "github")
    .map((a) => ({ id: a.id, available: a.available, version: a.version }));
  emit();
});
tunnel.on("change", emit);
async function refreshAccounts() {
  accountLoading = true;
  emit();
  try {
    return await accounts.refresh();
  } finally {
    accountLoading = false;
    emit();
  }
}
const localRoot = (a) => {
  const p =
    (a.sessionId && config.sessionPaths[a.sessionId]) ||
    config.paths[a.workspaceId];
  if (!p) throw Error("请先为此工作区关联本机项目目录");
  return p;
};
async function connect(url, token) {
  runner.close();
  client?.close();
  client = new HubClient();
  const next = client;
  next.on("state", () => {
    if (client !== next) return;
    online = true;
    emit();
    processRuns();
  });
  next.on("offline", () => {
    if (client !== next) return;
    online = false;
    runner.close();
    emit();
  });
  await next.connect(url, {
    token,
    name: config.name,
    secret: remote
      ? createHmac("sha256", config.secret)
          .update(new URL(url).host)
          .digest("hex")
      : config.secret,
  });
  emit();
}
async function processRuns() {
  if (!client?.state) return;
  for (const s of client.state.sessions)
    for (const l of s.lanes)
      if (
        l.ownerId === client.state.me.id &&
        l.stopRequested &&
        stops.get(l.id) !== l.stopRequested
      ) {
        stops.set(l.id, l.stopRequested);
        runner.stop(l.id);
      }
  for (const a of client.state.approvals) {
    if (
      a.status !== "approved" ||
      a.ownerId !== client.state.me.id ||
      claimed.has(a.id)
    )
      continue;
    claimed.add(a.id);
    const c = client;
    try {
      const data = await c.call("run.claim", { id: a.id });
      const cwd = localRoot(a);
      const project = await local.inspectProject(cwd);
      if (project.branch === "未初始化 Git" && a.provider === "codex")
        throw Error(
          "Codex 需要 Git 仓库。请先在终端执行 git init 并创建首次提交。",
        );
      const prior = data.session.lanes
        .flatMap((l) =>
          l.entries
            .filter((e) => ["user", "assistant"].includes(e.role))
            .slice(-12)
            .map((e) => `[${l.owner} / ${l.provider} / ${e.role}] ${e.text}`),
        )
        .join("\n")
        .slice(-30000);
      const prompt = `请用中文协作完成任务。\n共享任务：${data.session.title}\n任务说明：${data.session.description}\n计划：${data.session.plan.map((p) => `${p.done ? "[x]" : "[ ]"} ${p.text}`).join("\n")}\n团队记忆：${data.memories.map((m) => `${m.title}: ${m.text}`).join("\n")}\n其他通道的最近上下文（仅作参考）：\n${prior}\n\n当前用户要求：${a.prompt}`;
      let queue = Promise.resolve();
      runner.run({
        key: a.laneId,
        provider: a.provider,
        mode: a.mode,
        cwd,
        prompt,
        onEntry: (item) => {
          queue = queue
            .then(() => c.call("run.entry", { ...a, runId: a.id, ...item }))
            .catch(() => {});
        },
        onEnd: (status, message) => {
          queue.then(async () => {
            try {
              await c.call("run.finish", {
                ...a,
                runId: a.id,
                status,
                message,
              });
            } catch {}
            emit();
          });
        },
      });
    } catch (e) {
      await c
        .call("run.finish", {
          ...a,
          runId: a.id,
          status: "error",
          message: e.message,
        })
        .catch(() => {});
    }
  }
}
const hubMethods = new Set([
  "workspace.create",
  "session.create",
  "session.archive",
  "lane.create",
  "run.request",
  "approval.decide",
  "lane.stop",
  "plan.add",
  "plan.toggle",
  "comment.add",
  "memory.add",
  "memory.retire",
  "invite.revoke",
]);
async function invoke(method, a) {
  if (method === "bootstrap") return state();
  if (method === "accounts.refresh") return refreshAccounts();
  if (method === "accounts.login") {
    if (!accounts.accounts.find((p) => p.id === a.id)?.available)
      throw Error("请先安装此提供商组件");
    return accounts.start(a.id, a.device === true);
  }
  if (method === "accounts.code") return accounts.submit(a.id, a.code);
  if (method === "accounts.cancel") {
    accounts.cancel(a.id);
    return true;
  }
  if (method === "accounts.open") {
    const job = accounts.jobs.get(a.id);
    const url = safeAuthUrl(job?.url);
    if (!url) throw Error("尚未收到官方登录地址");
    await shell.openExternal(url);
    return true;
  }
  if (method === "tools.install") {
    if (!["codex", "claude", "github", "cloudflared"].includes(a.id))
      throw Error("未知组件");
    if (installations.get(a.id)?.status === "running") return true;
    const job = { id: a.id, status: "running", message: "准备安装……" };
    installations.set(a.id, job);
    emit();
    installTool(a.id, join(dir, "bin"), (message) => {
      job.message = message;
      emit();
    })
      .then(async () => {
        job.status = "done";
        job.message = "安装完成";
        await refreshAccounts();
      })
      .catch((error) => {
        job.status = "error";
        job.message = error.message;
      })
      .finally(emit);
    return true;
  }
  if (method === "github.repositories") return repositories();
  if (method === "github.clone") {
    validateRepo(a.repo);
    if (
      a.workspaceId &&
      !client.state.workspaces.some((w) => w.id === a.workspaceId)
    )
      throw Error("工作区不存在");
    if (remote && !a.workspaceId) throw Error("请先选择要关联的共享工作区");
    const result = await dialog.showOpenDialog(win, {
      title: "选择仓库的保存位置",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const target = join(result.filePaths[0], a.repo.split("/")[1]);
    await cloneRepository(a.repo, target);
    const p = await local.inspectProject(target);
    if (a.workspaceId) {
      if (!client.state.workspaces.some((w) => w.id === a.workspaceId))
        throw Error("工作区不存在");
      config.paths[a.workspaceId] = p.root;
      saveConfig();
      emit();
      return { id: a.workspaceId };
    }
    const w = await client.call("workspace.create", {
      name: basename(p.root),
      branch: p.branch,
      remote: p.remote,
    });
    config.paths[w.id] = p.root;
    saveConfig();
    emit();
    return w;
  }
  if (method === "share.stopInternet") {
    tunnel.stop();
    return true;
  }

  if (hubMethods.has(method)) {
    if (method === "run.request") {
      localRoot(a);
      if (
        !providerList.find(
          (p) =>
            p.id ===
            client.state.sessions
              .find((s) => s.id === a.sessionId)
              ?.lanes.find((l) => l.id === a.laneId)?.provider,
        )?.available
      )
        throw Error("本机尚未安装此 Agent CLI");
    }
    return client.call(method, a);
  }
  if (method === "project.add") {
    const selected = await dialog.showOpenDialog(win, {
      title: "选择本地 Git 项目",
      properties: ["openDirectory"],
    });
    if (selected.canceled) return null;
    const p = await local.inspectProject(selected.filePaths[0]);
    const w = await client.call("workspace.create", {
      name: basename(p.root),
      branch: p.branch,
      remote: p.remote,
    });
    config.paths[w.id] = p.root;
    saveConfig();
    emit();
    return w;
  }
  if (method === "project.map") {
    const selected = await dialog.showOpenDialog(win, {
      title: "关联这个共享项目在本机的目录",
      properties: ["openDirectory"],
    });
    if (selected.canceled) return null;
    const p = await local.inspectProject(selected.filePaths[0]);
    config.paths[a.workspaceId] = p.root;
    saveConfig();
    emit();
    return p;
  }
  if (method === "worktree.create") {
    const s = client.state.sessions.find((s) => s.id === a.sessionId);
    if (!s || s.workspaceId !== a.workspaceId)
      throw Error("会话不属于此工作区");
    if (
      s.lanes.some(
        (l) => l.ownerId === client.state.me.id && l.status === "running",
      )
    )
      throw Error("请先停止本机 Agent");
    const path = await local.worktree(
      localRoot({ workspaceId: a.workspaceId }),
      a.sessionId,
      dir,
    );
    config.sessionPaths[a.sessionId] = path;
    saveConfig();
    emit();
    return path;
  }
  if (method === "files") return local.files(localRoot(a), a.path);
  if (method === "file.read") return local.read(localRoot(a), a.path);
  if (method === "file.save")
    return local.save(localRoot(a), a.path, a.content, a.hash);
  if (method === "git.changes") return local.changes(localRoot(a));
  if (method === "diff.publish") {
    const change = await local.changes(localRoot(a));
    if (change.error) throw Error(change.error);
    return client.call(method, { ...a, ...change });
  }
  if (method === "providers.refresh") {
    await refreshAccounts();
    return providerList;
  }
  if (method === "settings.name") {
    config.name = String(a.name).trim().slice(0, 40) || config.name;
    saveConfig();
    await connect(client.url, client.auth.token);
    return true;
  }
  if (method === "share.create") {
    if (remote) throw Error("请由房主生成邀请");
    let server,
      addresses = [],
      port;
    if (a.internet) {
      const endpoint = await tunnel.start(hub.port);
      server = endpoint.replace(/^https:/, "wss:");
    } else {
      if (!hub.sharePort) await hub.listen({ host: "0.0.0.0", port: 0 });
      port = hub.sharePort;
      addresses = Object.values(networkInterfaces())
        .flat()
        .filter((n) => n && n.family === "IPv4" && !n.internal)
        .map((n) => n.address);
    }
    const invite = await client.call("invite.create", {
      workspaceId: a.workspaceId,
    });
    const url = makeInvitation({
      server,
      host: addresses[0] || "127.0.0.1",
      port,
      token: invite.token,
      sessionId: a.sessionId,
    });
    clipboard.writeText(url);
    return {
      url,
      addresses,
      port,
      expires: invite.expires,
      internet: !!a.internet,
    };
  }
  if (method === "share.join") {
    const invitation = parseInvitation(a.url);
    remote = true;
    try {
      await connect(invitation.url, invitation.token);
    } catch (e) {
      remote = false;
      await connect(`ws://127.0.0.1:${hub.port}`, hub.db.hostToken);
      throw e;
    }
    return {
      sessionId: invitation.sessionId,
      workspaceId: client.state.workspaces[0]?.id,
    };
  }
  if (method === "share.leave") {
    remote = false;
    await connect(`ws://127.0.0.1:${hub.port}`, hub.db.hostToken);
    return true;
  }
  if (method === "clipboard") {
    clipboard.writeText(String(a.text));
    return true;
  }
  if (method === "folder.reveal") {
    shell.showItemInFolder(localRoot(a));
    return true;
  }
  if (method === "session.export") {
    const s = client.state.sessions.find((s) => s.id === a.sessionId);
    if (!s) throw Error("会话不存在");
    const d = await dialog.showSaveDialog(win, {
      defaultPath: `${s.title.replace(/[\/\\:]/g, "-")}.json`,
      filters: [{ name: "会话记录", extensions: ["json"] }],
    });
    if (!d.canceled) {
      const fullSession = await client.call("session.export", {
        sessionId: s.id,
      });
      writeFileSync(d.filePath, JSON.stringify(fullSession, null, 2));
      return true;
    }
    return false;
  }
  if (method === "terminal.run") {
    const cwd = localRoot(a);
    if (typeof a.command !== "string" || a.command.length > 8000)
      throw Error("命令无效");
    return new Promise((resolve) => {
      const p = spawn("/bin/zsh", ["-lc", a.command], {
        cwd,
        env: local.localEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      terminals.add(p);
      let output = "";
      const timer = setTimeout(() => {
        stopTerminal(p);
        setTimeout(() => {
          if (terminals.has(p)) {
            try {
              process.kill(-p.pid, "SIGKILL");
            } catch {}
          }
        }, 3000).unref();
      }, 60000);
      const append = (d) => {
        output = (output + d.toString()).slice(-100000);
      };
      p.stdout.on("data", append);
      p.stderr.on("data", append);
      p.on("error", (e) => {
        terminals.delete(p);
        clearTimeout(timer);
        resolve({ output: e.message, code: -1 });
      });
      p.on("close", (code) => {
        terminals.delete(p);
        clearTimeout(timer);
        resolve({ output, code });
      });
    });
  }
  throw Error("未知操作");
}
app
  .whenReady()
  .then(async () => {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
    } else {
      hub = new Hub(join(dir, "hub"));
      await hub.listen();
      await connect(`ws://127.0.0.1:${hub.port}`, hub.db.hostToken);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "头号玩家",
            submenu: [
              { role: "about", label: "关于头号玩家" },
              { role: "quit", label: "退出头号玩家" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo", label: "撤销" },
              { role: "redo", label: "重做" },
              { type: "separator" },
              { role: "cut", label: "剪切" },
              { role: "copy", label: "复制" },
              { role: "paste", label: "粘贴" },
              { role: "selectAll", label: "全选" },
            ],
          },
          {
            label: "视图",
            submenu: [
              { role: "reload", label: "重新载入" },
              { role: "toggleDevTools", label: "开发者工具" },
              { role: "resetZoom", label: "实际大小" },
              { role: "zoomIn", label: "放大" },
              { role: "zoomOut", label: "缩小" },
              { role: "togglefullscreen", label: "全屏" },
            ],
          },
        ]),
      );
      win = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1080,
        minHeight: 700,
        title: "头号玩家",
        backgroundColor: "#111416",
        titleBarStyle: "hiddenInset",
        webPreferences: {
          preload: join(base, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const entry = fileURLToPath(
        new URL("../dist/index.html", import.meta.url),
      );
      ipcMain.handle("rpo:invoke", async (event, method, args) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          throw Error("无效调用来源");
        return invoke(method, args || {});
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      await win.loadFile(entry);
      refreshAccounts().catch(console.error);
      win.on("closed", () => {
        win = null;
        app.quit();
      });
      app.on("second-instance", () => {
        win?.show();
        win?.focus();
      });
    }
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox("启动失败", error.message);
    app.quit();
  });
app.on("before-quit", () => {
  if (shutting) return;
  shutting = true;
  accounts.close();
  tunnel.stop();
  for (const p of terminals) stopTerminal(p);
  runner.close();
  client?.close();
  hub?.close();
});
