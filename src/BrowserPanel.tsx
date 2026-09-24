import { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RefreshCw,
  X,
} from "lucide-react";
export type BrowserEvent = {
  kind: "browser";
  type: string;
  id: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  message?: string;
  requestId?: string;
};
export type BrowserBridge = {
  invoke: (method: string, args?: Record<string, unknown>) => Promise<any>;
  subscribeBrowser: (callback: (event: BrowserEvent) => void) => () => void;
};
export function BrowserPanel({ bridge }: { bridge: BrowserBridge }) {
  const viewport=useRef<HTMLDivElement>(null);
  const [id, setId] = useState(""),
    [url, setUrl] = useState("http://localhost:3000"),
    [state, setState] = useState<BrowserEvent | null>(null),
    [error, setError] = useState(""),
    [external, setExternal] = useState<BrowserEvent | null>(null);
  const call = async (method: string, args: Record<string, unknown> = {}) => {
    try {
      setError("");
      return await bridge.invoke(method, args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(
    () =>
      bridge.subscribeBrowser((event) => {
        if (event.id !== id) return;
        if (event.type === "closed") {
          setId("");
          setState(null);
        } else if (event.type === "state") {
          setState(event);
          if (event.url) setUrl(event.url);
        } else if (event.type === "external-request") setExternal(event);
        else if (event.message) setError(event.message);
      }),
    [bridge, id],
  );
  useEffect(
    () => () => {
      if (id) void bridge.invoke("browser.close", { id }).catch(() => {});
    },
    [bridge, id],
  );
  useEffect(()=>{
    if(!id||!viewport.current)return;
    const area=viewport.current;
    const update=()=>{const r=area.getBoundingClientRect();void bridge.invoke("browser.bounds",{id,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},visible:!document.querySelector('[role="dialog"]')}).catch(()=>{});};
    const resize=new ResizeObserver(update);resize.observe(area);
    const changes=new MutationObserver(update);changes.observe(document.body,{childList:true,subtree:true});
    window.addEventListener("resize",update);document.addEventListener("scroll",update,true);update();
    return()=>{resize.disconnect();changes.disconnect();window.removeEventListener("resize",update);document.removeEventListener("scroll",update,true);};
  },[id,bridge]);
  return (
    <section style={{ padding: 12, height:"100%",display:"flex",flexDirection:"column",minHeight:180 }}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await call(id ? "browser.navigate" : "browser.open", {
            id,
            url,
          });
          if (result?.id) setId(result.id);
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <button
          type="button"
          title="后退"
          aria-label="后退"
          disabled={!state?.canGoBack}
          onClick={() => call("browser.action", { id, action: "back" })}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          title="前进"
          aria-label="前进"
          disabled={!state?.canGoForward}
          onClick={() => call("browser.action", { id, action: "forward" })}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          disabled={!id}
          onClick={() => call("browser.action", { id, action: "reload" })}
        >
          <RefreshCw size={14} />
        </button>
        <input
          aria-label="网址"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          style={{ flex: 1, minWidth: 80 }}
        />
        <button title="打开网址" aria-label="打开网址">
          <Globe size={14} />
        </button>
        {!!id && (
          <button
            type="button"
            title="关闭浏览器"
            aria-label="关闭浏览器"
            onClick={() => call("browser.close", { id })}
          >
            <X size={14} />
          </button>
        )}
      </form>
      {external && (
        <div style={{ marginTop: 8 }}>
          打开外链：{external.url}
          <button
            onClick={async () => {
              await call("browser.external", {
                id,
                requestId: external.requestId,
                allow: true,
              });
              setExternal(null);
            }}
          >
            在系统浏览器打开
          </button>
          <button
            onClick={async () => {
              await call("browser.external", {
                id,
                requestId: external.requestId,
                allow: false,
              });
              setExternal(null);
            }}
          >
            取消
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div ref={viewport} style={{flex:1,minHeight:100,marginTop:8}}/>
    </section>
  );
}
