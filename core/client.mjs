import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
export class HubClient extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.state = null;
    this.closed = false;
  }
  async connect(url, auth) {
    clearTimeout(this.retry);
    this.ws?.close();
    this.url = url;
    this.auth = auth;
    this.closed = false;
    this.ws = new WebSocket(url, {
      maxPayload: 32 * 1024 * 1024,
      handshakeTimeout: 15000,
    });
    const socket = this.ws;
    socket.on("message", (raw) => {
      if (this.ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object") throw Error("Invalid response");
      } catch {
        socket.close(1008, "无效协作响应");
        return;
      }
      if (msg.event === "state") {
        this.state = msg.data;
        this.emit("state", msg.data);
      } else {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          msg.error ? p.reject(Error(msg.error)) : p.resolve(msg.result);
        }
      }
    });
    socket.on("close", (code) => {
      if (this.ws !== socket) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("协作连接已断开"));
      }
      this.pending.clear();
      this.emit("offline", code);
      if (!this.closed)
        this.retry = setTimeout(
          () => this.connect(this.url, this.auth).catch(() => {}),
          3000,
        );
    });
    socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(Error("协作连接已断开")));
    });
    try {
      this.state = await this.call("auth", auth);
      this.emit("state", this.state);
      return this.state;
    } catch (e) {
      this.closed = true;
      socket.close();
      throw e;
    }
  }
  call(method, args = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(Error("协作服务未连接"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("协作服务响应超时"));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, args }));
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }
}
