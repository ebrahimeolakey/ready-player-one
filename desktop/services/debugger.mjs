import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath, stat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, isAbsolute, extname, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import WebSocket from "ws";
import { platformEnv, stopProcess } from "../../core/platform.mjs";
const exec = promisify(execFile);
const methods = new Set(["debug.files", "debug.source", "debug.start", "debug.read", "debug.action", "debug.breakpoint.set", "debug.breakpoint.remove", "debug.variables", "debug.stop"]);
export const handlesDebugger = method => methods.has(method);
const extensions = new Set([".js", ".mjs", ".cjs"]);
const terminalStates = new Set(["exited", "failed", "stopped"]);
const inside = (root, file) => { const path = relative(root, file); return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const trim = (value, max = 2000) => String(value ?? "").slice(0, max);
function lineNumber(value) { if (!Number.isInteger(value) || value < 1 || value > 1000000) throw Error("断点行号无效"); return value; }
async function checkedFile(root, path) {
  if (typeof path !== "string" || !path || path.length > 4000 || path.includes("\0") || isAbsolute(path)) throw Error("请选择工作区内的 JavaScript 文件");
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw Error("文件超出当前工作区");
  const file = await realpath(candidate), info = await stat(file);
  if (!inside(root, file)) throw Error("文件链接超出当前工作区");
  if (!info.isFile() || !extensions.has(extname(file).toLowerCase())) throw Error("仅支持 .js、.mjs、.cjs 文件");
  return { file, path: relative(root, file).split(sep).join("/"), info };
}
function childEnv(env) {
  const result = { ...env };
  // Hidden preload/inspect flags must not execute before the explicitly selected file.
  for (const key of Object.keys(result)) if (/^(?:NODE_OPTIONS|NODE_PATH|NODE_INSPECT_RESUME_ON_START|ELECTRON_RUN_AS_NODE|RPO_.*)$/i.test(key)) delete result[key];
  result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}
export class DebuggerService extends EventEmitter {
  constructor({ resolveContext, beforeStart = async () => {}, executable = process.execPath, env = platformEnv(), platform = process.platform } = {}) {
    super();
    if (typeof resolveContext !== "function") throw Error("调试器必须配置受信任的工作区与权限解析器");
    this.resolveContext = resolveContext; this.beforeStart = beforeStart; this.executable = executable; this.env = childEnv(env); this.platform = platform;
    this.records = new Map(); this.closedOwners = new Set(); this.starting = new Set(); this.startingRoots = new Set();
  }
  async context(ownerId, args) {
    if (ownerId === undefined || ownerId === null || this.closedOwners.has(ownerId)) throw Error("调试窗口已关闭");
    const trusted = await this.resolveContext(ownerId, args);
    if (!trusted || typeof trusted.root !== "string" || !trusted.contextId) throw Error("调试器需要当前工作区");
    const root = await realpath(trusted.root);
    if (!(await stat(root)).isDirectory()) throw Error("工作区目录不存在");
    if (this.closedOwners.has(ownerId)) throw Error("调试窗口已关闭");
    return { root, contextId: String(trusted.contextId) };
  }
  isBusy(root) { try { root = realpathSync(root); } catch { return false; } return this.startingRoots.has(root) || [...this.records.values()].some(r => r.root === root && r.process && (!r.processExited || !r.treeStopped)); }
  get(ownerId, id, context) {
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || (context && (record.root !== context.root || record.contextId !== context.contextId))) throw Error("调试会话不存在或无权访问");
    return record;
  }
  location(record, location, url = "") {
    const script = record.scripts.get(location?.scriptId), source = url || script?.url || "";
    let path = source;
    if (source.startsWith("file:")) { try { const file = fileURLToPath(source); path = inside(record.root, file) ? relative(record.root, file).split(sep).join("/") : "[外部模块]"; } catch { path = "[未知模块]"; } }
    return { path: trim(path, 4000), line: (location?.lineNumber ?? 0) + 1, column: (location?.columnNumber ?? 0) + 1 };
  }
  snapshot(record) {
    return { id: record.id, contextId: record.contextId, path: record.path, status: record.status, reason: record.reason, pauseId: record.pauseId, sequence: record.sequence, exitCode: record.exitCode, signal: record.signal, error: record.error,
      frames: record.frames.map(frame => ({ id: frame.callFrameId, name: trim(frame.functionName || "(匿名函数)", 300), ...this.location(record, frame.location, frame.url) })),
      breakpoints: [...record.breakpoints.values()].map(b => ({ ...b })), output: record.output };
  }
  changed(record) { record.sequence++; this.emit("event", record.ownerId, this.snapshot(record)); }
  output(record, data) {
    record.output = (record.output + data).slice(-128 * 1024);
    record.sequence++;
  }
  send(record, method, params = {}) {
    if (!record.ws || record.ws.readyState !== WebSocket.OPEN) return Promise.reject(Error("调试连接已关闭"));
    const id = ++record.rpcId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { record.pending.delete(id); reject(Error(`调试命令超时：${method}`)); }, 8000);
      record.pending.set(id, { resolve, reject, timeout });
      record.ws.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timeout); record.pending.delete(id); reject(error); } });
    });
  }
  receive(record, data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { void this.stop(record).catch(() => {}); return; }
    if (message.id) {
      const pending = record.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timeout); record.pending.delete(message.id);
      if (message.error) pending.reject(Error(trim(message.error.message))); else pending.resolve(message.result || {});
      return;
    }
    const params = message.params || {};
    if (message.method === "Debugger.scriptParsed") {
      if (record.scripts.size < 10000) record.scripts.set(params.scriptId, { url: params.url });
    } else if (message.method === "Debugger.paused") {
      record.status = "paused"; record.reason = trim(params.reason); record.frames = (params.callFrames || []).slice(0, 100); record.pauseId++; this.changed(record);
    } else if (message.method === "Debugger.resumed") {
      record.frames = []; record.status = "running"; record.reason = ""; record.pauseId++; this.changed(record);
    } else if (message.method === "Debugger.breakpointResolved") {
      const breakpoint = record.breakpoints.get(params.breakpointId);
      if (breakpoint) { breakpoint.resolved = true; breakpoint.actualLine = this.location(record, params.location).line; this.changed(record); }
    }
  }
  async connect(record, url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password) throw Error("调试器必须只连接本机子进程");
    const socket = record.ws = new WebSocket(url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 8000 });
    socket.on("message", data => this.receive(record, data));
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const pending of record.pending.values()) { clearTimeout(pending.timeout); pending.reject(Error("调试连接已关闭")); }
      record.pending.clear();
      if (!record.stopping && !record.finishing && !terminalStates.has(record.status)) {
        record.error = "调试连接意外断开，进程已停止";
        void this.stop(record, "failed");
      }
    });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    await this.send(record, "Runtime.enable");
    await this.send(record, "Debugger.enable");
    await this.send(record, "Debugger.setPauseOnExceptions", { state: "uncaught" });
  }
  async setBreakpoint(record, path, line) {
    lineNumber(line);
    const selected = await checkedFile(record.root, path);
    const existing = [...record.breakpoints.values()].find(b => b.path === selected.path && b.line === line);
    if (existing) return existing;
    if (record.breakpoints.size >= 200) throw Error("最多设置 200 个断点");
    const result = await this.send(record, "Debugger.setBreakpointByUrl", { url: pathToFileURL(selected.file).href, lineNumber: line - 1 });
    const breakpoint = { id: result.breakpointId, path: selected.path, line, resolved: Boolean(result.locations?.length), actualLine: result.locations?.[0]?.lineNumber + 1 || null };
    record.breakpoints.set(breakpoint.id, breakpoint); this.changed(record); return breakpoint;
  }
  async start(ownerId, context, args) {
    if (this.starting.has(ownerId) || this.startingRoots.has(context.root)) throw Error("调试器正在启动");
    if (this.isBusy(context.root)) throw Error("当前工作区已有调试进程");
    if ([...this.records.values()].some(r => r.ownerId === ownerId && r.process && (!r.processExited || !r.treeStopped))) throw Error("请先停止当前调试");
    if ([...this.records.values()].filter(r => !terminalStates.has(r.status)).length >= 6) throw Error("调试进程数量已达到上限");
    this.starting.add(ownerId); this.startingRoots.add(context.root);
    let record;
    try {
      await this.beforeStart(context.root, ownerId, args);
      const selected = await checkedFile(context.root, args.path);
      const breakpoints = args.breakpoints ?? [];
      if (!Array.isArray(breakpoints) || breakpoints.length > 200) throw Error("断点列表无效");
      for (const b of breakpoints) { lineNumber(b.line); await checkedFile(context.root, b.path || selected.path); }
      if (this.closedOwners.has(ownerId)) throw Error("调试窗口已关闭");
      for (const [id, old] of this.records) if (old.ownerId === ownerId && terminalStates.has(old.status)) this.records.delete(id);
      record = { id: randomUUID(), ownerId, ...context, path: selected.path, status: "starting", frames: [], pauseId: 0, sequence: 0, scripts: new Map(), breakpoints: new Map(), pending: new Map(), rpcId: 0, output: "", reason: "", error: "", exitCode: null };
      this.records.set(record.id, record);
      const child = record.process = spawn(this.executable, ["--inspect-brk=127.0.0.1:0", "--", selected.file], { cwd: context.root, env: this.env, detached: this.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      record.exited = new Promise(resolve => { record.resolveExit = resolve; });
      record.processExited = false; record.treeStopped = false;
      child.once("exit", (code, signal) => {
        record.processExited = true; record.exitCode = code; record.signal = signal; record.frames = [];
        if (!record.stopping) record.status = record.error ? "failed" : "exited";
        record.ws?.terminate(); this.changed(record); record.resolveExit();
        // Clean descendants that outlived the launched script, including stubborn ones.
        void this.killTree(record, "SIGKILL").then(() => this.waitTree(record)).catch(error => { record.error = error.message; this.changed(record); });
      });
      child.once("error", error => { record.error = trim(error.message); record.status = "failed"; record.processExited = true; record.treeStopped = true; record.resolveExit(); this.changed(record); });
      child.stdout.on("data", chunk => this.output(record, String(chunk)));
      let stderrBuffer = "", urlResolved = false;
      const inspectorUrl = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Node.js 未能开启本机调试端口")), 8000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); if (!urlResolved) reject(Error("调试进程在连接前退出")); });
        child.stderr.on("data", chunk => {
          stderrBuffer += String(chunk);
          if (stderrBuffer.length > 256 * 1024) stderrBuffer = stderrBuffer.slice(-256 * 1024);
          const lines = stderrBuffer.split(/\r?\n/); stderrBuffer = lines.pop();
          for (const line of lines) {
            const match = line.match(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)$/);
            if (match && !urlResolved) { urlResolved = true; clearTimeout(timer); resolve(match[1]); }
            else if (line === "Waiting for the debugger to disconnect...") { record.finishing = true; record.ws?.close(); }
            else if (!line.startsWith("Debugger attached.") && !line.startsWith("For help, see: https://nodejs.org/")) this.output(record, line + "\n");
          }
        });
      });
      await this.connect(record, await inspectorUrl);
      for (const b of breakpoints) await this.setBreakpoint(record, b.path || selected.path, b.line);
      await this.send(record, "Runtime.runIfWaitingForDebugger");
      const deadline = Date.now() + 8000;
      while (record.status === "starting" && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      if (record.status === "starting") throw Error("调试器未能暂停在入口");
      return this.snapshot(record);
    } catch (error) { if (record) { record.error = trim(error.message); await this.stop(record, "failed"); } throw error; }
    finally { this.starting.delete(ownerId); this.startingRoots.delete(context.root); }
  }
  async killTree(record, signal) {
    if (this.platform === "win32" && record.process?.pid) {
      try { await exec("taskkill.exe", ["/pid", String(record.process.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); }
      catch (error) { if (!record.processExited) throw Error("无法确认调试进程树退出：" + trim(error.message)); }
    } else stopProcess(record.process, signal, this.platform);
  }
  async waitTree(record) {
    if (this.platform !== "win32" && record.process?.pid) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { process.kill(-record.process.pid, 0); }
        catch (error) { if (error.code === "ESRCH") break; throw error; }
        if (Date.now() >= deadline) throw Error("调试进程树尚未确认退出");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (record.processExited) record.treeStopped = true;
  }
  async stop(record, status = "stopped") {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      record.status = "stopping"; record.frames = []; record.pauseId++;
      record.ws?.terminate();
      await this.killTree(record, "SIGTERM");
      if (!record.processExited) await Promise.race([record.exited, new Promise(resolve => setTimeout(resolve, 500))]);
      await this.killTree(record, "SIGKILL");
      if (!record.processExited) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("调试进程尚未确认退出")), 5000);
        record.exited.then(() => { clearTimeout(timer); resolve(); });
      });
      await this.waitTree(record);
      record.status = status; this.changed(record);
      return this.snapshot(record);
    })();
    return record.stopping;
  }
  async invoke(ownerId, method, args = {}) {
    if (!methods.has(method)) throw Error("不支持的调试操作");
    const context = await this.context(ownerId, args);
    if (method === "debug.files") {
      const files = [], queue = [context.root]; let visited = 0;
      while (queue.length && visited < 10000 && files.length < 1000) {
        const directory = queue.shift(), entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (++visited > 10000 || files.length >= 1000) break;
          if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name) || entry.isSymbolicLink()) continue;
          const file = resolve(directory, entry.name);
          if (entry.isDirectory()) queue.push(file);
          else if (entry.isFile() && extensions.has(extname(file).toLowerCase())) files.push(relative(context.root, file).split(sep).join("/"));
        }
      }
      return { files: files.sort(), truncated: Boolean(queue.length || visited >= 10000 || files.length >= 1000) };
    }
    if (method === "debug.source") {
      const file = await checkedFile(context.root, args.path);
      if (file.info.size > 512 * 1024) throw Error("文件超过调试预览大小限制");
      return { path: file.path, text: await readFile(file.file, "utf8") };
    }
    if (method === "debug.start") return this.start(ownerId, context, args);
    if (method === "debug.read" && !args.id) {
      const record = [...this.records.values()].find(r => r.ownerId === ownerId && r.root === context.root && r.contextId === context.contextId);
      return record ? this.snapshot(record) : null;
    }
    const record = this.get(ownerId, args.id, context);
    if (method === "debug.read") return this.snapshot(record);
    if (method === "debug.stop") return this.stop(record);
    if (terminalStates.has(record.status)) throw Error("调试进程已结束");
    if (method === "debug.breakpoint.set") { await this.setBreakpoint(record, args.path, args.line); return this.snapshot(record); }
    if (method === "debug.breakpoint.remove") {
      if (!record.breakpoints.has(args.breakpointId)) throw Error("断点不存在");
      await this.send(record, "Debugger.removeBreakpoint", { breakpointId: args.breakpointId }); record.breakpoints.delete(args.breakpointId); this.changed(record); return this.snapshot(record);
    }
    if (method === "debug.action") {
      if (!["pause", "resume", "stepOver", "stepInto", "stepOut"].includes(args.action)) throw Error("不支持的调试指令");
      if (args.action === "pause" ? record.status !== "running" : record.status !== "paused") throw Error("当前状态不能执行此调试操作");
      await this.send(record, `Debugger.${args.action}`); return this.snapshot(record);
    }
    if (method === "debug.variables") {
      if (record.status !== "paused" || args.pauseId !== record.pauseId) throw Error("暂停位置已改变，请重新选择调用栈");
      const frame = record.frames.find(f => f.callFrameId === args.frameId);
      if (!frame) throw Error("调用栈帧不存在");
      const pauseId = record.pauseId, scopes = [];
      for (const scope of frame.scopeChain.slice(0, 12)) {
        // Never enumerate real global/with objects or call accessors/evaluate expressions.
        if (!["local", "closure", "block", "catch", "script", "module"].includes(scope.type) || !scope.object.objectId) continue;
        const result = await this.send(record, "Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true, generatePreview: false });
        const values = (result.result || []).slice(0, 200).map(property => ({ name: trim(property.name, 300), type: property.value?.type || "accessor", value: property.get || property.set ? "[访问器]" : trim(property.value?.unserializableValue ?? property.value?.value ?? property.value?.description ?? property.value?.type, 2000) }));
        scopes.push({ name: trim(scope.name || scope.type, 300), type: scope.type, values, truncated: (result.result || []).length > 200 });
      }
      if (record.pauseId !== pauseId || record.status !== "paused") throw Error("暂停位置已改变，请重新选择调用栈");
      return { pauseId, frameId: args.frameId, scopes };
    }
  }
  async closeOwner(ownerId) {
    this.closedOwners.add(ownerId);
    await Promise.all([...this.records.values()].filter(r => r.ownerId === ownerId).map(r => this.stop(r)));
    for (const [id, record] of this.records) if (record.ownerId === ownerId) this.records.delete(id);
  }
  async closeAll() { await Promise.all([...new Set([...this.records.values()].map(r => r.ownerId).concat([...this.starting]))].map(ownerId => this.closeOwner(ownerId))); }
}
