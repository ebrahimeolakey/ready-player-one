import {useAppearance, terminalColors} from "./Appearance";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
export type TerminalEvent = {
  kind: "terminal";
  id: string;
  type: "data" | "exit";
  sequence: number;
  data?: string;
  exitCode?: number;
};
export type TerminalBridge = {
  invoke: (method: string, args?: Record<string, unknown>) => Promise<any>;
  subscribeTerminal: (callback: (event: TerminalEvent) => void) => () => void;
};
export function InteractiveTerminal({
  bridge,
  workspaceId,
  sessionId,
  laneId,
  mode = "shell",
  onClose,
}: {
  bridge: TerminalBridge;
  workspaceId: string;
  sessionId: string;
  laneId?:string;
  mode?: "shell" | "provider";
  onClose?: () => void;
}) {
  const {theme}=useAppearance();
  const palette=terminalColors(theme);
  const liveTerminal=useRef<Terminal | null>(null);
  const currentTheme=useRef(theme);
  currentTheme.current=theme;
  useEffect(()=>{if(liveTerminal.current)liveTerminal.current.options.theme=terminalColors(theme);},[theme]);
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [cli, setCLI] = useState<{displayCommand:string;resolvedCommand:string;cwd:string;account:string;accountSource:string;configDirectory:string;credentialEnvironment:string[]} | null>(null);
  useEffect(() => {
    if (!container.current) return;
    setError("");setCLI(null);
    let disposed = false,
      id = "",
      sequence = 0,
      ready = false;
    const queued: TerminalEvent[] = [];
    const terminal = new Terminal({
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      fontSize: 12,
      fontFamily: "Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: terminalColors(currentTheme.current),
      allowProposedApi: false,
    });
    liveTerminal.current=terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    fit.fit();
    const report = (e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    };
    const consume = (event: TerminalEvent) => {
      if (event.id !== id || event.sequence <= sequence) return;
      sequence = event.sequence;
      if (event.type === "data") terminal.write(event.data || "");
      else terminal.writeln(`\r\n[进程退出 · ${event.exitCode ?? 0}]`);
    };
    const unsubscribe = bridge.subscribeTerminal((event) => {
      if (!ready) queued.push(event);
      else consume(event);
    });
    const onData = terminal.onData((data) => {
      if (id) void bridge.invoke("terminal.input", { id, data }).catch(report);
    });
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      if(!container.current?.clientWidth || !container.current?.clientHeight)return;
      fit.fit();
      if (id)
        void bridge
          .invoke("terminal.resize", {
            id,
            cols: terminal.cols,
            rows: terminal.rows,
          })
          .catch(report);
    });
    observer.observe(container.current);
    void (async () => {
      const opened = await bridge.invoke(mode === "provider" ? "terminal.provider.open" : "terminal.open", {
        workspaceId,
        sessionId,
        laneId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      id = opened.id;
      if (disposed) {
        await bridge.invoke("terminal.close", { id });
        return;
      }
      if (opened.cli) setCLI(opened.cli);
      const snapshot = await bridge.invoke("terminal.read", { id });
      if (disposed) return;
      terminal.write(snapshot.data || "");
      sequence = snapshot.sequence;
      if (snapshot.exited)
        terminal.writeln(`\r\n[进程退出 · ${snapshot.exitCode ?? 0}]`);
      ready = true;
      for (const event of queued) consume(event);
      queued.length = 0;
      terminal.focus();
    })().catch(report);
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      onData.dispose();
      liveTerminal.current=null;
      terminal.dispose();
      if (id) void bridge.invoke("terminal.close", { id }).catch(() => {});
    };
  }, [bridge, workspaceId, sessionId, laneId, mode]);
  return (
    <div
      className="interactive-terminal"
      data-terminal-theme={theme}
      style={{
        color:palette.foreground,
        height: "100%",
        minHeight: 100,
        position: "relative",
        background: palette.background,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {mode === "provider" && <div style={{padding:"6px 10px",fontSize:11,borderBottom:"1px solid #333",flexShrink:0}}>
        <div style={{display:"flex",gap:8,alignItems:"center"}}><strong>本机 CLI · 独立会话</strong>{cli && <span title={cli.accountSource}>{cli.account}</span>}<span className="grow"/>{onClose && <button onClick={onClose}>关闭 CLI</button>}</div>
        {cli && <details><summary style={{overflowWrap:"anywhere"}}>{cli.displayCommand}</summary>
          <div style={{overflowWrap:"anywhere"}}>目录：{cli.cwd}</div><div>{cli.accountSource} · {cli.account}</div>
          <div style={{overflowWrap:"anywhere"}}>配置：{cli.configDirectory}</div>
          {cli.resolvedCommand !== cli.displayCommand && <div style={{overflowWrap:"anywhere"}}>可执行文件：{cli.resolvedCommand}</div>}
          {!!cli.credentialEnvironment.length && <div>环境来源：{cli.credentialEnvironment.join("、")}（实际认证以 CLI 为准）</div>}
          <div>输入、输出和审批仅在本机 CLI 内处理；不接续共享 Agent 会话。</div>
        </details>}
      </div>}
      <div
        ref={container}
        style={{ flex:1, minHeight:0, padding: "8px 10px", boxSizing: "border-box" }}
      />
      {error && (
        <div
          role="alert"
          style={{
            position: "absolute",
            bottom: 0,
            background: theme==='light'?"#fbe9e7":"#391f1f",
            padding: 8,
            color: theme==='light'?"#902d27":"#fbb",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
