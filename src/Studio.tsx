import { useState, useEffect, useRef } from "react";
import {
  Files,
  Search,
  GitBranch,
  MessageSquare,
  PanelRight,
  PanelBottom,
  Plus,
  Bot,
  TerminalSquare,
  FolderOpen,
  Check,
  ArrowUp,
  ChevronDown,
  Download,
  Archive,
  Users,
  Settings2,
  Share2,
  FileCode2,
} from "lucide-react";
import type { State, Session } from "./types";
import { AgentLane, Editor, CommandTerminal } from "./Panels";
import { Avatar, Mark, Empty, statusNames, time, type Call } from "./ui";
export function Studio({
  session: s,
  state,
  call,
  notify,
  onAddLane,
  onShare,
  onRepos,
  compact = false,
  secondary = false,
}: {
  compact?: boolean;
  secondary?: boolean;
  session: Session;
  state: State;
  call: Call;
  notify: (s: string) => void;
  onAddLane: () => void;
  onShare: () => void;
  onRepos: () => void;
}) {
  const [tool, setTool] = useState(compact ? "none" : "files"),
    [dock, setDock] = useState("agent"),
    [rail, setRail] = useState("session"),
    [showRail, setShowRail] = useState(!compact),
    [showDock, setShowDock] = useState(true),
    [laneId, setLaneId] = useState(""),
    [plan, setPlan] = useState(""),
    [comment, setComment] = useState(""),
    [liveDiff, setLiveDiff] = useState(false),
    [height, setHeight] = useState(340),
    [commentOpen, setCommentOpen] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTool(compact ? "none" : "files");
    setShowRail(!compact);
  }, [compact]);
  const own = s.lanes.filter((l) => l.ownerId === state.me?.id),
    lane = s.lanes.find((l) => l.id === laneId) || own[0] || s.lanes[0],
    mapped = !!state.local.paths[s.workspaceId],
    params = { workspaceId: s.workspaceId, sessionId: s.id },
    pending = state.approvals.filter(
      (a) => a.sessionId === s.id && a.status === "pending",
    );
  useEffect(() => {
    if (!liveDiff || !own[0]) return;
    let busy = false;
    const send = async () => {
      if (busy) return;
      busy = true;
      try {
        await call("diff.publish", { ...params, laneId: own[0].id });
      } finally {
        busy = false;
      }
    };
    send();
    const t = setInterval(send, 3000);
    return () => clearInterval(t);
  }, [liveDiff, own[0]?.id, s.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const focused = document.activeElement?.closest(".studio");
      if (focused ? focused !== root.current : secondary) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "j") {
        e.preventDefault();
        setShowDock((v) => !v);
      }
      if (e.key === "p") {
        e.preventDefault();
        setTool("search");
      }
      if (e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        onAddLane();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onAddLane, secondary]);
  const welcome = (
    <div className="editor-welcome">
      <Mark />
      <p>开始处理这个项目</p>
      <div className="shortcut-list">
        <button onClick={onAddLane}>
          新建 Agent<kbd>⇧⌘L</kbd>
        </button>
        <button
          onClick={() => {
            setShowDock(true);
            setDock("terminal");
          }}
        >
          终端<kbd>⌘J</kbd>
        </button>
        <button onClick={() => setTool("search")}>
          查找文件<kbd>⌘P</kbd>
        </button>
        <button onClick={onRepos}>
          打开仓库
          <FolderOpen size={13} />
        </button>
      </div>
    </div>
  );
  return (
    <div
      ref={root}
      className={
        "studio " +
        (!showDock ? "dock-hidden " : "") +
        (tool === "none" ? "files-hidden" : "")
      }
      style={{ "--dock-height": `${height}px` } as React.CSSProperties}
    >
      <nav className="activity-rail">
        {[
          [Files, "files", "文件"],
          [Search, "search", "查找文件"],
          [GitBranch, "diff", "源代码管理"],
          [MessageSquare, "comments", "评论"],
        ].map(([Icon, id, label]: any) => (
          <button
            key={id}
            title={label}
            aria-label={label}
            className={tool === id ? "active" : ""}
            onClick={() => {
              if (id === "comments") {
                setRail("session");
                setCommentOpen(true);
                setShowRail(true);
                setShowDock(true);
              } else setTool(tool === id ? "none" : id);
            }}
          >
            <Icon size={20} />
          </button>
        ))}
      </nav>
      {mapped ? (
        <Editor
          params={params}
          mapped
          call={call}
          notify={notify}
          hidden={tool === "diff"}
          search={tool === "search"}
          welcome={welcome}
        />
      ) : (
        <>
          <aside className="file-tree">
            <header>文件</header>
            <button onClick={() => call("project.map", params)}>
              <FolderOpen size={14} />
              关联文件夹
            </button>
            <button onClick={onRepos}>
              <GitBranch size={14} />
              克隆仓库
            </button>
          </aside>
          <div className="editor-pane">{welcome}</div>
        </>
      )}
      {tool === "diff" && (
        <section className="studio-diff">
          <header className="panel-heading">
            <GitBranch size={14} />
            <span>源代码管理</span>
            <select
              aria-label="查看成员变更"
              value={lane?.id || ""}
              onChange={(e) => setLaneId(e.target.value)}
            >
              {s.lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.owner} · {l.provider}
                </option>
              ))}
            </select>
            {own[0] && (
              <label title="将已跟踪文件的 diff 同步给工作区成员">
                <input
                  type="checkbox"
                  checked={liveDiff}
                  disabled={!mapped}
                  onChange={(e) => setLiveDiff(e.target.checked)}
                />
                共享我的变更
              </label>
            )}
          </header>
          {lane?.changedFiles?.map((f) => (
            <div className="diff-file" key={f.path}>
              <span>{f.status}</span>
              {f.path}
            </div>
          ))}
          {lane?.diff ? (
            <pre className="diff-code">
              {lane.diff.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "added"
                      : line.startsWith("-")
                        ? "removed"
                        : ""
                  }
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          ) : (
            <Empty icon={GitBranch} title="暂无共享变更" />
          )}
        </section>
      )}
      {showDock && (
        <section className="agent-dock">
          <div
            className="dock-resizer"
            role="separator"
            aria-label="调整 Agent 面板高度"
            onPointerDown={(e) => {
              const y = e.clientY,
                start = height;
              e.currentTarget.setPointerCapture(e.pointerId);
              const handle = e.currentTarget;
              handle.onpointermove = (ev) =>
                setHeight(
                  Math.max(
                    260,
                    Math.min(window.innerHeight - 230, start + y - ev.clientY),
                  ),
                );
              handle.onpointerup = () => {
                handle.onpointermove = null;
              };
            }}
          />
          <header className="dock-tabs">
            <button
              className={dock === "agent" ? "active" : ""}
              onClick={() => setDock("agent")}
            >
              <Bot size={13} />
              AGENT
            </button>
            <button
              className={dock === "terminal" ? "active" : ""}
              onClick={() => setDock("terminal")}
            >
              <TerminalSquare size={13} />
              终端
            </button>
            {pending.length > 0 && (
              <button
                className="approval-count"
                onClick={() => {
                  setShowRail(true);
                  setRail("session");
                }}
              >
                {pending.length} 待审批
              </button>
            )}
            <div className="grow" />
            <button
              className="icon-button"
              title="成员面板"
              aria-label="成员面板"
              onClick={() => setShowRail(!showRail)}
            >
              <PanelRight size={15} />
            </button>
            <button
              className="icon-button"
              title="收起下方面板"
              aria-label="收起下方面板"
              onClick={() => setShowDock(false)}
            >
              <ChevronDown size={15} />
            </button>
          </header>
          <div className={"dock-body " + (!showRail ? "rail-hidden" : "")}>
            <div className="dock-main">
              <div
                className={
                  dock === "agent" ? "lane-container" : "lane-container hidden"
                }
              >
                {lane ? (
                  <AgentLane
                    key={lane.id}
                    lane={lane}
                    session={s}
                    state={state}
                    call={call}
                    mapped={mapped}
                  />
                ) : (
                  <div className="agent-first">
                    <div className="lane-header">
                      <Avatar name={state.local.name || "我"} small />
                      <strong>我的 Agent</strong>
                    </div>
                    <Empty icon={Bot} title="尚未开始" />
                    <button className="button" onClick={onAddLane}>
                      <Plus size={14} />
                      新建 Agent
                    </button>
                  </div>
                )}
              </div>
              <div
                className={
                  dock === "terminal"
                    ? "terminal-container"
                    : "terminal-container hidden"
                }
              >
                <CommandTerminal params={params} mapped={mapped} call={call} />
              </div>
            </div>
            {showRail && (
              <aside className="session-rail">
                <header className="rail-tabs">
                  <button
                    className={rail === "session" ? "active" : ""}
                    onClick={() => setRail("session")}
                  >
                    <Users size={12} />
                    会话
                  </button>
                  <button
                    className={rail === "environment" ? "active" : ""}
                    onClick={() => setRail("environment")}
                  >
                    <Settings2 size={12} />
                    环境
                  </button>
                </header>
                <div className="rail-scroll">
                  {rail === "session" ? (
                    <>
                      {pending.map((a) => (
                        <article className="approval-card" key={a.id}>
                          <strong>
                            {a.owner} · {a.provider}
                          </strong>
                          <p>{a.prompt}</p>
                          <small>
                            {a.mode === "read-only"
                              ? "只读"
                              : "允许修改本机文件"}
                          </small>
                          {a.files.length > 0 && (
                            <small>{a.files.join("、")}</small>
                          )}
                          {a.overlaps.length > 0 && (
                            <p className="warning">
                              文件重叠：{a.overlaps.join("、")}
                            </p>
                          )}
                          <footer>
                            <button
                              className="button"
                              onClick={() =>
                                call("approval.decide", {
                                  id: a.id,
                                  allow: false,
                                })
                              }
                            >
                              拒绝
                            </button>
                            <button
                              className="button primary"
                              onClick={() =>
                                call("approval.decide", {
                                  id: a.id,
                                  allow: true,
                                })
                              }
                            >
                              批准
                            </button>
                          </footer>
                        </article>
                      ))}
                      {[
                        ...new Map(
                          [
                            ...state.members,
                            ...s.lanes.map((l) => ({
                              id: l.ownerId,
                              name: l.owner,
                              host: false,
                            })),
                          ].map((m) => [m.id, m]),
                        ).values(),
                      ].map((m) => (
                        <div className="lane-member" key={m.id}>
                          <div className="member-line">
                            <Avatar name={m.name} small />
                            <div>
                              <strong>
                                {m.name}
                                {m.id === state.me?.id ? "（我）" : ""}
                              </strong>
                              <small>
                                {m.name === s.owner ? "创建者" : "成员"} ·{" "}
                                {state.members.some((x) => x.id === m.id)
                                  ? "在线"
                                  : "离线"}
                              </small>
                            </div>
                            {m.id === state.me?.id && (
                              <button
                                className="icon-button"
                                onClick={onAddLane}
                                title="新建 Agent"
                                aria-label="新建 Agent"
                              >
                                <Plus size={14} />
                              </button>
                            )}
                          </div>
                          {s.lanes
                            .filter((l) => l.ownerId === m.id)
                            .map((l) => (
                              <button
                                key={l.id}
                                className={
                                  "member-lane " +
                                  (lane?.id === l.id ? "selected" : "")
                                }
                                onClick={() => {
                                  setLaneId(l.id);
                                  setDock("agent");
                                }}
                              >
                                <span>
                                  {l.provider === "codex" ? "Codex" : "Claude"}
                                </span>
                                <small>
                                  <span
                                    className={
                                      "dot " +
                                      (l.status === "running" ? "mint" : "")
                                    }
                                  />
                                  {statusNames[l.status]}
                                </small>
                              </button>
                            ))}
                        </div>
                      ))}
                      <details className="rail-section">
                        <summary>
                          计划{" "}
                          <span>
                            {s.plan.filter((p) => p.done).length}/
                            {s.plan.length}
                          </span>
                        </summary>
                        {s.plan.map((p) => (
                          <button
                            className={
                              "plan-item " + (p.done ? "completed" : "")
                            }
                            key={p.id}
                            onClick={() =>
                              call("plan.toggle", { sessionId: s.id, id: p.id })
                            }
                          >
                            <span className="checkbox">
                              {p.done && <Check size={11} />}
                            </span>
                            {p.text}
                          </button>
                        ))}
                        <form
                          className="compact-input"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (
                              await call("plan.add", {
                                sessionId: s.id,
                                text: plan,
                              })
                            )
                              setPlan("");
                          }}
                        >
                          <input
                            placeholder="添加计划…"
                            aria-label="添加计划"
                            value={plan}
                            onChange={(e) => setPlan(e.target.value)}
                            required
                          />
                          <button
                            title="添加计划"
                            aria-label="添加计划"
                            disabled={!plan.trim()}
                          >
                            <Plus size={13} />
                          </button>
                        </form>
                      </details>
                      <section className="rail-section">
                        <button
                          className="section-toggle"
                          onClick={() => setCommentOpen(!commentOpen)}
                        >
                          <ChevronDown size={12} />
                          评论 <span>{s.comments.length || "—"}</span>
                        </button>
                        {commentOpen && (
                          <>
                            <div className="comment-list">
                              {s.comments.length ? (
                                s.comments.map((c) => (
                                  <article key={c.id}>
                                    <header>
                                      <strong>{c.owner}</strong>
                                      <time>{time(c.at)}</time>
                                    </header>
                                    {c.anchor && <small>{c.anchor}</small>}
                                    <p>{c.text}</p>
                                  </article>
                                ))
                              ) : (
                                <p className="rail-empty">暂无评论</p>
                              )}
                            </div>
                            <form
                              className="compact-input"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                if (
                                  await call("comment.add", {
                                    sessionId: s.id,
                                    text: comment,
                                  })
                                )
                                  setComment("");
                              }}
                            >
                              <textarea
                                aria-label="评论"
                                rows={2}
                                placeholder="评论…"
                                required
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                              />
                              <button
                                title="发送评论"
                                aria-label="发送评论"
                                disabled={!comment.trim()}
                              >
                                <ArrowUp size={14} />
                              </button>
                            </form>
                          </>
                        )}
                      </section>
                    </>
                  ) : (
                    <div className="environment">
                      <small>分支</small>
                      <p>
                        <GitBranch size={13} />
                        {s.branch}
                      </p>
                      <small>本机目录</small>
                      <p className="path-text">
                        {state.local.sessionPaths[s.id] ||
                          state.local.paths[s.workspaceId] ||
                          "未关联"}
                      </p>
                      <button
                        className="button full"
                        onClick={() => call("project.map", params)}
                      >
                        <FolderOpen size={13} />
                        关联文件夹
                      </button>
                      <button
                        className="button full"
                        disabled={!mapped || !!state.local.sessionPaths[s.id]}
                        title="从当前 HEAD 创建独立分支，不包含未提交修改"
                        onClick={async () => {
                          if (await call("worktree.create", params))
                            notify("已创建工作树");
                        }}
                      >
                        <GitBranch size={13} />
                        {state.local.sessionPaths[s.id]
                          ? "工作树已创建"
                          : "创建工作树"}
                      </button>
                      <button
                        className="button full"
                        onClick={() =>
                          call("session.export", { sessionId: s.id })
                        }
                      >
                        <Download size={13} />
                        导出会话
                      </button>
                      <button
                        className="button full"
                        onClick={() =>
                          call("session.archive", {
                            sessionId: s.id,
                            restore: s.status === "archived",
                          })
                        }
                      >
                        <Archive size={13} />
                        {s.status === "archived" ? "恢复会话" : "归档会话"}
                      </button>
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        </section>
      )}
      {!showDock && (
        <button
          className="restore-dock button"
          onClick={() => setShowDock(true)}
        >
          <PanelBottom size={14} />
          Agent / 终端
        </button>
      )}
    </div>
  );
}
