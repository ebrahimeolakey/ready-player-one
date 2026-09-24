import { useState, useEffect } from "react";
import {
  TerminalSquare,
  Github,
  RefreshCw,
  Download,
  ExternalLink,
  LoaderCircle,
  Globe,
} from "lucide-react";
import {TeamIdentity} from "./TeamIdentity";
import {ProviderSetup} from "./ProviderSetup";
import type { State } from "./types";
import { Modal, type Call } from "./ui";
const names: Record<string, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  github: "GitHub",
};
export function Accounts({
  state,
  call,
  onRepos,
  section = "providers",
}: {
  state: State;
  call: Call;
  onRepos: () => void;
  section?: string;
}) {
  const [selected, setSelected] = useState(""),
    [code, setCode] = useState("");
  const job = state.local.authJobs?.find((j) => j.id === selected),
    install = state.local.installations?.find((j) => j.id === "cloudflared");
  return (
    <>
      {section === "network" ? (
        <>
          <div className="setting-card">
            <Globe size={18} />
            <div className="grow">
              <strong>互联网协作</strong>
              <small>
                {state.local.tunnel?.status === "ready"
                  ? "已连接"
                  : state.local.tunnel?.installed
                    ? "组件已安装"
                    : "需要安装组件"}
              </small>
            </div>
            {state.local.tunnel?.status === "ready" ? (
              <button
                className="button"
                onClick={() => call("share.stopInternet")}
              >
                关闭
              </button>
            ) : (
              <button
                className="button"
                disabled={install?.status === "running"}
                onClick={() => call("tools.install", { id: "cloudflared" })}
              >
                <Download size={13} />
                {state.local.tunnel?.installed ? "更新" : "安装"}
              </button>
            )}
          </div>
          {install && (
            <p
              className={
                "small-note " + (install.status === "error" ? "warning" : "")
              }
            >
              {install.message}
            </p>
          )}
          <p className="small-note">临时加密通道 · 房主需在线</p>
          <details className="help-details">
            <summary>连接详情</summary>
            <p>通过 Cloudflare 中继，非端到端加密。断线或重启后需重新邀请。</p>
          </details>
        </>
      ) : (
        <>
          <div className="settings-toolbar">
            <button
              className="icon-button"
              title="刷新登录状态"
              aria-label="刷新登录状态"
              disabled={state.local.accountLoading}
              onClick={() => call("accounts.refresh")}
            >
              <RefreshCw
                size={14}
                className={state.local.accountLoading ? "spin" : ""}
              />
            </button>
          </div>
          {(section === "github" ? ["github"] : ["claude", "codex"]).map(
            (id) => {
              const a = state.local.accounts?.find((a) => a.id === id),
                install = state.local.installations?.find((j) => j.id === id),
                auth = state.local.authJobs?.find((j) => j.id === id);
              return (
                <div key={id}>
                  <div className="setting-card">
                    <span className="provider-symbol">
                      {id === "github" ? (
                        <Github size={17} />
                      ) : (
                        <TerminalSquare size={17} />
                      )}
                    </span>
                    <div className="grow">
                      <strong>{names[id]}</strong>
                      {section === "github" && a?.authenticated && (
                        <small>{a.label}</small>
                      )}
                    </div>
                    {a?.available ? (
                      <>
                        <button
                          className="button"
                          title={
                            a.authenticated
                              ? "切换或重新登录账号"
                              : "在官方页面登录"
                          }
                          onClick={async () => {
                            setSelected(id);
                            if (auth?.status !== "running")
                              await call("accounts.login", { id });
                          }}
                        >
                          {auth?.status === "running"
                            ? "继续登录"
                            : a.authenticated
                              ? "切换账号"
                              : "登录"}
                        </button>
                        <span
                          className={"tag " + (a.authenticated ? "green" : "")}
                          title={a.version}
                        >
                          {a.authenticated ? "已连接" : "未登录"}
                        </span>
                      </>
                    ) : (
                      <>
                        <button
                          className="button"
                          disabled={
                            state.local.accountLoading ||
                            install?.status === "running"
                          }
                          onClick={() => call("tools.install", { id })}
                        >
                          {install?.status === "running" ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : null}
                          安装
                        </button>
                        <span className="tag">
                          {state.local.accountLoading ? "检测中" : "未安装"}
                        </span>
                      </>
                    )}
                  </div>
                  {install && (
                    <p
                      className={
                        "small-note " +
                        (install.status === "error" ? "warning" : "")
                      }
                    >
                      {install.message}
                    </p>
                  )}
                </div>
              );
            },
          )}
          {section === "github" && (
            <button className="button full" onClick={onRepos}>
              <Github size={14} />
              打开仓库
            </button>
          )}
          <details className="help-details">
            <summary>账号详情</summary>
            <p>使用本机官方 CLI 授权，凭据保留在此电脑。</p>
            {state.local.accounts
              ?.filter((a) =>
                section === "github" ? a.id === "github" : a.id !== "github",
              )
              .map((a) => (
                <p key={a.id}>
                  {names[a.id]} · {a.label} · {a.version}
                </p>
              ))}
          </details>
        </>
      )}
      {section === "providers" && <ProviderSetup call={call} />}
      {section === "github" && <TeamIdentity call={window.rpo.invoke}/>}
      {selected && (
        <Modal title={"登录 " + names[selected]} close={() => setSelected("")}>
          <div className="auth-status">
            <span className="tag">
              {job?.status === "running"
                ? "等待授权"
                : job?.status === "done"
                  ? "已登录"
                  : job?.status === "cancelled"
                    ? "已取消"
                    : job?.status === "error"
                      ? "登录失败"
                      : "准备中"}
            </span>
            {job?.status === "running" && (
              <LoaderCircle className="spin" size={14} />
            )}
          </div>
          <pre className="auth-log">{job?.log || "启动登录…"}</pre>
          {job?.url && (
            <button
              className="button primary full"
              onClick={() => call("accounts.open", { id: selected })}
            >
              <ExternalLink size={14} />
              打开授权页面
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
              <input
                className="full"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="授权码（仅在官方页面要求时填写）"
              />
              <button className="button full" disabled={!code.trim()}>
                提交
              </button>
            </form>
          )}
          {selected === "codex" &&
            job?.status !== "running" &&
            job?.status !== "done" && (
              <button
                className="button full"
                onClick={() =>
                  call("accounts.login", { id: selected, device: true })
                }
              >
                使用设备码
              </button>
            )}
          {job?.status === "running" && (
            <button
              className="text-button"
              onClick={() => call("accounts.cancel", { id: selected })}
            >
              取消登录
            </button>
          )}
          {job?.status === "done" && (
            <button className="button full" onClick={() => setSelected("")}>
              完成
            </button>
          )}
        </Modal>
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
  const [repos, setRepos] = useState<any[]>([]),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    const rows = await call("github.repositories");
    setRepos(rows || []);
    setBusy(false);
    if (!rows) setError("请先在设置中登录 GitHub");
  };
  useEffect(() => {
    load();
  }, []);
  const clone = async (repo: string) => {
    setBusy(true);
    const w = await call("github.clone", { repo, workspaceId });
    setBusy(false);
    if (w) onImported(w);
  };
  return (
    <Modal
      title={workspaceId ? "克隆并关联仓库" : "打开 GitHub 仓库"}
      close={onClose}
    >
      <div className="inline-form">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索或输入 owner/repository"
          aria-label="搜索仓库"
        />
        <button
          className="icon-button"
          title="刷新仓库"
          aria-label="刷新仓库"
          disabled={busy}
          onClick={load}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </button>
      </div>
      {error && <p className="warning">{error}</p>}
      <div className="repo-list">
        {repos
          .filter((r) =>
            (r.fullName + " " + (r.description || ""))
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((r) => (
            <button
              key={r.fullName}
              disabled={busy}
              onClick={() => clone(r.fullName)}
            >
              <Github size={16} />
              <div>
                <strong>{r.fullName}</strong>
              </div>
              <span className="tag">{r.private ? "私有" : "公开"}</span>
            </button>
          ))}
      </div>
      {search.includes("/") && (
        <button
          className="button primary full"
          disabled={busy}
          onClick={() => clone(search.trim())}
        >
          克隆 {search.trim()}
        </button>
      )}
      {busy && <p className="small-note">处理中…</p>}
    </Modal>
  );
}
