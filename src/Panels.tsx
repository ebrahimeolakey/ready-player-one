import React, { useEffect, useRef, useState } from "react";

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

import { Avatar, Empty, time, statusNames, type Call } from "./ui";
export function AgentLane({
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
            <span>{mine ? "我" : ""}</span>
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
            {e.role === "system" && e.text.length > 200 ? (
              <details className="diagnostic-log">
                <summary>运行日志</summary>
                <pre>{e.text}</pre>
              </details>
            ) : e.role === "system" ? (
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
            <h3>尚无消息</h3>
            <p>{mine ? "" : "等待成员开始"}</p>
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
            {l.provider === "codex" ? "Codex" : "Claude"}
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
            placeholder={mapped ? "向 Agent 提问…" : "先关联本机项目目录"}
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
              <option value="read-only">只读</option>
              <option value="workspace-write">允许编辑</option>
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
          <div className="composer-hint">⌘ ↵</div>
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
export function Editor({
  params,
  mapped,
  call,
  notify,
  welcome,
  hidden = false,
  search = false,
}: {
  welcome?: React.ReactNode;
  hidden?: boolean;
  search?: boolean;
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
    [pendingFile, setPendingFile] = useState(""),
    [filter, setFilter] = useState(""),
    [results, setResults] = useState<any[]>([]);
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
  useEffect(() => {
    let cancelled = false;
    if (!search || !filter.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const found = await call("file.search", { ...params, query: filter });
      if (!cancelled) setResults(found || []);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, filter, params.sessionId]);
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
    <div className={"editor " + (hidden ? "pane-hidden" : "")}>
      <aside className="file-tree">
        <header>
          <span>资源管理器</span>
          <button title="刷新" onClick={() => list(path)}>
            <RefreshCw size={13} />
          </button>
        </header>
        {search && (
          <input
            autoFocus
            placeholder="查找项目文件…"
            aria-label="查找项目文件"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        {path && (
          <button onClick={() => list(path.split("/").slice(0, -1).join("/"))}>
            ../ 返回上级
          </button>
        )}
        {(search && filter.trim() ? results : listing).map((f) => (
          <button
            title={f.path}
            className={file === f.path ? "selected" : ""}
            key={f.path}
            onClick={() => (f.directory ? list(f.path) : open(f.path))}
          >
            {f.directory ? <Folder size={14} /> : <FileCode2 size={14} />}
            <span>{search && filter.trim() ? f.path : f.name}</span>
            {f.directory && <ChevronRight size={12} />}
          </button>
        ))}
      </aside>
      <div
        className="editor-pane"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s" && file) {
            e.preventDefault();
            if (content !== original) save();
          }
        }}
      >
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
          welcome || <Empty icon={Code2} title="选择文件" />
        )}
      </div>
    </div>
  );
}
export function CommandTerminal({
  params,
  mapped,
  call,
}: {
  params: { workspaceId: string; sessionId: string };
  mapped: boolean;
  call: Call;
}) {
  const [command, setCommand] = useState(""),
    [output, setOutput] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="command-terminal">
      <header>
        <TerminalSquare size={15} />
        <span>本机 zsh</span>
        <small>单次命令 · 60 秒</small>
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
              (r ? r.output || "" : "执行失败") +
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
          placeholder="输入命令…"
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
