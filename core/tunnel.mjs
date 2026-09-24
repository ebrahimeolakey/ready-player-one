import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { localEnv } from "./local.mjs";
export function tunnelAddress(text) {
  return text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] || null;
}
export function parseInvitation(value) {
  const u = new URL(String(value).trim());
  if (u.protocol !== "rpo:" || u.hostname !== "join")
    throw Error("请输入有效的 rpo://join 邀请");
  const token = u.searchParams.get("token");
  if (!/^[a-f0-9]{64}$/.test(token || "")) throw Error("邀请凭据无效");
  const secure = u.searchParams.get("server");
  let url;
  if (secure) {
    const endpoint = new URL(secure);
    if (
      endpoint.protocol !== "wss:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search ||
      endpoint.pathname !== "/"
    )
      throw Error("互联网邀请必须使用有效的加密 WSS 地址");
    url = endpoint.toString();
  } else {
    const host = u.searchParams.get("host"),
      port = Number(u.searchParams.get("port"));
    if (
      !host ||
      !/^[-a-zA-Z0-9.]+$/.test(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw Error("邀请地址不完整");
    url = `ws://${host}:${port}`;
  }
  return { url, token, sessionId: u.searchParams.get("session") };
}
export function makeInvitation({ server, host, port, token, sessionId }) {
  const url = new URL("rpo://join");
  if (server) url.searchParams.set("server", server);
  else {
    url.searchParams.set("host", host);
    url.searchParams.set("port", String(port));
  }
  url.searchParams.set("token", token);
  if (sessionId) url.searchParams.set("session", sessionId);
  return url.toString();
}
export class Tunnel extends EventEmitter {
  constructor({ spawnProcess = spawn } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.state = { status: "off", url: null, message: "尚未开启互联网共享" };
  }
  async start(port) {
    if (this.state.status === "ready" && this.child) return this.state.url;
    if (this.pending) return this.pending;
    this.state = {
      status: "starting",
      url: null,
      message: "正在建立 Cloudflare 加密通道……",
    };
    this.emit("change");
    this.pending = new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        "cloudflared",
        [
          "tunnel",
          "--url",
          `http://127.0.0.1:${port}`,
          "--no-autoupdate",
          "--protocol",
          "http2",
          "--edge-ip-version",
          "4",
        ],
        { env: localEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
      this.child = child;
      let buffer = "",
        settled = false,
        url = null,
        connected = false;
      const fail = (message) => {
        this.state = { status: "error", url: null, message };
        this.emit("change");
        if (!settled) {
          settled = true;
          reject(Error(message));
        }
      };
      this.cancelStart = () => {
        if (!settled) {
          settled = true;
          reject(Error("互联网共享已取消"));
        }
      };
      const timer = setTimeout(() => {
        fail("建立互联网通道超时，请检查网络后重试");
        this.stop(false);
      }, 60000);
      timer.unref?.();
      const receive = (d) => {
        buffer = (buffer + d.toString()).slice(-16000);
        url = tunnelAddress(buffer) || url;
        connected = /Registered tunnel connection/.test(buffer) || connected;
        if (url && connected && !settled) {
          settled = true;
          clearTimeout(timer);
          this.state = {
            status: "ready",
            url,
            message: "互联网通道在线 · 房主需保持应用打开",
          };
          this.emit("change");
          resolve(url);
        }
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.on("error", (e) => {
        clearTimeout(timer);
        fail(
          e.code === "ENOENT"
            ? "请先安装互联网协作组件"
            : "互联网协作组件启动失败：" + e.message,
        );
      });
      child.on("close", () => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.child = null;
        if (this.state.status !== "off")
          fail("互联网通道已断开，请重新生成邀请");
      });
    }).finally(() => {
      this.pending = null;
      this.cancelStart = null;
    });
    return this.pending;
  }
  stop(notify = true) {
    this.cancelStart?.();
    const child = this.child;
    this.child = null;
    if (child)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill?.();
      }
    if (notify) {
      this.state = { status: "off", url: null, message: "互联网共享已关闭" };
      this.emit("change");
    }
  }
}
