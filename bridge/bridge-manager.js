// ============================================
// Bridge Manager
// ============================================
// Core orchestration module that manages:
// 1. Cloud WebSocket connection (to DesignFlow backend)
// 2. Local WebSocket server (for Figma plugin)
// 3. File watcher for AE scripts
// ============================================

const EventEmitter = require("events");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

class BridgeManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.cloudWs = null;
    this.localWss = null;
    this.figmaClient = null;
    this.aeWatchInterval = null;
    this.cloudReconnectTimer = null;
    this.processedFiles = new Set();

    this.status = {
      cloud: "disconnected",
      figma: "disconnected",
      ae: "idle",
      localPort: config.localWsPort,
    };
  }

  // ──────────────────────────────────
  // Public API
  // ──────────────────────────────────
  start() {
    this.log("Starting DesignFlow Connector...", "info");
    this.startLocalServer();
    this.startAEWatcher();
    if (this.config.sessionKey) {
      this.connectCloud();
    } else {
      this.log("No session key — enter a key to connect to cloud", "warn");
    }
  }

  stop() {
    this.log("Shutting down...", "info");
    if (this.cloudWs) this.cloudWs.close();
    if (this.localWss) this.localWss.close();
    if (this.aeWatchInterval) clearInterval(this.aeWatchInterval);
    if (this.cloudReconnectTimer) clearTimeout(this.cloudReconnectTimer);
  }

  getStatus() {
    return { ...this.status };
  }

  reconnectCloud(sessionKey) {
    this.config.sessionKey = sessionKey;
    if (this.cloudWs) {
      this.cloudWs.close();
    }
    this.connectCloud();
  }

  // ──────────────────────────────────
  // 1. Cloud WebSocket Connection
  // ──────────────────────────────────
  connectCloud() {
    if (this.cloudReconnectTimer) clearTimeout(this.cloudReconnectTimer);

    this.log(`Connecting to cloud: ${this.config.cloudUrl}`, "info");
    this.updateStatus("cloud", "connecting");

    try {
      this.cloudWs = new WebSocket(`${this.config.cloudUrl}?type=connector`);
    } catch (err) {
      this.log(`Cloud connection failed: ${err.message}`, "error");
      this.updateStatus("cloud", "disconnected");
      this.scheduleCloudReconnect();
      return;
    }

    this.cloudWs.on("open", () => {
      this.log(`Linked to session: ${this.config.sessionKey} ✓`, "success");
      this.updateStatus("cloud", "connected");

      // Register this connector with sessionKey explicitly
      const regMsg = {
        type: "register_connector",
        sessionKey: this.config.sessionKey,
        capabilities: ["figma", "ae"],
        figmaConnected: this.status.figma === "connected",
      };
      
      this.cloudWs.send(JSON.stringify(regMsg));
      this.log("Sent registration to cloud", "info");
    });

    this.cloudWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        this.handleCloudMessage(msg);
      } catch (err) {
        this.log(`Cloud message parse error: ${err.message}`, "error");
      }
    });

    this.cloudWs.on("close", (code) => {
      this.log(`Cloud disconnected (${code})`, "warn");
      this.updateStatus("cloud", "disconnected");
      this.scheduleCloudReconnect();
    });

    this.cloudWs.on("error", (err) => {
      this.log(`Cloud error: ${err.message}`, "error");
    });
  }

  handleCloudMessage(msg) {
    this.log(`Cloud → ${msg.type}`, "info");

    switch (msg.type) {
      case "run_figma":
        // Route Figma script to local Figma plugin
        if (this.figmaClient && this.figmaClient.readyState === WebSocket.OPEN) {
          this.figmaClient.send(JSON.stringify({
            type: "run_script",
            script: msg.script,
            jobId: msg.jobId,
          }));
          this.log("Sent Figma script to plugin", "success");
          this.sendCloudAck(msg.jobId, "figma_sent");
        } else {
          this.log("Figma plugin not connected", "error");
          this.sendCloudAck(msg.jobId, "figma_not_connected");
        }
        break;

      case "run_ae":
        // Write AE script to watch folder
        const filename = `ae-script-${Date.now()}.jsx`;
        const filepath = path.join(this.config.aeWatchFolder, filename);
        fs.writeFileSync(filepath, msg.script);
        this.log(`Wrote AE script: ${filename}`, "success");
        this.sendCloudAck(msg.jobId, "ae_sent", { filename });
        break;

      case "ping":
        this.cloudWs.send(JSON.stringify({ type: "pong" }));
        break;

      default:
        this.log(`Unknown cloud message: ${msg.type}`, "warn");
    }
  }

  sendCloudAck(jobId, status, extra = {}) {
    if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
      this.cloudWs.send(JSON.stringify({
        type: "ack",
        jobId,
        status,
        ...extra,
      }));
    }
  }

  scheduleCloudReconnect() {
    this.cloudReconnectTimer = setTimeout(() => {
      if (this.config.sessionKey) {
        this.log("Attempting cloud reconnect...", "info");
        this.connectCloud();
      }
    }, 5000);
  }

  // ──────────────────────────────────
  // 2. Local WebSocket Server (Figma)
  // ──────────────────────────────────
  startLocalServer() {
    this.localWss = new WebSocket.Server({ port: this.config.localWsPort });
    this.log(`Local WS server on port ${this.config.localWsPort}`, "info");

    this.localWss.on("connection", (ws) => {
      this.log("New local connection", "info");

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw);

          if (msg.type === "register" && msg.from === "figma") {
            this.figmaClient = ws;
            this.updateStatus("figma", "connected");
            this.log("Figma plugin registered ✓", "success");
            ws.send(JSON.stringify({ type: "registered", status: "ok", from: "bridge" }));

            // Notify cloud that Figma is now connected
            if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
              this.cloudWs.send(JSON.stringify({
                type: "status_update",
                figma: "connected",
              }));
            }
          }

          if (msg.type === "figma_result" && msg.from === "figma") {
            this.log(`Figma result: ${msg.success ? "✓" : "✗"} ${msg.message}`, msg.success ? "success" : "error");

            // Forward result to cloud
            if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
              this.cloudWs.send(JSON.stringify({
                type: "figma_result",
                success: msg.success,
                message: msg.message,
                jobId: msg.jobId,
              }));
            }
          }
        } catch (err) {
          this.log(`Local parse error: ${err.message}`, "error");
        }
      });

      ws.on("close", () => {
        if (ws === this.figmaClient) {
          this.figmaClient = null;
          this.updateStatus("figma", "disconnected");
          this.log("Figma plugin disconnected", "warn");

          // Notify cloud
          if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
            this.cloudWs.send(JSON.stringify({
              type: "status_update",
              figma: "disconnected",
            }));
          }
        }
      });
    });

    this.localWss.on("error", (err) => {
      this.log(`Local server error: ${err.message}`, "error");
    });
  }

  // ──────────────────────────────────
  // 3. AE File Watcher
  // ──────────────────────────────────
  startAEWatcher() {
    // Ensure watch folder exists
    if (!fs.existsSync(this.config.aeWatchFolder)) {
      fs.mkdirSync(this.config.aeWatchFolder, { recursive: true });
      this.log(`Created AE watch folder: ${this.config.aeWatchFolder}`, "info");
    }

    this.updateStatus("ae", "watching");
    this.log(`Watching AE folder: ${this.config.aeWatchFolder}`, "info");

    // Poll every 2 seconds (matches original AE watcher)
    this.aeWatchInterval = setInterval(() => {
      try {
        const files = fs.readdirSync(this.config.aeWatchFolder)
          .filter((f) => f.endsWith(".jsx") && !this.processedFiles.has(f));

        for (const file of files) {
          this.processedFiles.add(file);
          this.log(`AE script detected: ${file}`, "info");

          // Notify cloud about script execution
          if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
            this.cloudWs.send(JSON.stringify({
              type: "ae_script_detected",
              filename: file,
            }));
          }
        }
      } catch (err) {
        // Folder might not exist yet
      }
    }, 2000);
  }

  // ──────────────────────────────────
  // Helpers
  // ──────────────────────────────────
  updateStatus(key, value) {
    this.status[key] = value;
    this.emit("status", this.getStatus());
  }

  log(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, message, type };
    console.log(`[${timestamp}] [${type}] ${message}`);
    this.emit("log", entry);
  }
}

module.exports = { BridgeManager };
