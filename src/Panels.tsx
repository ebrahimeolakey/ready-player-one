import React, { useEffect, useRef, useState, useMemo } from "react";

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
import { ProviderControls, ImageAttachments, DictationControl, type ProviderImage } from "./ProviderControls";
import {readDraft,writeDraft,removeDraft} from "./drafts";
import {languageExtensions,type DefinitionLocation} from "./language-extension";
import CodeMirror, {type ReactCodeMirrorRef} from "@uiw/react-codemirror";
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
  const [prompt, setPrompt] = useState(""),
    [draftReady,setDraftReady]=useState(false),
    [mode, setMode] = useState("read-only"),
    [files, setFiles] = useState(""),
    [expanded, setExpanded] = useState(false),
    [intent,setIntent]=useState("steer");
  const [images,setImages]=useState<ProviderImage[]>([]),[voice,setVoice]=useState({supported:false,listening:false,busy:false,error:""});
  const voiceBase=useRef("");
  const providerLabel=l.providerLabel || state.local.providers.find(p=>p.id===l.provider)?.name || (l.provider==="codex"?"Codex":l.provider==="claude"?"Claude Code":"自定义 API");
  const selection={model:state.local.laneOptions?.[l.id]?.model||"",effort:state.local.laneOptions?.[l.id]?.effort||""};
  const bottom = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    [follow, setFollow] = useState(true);
  const mine = l.ownerId === state.me?.id,
    busy = ["running", "awaiting"].includes(l.status);
  useEffect(()=>{
    if(!mine)return;
    let active=true;
    void window.rpo.invoke("dictation.probe").then(result=>{if(active)setVoice(v=>({...v,supported:result.supported}));}).catch(()=>{});
    const unsubscribe=window.rpo.subscribeDictation(event=>{
      if(event.targetId!==l.id)return;
      if(event.type==="transcript")setPrompt(voiceBase.current+(voiceBase.current?"\n":"")+event.text);
      if(event.type==="listening")setVoice(v=>({...v,listening:true,busy:false,error:""}));
      if(["stopped","closed","error"].includes(event.type))setVoice(v=>({...v,listening:false,busy:false,error:event.type==="error"?event.message:""}));
    });
    return()=>{active=false;unsubscribe();};
  },[l.id,mine]);
  async function startVoice(){voiceBase.current=prompt;setVoice(v=>({...v,busy:true,error:""}));try{await window.rpo.invoke("dictation.start",{targetId:l.id});}catch(e){setVoice(v=>({...v,busy:false,error:e instanceof Error?e.message:"语音启动失败"}));}}
  useEffect(()=>{let active=true;void readDraft("rpo-prompt-"+l.id).then(value=>{if(active){setPrompt(current=>current||value||"");setDraftReady(true);}}).catch(e=>{if(active)setVoice(v=>({...v,error:e.message}));});return()=>{active=false;};},[l.id]);
  useEffect(() => {
    if(!draftReady)return;
    const persist=()=>void writeDraft("rpo-prompt-"+l.id,prompt).catch(e=>setVoice(v=>({...v,error:e.message})));
    const timer=setTimeout(persist,300);return()=>{clearTimeout(timer);persist();};
  }, [prompt, l.id,draftReady]);
  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [l.entries.length, l.entries.at(-1)?.text, follow]);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || voice.listening || voice.busy) return;
    if(busy){
      const result=await call(l.status==="running"&&intent==="steer"?"run.steer":"run.queue",{sessionId:s.id,laneId:l.id,runId:l.activeRunId,text:prompt,prompt,mode,images,files:files.split(",").map(f=>f.trim()).filter(Boolean)});
      if(result){setPrompt("");setImages([]);}return;
    }
    const a = await call("run.request", {
      workspaceId: s.workspaceId,
      sessionId: s.id,
      laneId: l.id,
      prompt,
      mode,
      images,
      files: files
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    });
    if (a) {setPrompt("");setImages([]);}
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
          <small>{providerLabel}</small>
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
                        : providerLabel}
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
            {providerLabel}
            <ProviderControls models={state.local.modelCatalogs?.[l.provider]} value={selection} disabled={busy} loadModels={()=>window.rpo.invoke("provider.models",{provider:l.provider,workspaceId:s.workspaceId,sessionId:s.id,laneId:l.id})} onChange={value=>void call("lane.options",{sessionId:s.id,laneId:l.id,...value})}/>
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
            <ImageAttachments images={images} onChange={setImages} call={window.rpo.invoke} disabled={!mapped}/>
            <DictationControl {...voice} onStart={()=>void startVoice()} onStop={()=>void call("dictation.stop")}/>
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
              <>
              <select aria-label="发送方式" value={intent} onChange={e=>setIntent(e.target.value)}><option value="steer">指导当前执行</option><option value="queue">加入下一步</option></select>
              <button className="send" disabled={!prompt.trim()||!mapped||voice.listening||voice.busy} title={intent==="steer"?"发送指导":"加入队列"}><ArrowUp size={16}/></button>
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
              </>
            ) : (
              <button
                className="send"
                disabled={!prompt.trim() || !mapped || s.status === "archived" || voice.listening || voice.busy}
                title="发起审批并执行"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          {(l.queue||[]).filter(q=>q.status==="queued").map(q=><div className="queued-prompt" key={q.id}><span>{q.prompt}</span><button type="button" title="取消排队" onClick={()=>call("run.queue.cancel",{sessionId:s.id,laneId:l.id,id:q.id})}><X size={12}/></button></div>)}
          {(l.steering||[]).filter(q=>q.status==="failed"||q.status==="unsupported").map(q=><button type="button" className="warning" key={q.id} onClick={()=>setPrompt(q.text)}>指导未送达 · 点击恢复草稿</button>)}
          <div className="composer-hint">{state.local.os&&state.local.os!=="darwin"?"Ctrl":"⌘"} ↵</div>
        </form>
      ) : (
        <div className="watching">
          <Radio size={14} />
          <span>
            {state.members.some((m) => m.id === l.ownerId && m.online!==false)
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
  params: { workspaceId: string; sessionId: string; laneId?: string };
  mapped: boolean;
  call: Call;
  notify: (s: string) => void;
}) {
  const codeRef=useRef<ReactCodeMirrorRef>(null),openRef=useRef<(path:string)=>Promise<void>>(async()=>{});
  const [pendingDefinition,setPendingDefinition]=useState<DefinitionLocation|null>(null);
  const contextKey = params.sessionId + ":" + (params.laneId || "");
  const [listing, setListing] = useState<any[]>([]),
    [path, setPath] = useState(""),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [original, setOriginal] = useState(""),
    [hash, setHash] = useState(""),
    [pendingFile, setPendingFile] = useState(""),
    [filter, setFilter] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [openedFor, setOpenedFor] = useState(""),
    [selection, setSelection] = useState({ startLine: 1, endLine: 1 }),
    [commentOpen, setCommentOpen] = useState(false),
    [comment, setComment] = useState(""),
    [commentBusy, setCommentBusy] = useState(false),
    [anchorStatus, setAnchorStatus] = useState("");
  const list = async (p: string) => {
    const f = await call("files", { ...params, path: p });
    if (f) {
      setListing(f);
      setPath(p);
    }
  };
  useEffect(() => {
    if (mapped) list("");
  }, [mapped, contextKey]);
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
  }, [search, filter, contextKey]);
  const open = async (p: string, force = false) => {
    if (force && file) await removeDraft(`rpo-file-${contextKey}-${file}`);
    if (content !== original && !force) {
      setPendingFile(p);
      return;
    }
    const r = await call("file.read", { ...params, path: p });
    if (r) {
      const key = `rpo-file-${contextKey}-${p}`,
        oldKey = `rpo-file-${params.sessionId}-${p}`;
      let stored = await readDraft(key);
      if (stored === null) {
        stored = await readDraft(oldKey);
        if (stored !== null) {
          await writeDraft(key, stored);
          await removeDraft(oldKey);
        }
      }
      let draft;
      try {
        draft = stored ? JSON.parse(stored) : null;
      } catch {}
      setFile(p);
      setOpenedFor(contextKey);
      setSelection({ startLine: 1, endLine: 1 });
      setCommentOpen(false);
      setComment("");
      setAnchorStatus("");
      setContent(draft?.content ?? r.content);
      setOriginal(draft?.original ?? r.content);
      setHash(draft?.hash ?? r.hash);
      setPendingFile("");
      if (draft) notify("已恢复本机未保存草稿；保存时会检查文件冲突");
    }
  };
  useEffect(() => {
    if (!file || openedFor !== contextKey) return;
    const key = `rpo-file-${contextKey}-${file}`;
    const persist = () =>
      void (
        content !== original
          ? writeDraft(key, JSON.stringify({ content, original, hash }))
          : removeDraft(key)
      ).catch((e) => notify(e.message));
    const timer = setTimeout(persist, 300);
    return () => {
      clearTimeout(timer);
      persist();
    };
  }, [content, original, hash, file, openedFor, contextKey]);
  const addComment = async () => {
    if (!comment.trim() || content !== original || openedFor !== contextKey)
      return;
    setCommentBusy(true);
    try {
      const location = await call("references.capture", {
        ...params,
        path: file,
        ...selection,
        expectedHash: hash,
      });
      if (!location) return;
      const result = await call("comment.add", {
        ...params,
        text: comment,
        location,
      });
      if (result) {
        setComment("");
        setCommentOpen(false);
        notify("已添加代码评论");
      }
    } finally {
      setCommentBusy(false);
    }
  };
  const checkAnchors = async () => {
    const files = await call("references.check", {
      ...params,
      references: [{ path: file }],
    });
    if (!files) return;
    const result = await call("comment.check", { ...params, files });
    if (result) {
      setAnchorStatus(
        files[0]?.hash !== hash
          ? "磁盘文件已变化，请重新打开"
          : "评论位置已检查",
      );
    }
  };
  const save = async () => {
    if (openedFor !== contextKey) return;
    const r = await call("file.save", { ...params, path: file, content, hash });
    if (r) {
      setHash(r.hash);
      setOriginal(content);
      notify("文件已保存到本机");
    }
  };
  openRef.current=open;
  const intelligence=useMemo(()=>languageExtensions({call:window.rpo.invoke,context:params,path:file,onError:error=>notify(error.message),onOpenDefinition:location=>{setPendingDefinition(location);if(location.path!==file)void openRef.current(location.path);}}),[contextKey,file]);
  useEffect(()=>{if(!pendingDefinition||pendingDefinition.path!==file)return;const view=codeRef.current?.view;if(!view)return;view.dispatch({selection:{anchor:Math.min(pendingDefinition.offset,view.state.doc.length)},scrollIntoView:true});view.focus();setPendingDefinition(null);},[file,content,pendingDefinition]);
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
        {file && openedFor === contextKey ? (
          <>
            <div className="editor-file">
              <FileCode2 size={14} />
              <span>
                {file}
                {content !== original ? " ●" : ""}
              </span>
              <small style={{ whiteSpace: "nowrap" }}>
                L{selection.startLine}
                {selection.endLine !== selection.startLine
                  ? `–${selection.endLine}`
                  : ""}
              </small>
              <button
                className="button"
                title={
                  content !== original
                    ? "先保存文件，再绑定评论"
                    : "评论当前选中代码行"
                }
                disabled={content !== original || commentBusy}
                onClick={() => setCommentOpen(!commentOpen)}
              >
                <MessageSquare size={13} />
                评论
              </button>
              <button
                className="icon-button"
                title="检查此文件的评论是否过期"
                aria-label="检查评论"
                onClick={checkAnchors}
              >
                <RefreshCw size={13} />
              </button>
              <button
                className="button"
                onClick={save}
                disabled={content === original}
              >
                保存
              </button>
            </div>
            {anchorStatus && (
              <div className="attention">
                <span>{anchorStatus}</span>
                <button onClick={() => setAnchorStatus("")}>关闭</button>
              </div>
            )}
            {commentOpen && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void addComment();
                }}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "8px 12px",
                  borderBottom: "1px solid #303030",
                }}
              >
                <input
                  aria-label="代码评论"
                  autoFocus
                  placeholder={`评论 L${selection.startLine}${selection.endLine !== selection.startLine ? `–${selection.endLine}` : ""}`}
                  value={comment}
                  maxLength={5000}
                  onChange={(e) => setComment(e.target.value)}
                  style={{ flex: 1, minWidth: 80 }}
                />
                <button
                  className="button"
                  disabled={
                    commentBusy || !comment.trim() || content !== original
                  }
                >
                  {commentBusy ? "发送中…" : "发送"}
                </button>
                <button
                  type="button"
                  aria-label="取消评论"
                  onClick={() => setCommentOpen(false)}
                >
                  <X size={14} />
                </button>
              </form>
            )}
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
              ref={codeRef}
              value={content}
              height="100%"
              theme="dark"
              extensions={[ext,...intelligence]}
              onChange={setContent}
              onUpdate={(update) => {
                if (!update.selectionSet && !update.docChanged) return;
                const range = update.state.selection.main;
                const startLine = update.state.doc.lineAt(range.from).number;
                const endLine = update.state.doc.lineAt(
                  range.to > range.from ? range.to - 1 : range.to,
                ).number;
                setSelection((previous) =>
                  previous.startLine === startLine &&
                  previous.endLine === endLine
                    ? previous
                    : { startLine, endLine },
                );
              }}
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
