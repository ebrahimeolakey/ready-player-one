import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** JSONL subprocess transport. Never invokes a shell; owns the entire process tree. */
export class JsonLineProcess extends EventEmitter {
  constructor(
    command,
    args,
    { cwd, env = process.env, maxLineBytes = 8 * 1024 * 1024 } = {},
  ) {
    super();
    this.closed = false;
    this.stderr = "";
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > maxLineBytes)
          return this.fail(new Error("Provider message exceeds size limit"));
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new Error("Provider returned invalid JSON"));
          return;
        }
        this.emit("message", message);
      }
      if (Buffer.byteLength(buffer) > maxLineBytes)
        this.fail(new Error("Provider message exceeds size limit"));
    });
    this.child.stderr.on("data", (data) => {
      this.stderr = (this.stderr + data.toString()).slice(-8000);
    });
    this.child.stdin.on("error", (error) => this.emit("failure", error));
    this.child.on("error", (error) => this.emit("failure", error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.resolveExit();
      if (buffer.trim()) {
        try {
          this.emit("message", JSON.parse(buffer));
        } catch {
          this.emit("failure", new Error("Truncated provider message"));
        }
      }
      this.emit("close", { code, signal, stderr: this.stderr });
    });
  }
  write(message) {
    if (this.closed || this.child.stdin.destroyed)
      throw new Error("Provider connection is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  fail(error) {
    this.emit("failure", error);
    this.close();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const pid = this.child.pid;
    if (!pid) return this.closePromise = this.exitPromise;
    if (process.platform === "win32") {
      // taskkill /T terminates CLI-spawned descendants as well as the parent.
      this.closePromise = new Promise(resolve => {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        });
        killer.once("error", () => { this.child.kill(); resolve(); });
        killer.once("close", resolve);
      }).then(() => this.exitPromise);
    } else {
      // Waiting for the direct child's close is insufficient: its descendants can
      // ignore SIGTERM, close stdio and continue writing in the same process group.
      this.closePromise = new Promise(resolve => {
        let timer;
        const signal = value => { try { process.kill(-pid, value); return true; } catch (error) { return error.code !== "ESRCH"; } };
        signal("SIGTERM");
        const killTimer = setTimeout(() => signal("SIGKILL"), 1500);
        const check = () => {
          if (!signal(0)) { clearTimeout(killTimer); clearTimeout(timer); resolve(); }
          else timer = setTimeout(check, 20);
        };
        check();
      }).then(() => this.exitPromise);
    }
    return this.closePromise;
  }
}

export class Requests {
  constructor(send, timeoutMs = 30000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
  }
  request(build) {
    const id = `rpo-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Provider request timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(build(id));
      } catch (error) {
        this.resolve(id, undefined, error);
      }
    });
  }
  resolve(id, result, error) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error)
      entry.reject(
        error instanceof Error
          ? error
          : new Error(error.message || String(error)),
      );
    else entry.resolve(result);
    return true;
  }
  close(error = new Error("Provider connection closed")) {
    for (const id of this.pending.keys()) this.resolve(id, undefined, error);
  }
}
