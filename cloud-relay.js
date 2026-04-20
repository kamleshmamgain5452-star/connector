// ============================================
// DesignFlow Cloud WebSocket Relay Server
// ============================================
// This is the server-side component that runs on your cloud.
// It maintains WebSocket connections from:
//   1. Desktop Connectors (Electron apps on users' machines)
//   2. Website clients (browsers viewing the dashboard)
//
// When a user clicks "Push to Figma" on the website,
// this relay finds their desktop connector and forwards the command.
//
// DEPLOYMENT:
//   - For production: deploy as a standalone Node.js service
//   - For Next.js: use a custom server or edge function
//   - For serverless: use a service like Ably, Pusher, or Supabase Realtime
//
// RUN LOCALLY:
//   node cloud-relay.js
// ============================================

const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");
const url = require("url");

const PORT = process.env.PORT || 4000;

// ──────────────────────────────────────
// Connection registry
// ──────────────────────────────────────
// Maps userId → { connector: WebSocket, browser: WebSocket }
const connections = new Map();

// ──────────────────────────────────────
// HTTP Server (health check)
// ──────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // Root or /health check for Railway/hosting platforms
  if (pathname === "/" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "healthy",
      service: "DesignFlow Relay",
      connectors: connections.size,
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ──────────────────────────────────────
// WebSocket Server
// ──────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const params = url.parse(req.url, true).query;
  const clientType = params.type; // "connector" or "browser"

  console.log(`🔌 New ${clientType} connection`);

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, clientType, msg);
    } catch (err) {
      console.error("Parse error:", err.message);
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws, clientType);
  });
});

// ──────────────────────────────────────
// Message handlers
// ──────────────────────────────────────
function handleMessage(ws, clientType, msg) {
  switch (msg.type) {

    // ── Registration ──
    case "register_connector": {
      // Desktop connector registering itself
      const sessionKey = msg.sessionKey;
      if (!sessionKey) {
        ws.send(JSON.stringify({ type: "error", message: "No session key provided" }));
        return;
      }

      // Upgrade identification if not already set by URL
      ws.sessionKey = sessionKey;
      ws.clientType = "connector";

      if (!connections.has(sessionKey)) {
        connections.set(sessionKey, { connector: null, browser: null });
      }
      connections.get(sessionKey).connector = ws;

      console.log(`✅ [${sessionKey}] Connector detected and registered`);
      ws.send(JSON.stringify({ type: "registered", status: "ok" }));

      // Notify browser if connected
      const browserWs = connections.get(sessionKey)?.browser;
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({
          type: "connector_status",
          connected: true,
          figma: msg.figmaConnected || false,
        }));
      }
      break;
    }

    case "register_browser": {
      // Browser dashboard registering itself
      const sessionKey = msg.sessionKey;
      if (!sessionKey) {
        ws.send(JSON.stringify({ type: "error", message: "No session key provided" }));
        return;
      }

      // Upgrade identification if not already set by URL
      ws.sessionKey = sessionKey;
      ws.clientType = "browser";

      if (!connections.has(sessionKey)) {
        connections.set(sessionKey, { connector: null, browser: null });
      }
      connections.get(sessionKey).browser = ws;

      console.log(`✅ [${sessionKey}] Browser detected and registered`);

      // Send current connector status
      const connectorWs = connections.get(sessionKey)?.connector;
      ws.send(JSON.stringify({
        type: "connector_status",
        connected: !!(connectorWs && connectorWs.readyState === WebSocket.OPEN),
      }));
      break;
    }

    // ── Figma commands from browser ──
    case "run_figma": {
      const target = connections.get(ws.sessionKey)?.connector;
      if (target && target.readyState === WebSocket.OPEN) {
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        target.send(JSON.stringify({
          type: "run_figma",
          script: msg.script,
          jobId,
        }));
        ws.send(JSON.stringify({ type: "job_created", jobId, target: "figma" }));
        console.log(`📤 Figma script → session [${ws.sessionKey}] connector`);
      } else {
        ws.send(JSON.stringify({
          type: "error",
          message: "Desktop connector not connected. Enter the same session key in the app.",
        }));
      }
      break;
    }

    // ── AE commands from browser ──
    case "run_ae": {
      const target = connections.get(ws.sessionKey)?.connector;
      if (target && target.readyState === WebSocket.OPEN) {
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        target.send(JSON.stringify({
          type: "run_ae",
          script: msg.script,
          jobId,
        }));
        ws.send(JSON.stringify({ type: "job_created", jobId, target: "ae" }));
        console.log(`📤 AE script → session [${ws.sessionKey}] connector`);
      } else {
        ws.send(JSON.stringify({
          type: "error",
          message: "Desktop connector not connected.",
        }));
      }
      break;
    }

    // ── Results from connector back to browser ──
    case "figma_result":
    case "ae_script_detected":
    case "ack":
    case "status_update": {
      const browserWs = connections.get(ws.sessionKey)?.browser;
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify(msg));
      }
      break;
    }

    // ── Heartbeat ──
    case "pong":
      break;

    default:
      console.log(`Unknown message type: ${msg.type} from ${ws.clientType}`);
  }
}

function handleDisconnect(ws, clientType) {
  if (!ws.userId) return;

  const entry = connections.get(ws.userId);
  if (!entry) return;

  if (ws.clientType === "connector") {
    entry.connector = null;
    console.log(`🔴 Connector disconnected: user ${ws.userId}`);

    // Notify browser
    if (entry.browser && entry.browser.readyState === WebSocket.OPEN) {
      entry.browser.send(JSON.stringify({ type: "connector_status", connected: false }));
    }
  } else if (ws.clientType === "browser") {
    entry.browser = null;
    console.log(`🔴 Browser disconnected: user ${ws.userId}`);
  }

  // Clean up if both disconnected
  if (!entry.connector && !entry.browser) {
    connections.delete(ws.userId);
  }
}

// ──────────────────────────────────────
// Auth (stub — replace with real JWT verification)
// ──────────────────────────────────────
function authenticateToken(token) {
  // In production, verify JWT with Supabase/your auth provider
  // For local development, accept any non-empty token as userId
  if (!token) return null;

  // Stub: treat the token itself as the userId
  // REPLACE THIS with real JWT verification:
  //   const { data: { user } } = await supabase.auth.getUser(token);
  //   return user?.id;
  return `user-${token.slice(0, 8)}`;
}

// ──────────────────────────────────────
// Heartbeat (disconnect stale clients)
// ──────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`💀 Terminating stale connection: ${ws.userId || "unknown"}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

// ──────────────────────────────────────
// Start server
// Start the server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   DesignFlow Cloud Relay — LIVE                  │
  │                                                  │
  │   Port      : ${PORT}                                 │
  │                                                  │
  └──────────────────────────────────────────────────┘
  `);
});
