import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserService, browserURL } from "../desktop/services/browser.mjs";
class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      getURL: () => this.url || "",
      getTitle: () => "",
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: (handler) => (this.popup = handler),
    });
  }
  setMenu() {}
  isDestroyed() {
    return this.destroyed;
  }
  async loadURL(url) {
    this.url = url;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}
test("browser isolates remote pages, rejects custom protocols and requires explicit external decision", async () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:a@b.test",
    "https://u:p@example.com",
  ])
    assert.throws(() => browserURL(url));
  assert.equal(browserURL("http://localhost:3000"), "http://localhost:3000/");
  let session,
    external = [];
  const service = new BrowserService({
    BrowserWindow: FakeWindow,
    session: {
      fromPartition(partition) {
        session = new EventEmitter();
        session.partition = partition;
        Object.assign(session, {
          setPermissionCheckHandler: (fn) => (session.check = fn),
          setPermissionRequestHandler: (fn) => (session.request = fn),
          setDevicePermissionHandler: (fn) => (session.device = fn),
          clearStorageData: async () => (session.cleared = true),
        });
        return session;
      },
    },
    openExternal: async (url) => external.push(url),
  });
  const events = [];
  service.on("event", (_owner, event) => events.push(event));
  const { id } = await service.open(3, { url: "https://example.test" });
  const window = service.get(3, id).window;
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.preload, undefined);
  assert.ok(!session.partition.startsWith("persist:"));
  assert.equal(session.check(), false);
  assert.equal(session.device(), false);
  let permitted;
  session.request(null, "camera", (value) => (permitted = value));
  assert.equal(permitted, false);
  let blocked = false;
  window.webContents.emit("will-frame-navigate", {
    url: "file:///tmp/test",
    preventDefault() {
      blocked = true;
    },
  });
  assert.ok(blocked);
  blocked = false;
  window.webContents.emit("will-frame-navigate", {
    url: "https://example.test/frame",
    preventDefault() {
      blocked = true;
    },
  });
  assert.equal(blocked, false);
  assert.deepEqual(window.popup({ url: "https://example.test/external" }), {
    action: "deny",
  });
  assert.equal(external.length, 0);
  const request = events.find((e) => e.type === "external-request");
  await assert.rejects(
    service.external(99, { id, requestId: request.requestId, allow: true }),
    /无权/,
  );
  await service.external(3, { id, requestId: request.requestId, allow: true });
  assert.deepEqual(external, ["https://example.test/external"]);
  await assert.rejects(
    service.external(3, { id, requestId: request.requestId, allow: true }),
    /失效/,
  );
  service.closeOwner(3);
  assert.equal(service.windows.size, 0);
  assert.equal(session.cleared, true);
});
