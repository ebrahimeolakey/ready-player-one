import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { platformEnv, shellCommand } from "../../core/platform.mjs";
const require = createRequire(import.meta.url);
const LIMIT = 512 * 1024;
export function interactiveShell(
  platform = process.platform,
  env = process.env,
) {
  return [
    shellCommand("", platform)[0],
    platform === "win32" ? ["-NoLogo", "-NoProfile"] : ["-l"],
  ];
}
function dimensions(cols = 80, rows = 24) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    cols > 500 ||
    rows < 2 ||
    rows > 300
  )
    throw Error("终端尺寸无效");
  return { cols, rows };
}
export class TerminalService extends EventEmitter {
  constructor({
    spawnPty,
    platform = process.platform,
    env = platformEnv(),
  } = {}) {
    super();
    this.spawnPty = spawnPty;
    this.platform = platform;
    this.env = env;
    this.terminals = new Map();
    this.closedOwners = new Set();
  }
  async open(ownerId, { cwd, contextId = "", cols = 80, rows = 24 }) {
    if (this.terminals.size >= 12) throw Error("最多同时打开 12 个终端");
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw Error("终端需要项目文件夹");
    if (this.closedOwners.has(ownerId)) throw Error("终端窗口已关闭");
    if (this.terminals.size >= 12) throw Error("最多同时打开 12 个终端");
    const size = dimensions(cols, rows);
    const spawn = this.spawnPty || require("node-pty").spawn;
    const [shell, args] = interactiveShell(this.platform, this.env);
    const process = spawn(shell, args, {
      name: "xterm-256color",
      cwd: root,
      env: { ...this.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      ...size,
    });
    const id = randomUUID();
    const record = {
      id,
      ownerId,
      contextId,
      process,
      data: "",
      pending: "",
      sequence: 0,
      exitCode: null,
      exited: false,
      timer: null,
      disposables: [],
    };
    this.terminals.set(id, record);
    record.disposables.push(
      process.onData((data) => {
        record.data = (record.data + data).slice(-LIMIT);
        record.pending += data;
        if (record.pending.length > LIMIT) process.pause();
        if (!record.timer)
          record.timer = setTimeout(() => this.flush(record), 16);
      }),
    );
    record.disposables.push(
      process.onExit(({ exitCode, signal }) => {
        this.flush(record);
        record.exited = true;
        record.exitCode = exitCode;
        this.emit("event", ownerId, {
          kind: "terminal",
          type: "exit",
          id,
          exitCode,
          signal,
          sequence: ++record.sequence,
        });
      }),
    );
    return { id, contextId, ...size };
  }
  get(ownerId, id) {
    const r = this.terminals.get(id);
    if (!r || r.ownerId !== ownerId) throw Error("终端不存在或无权访问");
    return r;
  }
  flush(r) {
    clearTimeout(r.timer);
    r.timer = null;
    if (!r.pending) return;
    const data = r.pending;
    r.pending = "";
    this.emit("event", r.ownerId, {
      kind: "terminal",
      type: "data",
      id: r.id,
      data,
      sequence: ++r.sequence,
    });
    if (!r.exited) r.process.resume();
  }
  read(ownerId, { id }) {
    const r = this.get(ownerId, id);
    this.flush(r);
    return {
      id,
      data: r.data,
      sequence: r.sequence,
      exited: r.exited,
      exitCode: r.exitCode,
    };
  }
  input(ownerId, { id, data }) {
    const r = this.get(ownerId, id);
    if (r.exited) throw Error("终端已退出");
    if (typeof data !== "string" || data.length > 65536)
      throw Error("终端输入过长");
    r.process.write(data);
    return true;
  }
  resize(ownerId, { id, cols, rows }) {
    const r = this.get(ownerId, id);
    dimensions(cols, rows);
    if (!r.exited) r.process.resize(cols, rows);
    return true;
  }
  close(ownerId, { id }) {
    const r = this.get(ownerId, id);
    clearTimeout(r.timer);
    for (const disposable of r.disposables) disposable.dispose();
    if (!r.exited) r.process.kill();
    this.terminals.delete(id);
    return true;
  }
  closeOwner(ownerId) {
    this.closedOwners.add(ownerId);
    for (const r of this.terminals.values())
      if (r.ownerId === ownerId) this.close(ownerId, { id: r.id });
  }
  closeAll() {
    for (const r of this.terminals.values())
      this.close(r.ownerId, { id: r.id });
  }
}
