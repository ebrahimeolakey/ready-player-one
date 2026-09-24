import { Worker } from "node:worker_threads";

/** Run TypeScript analysis outside Electron's main/UI threads. Roots must be resolved by the caller's workspace authorization. */
export class LanguageService {
  constructor({ timeout = 20000 } = {}) {
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
    this.worker = null;
  }
  ensureWorker() {
    if (this.worker) return;
    const worker = new Worker(
      new URL("./language-worker.mjs", import.meta.url),
    );
    this.worker = worker;
    worker.on("message", ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      error ? request.reject(new Error(error)) : request.resolve(result);
    });
    worker.on("error", (error) => this.fail(worker, error));
    worker.on("exit", (code) =>
      this.fail(worker, new Error(`语言服务已退出 (${code})`)),
    );
  }
  fail(worker, error) {
    if (worker !== this.worker) return;
    this.worker = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    void worker.terminate();
  }
  request(method, root, args = {}) {
    this.ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            this.worker,
            new Error("语言服务分析超时；下次请求将重新启动"),
          ),
        this.timeout,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, root, args });
    });
  }
  diagnostics(root, args) {
    return this.request("diagnostics", root, args);
  }
  completions(root, args) {
    return this.request("completions", root, args);
  }
  definition(root, args) {
    return this.request("definition", root, args);
  }
  update(root, args) {
    return this.request("update", root, args);
  }
  closeDocument(root, args) {
    return this.request("close", root, args);
  }
  async dispose() {
    if (this.worker) {
      const worker = this.worker;
      this.fail(worker, new Error("语言服务已关闭"));
      await worker.terminate();
    }
  }
}
