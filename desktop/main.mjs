import { defaultBindings, validateBindings } from "../core/keybindings.mjs";
import { ACPConfigStore } from "../core/acp-config.mjs";
import { registerACP, probeACP } from "../core/providers/acp.mjs";
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  clipboard,
  shell,
  Menu,
  Notification,
  session as electronSession,
  webContents,
  safeStorage,
  nativeImage,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { randomBytes, createHmac, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Hub } from "../core/hub.mjs";
import { HubClient } from "../core/client.mjs";
import * as local from "../core/local.mjs";
import { FileSearchService } from "./services/file-search.mjs";
import * as snapshots from "../core/snapshots.mjs";
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import { listProviderModels } from "../core/providers/catalog.mjs";
import { RunCoordinator } from "../core/run-coordinator.mjs";
import { SecureStore } from "../core/secure-store.mjs";
import { loadDesktopDataKey } from "./services/data-key.mjs";
import { ProviderConfigStore } from "../core/provider-config.mjs";
import { registerOpenAICompatible } from "../core/providers/openai-compatible.mjs";
import { createWorkspaceTools } from "../core/providers/workspace-tools.mjs";
import { normalizeImages, IMAGE_LIMITS } from "../core/providers/input.mjs";
import {
  DictationService,
  dictationHelperPath,
} from "./services/dictation.mjs";
import {
  createTaskCoordination,
  handlesTaskCoordination,
} from "./services/task-coordination.mjs";
import { CoordinationBridge } from "./services/coordination-bridge.mjs";
import {
  createTeamIdentity,
  handlesTeamIdentity,
} from "./services/team-identity.mjs";
import { createIdentityVerifier } from "../core/team-identity.mjs";
import { DebuggerService, handlesDebugger } from "./services/debugger.mjs";
import { ComposerStore } from "./services/composer.mjs";
import { LanguageService } from "./services/language.mjs";
import { DraftStore } from "./services/drafts.mjs";
import { GitService } from "./services/git.mjs";
import {
  captureReference,
  fileReferences,
  checkReferences,
} from "./services/references.mjs";
import { UpdateService } from "./services/updater.mjs";
import { TerminalService } from "./services/terminal.mjs";
import { BrowserService, browserURL } from "./services/browser.mjs";
import { shellCommand, binaryName, stopProcess } from "../core/platform.mjs";
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
if (process.env.RPO_DATA_DIR) {
  mkdirSync(join(dir, "electron"), { recursive: true, mode: 0o700 });
  app.setPath("userData", join(dir, "electron"));
}
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
let composerStore;
let settingsStore, drafts, pendingTeamConnection;
const saveConfig = () => {
  if (!settingsStore) throw Error("本机加密存储尚未就绪");
  settingsStore.writeJSON("client.json", config);
};
let win,
  hub,
  client,
  remote = false,
  online = false,
  providerList = [],
  shutting = false;
const syncStates = new Map();
const syncBusy = new Set();
const notifiedApprovals = new Set();
config.syncSessions ??= {};
config.lanePaths ??= {};
let customProviders = [];
let acpProviders = [];
let updater;
const runImages = new Map();
const saveRunImages = () =>
  settingsStore.writeJSON("run-images.json", Object.fromEntries(runImages));
const providerStore = new ProviderConfigStore({
  path: join(dir, "providers.json"),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
});
const acpStore = new ACPConfigStore({
  path: join(dir, "acp-providers.json"),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
});
async function refreshACP() {
  acpProviders = await acpStore.list();
  emit();
}
const allProviders = () => [
  ...providerList,
  ...acpProviders.map((p) => ({
    id: p.id,
    name: p.name,
    available: true,
    version: "ACP",
  })),
  ...customProviders.map((p) => ({
    id: p.id,
    name: p.name,
    available: true,
    version: p.model,
  })),
];
async function refreshCustomProviders() {
  customProviders = await providerStore.list();
  emit();
}
const dictation = new DictationService({
  helperPath: dictationHelperPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  }),
  onEvent: (event) => {
    if (win && !win.isDestroyed()) win.webContents.send("rpo:dictation", event);
  },
});
const terminalService = new TerminalService();
const browserService = new BrowserService({
  BrowserWindow,
  WebContentsView,
  getOwnerWindow: (id) => BrowserWindow.fromWebContents(webContents.fromId(id)),
  session: electronSession,
  openExternal: (url) => shell.openExternal(url),
});
for (const [service, channel] of [
  [terminalService, "rpo:terminal"],
  [browserService, "rpo:browser"],
])
  service.on("event", (ownerId, payload) => {
    const target = webContents.fromId(ownerId);
    if (target && !target.isDestroyed()) target.send(channel, payload);
  });
const terminals = new Set();
const stopTerminal = (p) => stopProcess(p);
const languageService = new LanguageService();
const runtime = new ProviderRuntime({ env: local.localEnv() });
config.laneOptions ??= {};
config.modelCatalogs ??= {};
const repoLocks = new Set();
const canonicalRoot = (root) => realpathSync(root);
function agentBusy(root) {
  if (
    [...runtime.runs.values()].some((run) => {
      try {
        return canonicalRoot(run.options.cwd) === root;
      } catch {
        return false;
      }
    })
  )
    return true;
  return [...coordinator.records.values()].some((r) => {
    if (
      r.ended ||
      r.blocked ||
      !client?.state ||
      r.scope !== coordinator.scope(client)
    )
      return false;
    try {
      return canonicalRoot(localRoot(r)) === root;
    } catch {
      return false;
    }
  });
}
function rootBusy(root) {
  return debuggerService.isBusy(root) || agentBusy(root);
}
const debuggerService = new DebuggerService({
  resolveContext: (_owner, a) => {
    const ws = client?.state?.workspaces.find((w) => w.id === a.workspaceId);
    if (!ws) throw Error("工作区不存在");
    const me = client.state.me,
      role = me.roles?.[ws.id] || (me.host ? "owner" : "editor");
    if (!["owner", "editor"].includes(role))
      throw Error("当前角色不能调试代码");
    if (a.sessionId) {
      const session = client.state.sessions.find(
        (s) => s.id === a.sessionId && s.workspaceId === ws.id,
      );
      if (!session) throw Error("会话不存在");
      if (
        a.laneId &&
        !session.lanes.some((l) => l.id === a.laneId && l.ownerId === me.id)
      )
        throw Error("只能调试自己的 Agent 目录");
    } else if (a.laneId) throw Error("需要关联会话");
    return {
      root: localRoot(a),
      contextId: a.laneId || a.sessionId || a.workspaceId,
    };
  },
  beforeStart: (root) => {
    if (repoLocks.has(root) || agentBusy(root))
      throw Error("请先等待或停止项目的 Agent 和 Git 操作");
  },
});
async function withRepository(root, action) {
  root = canonicalRoot(root);
  if (repoLocks.has(root)) throw Error("项目正在执行 Git 操作，请稍后重试");
  if (rootBusy(root)) throw Error("请先等待或停止此项目的 Agent");
  repoLocks.add(root);
  try {
    return await action();
  } finally {
    repoLocks.delete(root);
  }
}
const gitService = new GitService({ env: local.localEnv(), isBusy: rootBusy });
gitService.locks = repoLocks;
const gitMethods = new Set([
  "status",
  "diff",
  "stage",
  "unstage",
  "commit",
  "fetch",
  "pull",
  "push",
  "branches",
  "createBranch",
  "switchBranch",
]);
const state = () => ({
  ...(client?.state || {
    workspaces: [],
    sessions: [],
    memories: [],
    approvals: [],
    members: [],
  }),
  local: {
    keyboard: { ...defaultBindings(process.platform), ...config.keyboard },
    runIssues: coordinator?.issues || [],
    update: updater?.getState(),
    laneOptions: config.laneOptions,
    modelCatalogs: config.modelCatalogs,
    sync: Object.fromEntries(syncStates),
    syncSessions: config.syncSessions,
    paths: config.paths,
    sessionPaths: config.sessionPaths,
    providers: allProviders(),
    lanePaths: config.lanePaths,
    online,
    remote,
    dataDir: dir,
    name: config.name,
    ...accounts.snapshot(),
    installations: [...installations.values()],
    tunnel: {
      ...tunnel.state,
      installed: existsSync(join(dir, "bin", binaryName("cloudflared"))),
    },
    accountLoading,
    appVersion: app.getVersion(),
    platform: process.arch,
    os: process.platform,
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
    (a.laneId && config.lanePaths[a.laneId]) ||
    (a.sessionId && config.sessionPaths[a.sessionId]) ||
    config.paths[a.workspaceId];
  if (!p) throw Error("请先为此工作区关联本机项目目录");
  return p;
};
const fileSearchService = new FileSearchService({
  resolveRoot: (a) => {
    const session = client?.state?.sessions.find(s => s.id === a.sessionId && s.workspaceId === a.workspaceId);
    if (!session) throw Error("搜索会话不存在或无权访问");
    if (a.laneId && !session.lanes.some(l => l.id === a.laneId && l.ownerId === client.state.me.id))
      throw Error("只能搜索本机 Agent 的工作目录");
    return localRoot(a);
  },
});
const coordinator = new RunCoordinator({
  runtime,
  client: () => client,
  dir: join(dir, "outbox"),
  root: localRoot,
  options: async (a) => {
    const env = {
      ELECTRON_RUN_AS_NODE: "1",
      RPO_HUB_URL: client.url,
      RPO_HUB_TOKEN: client.auth.token,
      RPO_CLIENT_SECRET: client.auth.secret,
      RPO_CLIENT_NAME: config.name,
      RPO_SESSION_ID: a.sessionId,
      RPO_LANE_ID: a.laneId,
      ...(client.auth.identitySession
        ? { RPO_IDENTITY_SESSION: client.auth.identitySession }
        : {}),
    };
    const mcp = {
      command: process.execPath,
      args: [join(base, "../core/mcp-coordination.mjs")],
      env,
    };
    const lane = client.state.sessions
      .find((s) => s.id === a.sessionId)
      ?.lanes.find((l) => l.id === a.laneId);
    const queued = lane?.queue?.find((q) => q.approvalId === a.id);
    const images = runImages.get(a.id) || runImages.get(queued?.id) || [];
    let custom = {};
    let configuredModel;
    if (a.provider.startsWith("custom-")) {
      const settings = await providerStore.getRuntimeConfig(a.provider);
      registerOpenAICompatible(runtime, a.provider, {
        baseUrl: settings.baseUrl,
        model: settings.model,
        requestUsage: settings.requestUsage === true,
        apiKeyEnv: settings.apiKey ? "RPO_SELECTED_PROVIDER_KEY" : undefined,
        tools: createWorkspaceTools(),
      });
      custom = { env: { RPO_SELECTED_PROVIDER_KEY: settings.apiKey } };
      configuredModel = settings.model;
    }
    if (a.provider.startsWith("acp-")) {
      const settings = await acpStore.getRuntimeConfig(a.provider);
      registerACP(runtime, a.provider, settings);
      configuredModel = settings.model;
    }
    if (debuggerService.isBusy(localRoot(a))) throw Error("请先停止项目调试");
    if (repoLocks.has(canonicalRoot(localRoot(a))))
      throw Error("项目正在执行 Git 操作，请稍后重试");
    const selectedOptions = config.laneOptions[a.laneId] || {};
    const model = selectedOptions.model || configuredModel || undefined;
    await client.call("lane.configure", {
      sessionId: a.sessionId, laneId: a.laneId,
      model: model || null, effort: selectedOptions.effort || null,
    });
    Object.assign(env, await coordinationBridge.issue({workspaceId:a.workspaceId,sessionId:a.sessionId,laneId:a.laneId,runId:a.id}));
    return {
      ...selectedOptions,
      model,
      ...custom,
      images,
      codexConfig: { "mcp_servers.rpo": mcp },
      mcpServers: { rpo: mcp },
      readOnlyMcpTools: ["mcp__rpo__rpo_context", "mcp__rpo__rpo_overlap_check", "mcp__rpo__rpo_memory_list"],
    };
  },
  steeringImages: (id) => runImages.get(id) || [],
  onChange: emit,
  onFinish: (result) => {
    coordinationBridge.revokeRun(result.runId);
    if (win && !win.isFocused() && Notification.isSupported())
      new Notification({
        title: "头号玩家",
        body:
          result.status === "done"
            ? "Agent 已完成任务"
            : "Agent 需要你查看执行结果",
      }).show();
    const lane = client?.state?.sessions
      .find((s) => s.id === result.sessionId)
      ?.lanes.find((l) => l.activeRunId === result.runId);
    runImages.delete(result.runId);
    for (const q of lane?.queue || [])
      if (q.approvalId === result.runId) runImages.delete(q.id);
    for (const q of lane?.steering || [])
      if (
        q.runId === result.runId &&
        ["delivered", "restored"].includes(q.status)
      )
        runImages.delete(q.id);
    saveRunImages();
    if (config.syncSessions[result.sessionId])
      syncSession(result.sessionId).catch(() => {});
  },
});
const taskCoordination = createTaskCoordination({
  client: () => client,
  runtime,
  localRoot,
  config,
  saveConfig,
  dataDir: dir,
  withRepository,
});
const coordinationBridge = new CoordinationBridge({client:()=>client,runtime,taskCoordination});
const teamIdentity = createTeamIdentity({
  client: () => client,
  endpoint: () => client?.url,
  localConfig: config,
  saveConfig,
  openExternal: (url) => shell.openExternal(url),
  scopeKey: (url) =>
    hub && url === `ws://127.0.0.1:${hub.port}`
      ? `local:${hub.identity.info.audience}`
      : url,
});
const connectionSecret = (url) =>
  remote
    ? createHmac("sha256", config.secret)
        .update(new URL(url).host)
        .digest("hex")
    : config.secret;
async function connect(url, token) {
  coordinationBridge.revokeAll();
  await coordinator.close();
  client?.close();
  client = new HubClient();
  const next = client;
  next.on("state", () => {
    if (client !== next) return;
    online = true;
    for (const a of [
      ...(next.state.approvals || []),
      ...(next.state.toolApprovals || []),
    ])
      if (a.status === "pending" && !notifiedApprovals.has(a.id)) {
        notifiedApprovals.add(a.id);
        if (win && !win.isFocused() && Notification.isSupported())
          new Notification({
            title: "头号玩家",
            body: "有一项操作等待审批",
          }).show();
      }
    emit();
    processRuns().catch(console.error);
  });
  next.on("offline", () => {
    if (client !== next) return;
    online = false;
    emit();
  });
  const auth = {
    token,
    name: config.name,
    secret: connectionSecret(url),
    ...teamIdentity.getAuth(url),
  };
  try {
    await next.connect(url, auth);
    pendingTeamConnection = null;
    await coordinator.resume();
  } catch (error) {
    if (/GitHub.*身份|GitHub.*用户/.test(error.message))
      pendingTeamConnection = { url, ...auth, remote };
    throw error;
  }
  emit();
}
async function processRuns() {
  await coordinator.process();
}
async function syncSession(sessionId) {
  if (!online || syncBusy.has(sessionId)) return;
  const s = client?.state?.sessions.find((s) => s.id === sessionId);
  const lane = s?.lanes.find((l) => l.ownerId === client.state.me.id);
  if (!s || !lane) return;
  if (
    s.lanes.some(
      (l) => l.ownerId === client.state.me.id && l.status === "running",
    )
  ) {
    syncStates.set(sessionId, {
      status: "waiting",
      message: "本机 Agent 运行中，完成后同步",
    });
    emit();
    return;
  }
  const root = config.sessionPaths[sessionId];
  if (!root) throw Error("请先创建会话独立工作树");
  const canonical = canonicalRoot(root);
  if (repoLocks.has(canonical) || rootBusy(canonical)) return;
  syncBusy.add(sessionId);
  repoLocks.add(canonical);
  try {
    await snapshots.assertSessionWorktree(root, { sessionId, allowConflicts: true });
    const conflicts = await snapshots.conflictFiles(root);
    if (conflicts.length) {
      syncStates.set(sessionId, { status: "conflict", files: conflicts });
      return;
    }
    syncStates.set(sessionId, { status: "syncing" });
    emit();
    for (const peer of s.lanes.filter(
      (l) => l.ownerId !== lane.ownerId && l.snapshot,
    )) {
      const result = await snapshots.receiveSnapshot(root, {
        sessionId,
        snapshot: peer.snapshot,
      });
      if (result.status === "conflict") {
        syncStates.set(sessionId, result);
        await client.call("snapshot.status", {
          sessionId,
          laneId: lane.id,
          status: "conflict",
        });
        return;
      }
    }
    const snapshot = await snapshots.publishSnapshot(root, {
      sessionId,
      ownerId: lane.ownerId,
    });
    if (lane.snapshot?.commit !== snapshot.commit)
      await client.call("snapshot.publish", {
        sessionId,
        laneId: lane.id,
        ...snapshot,
      });
    syncStates.set(sessionId, { status: "synced", ...snapshot });
    await client.call("snapshot.status", {
      sessionId,
      laneId: lane.id,
      status: "synced",
    });
  } catch (e) {
    const branchPaused = ["RPO_SYNC_BRANCH_MISMATCH", "RPO_SYNC_BRANCH_UNBOUND"].includes(e.code);
    syncStates.set(sessionId, {
      status: branchPaused ? "paused" : "error", message: e.message,
      ...(branchPaused ? { code: e.code, expectedBranch: e.expectedBranch, actualBranch: e.actualBranch } : {}),
    });
  } finally {
    syncBusy.delete(sessionId);
    repoLocks.delete(canonical);
    emit();
  }
}
const syncTimer = setInterval(() => {
  for (const [id, enabled] of Object.entries(config.syncSessions))
    if (enabled) syncSession(id).catch(() => {});
}, 5000);
syncTimer.unref();
const editorActivity = new Map();
async function currentBranch(args) {
  try {
    const root = localRoot(args);
    return (
      (await local.git(root, ["branch", "--show-current"])).trim() ||
      "detached/" +
        (await local.git(root, ["rev-parse", "--short", "HEAD"])).trim()
    );
  } catch {
    return undefined;
  }
}
async function publishEditorActivity(args) {
  const session = client.state.sessions.find(
      (s) => s.id === args.sessionId && s.workspaceId === args.workspaceId,
    ),
    lane = session?.lanes.find(
      (l) => l.id === args.laneId && l.ownerId === client.state.me.id,
    );
  if (!lane) throw Error("只能更新自己的文件活动");
  if (typeof args.viewId !== "string" || !/^[\w-]{1,80}$/.test(args.viewId))
    throw Error("编辑器标识无效");
  const prefix = client.state.identity.audience + ":" + lane.id + ":",
    key = prefix + args.viewId;
  const now = Date.now();
  for (const [key, value] of editorActivity)
    if (value.expires < now) editorActivity.delete(key);
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length > 20) throw Error("打开文件过多");
  for (const path of paths) await local.safePath(localRoot(args), path);
  if (paths.length) editorActivity.set(key, { paths, expires: now + 120000 });
  else editorActivity.delete(key);
  const all = [
    ...new Set(
      [...editorActivity]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, v]) => v.paths),
    ),
  ];
  return client.call("coordination.activity", {
    workspaceId: session.workspaceId,
    sessionId: session.id,
    laneId: lane.id,
    branch: await currentBranch(args),
    fileScopes: all.map((path) => ({ path, kind: "file" })),
    ttlMs: 120000,
  });
}
const hubMethods = new Set([
  "storage.retention",
  "handoff.request",
  "handoff.offline",
  "handoff.cancel",
  "handoff.reject",
  "subtask.cancel",
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
  "run.steer",
  "run.queue",
  "run.queue.cancel",
  "tool.decide",
  "outcome.resolve",
  "plan.transfer.accept",
  "plan.transfer.decline",
  "member.role",
  "member.remove",
  "plan.assign",
  "plan.claim",
  "plan.status",
  "plan.transfer",
  "comment.resolve",
  "comment.task",
  "comment.check",
  "memory.update",
  "memory.check",
  "lock.acquire",
  "lock.renew",
  "lock.release",
  "coordination.context",
  "coordination.message",
]);
async function invoke(method, a) {
  if (method === "bootstrap") return state();
  if (method === "link.open") {
    await shell.openExternal(browserURL(a.url));
    return true;
  }
  if (handlesDebugger(method))
    return debuggerService.invoke(win.webContents.id, method, a);
  if (
    [
      "language.diagnostics",
      "language.completions",
      "language.definition",
      "language.update",
      "language.close",
    ].includes(method)
  )
    return languageService[
      method === "language.close" ? "closeDocument" : method.split(".")[1]
    ](localRoot(a), a);
  if (handlesTeamIdentity(method)) {
    if (method === "team.status" && pendingTeamConnection)
      return {
        configured: true,
        github: null,
        jobs: (await teamIdentity.invoke(method, a)).jobs,
      };
    if (method === "team.begin" && pendingTeamConnection)
      return teamIdentity.beginJoin(pendingTeamConnection);
    const result = await teamIdentity.invoke(method, a);
    if (method === "team.poll" && result.status === "verified") {
      if (pendingTeamConnection) {
        const saved = pendingTeamConnection;
        remote = saved.remote;
        await connect(saved.url, saved.token);
      } else if (client)
        Object.assign(client.auth, teamIdentity.getAuth(client.url));
      emit();
    }
    return result;
  }
  if (method === "editor.activity") return publishEditorActivity(a);
  if (method === "coordination.check")
    return client.call(method, { ...a, branch: await currentBranch(a) });
  if (method === "composer.conflict.restore")
    return composerStore.restoreConflict(a);
  if (method === "composer.read") return composerStore.read(a.laneId);
  if (method === "composer.save") return composerStore.save(a);
  if (method === "composer.restore") {
    const lane = client.state.sessions
      .find((s) => s.id === a.sessionId)
      ?.lanes.find(
        (l) => l.id === a.laneId && l.ownerId === client.state.me.id,
      );
    const instruction = lane?.steering?.find((q) => q.id === a.id);
    if (
      !instruction ||
      !["failed", "unsupported", "restored"].includes(instruction.status)
    )
      throw Error("这条指导还不能恢复");
    const value = composerStore.restore({
      laneId: a.laneId,
      id: a.id,
      text: instruction.text,
      images: runImages.get(a.id) || [],
    });
    // Durable local receipt precedes shared acknowledgement; retries never duplicate text.
    try {
      await client.call("run.steer.restore", {
        sessionId: a.sessionId,
        laneId: a.laneId,
        runId: instruction.runId,
        id: a.id,
      });
    } catch (error) {
      return {
        ...value,
        warning: "草稿已恢复；共享确认待重试：" + error.message,
      };
    }
    runImages.delete(a.id);
    saveRunImages();
    return value;
  }
  if (method === "providers.images.validate") {
    const images = normalizeImages(a.images);
    for (const image of images) {
      const decoded = nativeImage.createFromBuffer(
          Buffer.from(image.data, "base64"),
        ),
        size = decoded.getSize();
      if (decoded.isEmpty() || size.width * size.height > 40000000)
        throw Error("图片无效或尺寸过大");
    }
    return images;
  }
  if (method === "draft.read") return drafts.read(a.key);
  if (method === "draft.set") return drafts.set(a.key, a.value);
  if (method === "draft.remove") return drafts.remove(a.key);
  if (method.startsWith("git.") && gitMethods.has(method.slice(4)))
    return gitService[method.slice(4)](localRoot(a), a);
  if (method === "references.capture") return captureReference(localRoot(a), a);
  if (method === "references.files") return fileReferences(localRoot(a), a);
  if (method === "references.check") return checkReferences(localRoot(a), a);
  if (method === "updates.state") return updater.getState();
  if (
    [
      "updates.check",
      "updates.download",
      "updates.cancel",
      "updates.install",
    ].includes(method)
  ) {
    if (
      method === "updates.install" &&
      (runtime.runs.size ||
        repoLocks.size ||
        [...debuggerService.records.values()].some((r) =>
          debuggerService.isBusy(r.root),
        ))
    )
      throw Error("请先等待或停止正在运行的 Agent，再安装更新");
    return updater[method.split(".")[1]]();
  }
  if (handlesTaskCoordination(method)) {
    const result = await taskCoordination.invoke(method, a);
    emit();
    return result;
  }
  if (method === "providers.acp.list") return acpStore.list();
  if (method === "providers.acp.save") {
    const p = await acpStore.save(a);
    await refreshACP();
    return p;
  }
  if (method === "providers.acp.remove") {
    if ([...runtime.runs.values()].some((r) => r.options.provider === a.id))
      throw Error("请先停止此 Provider 的执行");
    const result = await acpStore.remove(a.id);
    await refreshACP();
    return result;
  }
  if (method === "providers.acp.probe") {
    const p = await acpStore.getRuntimeConfig(a.id);
    const result = await probeACP(p, {
      cwd: a.workspaceId ? localRoot(a) : homedir(),
      env: local.localEnv(),
    });
    if (result.connected && !result.requiresAuth) {
      config.modelCatalogs[a.id] = result.models;
      saveConfig();
      emit();
    }
    return result;
  }
  if (method === "providers.custom.list") return providerStore.list();
  if (method === "providers.custom.save") {
    const result = await providerStore.save(a);
    await refreshCustomProviders();
    return result;
  }
  if (method === "providers.custom.remove") {
    const result = await providerStore.remove(a.id);
    await refreshCustomProviders();
    return result;
  }
  if (method === "providers.images.pick") {
    const chosen = await dialog.showOpenDialog(win, {
      title: "添加图片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (chosen.canceled) return [];
    if (chosen.filePaths.length > IMAGE_LIMITS.count)
      throw Error("最多添加 5 张图片");
    const images = chosen.filePaths.map((path) => {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > IMAGE_LIMITS.each)
        throw Error("单张图片不能超过 8 MB");
      const bytes = readFileSync(path),
        decoded = nativeImage.createFromBuffer(bytes),
        size = decoded.getSize();
      if (decoded.isEmpty() || size.width * size.height > 40000000)
        throw Error("图片无效或尺寸过大");
      return { name: basename(path), data: bytes.toString("base64") };
    });
    return normalizeImages(images);
  }
  if (method === "dictation.probe") return dictation.probe("zh-CN");
  if (method === "dictation.start")
    return dictation.start("zh-CN", { targetId: String(a.targetId || "") });
  if (method === "dictation.stop") return dictation.stop();
  if (method === "terminal.open")
    return terminalService.open(win.webContents.id, {
      cwd: localRoot(a),
      contextId: a.laneId || a.sessionId,
      cols: a.cols,
      rows: a.rows,
    });
  if (
    [
      "terminal.read",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
    ].includes(method)
  )
    return terminalService[method.split(".")[1]](win.webContents.id, a);
  if (
    [
      "browser.open",
      "browser.navigate",
      "browser.action",
      "browser.close",
      "browser.external",
      "browser.bounds",
    ].includes(method)
  )
    return browserService[method.split(".")[1]](win.webContents.id, a);
  if (method === "provider.models") {
    if (a.provider?.startsWith("acp-")) {
      const result = await invoke("providers.acp.probe", {
        ...a,
        id: a.provider,
      });
      if (result.requiresAuth) throw Error("请先在此 CLI 完成登录");
      return result.models;
    }

    if (a.provider?.startsWith("custom-")) {
      const p = customProviders.find((p) => p.id === a.provider);
      if (!p) throw Error("Provider 不存在");
      const models = p.models.map((id) => ({
        id,
        label: id,
        default: id === p.model,
        efforts: p.efforts || [],
      }));
      config.modelCatalogs[a.provider] = models;
      saveConfig();
      emit();
      return models;
    }
    try {
      const models = await listProviderModels(a.provider, {
        cwd: localRoot(a),
        env: local.localEnv(),
      });
      config.modelCatalogs[a.provider] = models;
      saveConfig();
      emit();
      return models;
    } catch (error) {
      if (config.modelCatalogs[a.provider]?.length)
        return config.modelCatalogs[a.provider];
      throw error;
    }
  }
  if (method === "lane.options") {
    const session = client.state.sessions.find((s) => s.id === a.sessionId);
    const lane = session?.lanes.find(
      (l) => l.id === a.laneId && l.ownerId === client.state.me.id,
    );
    if (!lane) throw Error("只能设置自己的 Agent");
    const model =
      typeof a.model === "string" ? a.model.trim().slice(0, 150) : undefined;
    const effort =
      typeof a.effort === "string" ? a.effort.slice(0, 30) : undefined;
    if (
      lane.provider.startsWith("custom-") &&
      effort &&
      !customProviders
        .find((p) => p.id === lane.provider)
        ?.efforts?.includes(effort)
    )
      throw Error("此 API 尚未配置该推理强度");
    await client.call("lane.configure", {
      sessionId: a.sessionId, laneId: lane.id,
      model: model || null, effort: effort || null,
    });
    config.laneOptions[lane.id] = { model, effort };
    saveConfig();
    emit();
    return true;
  }
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
      a = { ...a, branch: await currentBranch(a) };
      if (
        !allProviders().find(
          (p) =>
            p.id ===
            client.state.sessions
              .find((s) => s.id === a.sessionId)
              ?.lanes.find((l) => l.id === a.laneId)?.provider,
        )?.available
      )
        throw Error("请先在提供商设置中配置此 Agent");
    }
    if (["run.request", "run.queue", "run.steer"].includes(method)) {
      const { images: rawImages, ...args } = a,
        images = normalizeImages(rawImages || []);
      if (method === "run.steer") {
        args.eventId = randomUUID();
        runImages.set(args.eventId, images);
        saveRunImages();
        try {
          return await client.call(method, args);
        } catch (error) {
          // The Hub may have accepted the instruction before its reply was lost.
          // Retain attachments until reconciliation or explicit draft recovery.
          throw error;
        }
      }
      const result = await client.call(method, args);
      if (images.length) {
        runImages.set(result.id, images);
        saveRunImages();
      }
      return result;
    }
    return client.call(method, a);
  }
  if (method === "project.add") {
    const selected = await dialog.showOpenDialog(win, {
      title: "选择本地项目目录",
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
  if (method === "sync.enable") {
    const s = client.state.sessions.find((s) => s.id === a.sessionId);
    if (!s || s.workspaceId !== a.workspaceId) throw Error("会话不存在");
    const role =
      client.state.me.roles?.[s.workspaceId] ||
      (client.state.me.host ? "owner" : "editor");
    if (!["owner", "editor"].includes(role))
      throw Error("当前角色不能同步代码");
    if (a.enabled && !config.sessionPaths[s.id])
      await invoke("worktree.create", a);
    config.syncSessions[s.id] = a.enabled === true;
    saveConfig();
    emit();
    if (a.enabled) await syncSession(s.id);
    return true;
  }
  if (method === "sync.now") {
    await syncSession(a.sessionId);
    return true;
  }
  if (method === "sync.binding" || method === "sync.bind") {
    const s = client.state.sessions.find(s => s.id === a.sessionId && s.workspaceId === a.workspaceId);
    if (!s) throw Error("会话不存在");
    const root = config.sessionPaths[s.id];
    if (!root) throw Error("请先创建会话独立工作树");
    if (method === "sync.binding") return snapshots.inspectSessionWorktree(root, { sessionId: s.id });
    const role = client.state.me.roles?.[s.workspaceId] || (client.state.me.host ? "owner" : "editor");
    if (!["owner", "editor"].includes(role) || !s.lanes.some(l => l.ownerId === client.state.me.id))
      throw Error("当前角色不能绑定同步分支");
    const binding = await withRepository(root, () => snapshots.bindSessionWorktree(root, {
      sessionId: s.id, expectedBranch: a.expectedBranch, replaceExpectedBranch: a.replaceExpectedBranch,
    }));
    syncStates.set(s.id, { status: "ready", message: "已绑定同步分支" });
    emit();
    if (config.syncSessions[s.id]) await syncSession(s.id);
    return binding;
  }
  if (method === "sync.conflict")
    return snapshots.conflictVersions(localRoot(a), a.path);
  if (method === "sync.resolve") {
    if (syncBusy.has(a.sessionId)) throw Error("代码正在同步，请稍后重试");
    const result = await withRepository(localRoot(a), () =>
      snapshots.resolveConflict(localRoot(a), a),
    );
    syncStates.set(a.sessionId, result);
    emit();
    return result;
  }
  if (method === "files") return local.files(localRoot(a), a.path);
  if (method === "file.search") return fileSearchService.start(win.webContents.id, a);
  if (method === "file.search.cancel") return fileSearchService.cancel(win.webContents.id, a);
  if (method === "file.read") return local.readBound(canonicalRoot(localRoot(a)), a.path);
  if (method === "file.save")
    return local.saveBound(canonicalRoot(localRoot(a)), a.path, a.content, a.hash, a.expectedRoot);
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
  if (method === "settings.keyboard") {
    config.keyboard = validateBindings(a.bindings, process.platform);
    saveConfig();
    emit();
    return config.keyboard;
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
      role: a.role || "editor",
      ...(a.githubLogin ? { githubLogin: a.githubLogin } : {}),
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
      if (pendingTeamConnection?.url === invitation.url)
        return { needsIdentity: true };
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
      const [program, args] = shellCommand(a.command);
      const p = spawn(program, args, {
        cwd,
        env: local.localEnv(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      terminals.add(p);
      let output = "";
      const timer = setTimeout(() => {
        stopTerminal(p);
        setTimeout(() => {
          if (terminals.has(p)) {
            stopProcess(p, "SIGKILL");
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
      updater = new UpdateService({
        version: app.getVersion(),
        cacheDir: join(app.getPath("cache"), "rpo-updates"),
        execPath: process.execPath,
        isPackaged: app.isPackaged,
        appImagePath: process.env.APPIMAGE,
        onState: () => emit(),
        quit: () => app.quit(),
      });
      const dataKey = loadDesktopDataKey({
        safeStorage,
        keyFile: join(dir, "data-key.json"),
        dataDir: dir,
      });
      settingsStore = new SecureStore({ dir, key: dataKey });
      if (settingsStore.exists("client.json"))
        Object.assign(config, settingsStore.readJSON("client.json"));
      saveConfig();
      drafts = new DraftStore(settingsStore);
      composerStore = new ComposerStore(settingsStore, drafts);
      coordinator.attachStore(
        new SecureStore({ dir: join(dir, "outbox"), key: dataKey }),
      );
      if (settingsStore.exists("run-images.json"))
        for (const [id, images] of Object.entries(
          settingsStore.readJSON("run-images.json"),
        ))
          runImages.set(id, images);
      const identityVerifier =
        process.env.RPO_IDENTITY_ISSUER &&
        process.env.RPO_IDENTITY_PUBLIC_KEY_FILE
          ? createIdentityVerifier({
              issuer: process.env.RPO_IDENTITY_ISSUER,
              publicKey: readFileSync(
                process.env.RPO_IDENTITY_PUBLIC_KEY_FILE,
                "utf8",
              ),
            })
          : undefined;
      hub = new Hub(join(dir, "hub"), {
        store: new SecureStore({ dir: join(dir, "hub"), key: dataKey }),
        identityVerifier,
      });
      const localOwnerId = createHash("sha256")
        .update(config.secret)
        .digest("hex")
        .slice(0, 24);
      coordinator.migrateLegacyLocalRecords({
        hubId: hub.identity.info.audience,
        secret: config.secret,
        verify: (r) => {
          const a = hub.db.approvals.find((a) => a.id === r.runId),
            s = hub.db.sessions.find((s) => s.id === r.sessionId),
            l = s?.lanes.find((l) => l.id === r.laneId);
          return (
            !!a &&
            !!l &&
            a.ownerId === localOwnerId &&
            l.ownerId === localOwnerId &&
            a.sessionId === r.sessionId &&
            a.laneId === r.laneId &&
            a.workspaceId === r.workspaceId &&
            s.workspaceId === r.workspaceId &&
            l.activeRunId === r.runId
          );
        },
      });
      hub.on("storage-error", (error) => {
        console.error(error);
        if (win && !win.isDestroyed())
          dialog.showErrorBox("数据清理失败", error.message);
      });
      await hub.listen();
      try {
        await connect(`ws://127.0.0.1:${hub.port}`, hub.db.hostToken);
      } catch (error) {
        if (!pendingTeamConnection) throw error;
      }
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
        backgroundColor: "#121212",
        titleBarStyle:
          process.platform === "darwin" ? "hiddenInset" : "default",
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
      refreshCustomProviders().catch(console.error);
      refreshACP().catch(console.error);
      if (app.isPackaged) updater.check().catch(console.error);
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
app.on("before-quit", async (event) => {
  if (shutting) return;
  event.preventDefault();
  shutting = true;
  fileSearchService.closeAll();
  languageService.dispose();
  dictation.close();
  terminalService.closeAll();
  browserService.closeAll();
  clearInterval(syncTimer);
  accounts.close();
  tunnel.stop();
  for (const p of terminals) stopTerminal(p);
  try {
    await Promise.all([coordinationBridge.close(), coordinator.close(), debuggerService.closeAll()]);
    client?.close();
    await hub?.close();
  } catch (error) {
    console.error(error);
  } finally {
    app.quit();
  }
});
