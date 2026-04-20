// ============================================
// Preload Script — exposes safe APIs to renderer
// ============================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("connector", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),

  // Auth
  setAuthToken: (token) => ipcRenderer.invoke("set-auth-token", token),

  // Status
  getStatus: () => ipcRenderer.invoke("get-status"),
  onStatusUpdate: (callback) => {
    ipcRenderer.on("status-update", (_, status) => callback(status));
  },

  // Logs
  onLogEntry: (callback) => {
    ipcRenderer.on("log-entry", (_, entry) => callback(entry));
  },

  // External links
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
