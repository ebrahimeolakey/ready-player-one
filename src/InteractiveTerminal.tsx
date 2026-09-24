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
}: {
  bridge: TerminalBridge;
  workspaceId: string;
  sessionId: string;
  laneId?:string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!container.current) return;
    let disposed = false,
      id = "",
      sequence = 0,
      ready = false;
    const queued: TerminalEvent[] = [];
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: "#111111",
        foreground: "#d4d4d4",
        cursor: "#98d8c0",
      },
      allowProposedApi: false,
    });
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
      const opened = await bridge.invoke("terminal.open", {
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
      terminal.dispose();
      if (id) void bridge.invoke("terminal.close", { id }).catch(() => {});
    };
  }, [bridge, workspaceId, sessionId, laneId]);
  return (
    <div
      style={{
        height: "100%",
        minHeight: 100,
        position: "relative",
        background: "#111",
      }}
    >
      <div
        ref={container}
        style={{ height: "100%", padding: "8px 10px", boxSizing: "border-box" }}
      />
      {error && (
        <div
          role="alert"
          style={{
            position: "absolute",
            bottom: 0,
            background: "#391f1f",
            padding: 8,
            color: "#fbb",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
