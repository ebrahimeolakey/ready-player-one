import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function dictationHelperPath({ appPath, resourcesPath, isPackaged }) {
  return isPackaged
    ? join(resourcesPath, "rpo-dictation")
    : join(appPath, "release", "native", "rpo-dictation");
}
import { JsonLineProcess } from "../../core/providers/transport.mjs";

/** macOS native helper. Probe is read-only; start must be user initiated. */
export class DictationService {
  constructor({ helperPath, platform = process.platform, onEvent = () => {} }) {
    this.helperPath = helperPath;
    this.platform = platform;
    this.onEvent = onEvent;
    this.active = null;
  }
  async probe(locale = "zh-CN") {
    if (this.platform !== "darwin")
      return { supported: false, reason: "当前语音输入仅支持 macOS" };
    try {
      await access(this.helperPath, constants.X_OK);
    } catch {
      return { supported: false, reason: "此安装包未包含本机语音组件" };
    }
    return new Promise((resolve) => {
      const child = new JsonLineProcess(this.helperPath, [
        "--probe",
        "--locale",
        locale,
      ]);
      let done = false;
      const end = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.close();
        resolve(result);
      };
      const timer = setTimeout(
        () => end({ supported: false, reason: "语音组件未响应" }),
        5000,
      );
      child.on("message", (event) => {
        if (event.type === "capability")
          end({
            supported: Boolean(event.available && event.onDevice),
            ...event,
            ...(!event.onDevice
              ? { reason: "当前语言的本机语音资源不可用" }
              : {}),
          });
      });
      child.on("failure", () =>
        end({ supported: false, reason: "无法启动语音组件" }),
      );
      child.on("close", () =>
        end({ supported: false, reason: "语音组件提前退出" }),
      );
    });
  }
  async start(locale = "zh-CN", { targetId = "" } = {}) {
    if (this.active || this.starting) throw new Error("正在录音");
    if (this.closed) throw new Error("语音组件已关闭");
    this.starting = true;
    let capability;
    try {
      capability = await this.probe(locale);
    } finally {
      this.starting = false;
    }
    if (this.closed) throw new Error("语音组件已关闭");
    if (!capability.supported)
      throw new Error(capability.reason || "本机语音不可用");
    const child = new JsonLineProcess(this.helperPath, ["--locale", locale]);
    this.active = child;
    const sessionId = randomUUID();
    const emit = (event) => this.onEvent({ ...event, sessionId, targetId });
    child.on("message", emit);
    child.on("failure", () =>
      emit({ type: "error", message: "语音组件连接失败" }),
    );
    child.on("close", () => {
      if (this.active === child) this.active = null;
      emit({ type: "closed" });
    });
    return { started: true, sessionId };
  }
  stop() {
    this.active?.write({ method: "stop" });
    return { ok: true };
  }
  close() {
    this.closed = true;
    this.active?.close();
    this.active = null;
  }
}
