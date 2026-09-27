import { useEffect, useState, type ReactNode } from "react";
import { Bot, Plus, Users, Send } from "lucide-react";
import type { State } from "./types";
import type { ProjectTask } from "./project-types";
import { Modal, type Call } from "./ui";
import { LocalSetup } from "./LocalSetup";
import { AccessSummary, teamRoleNames } from "./TeamSpace";
export function TaskTeam({
  task,
  state,
  call,
  children,
  initialTaskId,
}: {
  task: ProjectTask;
  state: State;
  call: Call;
  initialTaskId?: string;
  children: (task: ProjectTask) => ReactNode;
}) {
  const [selected, setSelected] = useState(initialTaskId || ""),
    [adding, setAdding] = useState(false),
    [setup, setSetup] = useState(false),
    [access, setAccess] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [agentId, setAgentId] = useState(""),
    [goal, setGoal] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    setSelected(initialTaskId || "");
  }, [initialTaskId]);
  const all = state.collaboration?.tasks || [],
    root = all.find((t) => t.id === task.parentTaskId) || task,
    work = [root, ...all.filter((t) => t.parentTaskId === root.id)],
    project = state.collaboration?.projects.find(
      (p) => p.id === root.projectId,
    ),
    me = state.me?.id;
  const agents = (state.collaboration?.agents || []).filter(
      (a) =>
        a.teamId === root.teamId &&
        (!a.projectId || a.projectId === root.projectId),
    ),
    available = agents.filter((a) => !a.taskId),
    mine = available.filter((a) => a.workerId === me),
    members = state.members.filter(
      (m) =>
        m.workspaceId === root.teamId &&
        (!m.sessionId || m.sessionId === root.sessionId),
    );
  const pending = work.find(
      (t) =>
        t.status === "proposed" &&
        mine.some((a) => a.id === t.requestedAgentId),
    ),
    current = work.find((t) => t.id === selected) || pending || root,
    chosen = available.find((a) => a.id === agentId) || mine[0] || available[0];
  const editor =
    state.me?.host ||
    ["owner", "editor"].includes(
      state.me?.roles?.[root.teamId] || state.me?.role || "",
    );
  const agentFor = (t: ProjectTask) =>
    agents.find((a) => a.id === (t.agentId || t.requestedAgentId));
  const status: Record<string, string> = {
    proposed: "等待接入",
    ready: "待开始",
    running: "执行中",
    review: "待验收",
    accepted: "已完成",
    failed: "失败",
    interrupted: "已中断",
    declined: "暂不参与",
  };
  const messages = (state.messages || [])
    .filter((m) => m.sessionId === root.sessionId)
    .slice(-30);
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shared-task-workspace">
      <header className="task-team-header">
        <span>
          <Users size={16} />
          共享任务 · {work.filter((t) => t.workerId).length} 位 Agent
        </span>
        <div>
          <button onClick={() => setAccess(!access)}>谁能看到 / 控制</button>
          {editor && root.status !== "accepted" && (
            <button onClick={() => setAdding(true)}>
              <Plus size={14} />
              添加 Agent 分工
            </button>
          )}
        </div>
      </header>
      {access && (
        <div className="task-access">
          <AccessSummary />
          <div className="task-access-people">
            {members.map((m) => (
              <span key={`${m.id}:${m.sessionId || ""}`}>
                {m.name} · {teamRoleNames[m.role || "viewer"]}
                {m.sessionId ? " · 仅此会话" : ""}
              </span>
            ))}
          </div>
          <small>
            每个执行 Agent
            的持有人独立授权控制者。查看会话不等于可以操作别人的电脑。
          </small>
        </div>
      )}
      <nav className="task-agent-tabs" aria-label="参与协作的 Agent">
        {work.map((t) => {
          const a = agentFor(t),
            owner = state.members.find(
              (m) => m.id === (t.workerId || a?.workerId),
            );
          return (
            <button
              key={t.id}
              aria-pressed={current.id === t.id}
              onClick={() => setSelected(t.id)}
            >
              <Bot size={16} />
              <span>
                <strong>{a?.name || "主任务"}</strong>
                <small>
                  {owner?.name || "待认领"} · {status[t.status] || t.status}
                </small>
              </span>
            </button>
          );
        })}
      </nav>
      {error && (
        <p className="room-error" role="alert">
          {error}
        </p>
      )}
      {current.parentTaskId && (
        <div className="task-work-goal">
          <strong>{current.goal}</strong>
          <small title={current.artifactPath}>独立产物 · 自动同步到项目</small>
          {current.status === "proposed" &&
            agentFor(current)?.workerId === me && (
              <button
                onClick={() =>
                  void run(() =>
                    call("collab.task.decline", { taskId: current.id }),
                  )
                }
              >
                暂不参与
              </button>
            )}
        </div>
      )}
      {children(current)}
      <details className="task-coordination" open={messages.length > 0}>
        <summary>
          协作消息 · {messages.length}
          <small>成员与 Agent 共用，Agent 可通过协作工具读取</small>
        </summary>
        <div>
          {messages.map((m) => (
            <p key={m.id}>
              <strong>{m.owner}</strong> {m.text}
            </p>
          ))}
        </div>
        {editor && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("coordination.message", {
                  sessionId: root.sessionId,
                  text: message,
                });
                setMessage("");
              });
            }}
          >
            <input
              aria-label="Agent 协作消息"
              placeholder="同步进度、交接信息或提醒同伴…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              disabled={busy || !message.trim()}
              aria-label="发送协作消息"
            >
              <Send size={14} />
            </button>
          </form>
        )}
      </details>
      {adding && (
        <Modal title="一起完成这项任务" close={() => setAdding(false)}>
          <form
            className="team-work-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await call("collab.task.contribute", {
                  taskId: root.id,
                  agentId: chosen?.id,
                  goal,
                  requestKey: crypto.randomUUID(),
                });
                setSelected(result.id);
                setGoal("");
                setAdding(false);
              });
            }}
          >
            <label>
              选择 Agent
              <select
                aria-label="协作 Agent"
                value={chosen?.id || ""}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {available.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ·{" "}
                    {a.workerId === me
                      ? "我的"
                      : state.members.find((m) => m.id === a.workerId)?.name ||
                        "同事"}{" "}
                    · {a.provider}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setSetup(true);
              }}
            >
              ＋ 接入我的另一个 Agent
            </button>
            <label>
              负责什么
              <textarea
                aria-label="协作分工"
                required
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="例如：你负责调研；另一个 Agent 根据调研结果制作方案。"
              />
            </label>
            <p>
              {chosen?.workerId === me
                ? "加入后可在本会话中启动；每位 Agent 独立执行、独立交付。"
                : "分工会发给这位 Agent 的持有人，等待对方接入并启动。"}
            </p>
            <small>
              各自使用本机工作文件夹，产物在项目内共享。不会自动合并两台电脑的文件。
            </small>
            {error && <p role="alert">{error}</p>}
            <button
              className="button primary"
              disabled={busy || !chosen || !goal.trim()}
            >
              {chosen?.workerId === me ? "加入协作" : "邀请参与"}
            </button>
          </form>
        </Modal>
      )}
      {setup && project && (
        <LocalSetup
          state={state}
          project={project}
          call={call}
          onClose={() => {
            setSetup(false);
            setAdding(true);
          }}
        />
      )}
    </div>
  );
}
