import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
export function browserURL(value) {
  if (typeof value !== "string" || value.length > 8192) throw Error("网址无效");
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("仅支持不含账号密码的 HTTP / HTTPS 网址");
  return url.toString();
}
export const browserPreferences = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
});
export class BrowserService extends EventEmitter {
  constructor({ BrowserWindow, WebContentsView, getOwnerWindow, session, openExternal }) {
    super();
    this.BrowserWindow = BrowserWindow;
    this.WebContentsView=WebContentsView;
    this.getOwnerWindow=getOwnerWindow;
    this.session = session;
    this.openExternal = openExternal;
    this.windows = new Map();
  }
  get(ownerId, id) {
    const r = this.windows.get(id);
    if (!r || r.ownerId !== ownerId || r.window.isDestroyed())
      throw Error("浏览器不存在或无权访问");
    return r;
  }
  state(r) {
    const w = r.window.webContents;
    return {
      kind: "browser",
      type: "state",
      id: r.id,
      url: w.getURL(),
      title: w.getTitle(),
      loading: w.isLoading(),
      canGoBack: w.navigationHistory.canGoBack(),
      canGoForward: w.navigationHistory.canGoForward(),
    };
  }
  async open(ownerId, { url }) {
    url = browserURL(url);
    if (this.windows.size >= 6) throw Error("最多同时打开 6 个浏览器");
    const id = randomUUID();
    const isolatedSession = this.session.fromPartition(`rpo-browser-${id}`, {
      cache: false,
    });
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    isolatedSession.setDevicePermissionHandler(() => false);
    isolatedSession.on("will-download", (event) => event.preventDefault());
    const parent=this.WebContentsView&&this.getOwnerWindow?.(ownerId);
    let view;
    const options={
      width: 1100,
      height: 760,
      title: "浏览器 · 头号玩家",
      autoHideMenuBar: true,
      backgroundColor: "#181818",
      webPreferences: { ...browserPreferences, session: isolatedSession },
    };
    let window;
    if(parent){
      view=new this.WebContentsView({webPreferences:options.webPreferences});
      parent.contentView.addChildView(view);view.setVisible(false);
      window=new EventEmitter();window.webContents=view.webContents;
      window.isDestroyed=()=>view.webContents.isDestroyed();window.loadURL=url=>view.webContents.loadURL(url);window.focus=()=>view.webContents.focus();
      window.destroy=()=>{if(window.isDestroyed())return;parent.contentView.removeChildView(view);view.webContents.close();};
      view.webContents.once("destroyed",()=>window.emit("closed"));
    }else{window=new this.BrowserWindow(options);window.setMenu(null);}
    const r = {
      id,
      ownerId,
      window,
      view, parent,
      session: isolatedSession,
      external: new Map(),
    };
    this.windows.set(id, r);
    const send = () => {
      if (!window.isDestroyed()) this.emit("event", ownerId, this.state(r));
    };
    const check = (event, target) => {
      try {
        browserURL(typeof target === "string" ? target : (target || event).url);
      } catch {
        event.preventDefault();
        this.emit("event", ownerId, {
          kind: "browser",
          type: "blocked",
          id,
          message: "已阻止非 HTTP / HTTPS 导航",
        });
      }
    };
    window.webContents.on("will-navigate", check);
    window.webContents.on("will-frame-navigate", check);
    window.webContents.on("will-redirect", check);
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        const safe = browserURL(target);
        if (r.external.size < 20) {
          const requestId = randomUUID();
          r.external.set(requestId, safe);
          this.emit("event", ownerId, {
            kind: "browser",
            type: "external-request",
            id,
            requestId,
            url: safe,
          });
        }
      } catch {
        /* Custom protocol popups never escape into the OS. */
      }
      return { action: "deny" };
    });
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
    ])
      window.webContents.on(event, send);
    window.webContents.on(
      "did-fail-load",
      (_e, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3)
          this.emit("event", ownerId, {
            kind: "browser",
            type: "error",
            id,
            message: description,
          });
      },
    );
    window.on("closed", () => {
      this.windows.delete(id);
      r.external.clear();
      void isolatedSession.clearStorageData().catch(() => {});
      this.emit("event", ownerId, { kind: "browser", type: "closed", id });
    });
    void window.loadURL(url).catch((error) =>
      this.emit("event", ownerId, {
        kind: "browser",
        type: "error",
        id,
        message: error.message,
      }),
    );
    return { id, url };
  }
  bounds(ownerId,{id,bounds,visible=true}){
    const r=this.get(ownerId,id);if(!r.view)return true;
    if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite))throw Error("浏览器区域无效");
    const zoom=r.parent.webContents.getZoomFactor(), area=r.parent.getContentBounds();
    const x=Math.max(0,Math.min(area.width,Math.round(bounds.x*zoom))),y=Math.max(0,Math.min(area.height,Math.round(bounds.y*zoom)));
    const width=Math.max(0,Math.min(area.width-x,Math.round(bounds.width*zoom))),height=Math.max(0,Math.min(area.height-y,Math.round(bounds.height*zoom)));
    r.view.setBounds({x,y,width,height});r.view.setVisible(visible===true&&width>0&&height>0);return true;
  }
  async navigate(ownerId, { id, url }) {
    const r = this.get(ownerId, id);
    await r.window.loadURL(browserURL(url));
    return this.state(r);
  }
  action(ownerId, { id, action }) {
    const r = this.get(ownerId, id),
      w = r.window.webContents;
    if (action === "back" && w.navigationHistory.canGoBack())
      w.navigationHistory.goBack();
    else if (action === "forward" && w.navigationHistory.canGoForward())
      w.navigationHistory.goForward();
    else if (action === "reload") w.reload();
    else if (action === "focus") r.window.focus();
    return this.state(r);
  }
  async external(ownerId, { id, requestId, allow = false }) {
    const r = this.get(ownerId, id),
      url = r.external.get(requestId);
    if (!url) throw Error("外链请求已失效");
    r.external.delete(requestId);
    if (allow) await this.openExternal(browserURL(url));
    return true;
  }
  close(ownerId, { id }) {
    this.get(ownerId, id).window.destroy();
    return true;
  }
  closeOwner(ownerId) {
    for (const r of this.windows.values())
      if (r.ownerId === ownerId) r.window.destroy();
  }
  closeAll() {
    for (const r of this.windows.values()) r.window.destroy();
  }
}
