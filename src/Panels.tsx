import { useGeneralSettings } from "./GeneralSettings";
import { promptProblem, promptStats, PROMPT_LIMITS, SUMMARY_LIMIT } from "../core/prompt-limits.mjs";
import { useKeyboard, shortcutsAllowed } from "./KeyboardSettings";
import { ContextUsage } from "./ContextUsage";
import { LaneModel } from "./LaneModel";
import { useComposer } from "./useComposer";
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
import {
  ProviderControls,
  ImageAttachments,
  DictationControl,
  type ProviderImage,
} from "./ProviderControls";
import { MessageText, toolSummary } from "./MessageContent";
import { readImageFiles, imageFiles } from "./composer-files";
import { readDraft, writeDraft, removeDraft } from "./drafts";
import {
  languageExtensions,
  type DefinitionLocation,
} from "./language-extension";
import { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { CodeEditor } from "./CodeEditor";
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
  onBrowse,
  focusEntry,
  onOpenInEditor,
}: {
  lane: Lane;
  session: Session;
  state: State;
  call: Call;
  mapped: boolean;
  onBrowse?: (url: string) => void;
  focusEntry?:{entryId:string;hash:string;key:string};
  onOpenInEditor?:()=>void;
}) {
  const { conversationDensity } = useGeneralSettings();
  const [detailOpen, setDetailOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { setDetailOpen({}); }, [conversationDensity, l.id]);
  const detailsProps = (id: string, defaultOpen = conversationDensity === "detailed") => {
    const open = detailOpen[id] ?? defaultOpen;
    return { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;
      if (next !== open) setDetailOpen(current => ({ ...current, [id]: next }));
    } };
  };
  const [commentEntry,setCommentEntry]=useState<{id:string;text:string}|null>(null),[entryComment,setEntryComment]=useState(''),[entryCommentBusy,setEntryCommentBusy]=useState(false),[entryNotice,setEntryNotice]=useState('');
  const [focusedId,setFocusedId]=useState('');
  const workspaceRole=state.me?.roles?.[s.workspaceId]||(state.me?.host?'owner':'viewer');
  const canComment=workspaceRole!=='viewer',canExecute=['owner','editor'].includes(workspaceRole);
  const hashText=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
  async function addEntryComment(){if(!commentEntry||!entryComment.trim())return;setEntryCommentBusy(true);try{const expectedHash=await hashText(commentEntry.text);if(await call('comment.add',{sessionId:s.id,workspaceId:s.workspaceId,text:entryComment,transcript:{laneId:l.id,entryId:commentEntry.id,expectedHash}})){setCommentEntry(null);setEntryComment('');}}finally{setEntryCommentBusy(false);}}
  const keyboard = useKeyboard();
  const mine = l.ownerId === state.me?.id;
  const composer = useComposer(l.id,mine);
  const {
    text: prompt,
    images,
    setText: setPrompt,
    setImages,
    ready: draftReady,
    persist: persistComposer,
  } = composer;
  const [mode, setMode] = useState("read-only"),
    [files, setFiles] = useState(""),
    [expanded, setExpanded] = useState(false),
    [intent, setIntent] = useState("steer");
  const [voice, setVoice] = useState({
    supported: false,
    listening: false,
    busy: false,
    error: "",
  });
  const inputBusy = composer.busy,
    setInputBusy = composer.setBusy;
  const [composerError, setComposerError] = useState("");
  const restoring = useRef(false),
    restoreAttempts = useRef(new Set<string>());
  async function attachFiles(files: File[]) {
    if (!files.length || inputBusy || !draftReady || composer.blocked) return;
    setInputBusy(true);
    setComposerError("");
    try {
      const added = await readImageFiles(files, (images) =>
        window.rpo.invoke("providers.images.validate", { images }),
      );
      const combined = await window.rpo.invoke("providers.images.validate", {
        images: [...composer.current().images, ...added],
      });
      setImages(combined);
    } catch (e) {
      setComposerError(e instanceof Error ? e.message : String(e));
    } finally {
      setInputBusy(false);
    }
  }
  async function restoreGuidance(id: string) {
    if (restoring.current || composer.current().busy || composer.current().blocked) return;
    restoring.current = true;
    setInputBusy(true);
    setComposerError("");
    try {
      await persistComposer();
      if (composer.current().blocked) throw new Error("请先处理另存草稿");
      const saved = await window.rpo.invoke("composer.restore", {
        sessionId: s.id,
        laneId: l.id,
        id,
      });
      composer.applySaved(saved);
      if (saved.warning) setComposerError(saved.warning);
    } catch (e) {
      setComposerError(e instanceof Error ? e.message : String(e));
    } finally {
      restoring.current = false;
      setInputBusy(false);
    }
  }
  const providerLabel =
    l.providerLabel ||
    state.local.providers.find((p) => p.id === l.provider)?.name ||
    (l.provider === "codex"
      ? "Codex"
      : l.provider === "claude"
        ? "Claude Code"
        : "自定义 API");
  const selection = {
    model: state.local.laneOptions?.[l.id]?.model || "",
    effort: state.local.laneOptions?.[l.id]?.effort || "",
  };
  const promptError = promptProblem(prompt, {allowEmpty:true});
  const promptSize = promptStats(prompt);
  const [overlapHints, setOverlapHints] = useState<
    { laneId: string; owner: string; reason: string }[]
  >([]);
  useEffect(() => {
    if (!mine || !mapped || !prompt.trim() || promptError) {
      setOverlapHints([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void window.rpo
        .invoke("coordination.check", {
          workspaceId: s.workspaceId,
          sessionId: s.id,
          laneId: l.id,
          prompt,
          files: files
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean),
        })
        .then((result) => {
          if (active) setOverlapHints(result.details || []);
        })
        .catch(() => {
          if (active) setOverlapHints([]);
        });
    }, 650);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [prompt, files, l.id, s.id, mapped]);
  const bottom = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    [follow, setFollow] = useState(true);
  useEffect(()=>{let active=true;setFocusedId('');setEntryNotice('');if(focusEntry){setFollow(false);const entry=l.entries.find(e=>e.id===focusEntry.entryId);if(!entry)setEntryNotice('原消息已不可用');else void hashText(entry.text).then(hash=>{if(!active)return;if(hash!==focusEntry.hash){setEntryNotice('原消息内容已变化，无法定位原始片段');return;}setFocusedId(entry.id);setDetailOpen(current=>({...current,[entry.id]:true}));requestAnimationFrame(()=>scroll.current?.querySelector(`[data-entry-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({block:'center'}));});}return()=>{active=false;};},[focusEntry?.key,l.id,l.entries.find(e=>e.id===focusEntry?.entryId)?.text]);
  const busy = ["running", "awaiting"].includes(l.status);
  useEffect(() => {
    if (!mine || !canExecute) return;
    let active = true;
    void window.rpo
      .invoke("dictation.probe")
      .then((result) => {
        if (active) setVoice((v) => ({ ...v, supported: result.supported }));
      })
      .catch(() => {});
    const unsubscribe = window.rpo.subscribeDictation((event) => {
      if (event.targetId !== l.id) return;
      if (event.type === "transcript")
        setPrompt(
          composer.voiceBase() +
            (composer.voiceBase() ? "\n" : "") +
            event.text,
        );
      if (event.type === "listening")
        setVoice((v) => ({ ...v, listening: true, busy: false, error: "" }));
      if (["stopped", "closed", "error"].includes(event.type))
        setVoice((v) => ({
          ...v,
          listening: false,
          busy: false,
          error: event.type === "error" ? event.message : "",
        }));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [l.id, mine,canExecute]);
  async function startVoice() {
    if (!canExecute || !mapped || !composer.current().ready || composer.current().busy || composer.current().blocked || s.status === "archived") return;
    composer.captureVoiceBase();
    setVoice((v) => ({ ...v, busy: true, error: "" }));
    try {
      await window.rpo.invoke("dictation.start", { targetId: l.id });
    } catch (e) {
      setVoice((v) => ({
        ...v,
        busy: false,
        error: e instanceof Error ? e.message : "语音启动失败",
      }));
    }
  }
  useEffect(() => {
    if (
      !draftReady ||
      inputBusy ||
      prompt ||
      images.length ||
      !mine ||
      composer.blocked
    )
      return;
    const failed = l.steering?.find(
      (q) =>
        ["failed", "unsupported"].includes(q.status) &&
        !restoreAttempts.current.has(q.id),
    );
    if (failed) {
      restoreAttempts.current.add(failed.id);
      void restoreGuidance(failed.id);
    }
  }, [draftReady, inputBusy, prompt, images.length, l.steering, mine]);
  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [l.entries.length, l.entries.at(-1)?.text, follow]);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (
      !canExecute ||
      !prompt.trim() ||
      !!promptError ||
      voice.listening ||
      voice.busy ||
      inputBusy ||
      !draftReady ||
      composer.blocked
    )
      return;
    setInputBusy(true);
    setComposerError("");
    try {
      if (busy) {
        const result = await call(
          l.status === "running" && intent === "steer"
            ? "run.steer"
            : "run.queue",
          {
            sessionId: s.id,
            laneId: l.id,
            runId: l.activeRunId,
            text: prompt,
            prompt,
            mode,
            images,
            files: files
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean),
          },
        );
        if (result) {
          setPrompt("");
          setImages([]);
        }
        return;
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
      if (a) {
        setPrompt("");
        setImages([]);
      }
    } finally {
      setInputBusy(false);
    }
  };
  return (
    <section className={"agent-lane density-" + conversationDensity + " " + (mine ? "mine" : "")}>
      <header className="lane-header">
        <div className={"provider-icon small " + l.provider}>
          {l.provider === "codex" ? <Code2 size={16} /> : <span>✳</span>}
        </div>
        <div>
          <strong>
            {l.owner}
            <span>{mine ? "我" : ""}</span>
          </strong>
          <small className="lane-provider">{providerLabel} · <LaneModel lane={l} /></small>
        </div>
        {onOpenInEditor && <button className="icon-button" title="在编辑器中打开聊天" aria-label="在编辑器中打开聊天" onClick={onOpenInEditor}><FileCode2 size={14}/></button>}
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
        {entryNotice&&<p role="status">{entryNotice}</p>}
        {l.entries.map((e) => (
          <article className={"entry " + e.role+(focusedId===e.id?" reference-selected":"")} key={e.id} data-entry-id={e.id}>
            {e.role === "system" && e.text.length > 200 ? (
              <details className="diagnostic-log" {...detailsProps(e.id, false)}>
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
                      : e.role === "reasoning"
                        ? "思考"
                        : e.role === "tool"
                          ? "工具执行"
                          : providerLabel}
                  </span>
                  <span className="entry-actions">
                    {canComment&&<button type="button" title="评论这条消息" aria-label="评论这条消息" onClick={()=>{setCommentEntry({id:e.id,text:e.text});setEntryComment('');}}><MessageSquare size={12}/></button>}
                    <button
                      type="button"
                      title="复制消息"
                      aria-label="复制消息"
                      onClick={() => void call("clipboard", { text: e.text })}
                    >
                      <Copy size={12} />
                    </button>
                    <time>{time(e.at)}</time>
                  </span>
                </div>
                {e.role === "tool" ? (
                  <details {...detailsProps(e.id)}>
                    <summary>
                      <TerminalSquare size={13} />
                      {toolSummary(e.text)}
                    </summary>
                    <pre>{e.text}</pre>
                  </details>
                ) : e.role === "reasoning" ? (
                  <details
                    className="reasoning-entry"
                    {...detailsProps(e.id)}
                  >
                    <summary>
                      <Brain size={12} />
                      思考过程
                    </summary>
                    <div className="message-text">{e.text}</div>
                  </details>
                ) : (
                  <MessageText text={e.text} onBrowse={onBrowse} />
                )}
              </>
            )}
            {commentEntry?.id===e.id&&<form className="message-comment" onSubmit={ev=>{ev.preventDefault();void addEntryComment();}}><textarea autoFocus aria-label="消息评论" value={entryComment} maxLength={5000} onChange={ev=>setEntryComment(ev.target.value)} required/><button type="button" disabled={entryCommentBusy} onClick={()=>setCommentEntry(null)}>取消</button><button disabled={entryCommentBusy||!entryComment.trim()}>发送</button></form>}
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
      {mine && canExecute ? (
        <form
          className="composer"
          onSubmit={submit}
          onDragOver={(e) => {
            if (
              Array.from(e.dataTransfer.items).some(
                (item) => item.kind === "file",
              )
            ) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              void attachFiles(imageFiles(e.dataTransfer));
            }
          }}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData);
            if (files.length && !e.clipboardData.getData("text/plain")) {
              e.preventDefault();
              void attachFiles(files);
            }
          }}
        >
          <div className="composer-owner">
            <span className="dot mint" />
            {providerLabel}
            <ProviderControls
              models={state.local.modelCatalogs?.[l.provider]}
              value={selection}
              disabled={busy}
              loadModels={() =>
                window.rpo.invoke("provider.models", {
                  provider: l.provider,
                  workspaceId: s.workspaceId,
                  sessionId: s.id,
                  laneId: l.id,
                })
              }
              onChange={(value) =>
                void call("lane.options", {
                  sessionId: s.id,
                  laneId: l.id,
                  ...value,
                })
              }
            />
            <ContextUsage usage={l.usage} />
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (shortcutsAllowed(e.target) && keyboard.matches(e, "stopRun") && busy) {
                e.preventDefault();
                void call("lane.stop", { sessionId: s.id, laneId: l.id });
              }
              if (shortcutsAllowed(e.target) && keyboard.matches(e, "sendPrompt")) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={mapped ? "向 Agent 提问…" : "先关联本机项目目录"}
            disabled={
              !mapped ||
              s.status === "archived" ||
              !draftReady ||
              inputBusy ||
              composer.blocked
            }
            rows={3}
          />
          {promptError && <p role="alert" className="provider-error">{promptError}。请缩短后发送；本机草稿最多保留200,000码点。</p>}
          {!promptError && promptSize.codePoints > SUMMARY_LIMIT && <small>原文 {promptSize.codePoints.toLocaleString()} / {PROMPT_LIMITS.codePoints.toLocaleString()} 码点；协作检查仅使用前 {SUMMARY_LIMIT.toLocaleString()} 码点摘要，执行时完整投递。</small>}
          {expanded && (
            <input
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder="计划修改的文件，用英文逗号分隔"
            />
          )}
          <div className="composer-controls">
            <ImageAttachments
              images={images}
              onChange={setImages}
              call={window.rpo.invoke}
              disabled={!mapped || inputBusy || !draftReady || composer.blocked}
            />
            <DictationControl
              {...voice}
              disabled={!mapped || inputBusy || !draftReady || composer.blocked || s.status === "archived"}
              onStart={() => void startVoice()}
              onStop={() => void call("dictation.stop")}
            />
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
                <select
                  aria-label="发送方式"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                >
                  <option value="steer">指导当前执行</option>
                  <option value="queue">加入下一步</option>
                </select>
                <button
                  className="send"
                  disabled={
                    !prompt.trim() ||
                    !!promptError ||
                    !mapped ||
                    voice.listening ||
                    voice.busy ||
                    inputBusy ||
                    !draftReady || composer.blocked
                  }
                  title={intent === "steer" ? "发送指导" : "加入队列"}
                >
                  <ArrowUp size={16} />
                </button>
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
                disabled={
                  !prompt.trim() ||
                  !!promptError ||
                  !mapped ||
                  s.status === "archived" ||
                  voice.listening ||
                  voice.busy ||
                  inputBusy ||
                  !draftReady || composer.blocked
                }
                title="发起审批并执行"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          {(l.queue || [])
            .filter((q) => q.status === "queued")
            .map((q) => (
              <div className="queued-prompt" key={q.id}>
                <span>{q.prompt}</span>
                <button
                  type="button"
                  title="取消排队"
                  onClick={() =>
                    call("run.queue.cancel", {
                      sessionId: s.id,
                      laneId: l.id,
                      id: q.id,
                    })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          {(l.steering || [])
            .filter((q) => q.status === "failed" || q.status === "unsupported")
            .map((q) => (
              <button
                type="button"
                className="warning"
                key={q.id}
                disabled={inputBusy || !draftReady || composer.blocked}
                onClick={() => void restoreGuidance(q.id)}
              >
                指导未送达 · 恢复草稿
              </button>
            ))}
          {overlapHints.length > 0 && (
            <details className="overlap-hints">
              <summary>{overlapHints.length} 处协作提醒</summary>
              {overlapHints.map((hint, index) => (
                <p key={hint.laneId + index}>
                  <strong>{hint.owner}</strong> · {hint.reason}
                </p>
              ))}
            </details>
          )}
          {composer.conflicts.length > 0 && (
            <details className="overlap-hints" open={composer.blocked}>
              <summary>另存草稿 · {composer.conflicts.length}</summary>
              {composer.conflicts.map((draft: any) => (
                <div key={draft.id}>
                  <p>
                    {draft.text.slice(0, 120)}
                    {draft.images.length
                      ? ` · ${draft.images.length} 张图片`
                      : ""}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={inputBusy}
                    onClick={async () => {
                      setInputBusy(true);
                      try {
                        await persistComposer();
                        const saved = await window.rpo.invoke(
                          "composer.conflict.restore",
                          { laneId: l.id, id: draft.id },
                        );
                        composer.applySaved(saved);
                      } catch (e) {
                        setComposerError(
                          e instanceof Error ? e.message : String(e),
                        );
                      } finally {
                        setInputBusy(false);
                      }
                    }}
                  >
                    合并到输入框
                  </button>
                </div>
              ))}
              {composer.blocked && (
                <button
                  type="button"
                  className="button"
                  onClick={() => void composer.reload()}
                >
                  使用已保存草稿
                </button>
              )}
            </details>
          )}
          {composer.error && (
            <p role="alert" className="provider-error">
              {composer.error}
            </p>
          )}
          {composerError && (
            <p className="provider-error" role="alert">
              {composerError}
            </p>
          )}
          <div className="composer-hint">
            {keyboard.label("sendPrompt")}
          </div>
        </form>
      ) : (
        <div className="watching">
          <Radio size={14} />
          <span>
            {state.members.some((m) => m.id === l.ownerId && m.online !== false)
              ? `正在实时观看 ${l.owner} 的 Agent`
              : "此成员当前离线 · 历史通道已保留"}
          </span>
          {canExecute && l.status === "running" && (
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
  rootRevision = "",
  onDocumentChange,
  onOpenDocument,
}: {
  welcome?: React.ReactNode;
  hidden?: boolean;
  search?: boolean;
  rootRevision?: string;
  onDocumentChange?: (opened: boolean) => void;
  onOpenDocument?:()=>void;
  params: { workspaceId: string; sessionId: string; laneId?: string };
  mapped: boolean;
  call: Call;
  notify: (s: string) => void;
}) {
  const keyboard = useKeyboard();
  const codeRef = useRef<ReactCodeMirrorRef>(null),
    openRef = useRef<(path: string) => Promise<void>>(async () => {});
  const [pendingDefinition, setPendingDefinition] =
    useState<DefinitionLocation | null>(null);
  const activityView = useRef(crypto.randomUUID());
  const contextKey = params.sessionId + ":" + (params.laneId || "");
  const [listing, setListing] = useState<any[]>([]),
    [path, setPath] = useState(""),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [original, setOriginal] = useState(""),
    [hash, setHash] = useState(""),
    [fileRoot, setFileRoot] = useState(""),
    [openedRevision, setOpenedRevision] = useState(""),
    [draftKey, setDraftKey] = useState(""),
    [legacyDraft, setLegacyDraft] = useState<{content:string;canonicalRoot?:string}|null>(null),
    [legacyPreview, setLegacyPreview] = useState(false),
    [legacyLoading, setLegacyLoading] = useState(false),
    [pendingFile, setPendingFile] = useState(""),
    [filter, setFilter] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [openedFor, setOpenedFor] = useState(""),
    [selection, setSelection] = useState({ startLine: 1, endLine: 1 }),
    [commentOpen, setCommentOpen] = useState(false),
    [comment, setComment] = useState(""),
    [commentBusy, setCommentBusy] = useState(false),
    [anchorStatus, setAnchorStatus] = useState("");
  const documentCallback = useRef(onDocumentChange);
  documentCallback.current = onDocumentChange;
  useEffect(() => { documentCallback.current?.(!!file); }, [file]);
  const rootChanged = Boolean(file && openedRevision !== rootRevision);
  const currentView = useRef("");
  const currentContent = useRef(content);
  currentContent.current = content;
  currentView.current = contextKey + "\n" + rootRevision;
  const viewIdentity = currentView.current;
  const listSequence = useRef(0), openSequence = useRef(0);
  useEffect(() => {
    if (!params.laneId || !mapped || rootChanged) return;
    let pending = false;
    const publish = async () => {
      if (pending) return;
      pending = true;
      try {
        await window.rpo.invoke("editor.activity", {
          ...params,
          viewId: activityView.current,
          paths: file ? [file] : [],
        });
      } catch {
      } finally {
        pending = false;
      }
    };
    void publish();
    const timer = setInterval(publish, 45000);
    return () => {
      clearInterval(timer);
      void window.rpo
        .invoke("editor.activity", {
          ...params,
          viewId: activityView.current,
          paths: [],
        })
        .catch(() => {});
    };
  }, [file, contextKey, mapped, rootChanged]);
  const list = async (p: string) => {
    const request = ++listSequence.current;
    const f = await call("files", { ...params, path: p });
    if (f && currentView.current === viewIdentity && request === listSequence.current) {
      setListing(f);
      setPath(p);
    }
  };
  useEffect(() => {
    setListing([]); setPath(""); setResults([]);
    if (mapped) list("");
  }, [mapped, contextKey, rootRevision]);
  const searchView = useRef(crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    setResults([]);
    if (!search || hidden || !mapped || !filter.trim()) return;
    const request = { ...params, viewId: searchView.current, queryId: crypto.randomUUID(), query: filter };
    let started = false;
    const timer = setTimeout(async () => {
      started = true;
      const response = await call("file.search", request);
      if (!cancelled && currentView.current === viewIdentity && response?.queryId === request.queryId && !response.cancelled)
        setResults(response.results || []);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (started) void window.rpo.invoke("file.search.cancel", request).catch(() => {});
    };
  }, [search, hidden, mapped, filter, params.workspaceId, contextKey, rootRevision]);
  const open = async (p: string, force = false, keepDraft = false) => {
    onOpenDocument?.();
    if (force && draftKey) {
      if (keepDraft) await writeDraft(draftKey, JSON.stringify({content,original,hash,canonicalRoot:fileRoot}));
      else await removeDraft(draftKey);
    }
    if (content !== original && !force) {
      setPendingFile(p);
      return;
    }
    const request = ++openSequence.current;
    const r = await call("file.read", { ...params, path: p });
    if (r && typeof r.canonicalRoot === "string" && currentView.current === viewIdentity && request === openSequence.current) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.canonicalRoot));
      const rootKey = [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
      const key = `rpo-file-${contextKey}-${rootKey}-${p}`;
      const stored = await readDraft(key);
      let draft;
      try { draft = stored ? JSON.parse(stored) : null; } catch {}
      if (draft?.canonicalRoot !== r.canonicalRoot) draft = null;
      const legacy = await readDraft(`rpo-file-${contextKey}-${p}`) ?? await readDraft(`rpo-file-${params.sessionId}-${p}`);
      let recoverableLegacy = null;
      if (legacy) {
        try { const parsed = JSON.parse(legacy); if (typeof parsed?.content === "string") recoverableLegacy = parsed; } catch {}
        if (!recoverableLegacy) notify("旧草稿格式无法解析，原记录已保留");
      }
      if (currentView.current !== viewIdentity || request !== openSequence.current) return;
      setLegacyDraft(recoverableLegacy); setLegacyPreview(false);
      setDraftKey(key); setFileRoot(r.canonicalRoot); setOpenedRevision(rootRevision);
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
    if (!file || openedFor !== contextKey || !draftKey) return;
    const key = draftKey;
    const persist = () =>
      void (
        content !== original
          ? writeDraft(key, JSON.stringify({ content, original, hash, canonicalRoot:fileRoot }))
          : removeDraft(key)
      ).catch((e) => notify(e.message));
    const timer = setTimeout(persist, 300);
    return () => {
      clearTimeout(timer);
      persist();
    };
  }, [content, original, hash, file, openedFor, contextKey, draftKey, fileRoot]);
  const addComment = async () => {
    if (rootChanged || !comment.trim() || content !== original || openedFor !== contextKey)
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
    if (rootChanged) return;
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
    if (openedFor !== contextKey || rootChanged || !fileRoot) return;
    const openedRequest = openSequence.current;
    const requestedContent = content;
    const r = await call("file.save", { ...params, path: file, content:requestedContent, hash, expectedRoot:fileRoot });
    if (r && currentView.current === viewIdentity && openedRequest === openSequence.current) {
      const savedContent = typeof r.content === "string" ? r.content : requestedContent;
      setHash(r.hash);
      setOriginal(savedContent);
      if (currentContent.current === requestedContent) setContent(savedContent);
      notify(r.notices?.length ? "已保存 · " + r.notices.join("；") : "文件已保存到本机");
    }
  };
  const loadLegacyDraft = async () => {
    if (!legacyDraft || rootChanged || !fileRoot || legacyLoading || content !== original) return;
    const openedRequest = openSequence.current;
    setLegacyLoading(true);
    try {
      // Explicitly reread the selected target: legacy hashes/root assumptions
      // must never become the save baseline for a different directory.
      const disk = await call("file.read", {...params,path:file});
      if (!disk || currentView.current !== viewIdentity || openedRequest !== openSequence.current) return;
      if (disk.canonicalRoot !== fileRoot) { notify("目标目录已改变，请重新打开目标文件后再载入旧草稿"); return; }
      if (currentContent.current !== content) { notify("编辑内容已改变，未载入旧草稿"); return; }
      setOriginal(disk.content); setHash(disk.hash); setContent(legacyDraft.content);
      setLegacyPreview(false); notify("旧草稿已载入编辑器，尚未保存；旧记录仍保留");
    } finally { setLegacyLoading(false); }
  };
  openRef.current = open;
  const intelligence = useMemo(
    () =>
      rootChanged ? [] : languageExtensions({
        call: window.rpo.invoke,
        context: params,
        path: file,
        onError: (error) => notify(error.message),
        onOpenDefinition: (location) => {
          setPendingDefinition(location);
          if (location.path !== file) void openRef.current(location.path);
        },
      }),
    [contextKey, file, rootChanged, rootRevision],
  );
  useEffect(() => {
    if (!pendingDefinition || pendingDefinition.path !== file) return;
    const view = codeRef.current?.view;
    if (!view) return;
    view.dispatch({
      selection: {
        anchor: Math.min(pendingDefinition.offset, view.state.doc.length),
      },
      scrollIntoView: true,
    });
    view.focus();
    setPendingDefinition(null);
  }, [file, content, pendingDefinition]);
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
        onKeyDownCapture={(e) => {
          if (shortcutsAllowed(e.target) && keyboard.matches(e, "saveFile") && file) {
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
                disabled={rootChanged || content !== original || commentBusy}
                onClick={() => setCommentOpen(!commentOpen)}
              >
                <MessageSquare size={13} />
                评论
              </button>
              <button
                className="icon-button"
                title="检查此文件的评论是否过期"
                aria-label="检查评论"
                disabled={rootChanged}
                onClick={checkAnchors}
              >
                <RefreshCw size={13} />
              </button>
              <button
                className="button"
                onClick={save}
                disabled={rootChanged || !fileRoot || content === original}
              >
                保存
              </button>
            </div>
            {rootChanged && <div className="attention"><span>目录已切换，当前文件与未保存内容仍属于原目录。请切回原目录保存，或保留草稿后打开新文件。</span></div>}
            {legacyDraft && <div className="attention"><span>有旧版未保存草稿</span><button onClick={()=>setLegacyPreview(!legacyPreview)}>{legacyPreview ? "收起旧草稿" : "查看旧草稿"}</button></div>}
            {legacyDraft && legacyPreview && <section style={{padding:12,borderBottom:"1px solid #303030"}}>
              <div>载入目标：{fileRoot}/{file}</div>
              <small>旧草稿来源：{legacyDraft.canonicalRoot || "未记录"}。仅载入编辑器，不自动保存；旧草稿继续保留。</small>
              <pre style={{maxHeight:200,overflow:"auto",whiteSpace:"pre-wrap"}}>{legacyDraft.content}</pre>
              {content !== original && <small>请先保存当前编辑内容，或保留当前草稿后重新打开文件。</small>}
              <button className="button" disabled={rootChanged || !fileRoot || legacyLoading || content !== original} onClick={loadLegacyDraft}>{legacyLoading ? "读取目标…" : "载入当前文件"}</button>
              <button onClick={()=>setLegacyPreview(false)}>关闭</button>
            </section>}
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
                    rootChanged || commentBusy || !comment.trim() || content !== original
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
                <button onClick={() => open(pendingFile, true, true)}>保留草稿并打开</button>
                <button onClick={() => open(pendingFile, true)}>
                  放弃修改并打开
                </button>
                <button onClick={() => setPendingFile("")}>取消</button>
              </div>
            )}
            <CodeEditor
              agentDocument={{workspaceId:params.workspaceId,path:file,binding:rootRevision,blocked:rootChanged}}
              ref={codeRef}
              value={content}
              height="100%"
              theme="dark"
              extensions={[ext, ...intelligence]}
              onChange={(value) => { currentContent.current=value; setContent(value); }}
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
