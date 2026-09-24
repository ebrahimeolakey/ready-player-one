import { useEffect, useState } from "react";
import { ArrowDownToLine, Check, LoaderCircle, RefreshCw } from "lucide-react";
import type { Call } from "./ui";
export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  currentVersion: string;
  version?: string | null;
  progress?: number;
  size?: number;
  error?: string | null;
}
export function UpdatePanel({
  call,
  state: provided,
}: {
  call: Call;
  state?: UpdateState;
}) {
  const [state, setState] = useState<UpdateState>(
      provided || { status: "idle", currentVersion: "" },
    ),
    [error, setError] = useState("");
  useEffect(() => {
    if (provided) setState(provided);
  }, [provided]);
  useEffect(() => {
    if (!provided)
      void call("updates.state")
        .then(setState)
        .catch((error) => setError(error.message));
  }, []);
  // Hosts should pass their subscribed local update state for download progress.
  async function action(method: string) {
    setError("");
    try {
      const result = await call(method);
      if (result?.status) setState(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "更新失败");
    }
  }
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const labels: Record<string, string> = {
    idle: "检查更新",
    checking: "检查中",
    available: "下载更新",
    current: "已是最新版本",
    downloading: `下载中 ${state.progress || 0}%`,
    ready: "安装并重启",
    installing: "正在安装",
    error: "重新检查",
  };
  const method =
    state.status === "available"
      ? "updates.download"
      : state.status === "ready"
        ? "updates.install"
        : "updates.check";
  return (
    <section className="setting-card">
      <RefreshCw size={18} />
      <div className="grow">
        <strong>
          应用更新{state.currentVersion && ` · ${state.currentVersion}`}
        </strong>
        <small>
          {state.version ? `新版本 ${state.version}` : "来自官方 GitHub 发布"}
        </small>
        {(error || state.error) && (
          <small className="provider-error" role="alert">
            {error || state.error}
          </small>
        )}
      </div>
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => void action(method)}
      >
        {busy ? (
          <LoaderCircle size={13} className="spin" />
        ) : state.status === "current" ? (
          <Check size={13} />
        ) : state.status === "available" ? (
          <ArrowDownToLine size={13} />
        ) : null}
        {labels[state.status] || "检查更新"}
      </button>
      {state.status === "downloading" && (
        <button
          className="button"
          type="button"
          onClick={() => void action("updates.cancel")}
        >
          取消
        </button>
      )}
    </section>
  );
}
