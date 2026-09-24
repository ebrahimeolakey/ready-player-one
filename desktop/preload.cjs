const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rpo", {
  invoke: (method, args = {}) => ipcRenderer.invoke("rpo:invoke", method, args),
  subscribe: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("rpo:event", handler);
    return () => ipcRenderer.removeListener("rpo:event", handler);
  },
});
