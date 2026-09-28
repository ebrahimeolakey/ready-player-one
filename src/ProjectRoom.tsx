import { aiName } from "./ui";
import { BeginnerGuide } from "./BeginnerGuide";
import { Cindy, type CindyAction } from "./Cindy";
import { AgentMember } from "./AgentMember";
import { ProjectArtifacts } from "./ProjectArtifacts";
import { TeamSpace } from "./TeamSpace";
import { LocalSetup } from "./LocalSetup";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Send,
  FolderOpen,
  Bot,
  FileText,
  X,
  UserPlus,
  ArrowRight,
  Sparkles,
  Columns3,
  MessageSquare,
} from "lucide-react";
import type { State, Session } from "./types";
import { TaskSession } from "./TaskSession";
import { Avatar, Modal, time, type Call } from "./ui";
import "./project-room.css";

const status: Record<string, string> = {
  proposed: "待认领",
  ready: "待开始",
  running: "执行中",
  review: "待验收",
  accepted: "已验收",
  failed: "执行失败",
  interrupted: "已中断",
};
const taskColumns = [
  { id: "todo", name: "待办", statuses: ["proposed", "ready"] },
  { id: "running", name: "执行中", statuses: ["running"] },
  { id: "attention", name: "需处理", statuses: ["failed", "interrupted"] },
  { id: "review", name: "待验收", statuses: ["review"] },
  { id: "done", name: "已完成", statuses: ["accepted"] },
];
export function ProjectRoom({
  state,
  session,
  teamId: explicitTeam,
  call,
  onInvite,
  onProviders,
  onOpenTask,
  onOpenSession,
  initialProjectId,
}: {
  state: State;
  session?: Session;
  teamId?: string;
  call: Call;
  onInvite?: () => void;
  onProviders?: () => void;
  onOpenTask?: (id: string) => void;
  onOpenSession?: (id: string) => void;
  initialProjectId?: string;
}) {
  const data = state.collaboration,
    me = state.me?.id || "",
    teamId = explicitTeam || session?.workspaceId || "";
  const projects = data?.projects.filter((p) => p.teamId === teamId) || [];
  const rows: { project: (typeof projects)[number]; depth: number }[] = [];
  const walk = (parent: string | null, depth = 0) => {
    for (const p of projects.filter((p) => p.parentProjectId === parent)) {
      rows.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null);
  const [projectId, setProjectId] = useState(initialProjectId || ""),
    [view, setView] = useState<"discussion" | "tasks" | "artifacts" | "team">(
      "discussion",
    ),
    [taskId, setTaskId] = useState(""),
    [artifactOpen, setArtifactOpen] = useState(true),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(""),
    [form, setForm] = useState<Record<string, string>>({}),
    [agentId, setAgentId] = useState(""),
    [memberId, setMemberId] = useState(""),
    [cindy, setCindy] = useState(false),
    [guide,setGuide]=useState(false);
  const project = projects.find((p) => p.id === projectId) || projects[0],
    channel = data?.channels.find((c) => c.projectId === project?.id);
  const tasks = data?.tasks.filter((t) => t.channelId === channel?.id) || [],
    task =
      tasks.find((t) => t.id === taskId) ||
      tasks.find((t) => t.kind !== "planning");
  const messages =
      data?.channelMessages.filter((m) => m.channelId === channel?.id) || [],
    agents =
      data?.agents.filter(
        (a) =>
          a.teamId === teamId && (!a.projectId || a.projectId === project?.id),
      ) || [],
    ownAgents = agents.filter((a) => a.workerId === me && !a.taskId);
  const availableLanes = state.sessions
    .filter(
      (s) =>
        s.workspaceId === teamId &&
        !s.taskId &&
        (!s.projectId || s.projectId === (projectId || projects[0]?.id)),
    )
    .flatMap((s) =>
      s.lanes
        .filter((l) => l.ownerId === me)
        .map((l) => ({ ...l, sessionId: s.id })),
    );
  const selectedAgent = ownAgents.find((a) => a.id === agentId) || ownAgents[0];
  const projectTasks = tasks.filter((t) => t.kind !== "planning" && !t.parentTaskId);
  const pendingWork = tasks.filter(t=>t.status==="proposed"&&ownAgents.some(a=>a.id===t.requestedAgentId));
  const ownerName = (id: string) =>
    id === me
      ? state.me?.name || "我"
      : state.members.find((m) => m.id === id)?.name || "成员";
  const cindyAction = (a:CindyAction) => {
    setCindy(false);
    if(a.type === "task") {setForm({key:request(),dri:me,path:a.artifactPath||"artifact.md",goal:a.goal||"",acceptance:a.acceptance||""});setDialog("task");}
    else if(a.type === "invite") onInvite?.();
    else if(["discussion","team","artifacts"].includes(a.type))setView(a.type as "discussion"|"team"|"artifacts");
  };
  const openTask = () => {
    setForm({ key: request(), dri: me, path: "artifact.md" });
    setDialog("task");
  };
  const members = state.members.filter(
    (m) =>
      m.workspaceId === teamId &&
      !m.sessionId &&
      ["owner", "editor"].includes(m.role || ""),
  );
  const editor = ["owner", "editor"].includes(
    state.me?.roles?.[teamId] || state.me?.role || "",
  );
  const writable = editor || state.me?.roles?.[teamId] === "commenter";
  const participants = state.members.filter(
    (m) => !m.sessionId && (m.workspaceId === teamId || m.id === me),
  );
  const otherPeople = participants.filter((m) => m.id !== me);
  const mapped = !!(project && state.local.projectCheckouts?.[project.id]);
  const guideSeen=useRef(new Set<string>());
  useEffect(()=>{
    if(!project||!editor||!state.local.online||guideSeen.current.has(project.id))return;
    guideSeen.current.add(project.id);
    const record=data?.onboarding?.find(r=>r.projectId===project.id&&r.userId===me);
    const settings=data?.teamSettings?.find(t=>t.teamId===teamId);
    if(!record?.dismissed&&!record?.guideComplete&&!data?.onboarding?.some(r=>r.teamId===teamId&&r.userId===me&&(r.dismissed||r.guideComplete))&&settings?.onboardingEnabled!==false)setGuide(true);
  },[project?.id,editor,state.local.online,data?.onboarding,me,teamId]);
  const openAgent = () => {
    const provider =
      state.local.providers.find(
        (p) => p.available && ["codex", "claude"].includes(p.id),
      )?.id || "codex";
    setForm({
      key: request(),
      lane: availableLanes[0]?.id || provider,
      name: "项目助手",
      role: "负责人",
    });
    setDialog("setup");
  };
  const chooseTask = (id: string) => {
    if (onOpenTask) {
      onOpenTask(id);
      return;
    }
    setTaskId(id);
    setArtifactOpen(true);
  };
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  useEffect(() => {
    setTaskId("");
    setMemberId("");
    setArtifactOpen(view === "discussion");
    setMessage("");
    setError("");
  }, [project?.id]);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const fields = (name: string) => ({
    value: form[name] || "",
    onChange: (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => setForm((v) => ({ ...v, [name]: e.target.value })),
  });
  const providerLabel = (id: string) => {
    const account = state.local.accounts?.find((a) => a.id === id);
    const installed = state.local.providers.find((p) => p.id === id)?.available;
    return `${id === "codex" ? "Codex" : "Claude"}（${account?.authenticated ? "已登录" : installed ? "检查登录" : "需要安装"}）`;
  };
  const request = () => crypto.randomUUID();
  const sources = () =>
    messages
      .filter((m) => m.author.type !== "system")
      .slice(-8)
      .map((m) => m.id);
  const create = () =>
    run(async () => {
      if (dialog === "project") {
        const p = await call("collab.project.create", {
          teamId,
          name: form.name,
          parentProjectId: form.parent || null,
          repository: form.repository || null,
          subPath: form.subPath || "",
          branch: form.branch || "main",
          requestKey: form.key,
        });
        setProjectId(p.id);
      } else if (dialog === "agent") {
        const lane = availableLanes.find((l) => l.id === form.lane);
        await call("collab.agent.register", {
          teamId,
          projectId: project?.id,
          ...(lane
            ? { sessionId: lane.sessionId, laneId: lane.id }
            : { provider: form.lane }),
          name: form.name,
          role: form.role || "执行",
          requestKey: form.key,
        });
      } else {
        const result = await call("collab.task.propose", {
          channelId: channel?.id,
          goal: form.goal,
          acceptance: form.acceptance,
          artifactPath: form.path || "artifact.md",
          mode: "workspace-write",
          driUserId: form.dri || me,
          sourceMessageIds: sources(),
          requestKey: form.key,
        });
        chooseTask(result.duplicateTaskId || result.id);
        if (result.duplicateTaskId)
          setError("已有相同目标的任务，已为你打开。");
      }
      setDialog("");
    });
  return (
    <section
      className={`project-room ${!onOpenTask && task && artifactOpen ? "with-artifact" : "conversation-only"}`}
      aria-label="项目协作"
    >
      <aside className="project-tree">
        <header>
          <strong>项目</strong>
          {editor && (
            <button
              aria-label="新建项目"
              title="新建项目"
              onClick={() => {
                setForm({ key: request() });
                setDialog("project");
              }}
            >
              <Plus size={14} /> 新建
            </button>
          )}
        </header>
        {rows.map(({ project: p, depth }) => (
          <button
            key={p.id}
            className={p.id === project?.id ? "active" : ""}
            style={{ paddingLeft: 10 + Math.min(depth, 8) * 12 }}
            onClick={() => setProjectId(p.id)}
          >
            {p.parentProjectId ? "↳ " : ""}
            {p.name}
          </button>
        ))}
        {project && editor && <button className="cindy-entry" onClick={()=>setCindy(true)}><Sparkles size={16}/><span>{aiName("Cindy")}<small>上手与配置 Agent</small></span></button>}
        {project&&editor&&<button onClick={()=>setGuide(true)}>新手上手 · 8 步</button>}
        <header>
          <strong>AI 成员</strong>
          {editor && (
            <button
              aria-label="添加团队 Agent"
              title="添加团队 Agent"
              onClick={openAgent}
            >
              <Plus size={14} /> 添加
            </button>
          )}
        </header>
        {!agents.length && (
          <p className="tree-hint">添加后可整理讨论、执行任务</p>
        )}
        {agents.filter(a=>!a.taskId).map((a) => (
          <button className="project-agent" key={a.id}
            aria-label={`查看 AI 成员 ${aiName(a.name)}`}
            onClick={() => setMemberId(a.id)}>
            <Bot size={15} />
            <span>{aiName(a.name)}<small>{ownerName(a.workerId)} · {a.role || "执行"}</small></span>
          </button>
        ))}
        {project && editor && (
          <button
            className="checkout-button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                call("collab.checkout.map", { projectId: project.id }),
              )
            }
          >
            <FolderOpen size={15} />
            {state.local.projectCheckouts?.[project.id]
              ? "工作文件夹已连接"
              : "选择工作文件夹"}
          </button>
        )}
      </aside>
      <main className="project-chat">
        {project && editor && !ownAgents.length && !data?.onboarding?.some(r=>r.projectId===project.id&&r.dismissed) && <div className="cindy-welcome"><Sparkles size={19}/><span>第一次来？Cindy 带你连接 AI、搭团队、开始第一项任务。</span><button className="button" onClick={()=>setGuide(true)}>开始上手</button></div>}
        <header>
          <div className="project-heading">
            <strong>{project?.name || "项目"}</strong>
            {project && (
              <span className="project-presence">
                <span className="presence-dot" />
                {otherPeople.length
                  ? `你和 ${otherPeople.length} 位同事`
                  : "目前只有你"}
                {agents.filter(a=>!a.taskId).length
                  ? ` · ${agents.filter(a=>!a.taskId).length} 位 AI 成员`
                  : " · 尚未添加 AI"}
              </span>
            )}
          </div>
          {project && editor && (
            <div className="room-actions">
              {ownAgents.length > 0 && (
                <>
                  <select
                    aria-label="负责人 Agent"
                    value={selectedAgent?.id}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    {ownAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {aiName(a.name)}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={
                      busy ||
                      !messages.length ||
                      !state.local.projectCheckouts?.[project.id]
                    }
                    title={
                      !mapped
                        ? "先选择工作文件夹"
                        : !messages.length
                          ? "先在群里说说要做什么"
                          : "让 AI 将讨论整理成任务提案"
                    }
                    onClick={() =>
                      void run(() =>
                        call("collab.lead.plan", {
                          channelId: channel?.id,
                          agentId: selectedAgent?.id,
                          sourceMessageIds: sources(),
                          requestKey: request(),
                        }),
                      )
                    }
                  >
                    <Sparkles size={14} /> 整理讨论
                  </button>
                </>
              )}
              <button onClick={openTask}>
                <Plus size={14} />
                新建任务
              </button>
            </div>
          )}
        </header>
        {project && (
          <div
            className="project-view-tabs"
            role="tablist"
            aria-label="项目视图"
          >
            <button
              role="tab"
              id="project-discussion-tab"
              aria-selected={view === "discussion"}
              aria-controls="project-discussion"
              onClick={() => setView("discussion")}
            >
              <MessageSquare size={15} /> 讨论
            </button>
            <button
              role="tab"
              id="project-tasks-tab"
              aria-selected={view === "tasks"}
              aria-controls="project-tasks"
              onClick={() => {
                setView("tasks");
                setArtifactOpen(false);
              }}
            >
              <Columns3 size={15} /> 任务 <span>{projectTasks.length}</span>
            </button>
            <button
              role="tab"
              id="project-artifacts-tab"
              aria-selected={view === "artifacts"}
              aria-controls="project-artifacts"
              onClick={() => {
                setView("artifacts");
                setArtifactOpen(false);
              }}
            >
              <FileText size={15} />
              产物{" "}
              <span>
                {tasks.filter((t) =>
                  data?.artifactVersions.some((v) => v.taskId === t.id),
                ).length +
                  (data?.outputs?.filter((o) => o.projectId === project.id)
                    .length || 0)}
              </span>
            </button>
            <button role="tab" id="project-team-tab" aria-selected={view==="team"} onClick={()=>{setView("team");setArtifactOpen(false);}}><UserPlus size={15}/>成员与 Agent</button>
          </div>
        )}
        {pendingWork.length>0 && view!=="team" && <button className="team-setup-banner" onClick={()=>chooseTask(pendingWork[0].id)}>有 {pendingWork.length} 项协作分工等待你接入 <ArrowRight size={15}/></button>}
        {project && view!=="team" && (!otherPeople.length || !ownAgents.length || !mapped) && <button className="team-setup-banner" onClick={()=>{setView("team");setArtifactOpen(false);}}>开始团队协作 <small>{otherPeople.length?'同事已加入':'邀请同事'} · {ownAgents.length?`${ownAgents.length} 位我的 Agent`:'接入我的 Agent'} · 查看可见范围</small><ArrowRight size={15}/></button>}
        {error && (
          <div role="alert" className="room-error">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {!project ? (
          <div className="room-empty">
            <FileText size={25} />
            <h3>想一起完成什么？</h3>
            <p>给项目起个名字，再邀请同事或添加 AI。</p>
            {editor && (
              <button
                onClick={() => {
                  setForm({ key: request() });
                  setDialog("project");
                }}
              >
                新建项目
              </button>
            )}
          </div>
        ) : view === "team" ? (
          <TeamSpace state={state} project={project} call={call} onInvite={onInvite} onAdd={openAgent} onStart={()=>setView("tasks")} onOpenTask={chooseTask} onOpenAgent={setMemberId}/>
        ) : view === "artifacts" ? (
          <div
            className="project-board-view"
            role="tabpanel"
            id="project-artifacts"
            aria-labelledby="project-artifacts-tab"
          >
            <ProjectArtifacts
              projectId={project.id}
              state={state}
              call={call}
              onOpenTask={onOpenTask}
              onOpenSession={onOpenSession}
            />
          </div>
        ) : view === "tasks" ? (
          <section
            className="project-board-view"
            id="project-tasks"
            role="tabpanel"
            aria-labelledby="project-tasks-tab"
          >
            {projectTasks.length === 0 ? (
              <div className="project-board-empty">
                <Columns3 size={28} />
                <h2>这个项目，要做哪些事？</h2>
                <p>新建任务，或让 AI 将项目讨论整理成任务。</p>
                {editor && (
                  <button onClick={openTask}>
                    <Plus size={15} /> 新建任务
                  </button>
                )}
              </div>
            ) : (
              <div
                className="project-task-board"
                aria-label={`${project.name}的任务板`}
              >
                {taskColumns
                  .filter(
                    (column) =>
                      column.id !== "attention" ||
                      projectTasks.some((t) =>
                        column.statuses.includes(t.status),
                      ),
                  )
                  .map((column) => {
                    const items = projectTasks.filter((t) =>
                      column.statuses.includes(t.status),
                    );
                    return (
                      <section
                        className={`project-board-column ${column.id}`}
                        key={column.id}
                        aria-label={column.name}
                      >
                        <div className="project-board-column-heading">
                          <span className="board-status-dot" />
                          <strong>{column.name}</strong>
                          <span>{items.length}</span>
                        </div>
                        <div className="project-board-cards">
                          {items.map((t) => (
                            <button
                              key={t.id}
                              className={`project-task-card ${artifactOpen && t.id === task?.id ? "selected" : ""}`}
                              onClick={() => chooseTask(t.id)}
                              data-task-id={t.id}
                            >
                              <strong>{t.goal}</strong><small>{tasks.filter(c=>c.parentTaskId===t.id&&c.status!=="declined").length ? `${tasks.filter(c=>c.parentTaskId===t.id&&c.status!=="declined").length} 项 Agent 协作分工` : "共享 Agent 会话"}</small>
                              <span className={`board-task-status ${t.status}`}>
                                {t.status === "running" &&
                                t.execution === "waiting-worker"
                                  ? "等待设备上线"
                                  : status[t.status]}
                              </span>
                              <span className="board-task-owner">
                                <Avatar name={ownerName(t.driUserId)} small />
                                <span>{ownerName(t.driUserId)}</span>
                                <small>负责人</small>
                              </span>
                              <span className="board-task-agent">
                                <Bot size={13} />
                                {t.agentId ? aiName(agents.find((a) => a.id === t.agentId)?.name || "Agent") : "等待 AI 认领"}
                              </span>
                            </button>
                          ))}
                          {!items.length && (
                            <span className="board-column-empty">暂无任务</span>
                          )}
                        </div>
                      </section>
                    );
                  })}
              </div>
            )}
          </section>
        ) : (
          <div
            className="project-discussion-view"
            id="project-discussion"
            role="tabpanel"
            aria-labelledby="project-discussion-tab"
          >
            <div className="project-messages">
              {tasks.length === 0 && (
                <section className="project-welcome" aria-label="开始项目协作">
                  <span className="welcome-symbol">
                    <Sparkles size={24} />
                  </span>
                  <h2>
                    {!agents.length && !otherPeople.length
                      ? "找个搭档，一起开始"
                      : "把想法变成一起做的事"}
                  </h2>
                  <p>
                    {!agents.length && !otherPeople.length
                      ? "邀请同事来讨论，或添加 AI 帮你推进任务。"
                      : "在这里讨论目标，再让 AI 整理成任务。"}
                  </p>
                  <div className="project-welcome-actions">
                    {onInvite && (
                      <button
                        className="project-welcome-action"
                        onClick={onInvite}
                      >
                        <UserPlus size={20} />
                        <span>
                          <strong>邀请同事</strong>
                          <small>分享邀请，一起讨论</small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    )}
                    {editor && (
                      <button
                        className="project-welcome-action"
                        onClick={openAgent}
                      >
                        <Bot size={20} />
                        <span>
                          <strong>
                            {agents.length ? "添加 AI 成员" : "添加 AI"}
                          </strong>
                          <small>整理讨论，执行任务</small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </div>
                  {editor && ownAgents.length > 0 && !mapped && (
                    <button
                      className="setup-next"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          call("collab.checkout.map", {
                            projectId: project.id,
                          }),
                        )
                      }
                    >
                      <FolderOpen size={15} />
                      下一步：选择 AI 的工作文件夹
                      <ArrowRight size={14} />
                    </button>
                  )}
                  {!editor && (
                    <small>可以先参与讨论，由项目编辑者安排 AI 任务。</small>
                  )}
                </section>
              )}
              {messages.map((m) => (
                <article
                  key={m.id}
                  className={`project-message ${m.author.type}`}
                >
                  <div>
                    <Avatar name={m.author.name} small />
                    <strong>{m.author.type === "agent" ? aiName(m.author.name) : m.author.name}</strong>
                    <time>{time(m.at)}</time>
                  </div>
                  {m.versionId && <small>产物评论 · {m.anchor}</small>}
                  <p>{m.text}</p>
                  {m.outputId && (
                    <button onClick={() => setView("artifacts")}>
                      查看产物
                    </button>
                  )}
                  {m.taskId && (
                    <button onClick={() => chooseTask(m.taskId!)}>
                      查看任务
                    </button>
                  )}
                </article>
              ))}
              <div ref={end} />
            </div>
            {tasks.length > 0 && (
              <div className="project-task-list">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    className={t.id === task?.id ? "active" : ""}
                    onClick={() => chooseTask(t.id)}
                  >
                    <span>{t.kind === "planning" ? "整理讨论" : t.goal}</span>
                    <small>
                      {t.status === "running" &&
                      t.execution === "waiting-worker"
                        ? "等待设备上线"
                        : status[t.status]}
                    </small>
                  </button>
                ))}
              </div>
            )}
            <div className="composer-audience">
              <span>发给项目成员</span>
              <small>
                {agents.length
                  ? "@AI 成员可唤醒它 · 在成员配置里选择参与方式"
                  : otherPeople.length
                    ? "同事加入后可看到这里的消息"
                    : "目前只有你能参与，先邀请同事或添加 AI"}
              </small>
            </div>
            <form
              className="project-composer"
              onSubmit={(e) => {
                e.preventDefault();
                const text = message;
                void run(async () => {
                  await call("collab.message.send", {
                    channelId: channel?.id,
                    text,
                    requestKey: request(),
                  });
                  setMessage("");
                });
              }}
            >
              <textarea
                aria-label="群聊消息"
                placeholder="说说这个项目想完成什么…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!writable}
              />
              <button
                title="发送"
                aria-label="发送消息"
                disabled={busy || !message.trim() || !writable}
              >
                <Send size={15} /> 发送
              </button>
            </form>
          </div>
        )}
      </main>
      {!onOpenTask && task && artifactOpen && (
        <TaskSession
          task={task}
          state={state}
          call={call}
          onClose={() => setArtifactOpen(false)}
        />
      )}
      {dialog === "setup" && project ? (
        <LocalSetup
          state={state}
          project={project}
          call={call}
          onClose={() => setDialog("")}
          onOpenSession={onOpenSession}
        />
      ) : (
        dialog && (
          <Modal
            title={
              dialog === "project"
                ? "新建项目"
                : dialog === "agent"
                  ? "添加 AI 成员"
                  : "新建任务"
            }
            close={() => setDialog("")}
          >
            <form
              className="room-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              {dialog === "project" ? (
                <>
                  <label>
                    名称
                    <input
                      required
                      autoFocus
                      placeholder="例如：秋季发布会"
                      {...fields("name")}
                    />
                  </label>
                  <details className="room-advanced">
                    <summary>更多设置 · 层级与代码仓库</summary>
                    <label>
                      上级项目
                      <select {...fields("parent")}>
                        <option value="">无</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      GitHub 仓库
                      <input
                        placeholder="owner/repo（可选）"
                        {...fields("repository")}
                      />
                    </label>
                    <label>
                      分支
                      <input placeholder="main" {...fields("branch")} />
                    </label>
                    <label>
                      子目录
                      <input placeholder="可选" {...fields("subPath")} />
                    </label>
                  </details>
                </>
              ) : dialog === "agent" ? (
                <>
                  <label>
                    名称
                    <input required {...fields("name")} />
                  </label>
                  <label>
                    分工
                    <select {...fields("role")}>
                      <option value="负责人">整理讨论与任务</option>
                      <option value="执行">执行具体任务</option>
                    </select>
                  </label>
                  <label>
                    使用哪个 AI
                    <select required {...fields("lane")}>
                      <option value="codex">{providerLabel("codex")}</option>
                      <option value="claude">{providerLabel("claude")}</option>
                      {availableLanes.map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.sessionId &&
                            state.sessions.find((s) => s.id === l.sessionId)
                              ?.title}{" "}
                          · {l.providerLabel || l.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    目标
                    <textarea required {...fields("goal")} />
                  </label>
                  <label>
                    验收条件
                    <textarea required {...fields("acceptance")} />
                  </label>
                  <label>
                    负责人
                    <select {...fields("dri")}>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    产物文件
                    <input
                      required
                      placeholder="方案.md / 报表.xlsx / 设计.pdf"
                      {...fields("path")}
                    />
                  </label>
                </>
              )}
              <button className="button primary" disabled={busy}>
                {dialog === "agent"
                  ? "添加 AI"
                  : dialog === "project"
                    ? "创建项目"
                    : "创建任务"}
              </button>
              {dialog === "agent" && (
                <p className="room-hint">
                  使用你自己的 AI 账号。
                  {onProviders && (
                    <button
                      type="button"
                      className="inline-link"
                      onClick={onProviders}
                    >
                      连接 / 检查账号
                    </button>
                  )}
                </p>
              )}
              {error && <p role="alert">{error}</p>}
            </form>
          </Modal>
        )
      )}
      {guide && project && <BeginnerGuide key={project.id} state={state} project={project} call={call} close={()=>setGuide(false)} onInvite={onInvite} onTask={()=>{setForm({key:request(),dri:me,path:"project-plan.md",goal:"整理一页项目方案",acceptance:"包含项目目标、参与者分工和下一步行动。"});setDialog("task");}} onHelp={()=>{setGuide(false);setCindy(true);}} onArtifacts={()=>setView('artifacts')}/>}
      {cindy && project && <Cindy key={project.id} state={state} project={project} call={call} close={()=>setCindy(false)} onAction={cindyAction} onOpenSession={onOpenSession}/> }
      {memberId && <AgentMember call={call} state={state} agentId={memberId} projectId={project?.id}
        close={() => setMemberId("")} onDiscussion={() => { setMemberId(""); setView("discussion"); }}
        onOpenTask={chooseTask} onOpenSession={onOpenSession}/>}
    </section>
  );
}
