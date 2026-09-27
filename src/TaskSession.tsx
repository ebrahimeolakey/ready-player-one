import { TaskTeam } from "./TaskTeam";
import { useState, type ReactNode } from "react";
import { Play, Square, X, FolderOpen, Bot } from "lucide-react";
import type { State } from "./types";
import type { ProjectTask } from "./project-types";
import type { Call } from "./ui";
import { ProviderControls } from "./ProviderControls";
import { ArtifactPanel } from "./TaskArtifact";
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
function TaskExecution({
  task,
  state,
  call,
  onClose,
  ide,
}: {
  task: ProjectTask;
  state: State;
  call: Call;
  onClose?: () => void;
  ide?: ReactNode;
}) {
  const [view, setView] = useState("session");
  const [instruction, setInstruction] = useState(""),
    [agentId, setAgentId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const me = state.me?.id || "",
    teamId = task.teamId;
  const agents =
    state.collaboration?.agents.filter(
      (a) =>
        a.teamId === teamId && (!a.projectId || a.projectId === task.projectId),
    ) || [];
  const ownAgents = agents.filter((a) => a.workerId === me && !a.taskId && (!task.requestedAgentId || a.id === task.requestedAgentId));
  const selectedAgent = ownAgents.find((a) => a.id === agentId) || ownAgents[0];
  const members = state.members.filter(
    (m) =>
      m.workspaceId === teamId &&
      !m.sessionId &&
      ["owner", "editor"].includes(m.role || ""),
  );
  const editor = ["owner", "editor"].includes(
    state.me?.roles?.[teamId] || state.me?.role || "",
  );
  const controls =
      editor && task.controllers.some((g) => g.userId === me && !g.revokedAt),
    worker = task.workerId === me;
  const channel = state.collaboration?.channels.find(
    (c) => c.id === task.channelId,
  );
  const executionLane = state.sessions
    .find((s) => s.id === task.sessionId)
    ?.lanes.find((l) => l.id === task.laneId);
  const hasArtifact = state.collaboration?.artifactVersions.some(
    (v) => v.taskId === task.id,
  );
  const mapped = !!state.local.projectCheckouts?.[task.projectId];
  const request = () => crypto.randomUUID();
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
  return (
    <section
      className={`task-session project-room ${view === "ide" ? "with-ide" : ""} ${hasArtifact ? "has-artifact" : ""} ${onClose ? "task-session-inline" : ""}`}
      aria-label="任务共享会话"
    >
      <div className="task-session-execution">
        <header>
          <nav className="task-session-tabs" aria-label="共享会话视图">
            <button
              aria-pressed={view === "session"}
              onClick={() => setView("session")}
            >
              会话
            </button>
            {ide && (
              <button
                aria-pressed={view === "ide"}
                onClick={() => setView("ide")}
              >
                IDE
              </button>
            )}
          </nav>
          <span>{status[task.status]}</span>
          {onClose && (
            <button aria-label="收起任务与产物" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </header>
        {error && (
          <div role="alert" className="room-error">
            {error}
          </div>
        )}
        <div className="task-session-context">
          <span>项目上下文已关联</span>
          <small>每轮同步项目讨论、任务进度与已验收产物</small>
        </div>
        {editor && !mapped && (
          <button
            className="setup-next"
            onClick={() =>
              void run(() =>
                call("collab.checkout.map", { projectId: task.projectId }),
              )
            }
          >
            <FolderOpen size={15} />
            选择工作文件夹
          </button>
        )}
        {view === "ide" ? (
          <div className="task-session-ide">{ide}</div>
        ) : (
          <div className="task-transcript" aria-label="Agent 执行记录">
            {!executionLane?.entries.length && (
              <div className="room-empty">
                <Bot size={25} />
                <p>{task.requestedAgentId && !ownAgents.length ? "等待同事接入受邀的 Agent" : "选择 AI，开始这项任务"}</p>
                <small>执行过程与产物会在这里共享给团队</small>
              </div>
            )}
            {executionLane?.entries.map((e) =>
              ["user", "tool", "reasoning"].includes(e.role) ? (
                <details className={`task-session-entry ${e.role}`} key={e.id}>
                  <summary>
                    {e.role === "user"
                      ? "本轮指令"
                      : e.role === "tool"
                        ? "工具执行"
                        : "思考过程"}
                  </summary>
                  <p>{e.text}</p>
                </details>
              ) : (
                <article className={`task-session-entry ${e.role}`} key={e.id}>
                  <small>{e.role === "assistant" ? "Agent" : "状态"}</small>
                  <p>{e.text}</p>
                </article>
              ),
            )}
          </div>
        )}
        <div className="task-controls">
          <strong>{task.kind === "planning" ? "整理讨论" : task.goal}</strong>
          <small>
            负责人 ·{" "}
            {members.find((m) => m.id === task.driUserId)?.name || "成员"}
            {task.workerId &&
              `　执行 · ${agents.find((a) => a.id === task.agentId)?.name || "Agent"}`}
          </small>
          {executionLane && worker && (
            <ProviderControls
              value={{
                model: executionLane.configuration?.model || "",
                effort: executionLane.configuration?.effort || "",
              }}
              models={state.local.modelCatalogs?.[executionLane.provider]}
              disabled={task.status === "running"}
              loadModels={() =>
                call("provider.models", {
                  provider: executionLane.provider,
                  sessionId: task.sessionId,
                  laneId: task.laneId,
                })
              }
              onChange={(value) =>
                void run(() =>
                  call("lane.options", {
                    sessionId: task.sessionId,
                    laneId: task.laneId,
                    ...value,
                  }),
                )
              }
            />
          )}
          <details>
            <summary>验收条件</summary>
            <p>{task.acceptance}</p>
            <small>产物：{task.artifactPath} · 写入项目目录</small>
          </details>
          {task.proposalError && (
            <p role="alert">提案未生成：{task.proposalError}</p>
          )}
          {task.status === "proposed" && editor && ownAgents.length > 0 && (
            <div className="room-actions">
              <select
                aria-label="执行 Agent"
                value={selectedAgent?.id || ""}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="" disabled>
                  选择 Agent
                </option>
                {ownAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !selectedAgent}
                onClick={() =>
                  void run(() =>
                    call("collab.task.claim", {
                      taskId: task.id,
                      agentId: selectedAgent?.id,
                      revision: task.revision,
                      seenSeq: channel?.seq,
                    }),
                  )
                }
              >
                认领
              </button>
            </div>
          )}
          {controls &&
            ["ready", "review", "failed", "interrupted"].includes(
              task.status,
            ) && (
              <form
                className="room-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await call("collab.task.start", {
                      taskId: task.id,
                      revision: task.revision,
                      instruction,
                      requestKey: request(),
                    });
                    setInstruction("");
                  });
                }}
              >
                <input
                  aria-label="本轮要求"
                  placeholder={
                    task.status === "ready" ? "补充要求（可选）" : "继续修改…"
                  }
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
                <button disabled={busy}>
                  <Play size={14} />
                  {task.status === "ready" ? "开始" : "继续"}
                </button>
              </form>
            )}
          {controls && task.status === "running" && (
            <form
              className="room-actions"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await call("collab.task.steer", {
                    taskId: task.id,
                    runId: task.runId,
                    generation: task.generation,
                    text: instruction,
                    requestKey: request(),
                  });
                  setInstruction("");
                });
              }}
            >
              <input
                aria-label="补充执行要求"
                placeholder="补充要求…"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <button disabled={busy || !instruction.trim()}>发送</button>
            </form>
          )}
          {executionLane?.steering
            ?.filter((v) => v.runId === task.runId)
            .slice(-1)
            .map((v) => (
              <small key={v.id}>
                {(
                  {
                    pending: "等待 Agent 接收",
                    delivered: "要求已送达",
                    unsupported: "此 Provider 不支持运行中补充，请停止后继续",
                    failed: "要求未送达，请稍后重试",
                  } as Record<string, string>
                )[v.status] || v.status}
              </small>
            ))}
          {controls && task.status === "running" && (
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  call("collab.task.stop", {
                    taskId: task.id,
                    runId: task.runId,
                    generation: task.generation,
                  }),
                )
              }
            >
              <Square size={13} />
              停止
            </button>
          )}
          {task.status === "interrupted" && (
            <small>已撤销执行授权；离线设备停止状态待确认。</small>
          )}
          {task.workerId && (
            <details>
              <summary>
                控制者 · {task.controllers.filter((g) => !g.revokedAt).length}
              </summary>
              {members.map((m) => (
                <label className="controller-option" key={m.id}>
                  <input
                    type="checkbox"
                    checked={task.controllers.some(
                      (g) => g.userId === m.id && !g.revokedAt,
                    )}
                    disabled={!worker || m.id === task.workerId || busy}
                    onChange={(e) =>
                      void run(() =>
                        call("collab.controller.set", {
                          taskId: task.id,
                          revision: task.revision,
                          userId: m.id,
                          allow: e.target.checked,
                        }),
                      )
                    }
                  />
                  {m.name}
                </label>
              ))}
            </details>
          )}
        </div>

        {task.status === "proposed" && editor && !ownAgents.length && !task.requestedAgentId && (
          <div className="task-quick-provider">
            <span>用我的 AI 开始</span>
            {["codex", "claude"].map((provider) => (
              <button
                disabled={busy}
                key={provider}
                onClick={() =>
                  void run(async () => {
                    await call("collab.task.claim", {
                      taskId: task.id,
                      provider,
                      revision: task.revision,
                      seenSeq: channel?.seq,
                    });
                  })
                }
              >
                {provider === "codex" ? "Codex" : "Claude Code"}
              </button>
            ))}
          </div>
        )}
      </div>
      {hasArtifact && (
        <aside className="project-artifact">
          <header>
            <strong>产物</strong>
          </header>
          <ArtifactPanel
            key={task.id}
            task={task}
            state={state}
            call={call}
            onError={setError}
            canAccept={task.driUserId === state.me?.id}
            worker={worker}
          />
        </aside>
      )}
    </section>
  );
}

export function TaskSession(props: {task:ProjectTask;state:State;call:Call;onClose?:()=>void;ide?:ReactNode;initialTaskId?:string}) {
 return <TaskTeam task={props.task} state={props.state} call={props.call} initialTaskId={props.initialTaskId}>{task=><TaskExecution {...props} key={task.id} task={task}/>}</TaskTeam>;
}
