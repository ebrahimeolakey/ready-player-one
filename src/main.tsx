import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutGrid,
  Users,
  PanelLeft,
  Plus,
  Folder,
  FolderOpen,
  Settings2,
  Search,
  ChevronDown,
  MoreHorizontal,
  GitBranch,
  Share2,
  Link,
  Copy,
  Check,
  X,
  Globe,
  History,
  Brain,
  Download,
  TerminalSquare,
  Keyboard,
  Database,
  Github,
  ArrowRight,
  LoaderCircle,
  LogOut,
  Layers,
  ShieldCheck,
} from "lucide-react";
import { Accounts, GitHubPicker } from "./Accounts";
import { Studio } from "./Studio";
import { Avatar, Mark, Empty, Modal, type Call } from "./ui";
import type { State, Session, RPO } from "./types";
import "./style.css";
const empty: State = {
  workspaces: [],
  sessions: [],
  memories: [],
  approvals: [],
  members: [],
  local: {
    paths: {},
    sessionPaths: {},
    providers: [],
    online: false,
    remote: false,
    dataDir: "",
    name: "",
  },
};
const api: RPO = window.rpo || {
  invoke: async () => {
    throw Error("请通过桌面应用打开");
  },
  subscribe: () => () => {},
};
function App() {
  const [state, setState] = useState<State>(empty),
    [workspace, setWorkspace] = useState(""),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("sessions"),
    [modal, setModal] = useState(""),
    [toast, setToast] = useState(""),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [sort, setSort] = useState("recent"),
    [sidebar, setSidebar] = useState(true),
    [setting, setSetting] = useState("providers"),
    [repoPicker, setRepoPicker] = useState(false),
    [share, setShare] = useState<any>(null),
    [internet, setInternet] = useState(true),
    [loading, setLoading] = useState(false),
    [sessionMenu, setSessionMenu] = useState(""),
    [paneSession, setPaneSession] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = (s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  };
  const call: Call = async (method, args = {}) => {
    try {
      return await api.invoke(method, args);
    } catch (e) {
      notify(
        (e as Error).message.replace(
          /^Error invoking remote method 'rpo:invoke': Error: /,
          "",
        ),
      );
    }
  };
  useEffect(() => {
    api
      .invoke<State>("bootstrap")
      .then(setState)
      .catch((e) => notify(e.message));
    return api.subscribe(setState);
  }, []);
  useEffect(() => {
    if (!state.workspaces.some((w) => w.id === workspace)) {
      setWorkspace(state.workspaces[0]?.id || "");
      setSelected("");
    }
  }, [state.workspaces, workspace]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal("");
        setRepoPicker(false);
        setSessionMenu("");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setView("sessions");
        setSelected("");
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const ws = state.workspaces.find((w) => w.id === workspace),
    session = state.sessions.find((s) => s.id === selected),
    sessions = state.sessions.filter((s) => s.workspaceId === workspace),
    active = sessions.filter((s) => s.status === "active"),
    github = state.local.accounts?.find((a) => a.id === "github");
  const openSession = (s: Session) => {
    setWorkspace(s.workspaceId);
    setSelected(s.id);
    setView("sessions");
    setSessionMenu("");
  };
  const addProject = async () => {
    const w = await call("project.add");
    if (w) {
      setWorkspace(w.id);
      setSelected("");
      setView("sessions");
      setModal("");
    }
  };
  const beginShare = () => {
    setShare(null);
    setModal("share");
  };
  const openSettings = (page = "providers") => {
    setSetting(page);
    setView("settings");
    setSelected("");
    setModal("");
  };
  const second = state.sessions.find((s) => s.id === paneSession);
  const shown = sessions
    .filter(
      (s) =>
        s.status === (view === "history" ? "archived" : "active") &&
        s.title.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : Date.parse(b.at) - Date.parse(a.at),
    );
  return (
    <div className={"app-shell " + (!sidebar ? "sidebar-collapsed" : "")}>
      <div className="titlebar">
        <div className="drag-region" />
        <div className="title-brand">
          <Mark />
          <strong>头号玩家</strong>
        </div>
      </div>
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-tools">
            <button
              className="icon-button"
              title="收起侧栏"
              aria-label="收起侧栏"
              onClick={() => setSidebar(false)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <nav>
            {[
              [LayoutGrid, "sessions", "会话"],
              [Users, "team", "成员"],
            ].map(([Icon, id, label]: any) => (
              <button
                key={id}
                className={
                  "nav-item " + (view === id && !session ? "active" : "")
                }
                onClick={() => {
                  setView(id);
                  setSelected("");
                }}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
          <div className="nav-label">
            工作区
            <button
              title="管理工作区"
              aria-label="管理工作区"
              onClick={() => setModal("workspaces")}
            >
              <Layers size={15} />
            </button>
          </div>
          <div className="workspace-tree">
            {state.workspaces.map((w) => (
              <section key={w.id}>
                <div className="workspace-row">
                  <button
                    title={w.remote || w.name}
                    onClick={() => {
                      setWorkspace(w.id);
                      setSelected("");
                      setView("sessions");
                    }}
                  >
                    <Folder size={13} />
                    <span>{w.name}</span>
                  </button>
                  <button
                    className="workspace-more"
                    title="工作区菜单"
                    aria-label="工作区菜单"
                    onClick={() => {
                      setWorkspace(w.id);
                      setModal("workspaces");
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
                {state.sessions
                  .filter(
                    (s) => s.workspaceId === w.id && s.status === "active",
                  )
                  .map((s) => (
                    <button
                      className={
                        "mini-session " + (selected === s.id ? "selected" : "")
                      }
                      key={s.id}
                      onClick={() => openSession(s)}
                    >
                      {s.title}
                    </button>
                  ))}
              </section>
            ))}
          </div>
          {!state.workspaces.length && (
            <button
              className="button sidebar-open"
              onClick={() => setModal("workspaces")}
            >
              <Plus size={14} />
              打开项目
            </button>
          )}
          <div className="sidebar-bottom">
            <button className="profile" onClick={() => openSettings("general")}>
              <Avatar name={state.local.name || "我"} small />
              <span>
                <strong>
                  {github?.authenticated
                    ? github.label
                    : state.local.name || "我"}
                </strong>
                <small>{state.local.online ? "已连接" : "重连中"}</small>
              </span>
              <Settings2 size={16} />
            </button>
          </div>
        </aside>
        <main>
          {!sidebar && (
            <button
              className="sidebar-restore icon-button"
              title="展开侧栏"
              aria-label="展开侧栏"
              onClick={() => setSidebar(true)}
            >
              <PanelLeft size={16} />
            </button>
          )}
          {!state.local.online && (
            <div className="offline-banner">连接中断，正在重连…</div>
          )}
          {session ? (
            <div className="split-workspace">
              <div className="session-pane">
                <header className="session-topbar">
                  <GitBranch size={14} />
                  <strong>{session.title}</strong>
                  <span>/ {ws?.name}</span>
                  <div className="grow" />
                  <button
                    className="button"
                    title="在旁边打开会话"
                    onClick={() => setModal("split")}
                  >
                    <Plus size={13} />
                    新分栏
                  </button>
                  <button className="button primary" onClick={beginShare}>
                    <Share2 size={13} />
                    分享
                  </button>
                </header>
                <Studio
                  key={session.id}
                  session={session}
                  state={state}
                  call={call}
                  notify={notify}
                  onAddLane={() => setModal("lane")}
                  onShare={beginShare}
                  onRepos={() => setRepoPicker(true)}
                  compact={!!second}
                />
              </div>
              {second && (
                <div className="session-pane">
                  <header className="session-topbar">
                    <GitBranch size={14} />
                    <strong>{second.title}</strong>
                    <div className="grow" />
                    <button
                      className="icon-button"
                      title="关闭分栏"
                      aria-label="关闭分栏"
                      onClick={() => setPaneSession("")}
                    >
                      <X size={14} />
                    </button>
                  </header>
                  <Studio
                    key={"pane-" + second.id}
                    secondary
                    session={second}
                    compact
                    state={state}
                    call={call}
                    notify={notify}
                    onAddLane={() => {
                      openSession(second);
                      setPaneSession("");
                      setModal("lane");
                    }}
                    onShare={() => {
                      openSession(second);
                      beginShare();
                    }}
                    onRepos={() => setRepoPicker(true)}
                  />
                </div>
              )}
            </div>
          ) : view === "settings" ? (
            <div className="settings-layout">
              <aside className="settings-nav">
                <h2>设置</h2>
                <div className="nav-label">个人</div>
                {[
                  [Settings2, "general", "通用"],
                  [TerminalSquare, "providers", "提供商"],
                  [Github, "github", "GitHub"],
                  [Keyboard, "keyboard", "快捷键"],
                ].map(([Icon, id, label]: any) => (
                  <button
                    key={id}
                    className={setting === id ? "active" : ""}
                    onClick={() => setSetting(id)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
                <div className="nav-label">协作</div>
                {[
                  [Globe, "network", "网络"],
                  [Database, "data", "数据"],
                ].map(([Icon, id, label]: any) => (
                  <button
                    key={id}
                    className={setting === id ? "active" : ""}
                    onClick={() => setSetting(id)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </aside>
              <section className="settings-content">
                <h1>
                  {
                    (
                      {
                        general: "通用",
                        providers: "提供商",
                        github: "GitHub",
                        keyboard: "快捷键",
                        network: "网络",
                        data: "数据",
                      } as any
                    )[setting]
                  }
                </h1>
                {["providers", "github", "network"].includes(setting) && (
                  <Accounts
                    state={state}
                    call={call}
                    section={setting}
                    onRepos={() => setRepoPicker(true)}
                  />
                )}{" "}
                {setting === "general" && (
                  <>
                    <form
                      className="setting-card"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await call("settings.name", {
                            name: new FormData(e.currentTarget).get("name"),
                          })
                        )
                          notify("已保存");
                      }}
                    >
                      <label className="grow">昵称</label>
                      <input
                        name="name"
                        defaultValue={state.local.name}
                        required
                        maxLength={40}
                      />
                      <button className="button">保存</button>
                    </form>
                    <div className="setting-card">
                      <span className="grow">语言</span>
                      <span>简体中文</span>
                    </div>
                    <div className="setting-card">
                      <span className="grow">头号玩家</span>
                      <span className="muted">{state.local.appVersion}</span>
                    </div>
                  </>
                )}
                {setting === "keyboard" && (
                  <>
                    {[
                      ["搜索会话", "⌘K"],
                      ["新建 Agent", "⇧⌘L"],
                      ["展开 / 收起终端", "⌘J"],
                      ["查找文件", "⌘P"],
                      ["发送任务", "⌘↵"],
                      ["保存文件", "⌘S"],
                      ["关闭弹窗", "Esc"],
                    ].map(([a, b]) => (
                      <div className="setting-card" key={a}>
                        <span className="grow">{a}</span>
                        <kbd>{b}</kbd>
                      </div>
                    ))}
                  </>
                )}
                {setting === "data" && (
                  <>
                    <div className="setting-card">
                      <div>
                        <strong>本机数据</strong>
                        <small className="path-text">
                          {state.local.dataDir}
                        </small>
                      </div>
                    </div>
                    <button
                      className="setting-card full"
                      onClick={() => {
                        setView("history");
                        setSelected("");
                      }}
                    >
                      <History size={16} />
                      <span className="grow">归档会话</span>
                      <ArrowRight size={14} />
                    </button>
                    <button
                      className="setting-card full"
                      onClick={() => {
                        setView("memory");
                        setSelected("");
                      }}
                    >
                      <Brain size={16} />
                      <span className="grow">共享记忆</span>
                      <ArrowRight size={14} />
                    </button>
                  </>
                )}
              </section>
            </div>
          ) : (
            <div className="page">
              {(view === "sessions" || view === "history") && (
                <>
                  <header className="page-heading">
                    <h1>{view === "history" ? "归档会话" : "会话"}</h1>
                    <div className="grow" />
                    {searchOpen && (
                      <input
                        autoFocus
                        className="session-search"
                        placeholder="搜索会话…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    )}
                    <select
                      aria-label="排序"
                      className="sort-select"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="recent">最近创建</option>
                      <option value="name">名称</option>
                    </select>
                    <button
                      className="icon-button bordered"
                      title="搜索会话"
                      aria-label="搜索会话"
                      onClick={() => setSearchOpen(!searchOpen)}
                    >
                      <Search size={15} />
                    </button>
                    <button
                      className="button primary"
                      onClick={() =>
                        ws ? setModal("session") : setModal("workspaces")
                      }
                    >
                      <Plus size={15} />
                      新建
                    </button>
                  </header>
                  <div className="session-grid">
                    {shown.map((s) => {
                      const busy = s.lanes.some((l) => l.status === "running"),
                        awaiting = s.lanes.some((l) => l.status === "awaiting");
                      return (
                        <article className="session-card" key={s.id}>
                          <div className="card-top">
                            <button
                              className="card-name"
                              onClick={() => openSession(s)}
                            >
                              {s.title}
                            </button>
                            <button
                              className="icon-button"
                              title="会话菜单"
                              aria-label="会话菜单"
                              onClick={() =>
                                setSessionMenu(sessionMenu === s.id ? "" : s.id)
                              }
                            >
                              <MoreHorizontal size={15} />
                            </button>
                            {sessionMenu === s.id && (
                              <div className="card-menu">
                                <button onClick={() => openSession(s)}>
                                  打开
                                </button>
                                <button
                                  onClick={() => {
                                    call("session.export", { sessionId: s.id });
                                    setSessionMenu("");
                                  }}
                                >
                                  导出
                                </button>
                                <button
                                  onClick={() => {
                                    call("session.archive", {
                                      sessionId: s.id,
                                      restore: s.status === "archived",
                                    });
                                    setSessionMenu("");
                                  }}
                                >
                                  {s.status === "archived" ? "恢复" : "归档"}
                                </button>
                              </div>
                            )}
                          </div>
                          <button
                            className="card-content"
                            onClick={() => openSession(s)}
                          >
                            <div className="session-status">
                              <span className={"dot " + (busy ? "mint" : "")} />
                              {busy ? "执行中" : awaiting ? "待审批" : "待命"}
                              <small>
                                {new Date(s.at).toLocaleDateString("zh-CN", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </small>
                            </div>
                            <div className="card-providers">
                              {[...new Set(s.lanes.map((l) => l.provider))].map(
                                (p) => (
                                  <span key={p}>
                                    <TerminalSquare size={12} />
                                    {p === "codex" ? "Codex" : "Claude"}
                                  </span>
                                ),
                              )}
                            </div>
                            <div className="card-avatars">
                              <Avatar name={s.owner} small />
                            </div>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                  {!shown.length && (
                    <div className="list-empty">
                      <Empty
                        icon={LayoutGrid}
                        title={search ? "未找到会话" : "暂无会话"}
                      />
                      {view === "sessions" && (
                        <div className="welcome-actions">
                          <button
                            className="button"
                            onClick={() => setModal("workspaces")}
                          >
                            <FolderOpen size={14} />
                            打开项目
                          </button>
                          <button
                            className="button"
                            onClick={() => setModal("join")}
                          >
                            <Link size={14} />
                            加入会话
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {view === "team" && (
                <>
                  <header className="page-heading">
                    <h1>成员</h1>
                    <div className="grow" />
                    <button
                      className="button primary"
                      disabled={!ws}
                      onClick={beginShare}
                    >
                      <Plus size={14} />
                      邀请
                    </button>
                  </header>
                  <button
                    className="workspace-filter button"
                    onClick={() => setModal("workspaces")}
                  >
                    <Layers size={13} />
                    {ws?.name || "选择工作区"}
                    <ChevronDown size={13} />
                  </button>
                  <div className="members-list">
                    <div className="nav-label">成员</div>
                    {state.members.map((m) => (
                      <div className="member-row" key={m.id}>
                        <Avatar name={m.name} />
                        <div>
                          <strong>
                            {m.name}
                            {m.id === state.me?.id ? "（我）" : ""}
                          </strong>
                          <small>在线</small>
                        </div>
                        <span>{m.host ? "房主" : "成员"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {view === "memory" && (
                <>
                  <header className="page-heading">
                    <h1>共享记忆</h1>
                    <div className="grow" />
                    <button
                      className="button primary"
                      disabled={!ws}
                      onClick={() => setModal("memory")}
                    >
                      <Plus size={14} />
                      新建
                    </button>
                  </header>
                  {state.memories
                    .filter((m) => m.workspaceId === workspace)
                    .map((m) => (
                      <article
                        className={
                          "memory-card " + (m.retired ? "retired" : "")
                        }
                        key={m.id}
                      >
                        <h3>{m.title}</h3>
                        <p>{m.text}</p>
                        <footer>
                          <small>{m.owner}</small>
                          <button
                            className="text-button"
                            onClick={() =>
                              call("memory.retire", {
                                id: m.id,
                                retired: !m.retired,
                              })
                            }
                          >
                            {m.retired ? "恢复" : "停用"}
                          </button>
                        </footer>
                      </article>
                    ))}
                  {!state.memories.some((m) => m.workspaceId === workspace) && (
                    <Empty icon={Brain} title="暂无记忆" />
                  )}
                </>
              )}
            </div>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {repoPicker && (
        <GitHubPicker
          call={call}
          workspaceId={state.local.remote ? workspace : undefined}
          onClose={() => setRepoPicker(false)}
          onImported={(w) => {
            setRepoPicker(false);
            setWorkspace(w.id);
            setSelected("");
            setView("sessions");
            notify("仓库已关联");
          }}
        />
      )}
      {modal && (
        <Modal
          title={
            (
              {
                session: "新建会话",
                split: "打开分栏",
                lane: "新建 Agent",
                share: "分享",
                join: "加入会话",
                workspaces: "工作区",
                memory: "新建记忆",
              } as any
            )[modal] || modal
          }
          close={() => setModal("")}
          drawer={modal === "share"}
        >
          {modal === "split" && (
            <div className="workspace-options">
              {active.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setPaneSession(s.id);
                    setModal("");
                  }}
                >
                  <LayoutGrid size={14} />
                  <span>{s.title}</span>
                  <Plus size={14} />
                </button>
              ))}
            </div>
          )}
          {modal === "session" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const s = await call("session.create", {
                  workspaceId: workspace,
                  title: f.get("title"),
                  description: "",
                });
                if (s) {
                  openSession(s);
                  setModal("");
                }
              }}
            >
              <p className="small-note">
                {github?.authenticated
                  ? "GitHub · " + github.label
                  : state.local.name}
              </p>
              <select
                className="full"
                aria-label="仓库"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
              >
                {state.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <input
                className="full"
                autoFocus
                name="title"
                maxLength={150}
                required
                placeholder="准备做什么？"
              />
              <footer className="modal-footer">
                <small>你将成为创建者</small>
                <div className="grow" />
                <button
                  type="button"
                  className="button"
                  onClick={() => setModal("")}
                >
                  取消
                </button>
                <button className="button primary">
                  开始会话
                  <ArrowRight size={14} />
                </button>
              </footer>
            </form>
          )}
          {modal === "lane" && session && (
            <>
              <div className="provider-choices">
                {["claude", "codex"].map((id) => {
                  const p = state.local.providers.find((p) => p.id === id);
                  return (
                    <button
                      className="setting-card full"
                      key={id}
                      disabled={!p?.available}
                      onClick={async () => {
                        if (
                          await call("lane.create", {
                            sessionId: session.id,
                            provider: id,
                          })
                        )
                          setModal("");
                      }}
                    >
                      <TerminalSquare size={18} />
                      <span className="grow">
                        {id === "codex" ? "Codex" : "Claude Code"}
                      </span>
                      <small>{p?.available ? "本机账号" : "未安装"}</small>
                      <Plus size={15} />
                    </button>
                  );
                })}
              </div>
              <button
                className="text-button"
                onClick={() => openSettings("providers")}
              >
                管理提供商
                <ArrowRight size={13} />
              </button>
            </>
          )}
          {modal === "workspaces" && (
            <>
              <div className="workspace-options">
                {state.workspaces.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => {
                      setWorkspace(w.id);
                      setSelected("");
                      setView("sessions");
                      setModal("");
                    }}
                  >
                    <Folder size={15} />
                    <span>{w.name}</span>
                    {w.id === workspace && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div className="menu-actions">
                {!state.local.remote && (
                  <button className="button full" onClick={addProject}>
                    <FolderOpen size={15} />
                    打开本地项目
                  </button>
                )}
                <button
                  className="button full"
                  onClick={() => {
                    setModal("");
                    setRepoPicker(true);
                  }}
                >
                  <Github size={15} />
                  {state.local.remote ? "克隆并关联仓库" : "从 GitHub 打开"}
                </button>
                <button
                  className="button full"
                  onClick={() => setModal("join")}
                >
                  <Link size={15} />
                  通过邀请加入
                </button>
                {state.local.remote && (
                  <button
                    className="button full"
                    onClick={async () => {
                      await call("share.leave");
                      setModal("");
                      setSelected("");
                    }}
                  >
                    <LogOut size={15} />
                    退出共享工作区
                  </button>
                )}
              </div>
            </>
          )}
          {modal === "join" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                const r = await call("share.join", {
                  url: new FormData(e.currentTarget).get("url"),
                });
                setLoading(false);
                if (r) {
                  setModal("");
                  if (r.workspaceId) setWorkspace(r.workspaceId);
                  setSelected(r.sessionId || "");
                  setView("sessions");
                }
              }}
            >
              <textarea
                autoFocus
                required
                name="url"
                aria-label="邀请链接"
                placeholder="粘贴邀请链接…"
                rows={3}
              />
              <button className="button primary full" disabled={loading}>
                {loading ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <ArrowRight size={14} />
                )}
                加入
              </button>
            </form>
          )}
          {modal === "share" && (
            <>
              <div className="nav-label">邀请</div>
              {state.local.remote ? (
                <p className="small-note">请向房主获取邀请</p>
              ) : (
                <>
                  <select
                    className="full"
                    aria-label="协作网络"
                    value={internet ? "internet" : "lan"}
                    disabled={loading || !!share}
                    onChange={(e) => setInternet(e.target.value === "internet")}
                  >
                    <option value="internet">互联网</option>
                    <option value="lan">局域网 / VPN</option>
                  </select>
                  {internet && !state.local.tunnel?.installed ? (
                    <button
                      className="button primary full"
                      disabled={state.local.installations?.some(
                        (j) => j.id === "cloudflared" && j.status === "running",
                      )}
                      onClick={() =>
                        call("tools.install", { id: "cloudflared" })
                      }
                    >
                      <Download size={14} />
                      安装协作组件
                    </button>
                  ) : share ? (
                    <div className="copy-input">
                      <input readOnly aria-label="邀请链接" value={share.url} />
                      <button
                        className="button primary"
                        onClick={() => {
                          call("clipboard", { text: share.url });
                          notify("已复制");
                        }}
                      >
                        <Copy size={14} />
                        复制
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button primary full"
                      disabled={loading || !ws}
                      onClick={async () => {
                        setLoading(true);
                        const result = await call("share.create", {
                          workspaceId: workspace,
                          sessionId: session?.id,
                          internet,
                        });
                        setShare(result);
                        setLoading(false);
                        if (result) notify("邀请已复制");
                      }}
                    >
                      {loading ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Link size={14} />
                      )}
                      复制邀请链接
                    </button>
                  )}
                  {loading && (
                    <p className="small-note">{state.local.tunnel?.message}</p>
                  )}
                  {internet &&
                    state.local.installations?.find(
                      (j) => j.id === "cloudflared",
                    )?.status === "error" && (
                      <p className="warning">
                        {
                          state.local.installations.find(
                            (j) => j.id === "cloudflared",
                          )?.message
                        }
                      </p>
                    )}
                  <p className="small-note">24 小时有效 · 房主需在线</p>
                  {share?.addresses?.length > 1 && (
                    <select
                      className="full"
                      aria-label="共享地址"
                      onChange={(e) => {
                        const u = new URL(share.url);
                        u.searchParams.set("host", e.target.value);
                        setShare({ ...share, url: u.toString() });
                      }}
                    >
                      {share.addresses.map((a: string) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <div className="nav-label">有权访问</div>
              {state.members.map((m) => (
                <div className="member-row" key={m.id}>
                  <Avatar name={m.name} small />
                  <div>
                    <strong>{m.name}</strong>
                    <small>{m.host ? "房主" : "成员"}</small>
                  </div>
                </div>
              ))}
              {!state.local.remote && (
                <button
                  className="text-button danger"
                  onClick={async () => {
                    await call("invite.revoke", { workspaceId: workspace });
                    setShare(null);
                    notify("邀请已撤销");
                  }}
                >
                  撤销邀请
                </button>
              )}
              <details className="help-details">
                <summary>共享范围</summary>
                <p>
                  受邀成员可访问当前工作区的会话、评论、记忆、审批和已共享变更。互联网邀请经
                  Cloudflare 临时中继。
                </p>
              </details>
            </>
          )}
          {modal === "memory" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (
                  await call("memory.add", {
                    workspaceId: workspace,
                    title: f.get("title"),
                    text: f.get("text"),
                  })
                )
                  setModal("");
              }}
            >
              <input
                autoFocus
                name="title"
                required
                placeholder="标题"
                className="full"
              />
              <textarea name="text" required placeholder="内容…" rows={5} />
              <button className="button primary full">保存</button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
