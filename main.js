// ============================================
// DesignFlow Desktop Connector — Main Process
// ============================================
// This Electron app replaces bridge-server.js and adds:
// 1. Cloud WebSocket connection (to designflow.io backend)
// 2. Local WebSocket server (for Figma plugin)
// 3. File watcher for AE scripts
// 4. System tray with status
// 5. Auto-launch on login
// ============================================

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { BridgeManager } = require("./bridge/bridge-manager");

// Persistent settings
const store = new Store({
  defaults: {
    sessionKey: null,
    cloudUrl: "wss://YOUR_RELAY_URL_HERE", // Change this after deploying relay
    localWsPort: 3003,
    aeWatchFolder: path.join(app.getPath("documents"), "DesignFlow", "ae-scripts"),
    autoLaunch: true,
    minimizeToTray: true,
  },
});

let mainWindow = null;
let tray = null;
let bridgeManager = null;

// ──────────────────────────────────────
// Window
// ──────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    minWidth: 380,
    minHeight: 500,
    resizable: true,
    frame: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0F0F0F",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", (e) => {
    if (store.get("minimizeToTray")) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ──────────────────────────────────────
// System Tray
// ──────────────────────────────────────
function createTray() {
  // Create a simple tray icon (16x16 template image)
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA" +
    "UElEQVQ4T2NkoBAwUqifYdQABuoHwiAMg8GDgMaBkJaWxkBNL4waBINhGDCQOwyo6YVR" +
    "AwgEAiPVvEBuOIyaQMhEMoxCoaqqipreGAxpAABbrBAR1vfYRgAAAABJRU5ErkJggg=="
  );
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  updateTrayMenu();

  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } else {
      createWindow();
    }
  });
}

function updateTrayMenu() {
  const status = bridgeManager ? bridgeManager.getStatus() : {};
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "DesignFlow Connector",
      enabled: false,
    },
    { type: "separator" },
    {
      label: `Cloud: ${status.cloud || "Disconnected"}`,
      enabled: false,
    },
    {
      label: `Figma: ${status.figma || "Disconnected"}`,
      enabled: false,
    },
    {
      label: `AE: ${status.ae || "Watching"}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open Dashboard",
      click: () => shell.openExternal(process.env.DASHBOARD_URL || "https://app.designflow.io/dashboard"),
    },
    {
      label: "Show Window",
      click: () => {
        if (mainWindow) mainWindow.show();
        else createWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`DesignFlow — ${status.cloud || "Disconnected"}`);
}

// ──────────────────────────────────────
// Bridge Manager (core logic)
// ──────────────────────────────────────
function startBridge() {
  bridgeManager = new BridgeManager({
    cloudUrl: store.get("cloudUrl"),
    sessionKey: store.get("sessionKey"),
    localWsPort: store.get("localWsPort"),
    aeWatchFolder: store.get("aeWatchFolder"),
  });

  // Status updates → tray + renderer
  bridgeManager.on("status", (status) => {
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("status-update", status);
    }
  });

  // Log events → renderer
  bridgeManager.on("log", (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log-entry", entry);
    }
  });

  bridgeManager.start();
}

// ──────────────────────────────────────
// IPC Handlers
// ──────────────────────────────────────
ipcMain.handle("get-settings", () => store.store);
ipcMain.handle("set-setting", (_, key, value) => {
  store.set(key, value);
  return true;
});
ipcMain.handle("get-status", () => bridgeManager?.getStatus() || {});
ipcMain.handle("set-session-key", (_, key) => {
  store.set("sessionKey", key);
  bridgeManager?.reconnectCloud(key);
  return true;
});
ipcMain.handle("set-auth-token", (_, key) => {
  store.set("sessionKey", key);
  bridgeManager?.reconnectCloud(key);
  return true;
});
ipcMain.handle("open-external", (_, url) => shell.openExternal(url));

// ──────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  startBridge();
});

app.on("window-all-closed", () => {
  // Don't quit on Mac — keep in tray
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (bridgeManager) bridgeManager.stop();
});
