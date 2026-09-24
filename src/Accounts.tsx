import { useState } from "react";
import {
  Code2,
  Github,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
  Globe,
} from "lucide-react";
import type { State } from "./types";
type Call = (method: string, args?: Record<string, unknown>) => Promise<any>;
const names: Record<string, string> = {
  codex: "OpenAI Codex",
  claude: "Claude Code",
  github: "GitHub",
};
export function Accounts({
  state,
  call,
  onRepos,
}: {
  state: State;
  call: Call;
  onRepos: () => void;
}) {
  const [selected, setSelected] = useState(""),
    [code, setCode] = useState("");
  const accounts = state.local.accounts || [];
  const job = state.local.authJobs?.find((j) => j.id === selected);
  return (
    <>
      <div className="settings-section">
        <div className="account-heading">
          <div>
            <h2>账号与授权</h2>
            <p>登录你自己的账号。授权在官方页面完成，凭据由本机 CLI 保存。</p>
          </div>
          <button
            className="button"
            disabled={state.local.accountLoading}
            onClick={() => call("accounts.refresh")}
          >
            <RefreshCw
              size={14}
              className={state.local.accountLoading ? "spin" : ""}
            />
            刷新
          </button>
        </div>
        {["codex", "claude", "github"].map((id) => {
          const a = accounts.find((v) => v.id === id),
            install = state.local.installations?.find((j) => j.id === id),
            auth = state.local.authJobs?.find((j) => j.id === id);
          return (
            <div className="account-card" key={id}>
              <div className={"provider-icon " + id}>
                {id === "codex" ? (
                  <Code2 />
                ) : id === "github" ? (
                  <Github />
                ) : (
                  <span>✳</span>
                )}
              </div>
              <div className="account-detail">
                <strong>{names[id]}</strong>
                <small>
                  {state.local.accountLoading && !a ? (
                    "正在检查本机账号……"
                  ) : a?.authenticated ? (
                    <>
                      <Check size={11} />
                      {a.label}
                      {a.plan ? " · " + a.plan : ""}
                    </>
                  ) : (
                    a?.label || "尚未安装"
                  )}
                </small>
                <small className="account-version">
                  {a?.version || "支持在应用内安装官方 CLI，无需 Node.js"}
                </small>
                {install && (
                  <div className={"install-progress " + install.status}>
                    {install.status === "running" && (
                      <LoaderCircle size={12} className="spin" />
                    )}
                    {install.message}
                  </div>
                )}
              </div>
              <div className="account-actions">
                {a?.available ? (
                  <>
                    <span
                      className={"tag " + (a.authenticated ? "green" : "amber")}
                    >
                      {a.authenticated ? "已授权" : "需要登录"}
                    </span>
                    <button
                      className="button"
                      onClick={async () => {
                        setSelected(id);
                        if (auth?.status !== "running")
                          await call("accounts.login", { id });
                      }}
                    >
                      {auth?.status === "running"
                        ? "查看登录进度"
                        : a.authenticated
                          ? "重新登录"
                          : "登录账号"}
                    </button>
                    {id === "github" && a.authenticated && (
                      <button className="button primary" onClick={onRepos}>
                        选择仓库
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="button"
                    disabled={
                      state.local.accountLoading ||
                      install?.status === "running"
                    }
                    onClick={() => call("tools.install", { id })}
                  >
                    <Download size={14} />
                    {install?.status === "running"
                      ? "正在安装"
                      : "安装官方 CLI"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div className="account-notice">
          <ShieldCheck size={15} />
          <span>
            Codex 与 Claude 的模型调用使用你自己的订阅或 API 额度；GitHub
            授权用于读取、克隆你有权访问的仓库。账号详情和登录信息不会同步给协作者。
          </span>
        </div>
      </div>
      <div className="settings-section">
        <div className="account-heading">
          <div>
            <h2>互联网协作</h2>
            <p>
              通过 Cloudflare
              临时加密通道，让不同网络的同事直接加入。房主需保持应用打开。
            </p>
          </div>
          <Globe size={23} />
        </div>
        <div className="network-settings">
          <span
            className={
              "tag " + (state.local.tunnel?.status === "ready" ? "green" : "")
            }
          >
            {state.local.tunnel?.status === "ready"
              ? "互联网共享在线"
              : state.local.tunnel?.installed
                ? "组件已安装"
                : "尚未安装组件"}
          </span>
          <button
            className="button"
            disabled={state.local.installations?.some(
              (j) => j.id === "cloudflared" && j.status === "running",
            )}
            onClick={() => call("tools.install", { id: "cloudflared" })}
          >
            <Download size={14} />
            {state.local.tunnel?.installed
              ? "更新协作组件"
              : "安装互联网协作组件"}
          </button>
          {state.local.tunnel?.status === "ready" && (
            <button
              className="button"
              onClick={() => call("share.stopInternet")}
            >
              关闭互联网共享
            </button>
          )}
        </div>
        {state.local.installations
          ?.filter((j) => j.id === "cloudflared")
          .map((j) => (
            <p className="install-progress" key={j.id}>
              {j.status === "running" && (
                <LoaderCircle size={13} className="spin" />
              )}
              {j.message}
            </p>
          ))}
        <p className="small-note">
          此模式适合同事内测，邀请传输经
          Cloudflare；临时地址在关闭或断线后会变化。局域网模式仍可独立使用。
        </p>
      </div>
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected("")}>
          <div
            className="modal auth-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setSelected("")}>
              <X size={18} />
            </button>
            <div className="modal-icon">
              <ShieldCheck />
            </div>
            <h2>登录 {names[selected]}</h2>
            <p>请在官方浏览器页面完成授权。这里仅显示本机登录进度。</p>
            <div className="auth-status">
              <span
                className={"tag " + (job?.status === "done" ? "green" : "")}
              >
                {job?.status === "running"
                  ? "等待官方授权"
                  : job?.status === "done"
                    ? "登录已完成"
                    : job?.status === "cancelled"
                      ? "已取消"
                      : "登录状态"}
              </span>
              {job?.status === "running" && (
                <LoaderCircle size={15} className="spin" />
              )}
            </div>
            <pre className="auth-log">{job?.log || "准备启动……"}</pre>
            {job?.url && (
              <button
                className="button primary full"
                onClick={() => call("accounts.open", { id: selected })}
              >
                <ExternalLink size={14} />
                打开官方授权页面
              </button>
            )}
            {job?.status === "running" && selected === "claude" && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await call("accounts.code", { id: selected, code });
                  setCode("");
                }}
              >
                <label>
                  若官方页面要求回填授权码
                  <input
                    type="password"
                    autoComplete="off"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="仅在官方页面提示时粘贴"
                  />
                </label>
                <button className="button full" disabled={!code.trim()}>
                  提交授权码
                </button>
              </form>
            )}
            {selected === "codex" &&
              job?.status !== "running" &&
              job?.status !== "done" && (
                <button
                  className="button full gap-top"
                  onClick={() =>
                    call("accounts.login", { id: selected, device: true })
                  }
                >
                  改用设备码登录
                </button>
              )}
            {job?.status === "running" && (
              <button
                className="text-button danger"
                onClick={() => call("accounts.cancel", { id: selected })}
              >
                取消本次登录
              </button>
            )}
            {job?.status === "done" && (
              <button
                className="button full gap-top"
                onClick={() => setSelected("")}
              >
                完成
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
export function GitHubPicker({
  call,
  onClose,
  onImported,
  workspaceId,
}: {
  call: Call;
  onClose: () => void;
  onImported: (w: any) => void;
  workspaceId?: string;
}) {
  const [repos, setRepos] = useState<any[] | null>(null),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    const rows = await call("github.repositories");
    setRepos(rows || []);
    setBusy(false);
    if (!rows) setError("仓库列表读取失败，请先完成 GitHub 授权。");
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal repo-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="modal-icon">
          <Github />
        </div>
        <h2>{workspaceId ? "为共享工作区克隆仓库" : "从 GitHub 打开项目"}</h2>
        <p>使用你已授权的 GitHub 账号。选择仓库后，会提示选择本机保存位置。</p>
        <div className="inline-form">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索或输入 owner/repository"
          />
          <button className="button" disabled={busy} onClick={load}>
            <RefreshCw size={14} className={busy ? "spin" : ""} />
            {repos ? "刷新" : "加载仓库"}
          </button>
        </div>
        {error && <p className="install-progress error">{error}</p>}
        <div className="repo-list">
          {repos
            ?.filter((r) =>
              (r.fullName + " " + (r.description || ""))
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((r) => (
              <button
                key={r.fullName}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const w = await call("github.clone", {
                    repo: r.fullName,
                    workspaceId,
                  });
                  setBusy(false);
                  if (w) onImported(w);
                }}
              >
                <Github size={17} />
                <div>
                  <strong>{r.fullName}</strong>
                  <small>{r.description || r.defaultBranch}</small>
                </div>
                <span className="tag">{r.private ? "私有" : "公开"}</span>
              </button>
            ))}
        </div>
        {search.includes("/") && (
          <button
            className="button primary full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const w = await call("github.clone", {
                repo: search.trim(),
                workspaceId,
              });
              setBusy(false);
              if (w) onImported(w);
            }}
          >
            克隆 {search.trim()}
          </button>
        )}
        {busy && (
          <p className="small-note">
            正在读取或克隆，请稍候；大型仓库需要更长时间。
          </p>
        )}
      </div>
    </div>
  );
}
