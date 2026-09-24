const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rpo", {
  invoke: (method, args = {}) => ipcRenderer.invoke("rpo:invoke", method, args),
  subscribeTerminal: (callback) => {
    const handler=(_event,data)=>callback(data);ipcRenderer.on("rpo:terminal",handler);return()=>ipcRenderer.removeListener("rpo:terminal",handler);
  },
  subscribeDictation: (callback) => {
    const handler=(_event,data)=>callback(data);ipcRenderer.on("rpo:dictation",handler);return()=>ipcRenderer.removeListener("rpo:dictation",handler);
  },
  subscribeBrowser: (callback) => {
    const handler=(_event,data)=>callback(data);ipcRenderer.on("rpo:browser",handler);return()=>ipcRenderer.removeListener("rpo:browser",handler);
  },
  subscribe: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("rpo:event", handler);
    return () => ipcRenderer.removeListener("rpo:event", handler);
  },
});
