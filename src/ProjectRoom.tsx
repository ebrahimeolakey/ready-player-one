import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Send,
  FolderOpen,
  Bot,
  Play,
  Square,
  Check,
  FileText,
  X,
  Code,
  RefreshCw,
} from "lucide-react";
import type { State, Session } from "./types";
import type { ArtifactVersion, ProjectTask } from "./project-types";
import { artifactDocument } from "../core/artifact-preview.mjs";
import { Modal, time, type Call } from "./ui";
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
export function ProjectRoom({
  state,
  session,
  teamId: explicitTeam,
  call,
}: {
  state: State;
  session?: Session;
  teamId?: string;
  call: Call;
}) {
  const data = state.collaboration,
    me = state.me?.id || "",
    teamId = explicitTeam || session?.workspaceId || "";
  const availableLanes = state.sessions
    .filter((s) => s.workspaceId === teamId)
    .flatMap((s) =>
      s.lanes
        .filter((l) => l.ownerId === me)
        .map((l) => ({ ...l, sessionId: s.id })),
    );
  const projects = data?.projects.filter((p) => p.teamId === teamId) || [];
  const rows: { project: (typeof projects)[number]; depth: number }[] = [];
  const walk = (parent: string | null, depth = 0) => {
    for (const p of projects.filter((p) => p.parentProjectId === parent)) {
      rows.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null);
  const [projectId, setProjectId] = useState(""),
    [taskId, setTaskId] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(""),
    [form, setForm] = useState<Record<string, string>>({}),
    [agentId, setAgentId] = useState(""),
    [instruction, setInstruction] = useState("");
  const project = projects.find((p) => p.id === projectId) || projects[0],
    channel = data?.channels.find((c) => c.projectId === project?.id);
  const tasks = data?.tasks.filter((t) => t.channelId === channel?.id) || [],
    task =
      tasks.find((t) => t.id === taskId) ||
      tasks.find((t) => t.kind !== "planning");
  const messages =
      data?.channelMessages.filter((m) => m.channelId === channel?.id) || [],
    agents = data?.agents.filter((a) => a.teamId === teamId) || [],
    ownAgents = agents.filter((a) => a.workerId === me);
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
  const writable = editor || state.me?.roles?.[teamId] === "commenter";
  const executionLane = state.sessions
    .find((s) => s.id === task?.sessionId)
    ?.lanes.find((l) => l.id === task?.laneId);
  const controls = task?.controllers.some(
      (g) => g.userId === me && !g.revokedAt,
    ),
    worker = task?.workerId === me;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  useEffect(() => {
    setTaskId("");
    setInstruction("");
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
        setTaskId(result.duplicateTaskId || result.id);
        if (result.duplicateTaskId)
          setError("已有相同目标的任务，已为你打开。");
      }
      setDialog("");
    });
  return (
    <section className="project-room" aria-label="项目协作">
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
              <Plus size={16} />
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
        <header>
          <strong>Agent</strong>
          {editor && (
            <button
              aria-label="添加团队 Agent"
              title="添加团队 Agent"
              onClick={() => {
                setForm({
                  key: request(),
                  lane: availableLanes[0]?.id || "codex",
                });
                setDialog("agent");
              }}
            >
              <Plus size={16} />
            </button>
          )}
        </header>
        {agents.map((a) => (
          <div className="project-agent" key={a.id}>
            <Bot size={15} />
            <span>
              {a.name}
              <small>{a.role}</small>
            </span>
          </div>
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
              ? "已关联目录"
              : "关联本机目录"}
          </button>
        )}
      </aside>
      <main className="project-chat">
        <header>
          <strong>{project ? `${project.name} / 项目群` : "项目群"}</strong>
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
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={
                      busy ||
                      !messages.length ||
                      !state.local.projectCheckouts?.[project.id]
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
                    整理任务
                  </button>
                </>
              )}
              <button
                onClick={() => {
                  setForm({ key: request(), dri: me, path: "artifact.md" });
                  setDialog("task");
                }}
              >
                <Plus size={14} />
                任务
              </button>
            </div>
          )}
        </header>
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
            <h3>从一个项目开始</h3>
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
        ) : (
          <>
            <div className="project-messages">
              {messages.length === 0 && (
                <p className="room-hint">在这里讨论，再把想法变成任务。</p>
              )}
              {messages.map((m) => (
                <article
                  key={m.id}
                  className={`project-message ${m.author.type}`}
                >
                  <div>
                    <strong>{m.author.name}</strong>
                    <time>{time(m.at)}</time>
                  </div>
                  {m.versionId && <small>产物评论 · {m.anchor}</small>}
                  <p>{m.text}</p>
                  {m.taskId && (
                    <button onClick={() => setTaskId(m.taskId!)}>
                      查看任务
                    </button>
                  )}
                </article>
              ))}
              <div ref={end} />
            </div>
            <div className="project-task-list">
              {tasks.map((t) => (
                <button
                  key={t.id}
                  className={t.id === task?.id ? "active" : ""}
                  onClick={() => setTaskId(t.id)}
                >
                  <span>{t.kind === "planning" ? "整理讨论" : t.goal}</span>
                  <small>
                    {t.status === "running" && t.execution === "waiting-worker"
                      ? "等待设备上线"
                      : status[t.status]}
                  </small>
                </button>
              ))}
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
                placeholder="发消息…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!writable}
              />
              <button
                title="发送"
                aria-label="发送消息"
                disabled={busy || !message.trim() || !writable}
              >
                <Send size={17} />
              </button>
            </form>
          </>
        )}
      </main>
      <aside className="project-artifact">
        <header>
          <strong>产物</strong>
          {task && <span>{status[task.status]}</span>}
        </header>
        {task ? (
          <>
            <div className="task-controls">
              <strong>
                {task.kind === "planning" ? "整理讨论" : task.goal}
              </strong>
              <small>
                负责人 ·{" "}
                {members.find((m) => m.id === task.driUserId)?.name || "成员"}
                {task.workerId &&
                  `　执行 · ${agents.find((a) => a.id === task.agentId)?.name || "Agent"}`}
              </small>
              <details>
                <summary>验收条件</summary>
                <p>{task.acceptance}</p>
                <small>产物：{task.artifactPath} · 写入项目目录</small>
              </details>
              {task.proposalError && (
                <p role="alert">提案未生成：{task.proposalError}</p>
              )}
              {task.status === "proposed" && editor && (
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
                        task.status === "ready"
                          ? "补充要求（可选）"
                          : "继续修改…"
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
                        unsupported:
                          "此 Provider 不支持运行中补充，请停止后继续",
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
                    控制者 ·{" "}
                    {task.controllers.filter((g) => !g.revokedAt).length}
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
            <ArtifactPanel
              key={task.id}
              task={task}
              state={state}
              call={call}
              onError={setError}
              canAccept={!!controls}
              worker={!!worker}
            />
            <details className="task-transcript">
              <summary>执行记录</summary>
              {state.sessions
                .find((s) => s.id === task.sessionId)
                ?.lanes.find((l) => l.id === task.laneId)
                ?.entries.map((e) => (
                  <p key={e.id}>
                    <small>{e.role}</small>
                    {e.text}
                  </p>
                ))}
            </details>
          </>
        ) : (
          <div className="room-empty">
            <FileText size={24} />
            <p>选择任务查看产物</p>
          </div>
        )}
      </aside>
      {dialog && (
        <Modal
          title={
            dialog === "project"
              ? "新建项目"
              : dialog === "agent"
                ? "团队 Agent"
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
                  <input required {...fields("name")} />
                </label>
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
              </>
            ) : dialog === "agent" ? (
              <>
                <label>
                  名称
                  <input required {...fields("name")} />
                </label>
                <label>
                  角色
                  <input placeholder="执行 / 负责人" {...fields("role")} />
                </label>
                <label>
                  本机 Agent
                  <select required {...fields("lane")}>
                    <option value="codex">Codex（新建）</option>
                    <option value="claude">Claude（新建）</option>
                    {availableLanes.map((l) => (
                      <option value={l.id} key={l.id}>
                        {l.providerLabel || l.provider}
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
                    placeholder="artifact.md / index.html"
                    {...fields("path")}
                  />
                </label>
              </>
            )}
            <button className="button primary" disabled={busy}>
              创建
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </Modal>
      )}
    </section>
  );
}

function ArtifactPanel({
  task,
  state,
  call,
  onError,
  canAccept,
  worker,
}: {
  task: ProjectTask;
  state: State;
  call: Call;
  onError: (s: string) => void;
  canAccept: boolean;
  worker: boolean;
}) {
  const versions =
      state.collaboration?.artifactVersions.filter(
        (v) => v.taskId === task.id,
      ) || [],
    latest = versions.at(-1);
  const [chosen, setChosen] = useState(""),
    [cache, setCache] = useState<Record<string, string>>({}),
    [source, setSource] = useState(false),
    [comment, setComment] = useState(""),
    [anchor, setAnchor] = useState(""),
    [pending, setPending] = useState(false);
  const selected = versions.find(
      (v) => v.id === (chosen || task.previewVersionId),
    ),
    checking =
      latest?.previewStatus === "pending" &&
      latest.runId === task.runId &&
      ["running", "review"].includes(task.status)
        ? latest
        : undefined;
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (checking) reported.current.delete(checking.id);
  }, [checking?.id]);
  const action = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    let live = true;
    for (const v of [selected, checking])
      if (v && !cache[v.id])
        void call("collab.artifact.read", { versionId: v.id })
          .then((value: ArtifactVersion) => {
            if (live) setCache((c) => ({ ...c, [v.id]: value.content || "" }));
          })
          .catch((e) => {
            if (live) onError(e.message);
          });
    return () => {
      live = false;
    };
  }, [selected?.id, checking?.id, state.local.online]);
  const check = (version: ArtifactVersion, loaded: boolean) => {
    if (reported.current.has(version.id)) return;
    reported.current.add(version.id);
    void call("collab.artifact.check", {
      taskId: task.id,
      versionId: version.id,
      hash: version.hash,
      loaded,
    }).catch((e) => {
      reported.current.delete(version.id);
      onError(e.message);
    });
  };
  const comments =
    state.collaboration?.artifactComments.filter((c) => c.taskId === task.id) ||
    [];
  return (
    <div className="artifact-panel">
      <div className="artifact-toolbar">
        <select
          aria-label="产物版本"
          value={selected?.id || ""}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="" disabled>
            {versions.length ? "预览准备中" : "尚无产物"}
          </option>
          {versions
            .filter((v) => v.previewStatus === "ready")
            .map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number}
                {v.id === task.acceptedVersionId ? " · 已验收" : ""}
              </option>
            ))}
        </select>
        <button
          title={source ? "查看预览" : "查看源文件"}
          aria-label={source ? "查看预览" : "查看源文件"}
          onClick={() => setSource(!source)}
        >
          <Code size={15} />
        </button>
        {worker && task.runId && (
          <button
            disabled={pending}
            title="更新产物"
            aria-label="更新产物"
            onClick={() =>
              void action(() =>
                call("collab.artifact.capture", { taskId: task.id }),
              )
            }
          >
            <RefreshCw size={15} />
          </button>
        )}
        {canAccept &&
          task.status === "review" &&
          selected?.id === task.previewVersionId &&
          selected?.runId === task.runId && (
            <button
              disabled={pending}
              onClick={() =>
                void action(() =>
                  call("collab.task.accept", {
                    taskId: task.id,
                    revision: task.revision,
                    versionId: selected?.id,
                  }),
                )
              }
            >
              <Check size={14} />
              验收
            </button>
          )}
      </div>
      {checking && cache[checking.id] && (
        <iframe
          className="artifact-check"
          title="产物渲染检查"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={artifactDocument(cache[checking.id], checking.kind)}
          onLoad={() => check(checking, true)}
          onError={() => check(checking, false)}
        />
      )}
      {latest?.previewStatus === "failed" && (
        <p className="room-error">新版本预览失败，保留上一版。</p>
      )}
      {selected && cache[selected.id] ? (
        source ? (
          <pre className="artifact-source">{cache[selected.id]}</pre>
        ) : (
          <iframe
            className="artifact-frame"
            title={`产物 v${selected.number}`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={artifactDocument(cache[selected.id], selected.kind)}
          />
        )
      ) : (
        <div className="room-empty">
          <FileText size={24} />
          <p>{checking ? "正在检查预览" : `等待 ${task.artifactPath}`}</p>
        </div>
      )}
      {selected && (
        <div className="artifact-comments">
          {comments.map((c) => (
            <p key={c.id}>
              <small>
                {c.anchor}
                {c.versionId !== selected.id ? " · 旧版本，待重新定位" : ""}
              </small>
              {c.text}
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await call("collab.artifact.comment", {
                  taskId: task.id,
                  versionId: selected.id,
                  anchor: anchor || "整份产物",
                  text: comment,
                  requestKey: crypto.randomUUID(),
                });
                setComment("");
              });
            }}
          >
            <input
              aria-label="评论位置"
              placeholder="位置，例如：页面标题"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
            />
            <div className="room-actions">
              <input
                aria-label="产物评论"
                placeholder={`评论 v${selected.number}…`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button disabled={pending || !comment.trim()}>评论</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
