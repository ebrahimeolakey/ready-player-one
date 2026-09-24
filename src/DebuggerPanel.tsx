import { useEffect, useRef, useState } from "react";
import { Bug, Play, Pause, Square, StepForward, ArrowDownToLine, ArrowUpFromLine, RefreshCw, X } from "lucide-react";
import "./debugger-panel.css";
export type DebuggerBridge = { invoke: (method: string, args?: Record<string, unknown>) => Promise<any> };
type Frame = { id: string; name: string; path: string; line: number; column: number };
type Breakpoint = { id?: string; path: string; line: number; resolved?: boolean; actualLine?: number };
type DebugState = { id: string; path: string; status: string; pauseId: number; reason: string; error?: string; exitCode: number | null; frames: Frame[]; breakpoints: Breakpoint[]; output: string };
type Variables = { scopes: { name: string; type: string; truncated: boolean; values: { name: string; type: string; value: string }[] }[] };
const active = (state: DebugState | null) => Boolean(state && !["stopped", "exited", "failed"].includes(state.status));
const statuses: Record<string, string> = { starting: "启动中", running: "运行中", paused: "已暂停", stopping: "停止中", stopped: "已停止", exited: "已退出", failed: "失败" };
export function DebuggerPanel({ bridge, context }: { bridge: DebuggerBridge; context: Record<string, unknown> }) {
  const [files, setFiles] = useState<string[]>([]), [path, setPath] = useState(""), [source, setSource] = useState(""), [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<DebugState | null>(null), [planned, setPlanned] = useState<Breakpoint[]>([]), [frameId, setFrameId] = useState("");
  const [variables, setVariables] = useState<Variables | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const key = JSON.stringify(context), currentKey = useRef(key), currentState = useRef<DebugState | null>(null), epoch = useRef(0);
  currentKey.current = key; currentState.current = state;
  const frame = state?.frames.find(f => f.id === frameId) || state?.frames[0], running = active(state);
  const breakpoints = running ? state?.breakpoints || [] : planned;
  const apply = (next: DebugState | null) => { currentState.current = next; setState(next); };
  async function refreshFiles() {
    try { const result = await bridge.invoke("debug.files", context); if (currentKey.current !== key) return; setFiles(result.files); setTruncated(result.truncated); }
    catch (e) { if (currentKey.current === key) setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => {
    let disposed = false, polling = false;
    const generation = ++epoch.current;
    apply(null); setPath(""); setSource(""); setPlanned([]); setFrameId(""); setVariables(null); setError(""); setBusy(false);
    void refreshFiles();
    const poll = async () => {
      if (polling || disposed) return; polling = true;
      try { const result = await bridge.invoke("debug.read", context); if (!disposed && generation === epoch.current) apply(result); }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(poll, 500);
    return () => {
      disposed = true; clearInterval(timer);
      const record = currentState.current;
      if (active(record)) void bridge.invoke("debug.stop", { ...context, id: record!.id }).catch(() => {});
    };
  }, [key, bridge]);
  useEffect(() => {
    let disposed = false; setSource("");
    if (path) bridge.invoke("debug.source", { ...context, path }).then(result => { if (!disposed) setSource(result.text); }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [path, key, bridge]);
  useEffect(() => {
    let disposed = false; setVariables(null);
    if (state?.status === "paused" && frame) {
      bridge.invoke("debug.variables", { ...context, id: state.id, frameId: frame.id, pauseId: state.pauseId }).then(result => { if (!disposed) setVariables(result); }).catch(e => { if (!disposed) setError(e.message); });
    }
    return () => { disposed = true; };
  }, [state?.id, state?.pauseId, state?.status, frame?.id, key, bridge]);
  async function command(method: string, args: Record<string, unknown> = {}) {
    const generation = epoch.current; setBusy(true); setError("");
    try {
      const next = await bridge.invoke(method, { ...context, id: state?.id, ...args });
      if (generation !== epoch.current) { if (method === "debug.start" && next?.id) await bridge.invoke("debug.stop", { ...context, id: next.id }); return; }
      if (next?.id) { apply(next); setPlanned(next.breakpoints || []); }
    } catch (e) { if (generation === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  function toggleBreakpoint(line: number) {
    const existing = breakpoints.find(b => b.path === path && b.line === line);
    if (running) void command(existing ? "debug.breakpoint.remove" : "debug.breakpoint.set", existing ? { breakpointId: existing.id } : { path, line });
    else setPlanned(existing ? planned.filter(b => b !== existing) : [...planned, { path, line }]);
  }
  const paused = state?.status === "paused", selectedLine = paused && frame?.path === path ? frame.line : 0;
  return <section className="debugger-panel" aria-label="Node.js 调试器">
    <header><strong><Bug size={15}/> Node.js 调试</strong><span role="status">{state ? statuses[state.status] || state.status : "选择文件开始"}{state?.status === "exited" ? ` · ${state.exitCode ?? "—"}` : ""}</span></header>
    <div className="debugger-controls">
      <select aria-label="调试文件" value={path} onChange={e => setPath(e.target.value)} disabled={busy}><option value="">选择 JavaScript 文件</option>{files.map(file => <option key={file}>{file}</option>)}</select>
      <button title="刷新文件" aria-label="刷新调试文件" disabled={busy} onClick={() => void refreshFiles()}><RefreshCw size={14}/></button>
      {!running ? <button disabled={!path || busy} onClick={() => void command("debug.start", { path, breakpoints: planned })}><Play size={14}/>启动</button> : <>
        <button disabled={busy || !["paused", "running"].includes(state?.status || "")} onClick={() => void command("debug.action", { action: paused ? "resume" : "pause" })}>{paused ? <Play size={14}/> : <Pause size={14}/>} {paused ? "继续" : "暂停"}</button>
        <button disabled={busy || !paused} title="执行下一行" onClick={() => void command("debug.action", { action: "stepOver" })}><StepForward size={14}/>单步</button>
        <button disabled={busy || !paused} title="进入函数" onClick={() => void command("debug.action", { action: "stepInto" })}><ArrowDownToLine size={14}/>进入</button>
        <button disabled={busy || !paused} title="跳出当前函数" onClick={() => void command("debug.action", { action: "stepOut" })}><ArrowUpFromLine size={14}/>跳出</button>
        <button disabled={busy || state?.status === "stopping"} onClick={() => void command("debug.stop")}><Square size={14}/>停止</button>
      </>}
    </div>
    {(error || state?.error) && <p className="debugger-error" role="alert">{error || state?.error}</p>}
    {truncated && <small>文件较多，仅列出前 1000 个。</small>}
    {!files.length && !error && <p className="small-note">当前工作区没有 .js、.mjs 或 .cjs 文件。</p>}
    <div className="debugger-content">
      <div className="debugger-source" aria-label="源码与断点">{source ? source.split("\n").map((line, index) => {
        const number = index + 1, breakpoint = breakpoints.find(b => b.path === path && b.line === number);
        return <div key={number} className={selectedLine === number ? "debugger-current" : ""}><button className={breakpoint ? "debugger-breakpoint" : ""} disabled={busy} onClick={() => toggleBreakpoint(number)} title={`${breakpoint ? "移除" : "添加"}第 ${number} 行断点`} aria-label={`${breakpoint ? "移除" : "添加"}第 ${number} 行断点`}>{breakpoint ? "●" : number}</button><code>{line || " "}</code></div>;
      }) : <p className="small-note">选择文件，点击行号设置断点。</p>}</div>
      <aside>
        <details open><summary>调用栈{paused && state?.reason === "exception" ? " · 未捕获异常" : ""}</summary>{state?.frames.length ? state.frames.map(item => <button className={frame?.id === item.id ? "selected" : ""} key={item.id} onClick={() => { setFrameId(item.id); if (files.includes(item.path)) setPath(item.path); }}><span>{item.name}</span><small>{item.path}:{item.line}</small></button>) : <small>暂停后查看</small>}</details>
        <details open><summary>局部变量</summary>{variables?.scopes.length ? variables.scopes.map((scope, index) => <div key={index} className="debugger-scope"><small>{scope.name}</small>{scope.values.map((value, i) => <div key={i}><code title={value.type}>{value.name}</code><code>{value.value}</code></div>)}{scope.truncated && <small>仅展示前 200 项</small>}</div>) : <small>暂停后查看</small>}</details>
        <details><summary>断点 · {breakpoints.length}</summary>{breakpoints.map(item => <div className="debugger-breakpoint-row" key={`${item.path}:${item.line}`}><small>{item.path}:{item.line}{running && !item.resolved ? " · 待加载" : ""}{item.actualLine && item.actualLine !== item.line ? ` → ${item.actualLine}` : ""}</small><button aria-label={`移除 ${item.path}:${item.line} 断点`} disabled={busy} onClick={() => running ? void command("debug.breakpoint.remove", { breakpointId: item.id }) : setPlanned(planned.filter(b => b !== item))}><X size={12}/></button></div>)}</details>
      </aside>
    </div>
    <details className="debugger-output" open><summary>输出</summary><pre>{state?.output || "尚无输出"}</pre></details>
    <small>本机 Node.js · 直接执行所选文件 · 修改源码后请重新启动调试</small>
  </section>;
}
