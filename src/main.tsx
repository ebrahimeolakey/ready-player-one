import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Bot,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Globe,
  History,
  LayoutGrid,
  Link,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Monitor,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  Users,
  X,
  Zap,
} from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import type { State, Session, Lane, RPO } from "./types";
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
    throw Error("请通过桌面应用打开：npm start");
  },
  subscribe: () => () => {},
};
const statusNames: Record<string, string> = {
  idle: "待命",
  running: "执行中",
  awaiting: "等待审批",
  done: "已完成",
  error: "执行失败",
  interrupted: "已中断",
};
const time = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
function Mark({ small = false }: { small?: boolean }) {
  return (
    <div className={"brand-mark " + (small ? "small" : "")}>
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={"avatar " + (small ? "small" : "")}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
function App() {
  const [state, setState] = useState<State>(empty),
    [workspace, setWorkspace] = useState(""),
    [view, setView] = useState("sessions"),
    [selected, setSelected] = useState(""),
    [modal, setModal] = useState(""),
    [toast, setToast] = useState(""),
    [search, setSearch] = useState(""),
    [sessionTab, setSessionTab] = useState("agents"),
    [share, setShare] = useState<any>(null),
    [loading, setLoading] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6500);
  };
  async function call<T = any>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    try {
      return await api.invoke<T>(method, args);
    } catch (e) {
      notify(
        (e as Error).message.replace(
          /^Error invoking remote method 'rpo:invoke': Error: /,
          "",
        ),
      );
      return undefined;
    }
  }
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
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setModal("search");
      }
      if (e.key === "Escape") setModal("");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const ws = state.workspaces.find((w) => w.id === workspace),
    sessions = state.sessions.filter((s) => s.workspaceId === workspace),
    session = sessions.find((s) => s.id === selected),
    active = sessions.filter((s) => s.status === "active"),
    pending = state.approvals.filter(
      (a) => a.workspaceId === workspace && a.status === "pending",
    ),
    running = sessions
      .flatMap((s) => s.lanes)
      .filter((l) => l.status === "running").length;
  const openSession = (s: Session) => {
    setSelected(s.id);
    setView("sessions");
    setSessionTab("agents");
  };
  const addProject = async () => {
    const w = await call("project.add");
    if (w) {
      setWorkspace(w.id);
      setSelected("");
    }
  };
  const beginShare = async () => {
    setModal("share");
    setShare(null);
  };
  return (
    <div className="app-shell">
      <div className="titlebar">
        <div className="drag-region" />
        <div className="title-brand">
          <Mark small />
          <span>头号玩家</span>
          <span className="title-separator">/</span>
          <span className="english">READY PLAYER ONE</span>
        </div>
        <span className="local-pill">
          <span className={"dot " + (state.local.online ? "mint" : "")} />
          {state.local.remote ? "已加入共享空间" : "本地工作台"}
        </span>
      </div>
      <div className="app-body">
        <aside className="sidebar">
          <button
            className="workspace-switch"
            onClick={() => setModal("workspaces")}
          >
            <div className="workspace-icon">
              <Code2 size={19} />
            </div>
            <span>
              <strong>{ws?.name || "你的开发空间"}</strong>
              <small>{state.local.remote ? "共享工作区" : "本地工作区"}</small>
            </span>
            <ChevronDown size={14} />
          </button>
          <button className="search-trigger" onClick={() => setModal("search")}>
            <Search size={15} />
            <span>搜索会话</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="nav-label">工作台</div>
          {[
            [LayoutGrid, "sessions", "会话大厅"],
            [Users, "team", "协作成员"],
            [Brain, "memory", "共享记忆"],
            [History, "history", "历史记录"],
          ].map(([Icon, id, label]: any) => (
            <button
              key={id}
              className={"nav-item " + (view === id ? "active" : "")}
              onClick={() => {
                setView(id);
                setSelected("");
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {id === "sessions" && active.length > 0 && <b>{active.length}</b>}
              {id === "team" && (
                <span className="count">{state.members.length}</span>
              )}
            </button>
          ))}
          <div className="nav-label session-label">
            进行中的会话
            <button
              title="新建会话"
              disabled={!ws}
              onClick={() => setModal("session")}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="sidebar-sessions">
            {active.map((s) => (
              <button
                className={
                  "mini-session " + (selected === s.id ? "selected" : "")
                }
                key={s.id}
                onClick={() => openSession(s)}
              >
                <span
                  className={
                    "dot " +
                    (s.lanes.some((l) => l.status === "running") ? "mint" : "")
                  }
                />
                <span>{s.title}</span>
              </button>
            ))}
            {active.length === 0 && (
              <p className="muted inset">还没有进行中的会话</p>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="hub-status">
              <Radio size={16} />
              <div>
                <strong>
                  {state.local.online ? "协作引擎已连接" : "协作连接已断开"}
                </strong>
                <small>
                  {state.local.remote
                    ? "参与者模式 · 本机执行"
                    : "会话与记忆保存在本机"}
                </small>
              </div>
            </div>
            <button
              className="profile"
              onClick={() => {
                setView("settings");
                setSelected("");
              }}
            >
              <Avatar name={state.local.name || "P"} />
              <span>
                <strong>{state.local.name || "玩家"}</strong>
                <small>我的工作台</small>
              </span>
              <Settings2 size={16} />
            </button>
          </div>
        </aside>
        <main>
          <header className="topbar">
            <div className="breadcrumbs">
              <Code2 size={16} />
              <span>{ws?.name || "工作台"}</span>
              <ChevronRight size={13} />
              <strong>
                {session?.title ||
                  (
                    {
                      sessions: "会话大厅",
                      team: "协作成员",
                      memory: "共享记忆",
                      history: "历史记录",
                      settings: "设置",
                    } as any
                  )[view]}
              </strong>
            </div>
            <div className="top-actions">
              {state.members.slice(0, 3).map((m) => (
                <Avatar key={m.id} name={m.name} small />
              ))}
              <span className="online-label">
                {state.members.length} 人在线
              </span>
              {ws && (
                <button className="button subtle" onClick={beginShare}>
                  <Link size={14} />
                  共享工作区
                </button>
              )}
            </div>
          </header>
          {!state.local.online && (
            <div className="offline-banner">
              连接中断，正在重新连接。运行中的 Agent
              已停止，避免协作状态不同步。
            </div>
          )}
          {session ? (
            <SessionRoom
              key={session.id}
              session={session}
              state={state}
              tab={sessionTab}
              setTab={setSessionTab}
              call={call}
              notify={notify}
              onAddLane={() => setModal("lane")}
              onShare={beginShare}
            />
          ) : (
            <div className="page">
              {view === "sessions" && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">MISSION CONTROL</div>
                      <h1>
                        一起，把想法变成现实
                        <span className="heading-dot">.</span>
                      </h1>
                      <p>每个人的 Agent，同一个协作现场。</p>
                    </div>
                    <button
                      className="button primary"
                      onClick={() => (ws ? setModal("session") : addProject())}
                    >
                      <Plus size={16} />
                      {ws ? "新建会话" : "打开本地项目"}
                    </button>
                  </div>
                  <div className="stats">
                    <div>
                      <Radio />
                      <span>
                        活跃会话
                        <strong>
                          {active.length.toString().padStart(2, "0")}
                        </strong>
                      </span>
                      <small>所有工作，实时可见</small>
                    </div>
                    <div>
                      <Bot />
                      <span>
                        运行中的 Agent
                        <strong>{running.toString().padStart(2, "0")}</strong>
                      </span>
                      <small>在各自的电脑上执行</small>
                    </div>
                    <div>
                      <ShieldCheck />
                      <span>
                        等待审批
                        <strong className={pending.length ? "amber-text" : ""}>
                          {pending.length.toString().padStart(2, "0")}
                        </strong>
                      </span>
                      <small>协作成员共同把关</small>
                    </div>
                  </div>
                  {pending.length > 0 && (
                    <div className="attention">
                      <ShieldCheck size={18} />
                      <span>有 {pending.length} 个执行请求等待处理</span>
                      <button
                        onClick={() => {
                          const s = sessions.find(
                            (s) => s.id === pending[0].sessionId,
                          );
                          if (s) openSession(s);
                        }}
                      >
                        前往查看
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  <div className="section-heading">
                    <h2>
                      正在发生 <span>{active.length}</span>
                    </h2>
                    <span className="live-label">
                      <span className="dot mint" />
                      实时同步
                    </span>
                  </div>
                  {active.length ? (
                    <div className="session-grid">
                      {active.map((s, i) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          index={i}
                          onClick={() => openSession(s)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="welcome-panel">
                      <div className="orbital">
                        <div className="orbit o1" />
                        <div className="orbit o2" />
                        <span className="orbit-node n1">
                          <Bot size={20} />
                        </span>
                        <span className="orbit-node n2">
                          <Code2 size={20} />
                        </span>
                        <span className="orbit-node n3">
                          <Users size={20} />
                        </span>
                        <Mark />
                      </div>
                      <div className="eyebrow">
                        YOUR NEXT CHAPTER STARTS HERE
                      </div>
                      <h2>一个房间，无限可能</h2>
                      <p>
                        打开项目，创建共享会话。邀请伙伴带着自己的 Agent 加入，
                        <br />
                        并肩推进任务，共享每一步进展。
                      </p>
                      <div className="welcome-actions">
                        <button
                          className="button primary"
                          onClick={() =>
                            ws ? setModal("session") : addProject()
                          }
                        >
                          <Plus size={16} />
                          {ws ? "创建第一个会话" : "打开本地项目"}
                        </button>
                        <button
                          className="button"
                          onClick={() => setModal("join")}
                        >
                          <Link size={15} />
                          通过邀请加入
                        </button>
                      </div>
                      <div className="welcome-features">
                        <span>
                          <LockKeyhole size={14} />
                          本地优先
                        </span>
                        <span>
                          <GitBranch size={14} />
                          独立工作树
                        </span>
                        <span>
                          <Activity size={14} />
                          共享 Agent 会话
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="bottom-note">
                    <Monitor size={15} />
                    <span>你的代码，你的机器，你的 Agent。</span>
                    <button onClick={() => setView("settings")}>
                      管理智能体
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </>
              )}
              {view === "history" && (
                <>
                  <PageHeading
                    eyebrow="SESSION ARCHIVE"
                    title="每一次协作，都有迹可循"
                    subtitle="完整保留会话、执行记录和团队决策。"
                  />
                  {sessions
                    .filter((s) => s.status === "archived")
                    .map((s) => (
                      <button
                        className="history-row"
                        key={s.id}
                        onClick={() => openSession(s)}
                      >
                        <CheckCheck size={19} />
                        <div>
                          <strong>{s.title}</strong>
                          <small>
                            {new Date(s.at).toLocaleDateString("zh-CN")} ·{" "}
                            {s.lanes.length} 个通道
                          </small>
                        </div>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  {!sessions.some((s) => s.status === "archived") && (
                    <Empty
                      icon={History}
                      title="还没有归档会话"
                      text="完成一个任务后，可以在会话右上角归档。"
                    />
                  )}
                </>
              )}
              {view === "team" && (
                <>
                  <PageHeading
                    eyebrow="MULTIPLAYER"
                    title="你的伙伴，已在现场"
                    subtitle="每位成员使用自己的本地 CLI 和账号。会话进展实时共享。"
                    action={
                      <button
                        className="button primary"
                        disabled={!ws}
                        onClick={beginShare}
                      >
                        <Link size={16} />
                        邀请伙伴
                      </button>
                    }
                  />
                  <div className="members-grid">
                    {state.members.map((m) => (
                      <div className="member-card" key={m.id}>
                        <Avatar name={m.name} />
                        <h3>
                          {m.name}
                          {m.id === state.me?.id && <small>（你）</small>}
                        </h3>
                        <span className="tag">
                          {m.host ? "房主" : "协作者"}
                        </span>
                        <p>
                          <span className="dot mint" />
                          在线 · 可以加入会话
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="info-box">
                    <Radio size={20} />
                    <div>
                      <h3>同一会话，各自的 Agent</h3>
                      <p>
                        邀请成员加入工作区，在本机关联同一项目。进入会话后，点击「添加我的
                        Agent」即可创建自己的通道。所有人都能查看通道、共同维护计划、处理审批和发送评论。
                      </p>
                    </div>
                  </div>
                </>
              )}
              {view === "memory" && (
                <>
                  <PageHeading
                    eyebrow="SHARED BRAIN"
                    title="让共识，成为团队记忆"
                    subtitle="记录约定、决策和注意事项，自动作为每次 Agent 执行的上下文。"
                    action={
                      <button
                        className="button primary"
                        disabled={!ws}
                        onClick={() => setModal("memory")}
                      >
                        <Plus size={16} />
                        添加记忆
                      </button>
                    }
                  />
                  <div className="memory-grid">
                    {state.memories
                      .filter((m) => m.workspaceId === workspace)
                      .map((m) => (
                        <article
                          className={
                            "memory-card " + (m.retired ? "retired" : "")
                          }
                          key={m.id}
                        >
                          <Brain size={19} />
                          <h3>{m.title}</h3>
                          <p>{m.text}</p>
                          <footer>
                            <span>
                              {m.owner} · {m.retired ? "已停用" : "已生效"}
                            </span>
                            <button
                              onClick={() =>
                                call("memory.retire", { id: m.id })
                              }
                            >
                              {m.retired ? "重新启用" : "停用"}
                            </button>
                          </footer>
                        </article>
                      ))}
                  </div>
                  {!state.memories.some((m) => m.workspaceId === workspace) && (
                    <Empty
                      icon={Brain}
                      title="把重要的事，记在一起"
                      text="例如：接口约定、项目结构、测试命令或设计决策。"
                    />
                  )}
                </>
              )}
              {view === "settings" && (
                <>
                  <PageHeading
                    eyebrow="PREFERENCES"
                    title="按你的方式工作"
                    subtitle="应用默认中文，无需登录 Amoeba，也不依赖它的云端服务。"
                  />
                  <div className="settings-section">
                    <h2>智能体与提供商</h2>
                    <p>
                      使用已安装并登录的本机 CLI。模型调用由对应提供商处理。
                    </p>
                    {state.local.providers.map((p) => (
                      <div className="provider-row" key={p.id}>
                        <div className={"provider-icon " + p.id}>
                          {p.id === "codex" ? <Code2 /> : <span>✳</span>}
                        </div>
                        <div>
                          <strong>
                            {p.id === "codex" ? "OpenAI Codex" : "Claude Code"}
                          </strong>
                          <small>{p.version}</small>
                        </div>
                        <span className={"tag " + (p.available ? "green" : "")}>
                          {p.available ? "已检测到" : "未安装"}
                        </span>
                      </div>
                    ))}
                    <button
                      className="button"
                      onClick={() => call("providers.refresh")}
                    >
                      <RefreshCw size={14} />
                      重新检测
                    </button>
                  </div>
                  <div className="settings-section">
                    <h2>个人资料</h2>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const name = new FormData(e.currentTarget).get("name");
                        await call("settings.name", { name });
                        notify("昵称已更新");
                      }}
                    >
                      <div className="inline-form">
                        <input
                          name="name"
                          defaultValue={state.local.name}
                          maxLength={40}
                          placeholder="协作昵称"
                          required
                        />
                        <button className="button">保存昵称</button>
                      </div>
                    </form>
                  </div>
                  <div className="settings-section">
                    <h2>本地数据</h2>
                    <p className="mono">{state.local.dataDir}</p>
                    <p>
                      项目目录、会话、记忆与审批保存在此电脑。共享时，受邀成员可以查看工作区内的对话和主动共享的
                      Git diff。邀请 24 小时有效，可随时撤销。
                    </p>
                    <p>
                      当前支持可信局域网 / VPN 内协作。跨公网请使用加密
                      VPN；应用不提供云端中继。
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
          <footer className="statusbar">
            <span>
              <span className={"dot " + (state.local.online ? "mint" : "")} />
              {state.local.online ? "协作就绪" : "正在重连"}
            </span>
            <span>
              <GitBranch size={12} />
              {ws?.branch || "尚未打开项目"}
            </span>
            <span className="status-end">
              UTF-8 <span>简体中文</span>
              <span>v0.1.0</span>
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal("")}>
          <div
            className={"modal " + (modal === "search" ? "search-modal" : "")}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setModal("")}
              aria-label="关闭"
            >
              <X size={19} />
            </button>
            {modal === "session" && (
              <>
                <div className="modal-icon">
                  <LayoutGrid />
                </div>
                <h2>开启一个共同的任务</h2>
                <p>一个会话，一份计划。伙伴可以带着自己的 Agent 加入。</p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const s = await call<Session>("session.create", {
                      workspaceId: workspace,
                      title: f.get("title"),
                      description: f.get("description"),
                    });
                    if (s) {
                      openSession(s);
                      setModal("lane");
                    }
                  }}
                >
                  <label>
                    会话名称
                    <input
                      autoFocus
                      name="title"
                      required
                      maxLength={150}
                      placeholder="例如：一起完成用户登录功能"
                    />
                  </label>
                  <label>
                    任务说明
                    <textarea
                      name="description"
                      placeholder="目标、约束和完成标准，所有协作者都能看到。"
                      rows={4}
                    />
                  </label>
                  <div className="modal-info">
                    <GitBranch size={15} />
                    {ws?.branch}
                    <span>在 {ws?.name} 中创建</span>
                  </div>
                  <button className="button primary full">
                    创建会话
                    <ArrowRight size={16} />
                  </button>
                </form>
              </>
            )}
            {modal === "lane" && session && (
              <>
                <div className="modal-icon">
                  <Bot />
                </div>
                <h2>添加我的 Agent</h2>
                <p>
                  每个通道使用你本机的 CLI 和提供商账号。其他成员可以实时查看。
                </p>
                {state.local.providers.map((p) => (
                  <button
                    key={p.id}
                    disabled={!p.available}
                    className="provider-choice"
                    onClick={async () => {
                      const l = await call("lane.create", {
                        sessionId: session.id,
                        provider: p.id,
                      });
                      if (l) setModal("");
                    }}
                  >
                    <div className={"provider-icon " + p.id}>
                      {p.id === "codex" ? <Code2 /> : <span>✳</span>}
                    </div>
                    <span>
                      <strong>
                        {p.id === "codex" ? "Codex" : "Claude Code"}
                      </strong>
                      <small>
                        {p.available
                          ? "使用我的本地账号"
                          : "请先安装 CLI，再在设置里重新检测"}
                      </small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ))}
                <p className="small-note">
                  尚未登录？请在系统终端运行 codex login 或 claude 完成登录。
                </p>
              </>
            )}
            {modal === "memory" && (
              <>
                <div className="modal-icon">
                  <Brain />
                </div>
                <h2>添加共享记忆</h2>
                <p>这条记忆会随共享上下文传给成员发起的 Agent。</p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const m = await call("memory.add", {
                      workspaceId: workspace,
                      title: f.get("title"),
                      text: f.get("text"),
                    });
                    if (m) setModal("");
                  }}
                >
                  <label>
                    标题
                    <input
                      autoFocus
                      required
                      name="title"
                      maxLength={120}
                      placeholder="例如：项目编码约定"
                    />
                  </label>
                  <label>
                    内容
                    <textarea
                      required
                      name="text"
                      rows={5}
                      maxLength={6000}
                      placeholder="写下团队应该共同知道的事情……"
                    />
                  </label>
                  <button className="button primary full">保存记忆</button>
                </form>
              </>
            )}
            {modal === "share" && (
              <>
                <div className="modal-icon">
                  <Users />
                </div>
                <h2>邀请伙伴，共享现场</h2>
                <p>
                  加入者可以查看本工作区的会话、评论、记忆和共享变更，并参与审批。
                </p>
                {state.local.remote ? (
                  <div className="info-box">
                    你是受邀成员。请联系房主获取邀请链接。
                  </div>
                ) : (
                  <>
                    <div className="share-preview">
                      <div className="share-workspace">
                        <div className="workspace-icon">
                          <Code2 />
                        </div>
                        <div>
                          <strong>{ws?.name}</strong>
                          <small>24 小时有效 · 工作区协作权限</small>
                        </div>
                      </div>
                      <div className="share-network">
                        <Radio size={15} />
                        可信局域网或 VPN 内连接；房主需保持应用打开。
                      </div>
                    </div>
                    {share ? (
                      <>
                        <label>
                          邀请链接
                          <div className="copy-input">
                            <input readOnly value={share.url} />
                            <button
                              title="复制邀请"
                              onClick={() => {
                                call("clipboard", { text: share.url });
                                notify("邀请已复制");
                              }}
                            >
                              <Copy size={16} />
                            </button>
                          </div>
                        </label>
                        {share.addresses.length > 1 && (
                          <label>
                            伙伴能访问的本机地址
                            <select
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
                          </label>
                        )}
                        <p className="success-text">
                          <Check size={14} />
                          已复制邀请链接，发给伙伴即可加入。
                        </p>
                      </>
                    ) : (
                      <button
                        className="button primary full"
                        disabled={loading}
                        onClick={async () => {
                          setLoading(true);
                          const result = await call("share.create", {
                            workspaceId: workspace,
                            sessionId: session?.id,
                          });
                          setShare(result);
                          setLoading(false);
                        }}
                      >
                        {loading ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Link size={16} />
                        )}
                        开启共享并复制邀请
                      </button>
                    )}
                    <button
                      className="text-button danger"
                      onClick={async () => {
                        await call("invite.revoke", { workspaceId: workspace });
                        setShare(null);
                        notify("此工作区的邀请已撤销，受邀连接已断开");
                      }}
                    >
                      撤销此工作区所有邀请
                    </button>
                  </>
                )}
                <div className="divider" />
                <button
                  className="button full"
                  onClick={() => setModal("join")}
                >
                  <Link size={15} />
                  加入其他人的工作区
                </button>
              </>
            )}
            {modal === "join" && (
              <>
                <div className="modal-icon">
                  <Link />
                </div>
                <h2>加入伙伴的工作区</h2>
                <p>粘贴对方分享的邀请链接。加入后，在本机关联同一项目目录。</p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setLoading(true);
                    const f = new FormData(e.currentTarget);
                    const ok = await call("share.join", { url: f.get("url") });
                    setLoading(false);
                    if (ok) {
                      setModal("");
                      if (ok.workspaceId) setWorkspace(ok.workspaceId);
                      setSelected(ok.sessionId || "");
                      setView("sessions");
                      notify("已加入共享工作区");
                    }
                  }}
                >
                  <label>
                    邀请链接
                    <textarea
                      autoFocus
                      name="url"
                      required
                      rows={3}
                      placeholder="rpo://join?host=…"
                    />
                  </label>
                  <button disabled={loading} className="button primary full">
                    {loading ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                    加入共享工作区
                  </button>
                </form>
              </>
            )}
            {modal === "workspaces" && (
              <>
                <h2>切换工作区</h2>
                <p>选择项目，进入它的协作现场。</p>
                {state.workspaces.map((w) => (
                  <button
                    className="workspace-option"
                    key={w.id}
                    onClick={() => {
                      setWorkspace(w.id);
                      setSelected("");
                      setView("sessions");
                      setModal("");
                    }}
                  >
                    <Folder size={18} />
                    <span>{w.name}</span>
                    {w.id === workspace && <Check size={16} />}
                  </button>
                ))}
                <div className="divider" />
                {!state.local.remote && (
                  <button
                    className="button full"
                    onClick={async () => {
                      await addProject();
                      setModal("");
                    }}
                  >
                    <Plus size={16} />
                    打开本地项目
                  </button>
                )}
                <button
                  className="button full gap-top"
                  onClick={() => setModal("join")}
                >
                  <Link size={16} />
                  通过邀请加入
                </button>
                {state.local.remote && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      await call("share.leave");
                      setModal("");
                    }}
                  >
                    返回我的本地工作台
                  </button>
                )}
              </>
            )}
            {modal === "search" && (
              <>
                <h2>寻找一个会话</h2>
                <div className="search-box">
                  <Search size={18} />
                  <input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索名称、描述或成员……"
                  />
                </div>
                {sessions
                  .filter((s) =>
                    (s.title + s.description + s.owner)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((s) => (
                    <button
                      className="workspace-option"
                      key={s.id}
                      onClick={() => {
                        openSession(s);
                        setModal("");
                      }}
                    >
                      <MessageSquare size={17} />
                      <span>{s.title}</span>
                      <ArrowRight size={14} />
                    </button>
                  ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      <Icon size={35} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function SessionCard({
  session: s,
  index,
  onClick,
}: {
  session: Session;
  index: number;
  onClick: () => void;
}) {
  const busy = s.lanes.some((l) => l.status === "running"),
    awaiting = s.lanes.some((l) => l.status === "awaiting"),
    done = s.plan.filter((p) => p.done).length;
  return (
    <button className="session-card" onClick={onClick}>
      <div className="card-top">
        <span className="session-number">
          SESSION {String(index + 1).padStart(2, "0")}
        </span>
        <span className={"tag " + (busy ? "green" : awaiting ? "amber" : "")}>
          <span className={"dot " + (busy ? "mint" : "")} />
          {busy ? "执行中" : awaiting ? "等待审批" : "协作就绪"}
        </span>
      </div>
      <h3>{s.title}</h3>
      <p>{s.description || "进入会话，添加 Agent 并开始协作。"}</p>
      <div className="card-branch">
        <GitBranch size={13} />
        {s.branch}
      </div>
      <div className="card-progress">
        <span
          style={{
            width: `${s.plan.length ? (done / s.plan.length) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="card-bottom">
        <div>
          <Avatar name={s.owner} small />
          {s.lanes.length > 0 && <span>{s.lanes.length} 个 Agent 通道</span>}
        </div>
        <span>
          {s.plan.length ? `${done} / ${s.plan.length} 步完成` : "尚未添加计划"}
        </span>
        <ArrowRight size={15} />
      </div>
    </button>
  );
}
type Call = (method: string, args?: Record<string, unknown>) => Promise<any>;
function SessionRoom({
  session: s,
  state,
  tab,
  setTab,
  call,
  notify,
  onAddLane,
  onShare,
}: {
  session: Session;
  state: State;
  tab: string;
  setTab: (s: string) => void;
  call: Call;
  notify: (s: string) => void;
  onAddLane: () => void;
  onShare: () => void;
}) {
  const [rail, setRail] = useState("plan"),
    [plan, setPlan] = useState(""),
    [comment, setComment] = useState(""),
    [anchor, setAnchor] = useState(""),
    [liveDiff, setLiveDiff] = useState(false),
    [diffLane, setDiffLane] = useState("");
  const own = s.lanes.filter((l) => l.ownerId === state.me?.id),
    mapped = !!state.local.paths[s.workspaceId],
    params = { workspaceId: s.workspaceId, sessionId: s.id },
    pending = state.approvals.filter(
      (a) => a.sessionId === s.id && a.status === "pending",
    );
  const ownId = own[0]?.id;
  useEffect(() => {
    if (!liveDiff || !ownId) return;
    let busy = false;
    const publish = async () => {
      if (busy) return;
      busy = true;
      await call("diff.publish", { ...params, laneId: ownId });
      busy = false;
    };
    publish();
    const t = setInterval(publish, 3000);
    return () => clearInterval(t);
  }, [liveDiff, ownId, s.id]);
  const chosenLane =
    s.lanes.find((l) => l.id === diffLane) ||
    s.lanes.find((l) => l.diff) ||
    s.lanes[0];
  return (
    <div className="room">
      <div className="room-heading">
        <div className="eyebrow">
          SHARED SESSION{" "}
          <span className="live-label">
            <span className="dot mint" />
            LIVE
          </span>
        </div>
        <div className="room-title">
          <h1>{s.title}</h1>
          <div className="room-buttons">
            <button
              className="icon-button"
              title="导出会话"
              onClick={() => call("session.export", { sessionId: s.id })}
            >
              <ArrowDownToLine size={17} />
            </button>
            <button
              className="button subtle"
              onClick={async () => {
                await call("session.archive", {
                  sessionId: s.id,
                  restore: s.status === "archived",
                });
              }}
            >
              <History size={14} />
              {s.status === "archived" ? "恢复会话" : "归档"}
            </button>
            <button className="button primary" onClick={onShare}>
              <Users size={15} />
              邀请协作
            </button>
          </div>
        </div>
        <p>
          {s.description ||
            "所有通道共享任务与计划，Agent 在各自的电脑上执行。"}
        </p>
        <div className="room-meta">
          <GitBranch size={13} />
          <span>{s.branch}</span>
          <span className="meta-separator" />
          <Avatar name={s.owner} small />
          <span>{s.owner} 创建</span>
          <span className="meta-separator" />
          <LockKeyhole size={12} />
          <span>仅受邀成员可见</span>
        </div>
      </div>
      {!mapped && (
        <div className="attention map-banner">
          <FolderOpen size={18} />
          <span>关联本机项目目录后，即可运行自己的 Agent 和查看代码。</span>
          <button
            onClick={() => call("project.map", { workspaceId: s.workspaceId })}
          >
            关联项目
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="room-tabs">
        <div>
          {[
            [Bot, "agents", "Agent 通道"],
            [Files, "editor", "代码文件"],
            [GitCompareArrows, "diff", "共享变更"],
            [TerminalSquare, "terminal", "命令终端"],
          ].map(([Icon, id, label]: any) => (
            <button
              className={tab === id ? "active" : ""}
              key={id}
              onClick={() => setTab(id)}
            >
              <Icon size={15} />
              {label}
              {id === "agents" && <span>{s.lanes.length}</span>}
            </button>
          ))}
        </div>
        <button
          className="text-button"
          onClick={onAddLane}
          disabled={s.status === "archived"}
        >
          <Plus size={14} />
          添加我的 Agent
        </button>
      </div>
      <div className="room-body">
        <div className="room-main">
          {tab === "agents" && (
            <div className="lanes">
              {s.lanes.map((l) => (
                <AgentLane
                  key={l.id}
                  lane={l}
                  session={s}
                  state={state}
                  call={call}
                  mapped={mapped}
                />
              ))}
              {!s.lanes.length && (
                <div className="lane-empty">
                  <div className="lane-illustration">
                    <Bot size={35} />
                    <span className="connection-line" />
                    <Users size={30} />
                  </div>
                  <h2>让你的 Agent 入场</h2>
                  <p>
                    每位伙伴拥有自己的对话通道。
                    <br />
                    所有人的进展，都在同一个现场。
                  </p>
                  <button
                    className="button primary"
                    onClick={onAddLane}
                    disabled={s.status === "archived"}
                  >
                    <Plus size={16} />
                    添加我的 Agent
                  </button>
                </div>
              )}
            </div>
          )}
          {tab === "editor" && (
            <Editor
              params={params}
              mapped={mapped}
              call={call}
              notify={notify}
            />
          )}
          {tab === "terminal" && (
            <CommandTerminal params={params} mapped={mapped} call={call} />
          )}
          {tab === "diff" && (
            <div className="diff-panel">
              <div className="diff-toolbar">
                <select
                  value={chosenLane?.id || ""}
                  onChange={(e) => setDiffLane(e.target.value)}
                >
                  {s.lanes.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.owner} · {l.provider}
                    </option>
                  ))}
                </select>
                {own.length > 0 && (
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={liveDiff}
                      disabled={!mapped}
                      onChange={(e) => setLiveDiff(e.target.checked)}
                    />
                    实时共享我的 Git diff
                  </label>
                )}
              </div>
              <p className="diff-note">
                开启后，已跟踪文件的变更内容每 3
                秒同步给工作区成员。请检查是否含有敏感内容。未跟踪文件仅共享文件名。
              </p>
              {chosenLane?.changedFiles?.length ? (
                <div className="diff-files">
                  {chosenLane.changedFiles.map((f) => (
                    <span key={f.path}>
                      <b>{f.status}</b>
                      {f.path}
                    </span>
                  ))}
                </div>
              ) : null}
              {chosenLane?.diff ? (
                <pre className="diff-code">
                  {chosenLane.diff.split("\n").map((line, i) => (
                    <div
                      className={
                        line.startsWith("+")
                          ? "added"
                          : line.startsWith("-")
                            ? "removed"
                            : line.startsWith("@@")
                              ? "hunk"
                              : ""
                      }
                      key={i}
                    >
                      {line || " "}
                    </div>
                  ))}
                </pre>
              ) : (
                <Empty
                  icon={GitCompareArrows}
                  title="共享变更，一起审阅"
                  text="开启实时共享后，团队成员可以在这里查看你的 Git diff。"
                />
              )}
            </div>
          )}
        </div>
        <aside className="session-rail">
          {pending.length > 0 && (
            <div className="approval-section">
              <div className="rail-title">
                <ShieldCheck size={15} />
                <strong>等待审批</strong>
                <span>{pending.length}</span>
              </div>
              {pending.map((a) => (
                <article className="approval-card" key={a.id}>
                  <div>
                    <Avatar name={a.owner} small />
                    <strong>{a.owner}</strong>
                    <span>{a.provider}</span>
                  </div>
                  <p>{a.prompt}</p>
                  <small>
                    {a.mode === "read-only" ? "只读分析" : "允许修改本机工作区"}{" "}
                    · 使用 {a.owner} 的账号
                  </small>
                  {a.files.length > 0 && (
                    <small>计划文件：{a.files.join("、")}</small>
                  )}
                  {a.overlaps.length > 0 && (
                    <div className="overlap">
                      文件范围重叠：{a.overlaps.join("、")}
                    </div>
                  )}
                  <footer>
                    <button
                      onClick={() =>
                        call("approval.decide", { id: a.id, allow: false })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="allow"
                      onClick={() =>
                        call("approval.decide", { id: a.id, allow: true })
                      }
                    >
                      <Check size={13} />
                      批准执行
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          )}
          <div className="rail-tabs">
            <button
              className={rail === "plan" ? "active" : ""}
              onClick={() => setRail("plan")}
            >
              共同计划
            </button>
            <button
              className={rail === "comments" ? "active" : ""}
              onClick={() => setRail("comments")}
            >
              讨论 <span>{s.comments.length}</span>
            </button>
          </div>
          {rail === "plan" ? (
            <div className="rail-content">
              <div className="plan-summary">
                <span>任务进度</span>
                <strong>
                  {s.plan.filter((p) => p.done).length}
                  <em> / {s.plan.length}</em>
                </strong>
              </div>
              <div className="card-progress">
                <span
                  style={{
                    width: `${s.plan.length ? (s.plan.filter((p) => p.done).length / s.plan.length) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="plan-list">
                {s.plan.map((p) => (
                  <button
                    key={p.id}
                    className={"plan-item " + (p.done ? "completed" : "")}
                    onClick={() =>
                      call("plan.toggle", { sessionId: s.id, id: p.id })
                    }
                  >
                    <span className="checkbox">
                      {p.done && <Check size={12} />}
                    </span>
                    <div>
                      {p.text}
                      <small>{p.owner}</small>
                    </div>
                  </button>
                ))}
              </div>
              {!s.plan.length && (
                <p className="rail-empty">
                  把任务拆成小步，
                  <br />
                  所有人一起推进。
                </p>
              )}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await call("plan.add", { sessionId: s.id, text: plan }))
                    setPlan("");
                }}
                className="add-plan"
              >
                <Plus size={14} />
                <input
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  placeholder="添加一个步骤，回车保存"
                  required
                  maxLength={500}
                />
              </form>
              <div className="rail-divider" />
              <div className="rail-title">
                <GitBranch size={15} />
                <strong>我的运行目录</strong>
              </div>
              <p className="path-text">
                {state.local.sessionPaths[s.id] ||
                  state.local.paths[s.workspaceId] ||
                  "尚未关联本机项目"}
              </p>
              <button
                className="button full small-button"
                disabled={!mapped}
                onClick={async () => {
                  const p = await call("worktree.create", params);
                  if (p) notify("独立工作树已就绪，新执行将在其中进行");
                }}
              >
                <GitBranch size={14} />
                {state.local.sessionPaths[s.id]
                  ? "工作树已创建"
                  : "创建独立工作树"}
              </button>
              <p className="small-note">
                从本机当前 HEAD
                创建分支。不包含未提交改动。工作树用于分开代码变更。
              </p>
            </div>
          ) : (
            <div className="rail-content comments">
              <div className="comment-list">
                {s.comments.map((c) => (
                  <article key={c.id}>
                    <header>
                      <Avatar name={c.owner} small />
                      <strong>{c.owner}</strong>
                      <time>{time(c.at)}</time>
                    </header>
                    {c.anchor && (
                      <span className="comment-anchor">{c.anchor}</span>
                    )}
                    <p>{c.text}</p>
                  </article>
                ))}
                {!s.comments.length && (
                  <p className="rail-empty">
                    在这里交流想法、交接任务。
                    <br />
                    评论不会调用模型。
                  </p>
                )}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await call("comment.add", {
                      sessionId: s.id,
                      text: comment,
                      anchor,
                    })
                  ) {
                    setComment("");
                    setAnchor("");
                  }
                }}
              >
                <input
                  value={anchor}
                  onChange={(e) => setAnchor(e.target.value)}
                  placeholder="关联位置（选填）：src/app.ts:12"
                />
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="给伙伴留言……"
                  required
                  rows={3}
                />
                <button className="button full" disabled={!comment.trim()}>
                  发送评论
                  <ArrowUp size={14} />
                </button>
              </form>
            </div>
          )}
          <div className="rail-foot">
            <span className="dot mint" />
            房间内的变更实时同步
          </div>
        </aside>
      </div>
    </div>
  );
}
function AgentLane({
  lane: l,
  session: s,
  state,
  call,
  mapped,
}: {
  lane: Lane;
  session: Session;
  state: State;
  call: Call;
  mapped: boolean;
}) {
  const [prompt, setPrompt] = useState(
      () => localStorage.getItem("rpo-prompt-" + l.id) || "",
    ),
    [mode, setMode] = useState("read-only"),
    [files, setFiles] = useState(""),
    [expanded, setExpanded] = useState(false);
  const bottom = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    [follow, setFollow] = useState(true);
  const mine = l.ownerId === state.me?.id,
    busy = ["running", "awaiting"].includes(l.status);
  useEffect(() => {
    localStorage.setItem("rpo-prompt-" + l.id, prompt);
  }, [prompt, l.id]);
  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [l.entries.length, follow]);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    const a = await call("run.request", {
      workspaceId: s.workspaceId,
      sessionId: s.id,
      laneId: l.id,
      prompt,
      mode,
      files: files
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    });
    if (a) setPrompt("");
  };
  return (
    <section className={"agent-lane " + (mine ? "mine" : "")}>
      <header className="lane-header">
        <div className={"provider-icon small " + l.provider}>
          {l.provider === "codex" ? <Code2 size={16} /> : <span>✳</span>}
        </div>
        <div>
          <strong>
            {l.owner}
            <span>{mine ? "我的通道" : "协作通道"}</span>
          </strong>
          <small>{l.provider === "codex" ? "Codex" : "Claude Code"}</small>
        </div>
        <span className={"lane-status " + l.status}>
          {l.status === "running" ? (
            <LoaderCircle className="spin" size={12} />
          ) : (
            <span className={"dot " + (l.status === "done" ? "mint" : "")} />
          )}
          {statusNames[l.status] || l.status}
        </span>
      </header>
      <div
        className="lane-messages"
        ref={scroll}
        onScroll={() => {
          const e = scroll.current;
          if (e) setFollow(e.scrollHeight - e.scrollTop - e.clientHeight < 80);
        }}
      >
        {l.entries.map((e) => (
          <article className={"entry " + e.role} key={e.id}>
            {e.role === "system" ? (
              <p>
                <Activity size={12} />
                {e.text}
              </p>
            ) : (
              <>
                <div className="entry-heading">
                  <span>
                    {e.role === "user"
                      ? l.owner
                      : e.role === "tool"
                        ? "工具执行"
                        : l.provider === "codex"
                          ? "Codex"
                          : "Claude"}
                  </span>
                  <time>{time(e.at)}</time>
                </div>
                {e.role === "tool" ? (
                  <details>
                    <summary>
                      <TerminalSquare size={13} />
                      {e.text.split("\n")[0].slice(0, 100)}
                    </summary>
                    <pre>{e.text}</pre>
                  </details>
                ) : (
                  <div className="message-text">{e.text}</div>
                )}
              </>
            )}
          </article>
        ))}
        {l.entries.filter((e) => e.role === "user").length === 0 && (
          <div className="lane-intro">
            <Bot size={28} />
            <h3>准备好一起工作了</h3>
            <p>
              {mine
                ? "描述你的任务，发起执行请求。"
                : "等待伙伴发起任务，进展将在这里实时出现。"}
            </p>
            <div className="lane-context">
              <Brain size={12} />
              自动带入共同计划与共享记忆
            </div>
          </div>
        )}
        {l.status === "running" && (
          <div className="thinking">
            <i />
            <i />
            <i />
            <span>Agent 正在工作</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {mine ? (
        <form className="composer" onSubmit={submit}>
          <div className="composer-owner">
            <span className="dot mint" />
            使用我的 {l.provider === "codex" ? "Codex" : "Claude"} 账号
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              mapped ? "描述任务，让 Agent 开始工作……" : "先关联本机项目目录"
            }
            disabled={!mapped || s.status === "archived"}
            rows={3}
          />
          {expanded && (
            <input
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder="计划修改的文件，用英文逗号分隔"
            />
          )}
          <div className="composer-controls">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              aria-label="权限模式"
            >
              <option value="read-only">只读分析</option>
              <option value="workspace-write">工作区写入</option>
            </select>
            <button
              type="button"
              className={"scope-toggle " + (expanded ? "active" : "")}
              title="计划文件范围，用于冲突提示"
              onClick={() => setExpanded(!expanded)}
            >
              <Files size={14} />
            </button>
            {busy ? (
              <button
                type="button"
                className="send stop"
                title="请求停止"
                onClick={() =>
                  call("lane.stop", { sessionId: s.id, laneId: l.id })
                }
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                className="send"
                disabled={!prompt.trim() || !mapped || s.status === "archived"}
                title="发起审批并执行"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <div className="composer-hint">批准后执行 · ⌘ Enter 发送</div>
        </form>
      ) : (
        <div className="watching">
          <Radio size={14} />
          <span>
            {state.members.some((m) => m.id === l.ownerId)
              ? `正在实时观看 ${l.owner} 的 Agent`
              : "此成员当前离线 · 历史通道已保留"}
          </span>
          {l.status === "running" && (
            <button
              onClick={() =>
                call("lane.stop", { sessionId: s.id, laneId: l.id })
              }
              title="请求伙伴停止"
            >
              <Square size={12} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
function Editor({
  params,
  mapped,
  call,
  notify,
}: {
  params: { workspaceId: string; sessionId: string };
  mapped: boolean;
  call: Call;
  notify: (s: string) => void;
}) {
  const [listing, setListing] = useState<any[]>([]),
    [path, setPath] = useState(""),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [original, setOriginal] = useState(""),
    [hash, setHash] = useState(""),
    [pendingFile, setPendingFile] = useState("");
  const list = async (p: string) => {
    const f = await call("files", { ...params, path: p });
    if (f) {
      setListing(f);
      setPath(p);
    }
  };
  useEffect(() => {
    if (mapped) list("");
  }, [mapped, params.sessionId]);
  const open = async (p: string, force = false) => {
    if (force && file)
      localStorage.removeItem(`rpo-file-${params.sessionId}-${file}`);
    if (content !== original && !force) {
      setPendingFile(p);
      return;
    }
    const r = await call("file.read", { ...params, path: p });
    if (r) {
      const stored = localStorage.getItem(`rpo-file-${params.sessionId}-${p}`);
      let draft;
      try {
        draft = stored ? JSON.parse(stored) : null;
      } catch {}
      setFile(p);
      setContent(draft?.content ?? r.content);
      setOriginal(draft?.original ?? r.content);
      setHash(draft?.hash ?? r.hash);
      setPendingFile("");
      if (draft) notify("已恢复本机未保存草稿；保存时会检查文件冲突");
    }
  };
  useEffect(() => {
    if (!file) return;
    const key = `rpo-file-${params.sessionId}-${file}`;
    if (content !== original)
      localStorage.setItem(key, JSON.stringify({ content, original, hash }));
    else localStorage.removeItem(key);
  }, [content, original, hash, file, params.sessionId]);
  const save = async () => {
    const r = await call("file.save", { ...params, path: file, content, hash });
    if (r) {
      setHash(r.hash);
      setOriginal(content);
      notify("文件已保存到本机");
    }
  };
  const ext = file.endsWith(".md")
    ? markdown()
    : file.endsWith(".json")
      ? json()
      : javascript({ typescript: true, jsx: true });
  if (!mapped)
    return (
      <Empty
        icon={FolderOpen}
        title="先关联本机项目"
        text="点击上方的「关联项目」，选择本机代码目录。"
      />
    );
  return (
    <div className="editor">
      <aside className="file-tree">
        <header>
          <span>资源管理器</span>
          <button title="刷新" onClick={() => list(path)}>
            <RefreshCw size={13} />
          </button>
        </header>
        {path && (
          <button onClick={() => list(path.split("/").slice(0, -1).join("/"))}>
            ../ 返回上级
          </button>
        )}
        {listing.map((f) => (
          <button
            title={f.path}
            className={file === f.path ? "selected" : ""}
            key={f.path}
            onClick={() => (f.directory ? list(f.path) : open(f.path))}
          >
            {f.directory ? <Folder size={14} /> : <FileCode2 size={14} />}
            <span>{f.name}</span>
            {f.directory && <ChevronRight size={12} />}
          </button>
        ))}
      </aside>
      <div className="editor-pane">
        {file ? (
          <>
            <div className="editor-file">
              <FileCode2 size={14} />
              <span>
                {file}
                {content !== original ? " ●" : ""}
              </span>
              <button
                className="button"
                onClick={save}
                disabled={content === original}
              >
                保存
              </button>
            </div>
            {pendingFile && (
              <div className="attention">
                <span>当前文件尚未保存</span>
                <button onClick={() => open(pendingFile, true)}>
                  放弃修改并打开
                </button>
                <button onClick={() => setPendingFile("")}>取消</button>
              </div>
            )}
            <CodeMirror
              value={content}
              height="100%"
              theme="dark"
              extensions={[ext]}
              onChange={setContent}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                autocompletion: true,
              }}
            />
          </>
        ) : (
          <Empty
            icon={Code2}
            title="代码与协作，在同一个地方"
            text="选择左侧文件开始编辑。保存前会检查外部修改，避免覆盖。"
          />
        )}
      </div>
    </div>
  );
}
function CommandTerminal({
  params,
  mapped,
  call,
}: {
  params: { workspaceId: string; sessionId: string };
  mapped: boolean;
  call: Call;
}) {
  const [command, setCommand] = useState(""),
    [output, setOutput] = useState(
      "头号玩家 · 本机命令终端\n逐条执行 shell 命令；每条命令使用新的 shell。交互式 CLI 请使用系统终端。\n",
    ),
    [busy, setBusy] = useState(false);
  return (
    <div className="command-terminal">
      <header>
        <TerminalSquare size={15} />
        <span>本机 zsh</span>
        <small>只在你的电脑执行 · 60 秒超时</small>
      </header>
      <pre>
        {output}
        {busy ? "\n执行中……" : ""}
      </pre>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!command.trim() || busy) return;
          const cmd = command;
          setCommand("");
          setBusy(true);
          setOutput((o) => o + "\n$ " + cmd + "\n");
          const r = await call("terminal.run", { ...params, command: cmd });
          setOutput((o) =>
            (
              o +
              (r?.output || "执行失败") +
              `\n[退出码 ${r?.code ?? "?"}]\n`
            ).slice(-150000),
          );
          setBusy(false);
        }}
      >
        <span>❯</span>
        <input
          disabled={!mapped || busy}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="输入本机命令，例如 git status"
        />
        <button
          className="button"
          disabled={!mapped || busy || !command.trim()}
        >
          执行
          <ArrowRight size={14} />
        </button>
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
