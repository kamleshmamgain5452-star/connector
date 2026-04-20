# DesignFlow Desktop Connector

> The bridge between your cloud dashboard and local design tools (Figma + After Effects)

---

## What This Does

```
DesignFlow Website (cloud)
        ↕ WSS (internet)
Cloud Relay Server (cloud-relay.js)
        ↕ WSS (internet)
Desktop Connector (this Electron app)
        ├── WS → Figma Plugin (localhost:3003)
        └── File System → AE Watcher (ae-scripts/)
```

When you click "Push to Figma" on the website, the command flows through the cloud relay → desktop connector → Figma plugin, all in under 200ms.

---

## Project Structure

```
designflow-connector/
├── main.js              # Electron main process (window, tray, IPC)
├── preload.js           # Secure bridge between main and renderer
├── bridge/
│   └── bridge-manager.js  # Core: cloud WS + local WS + AE watcher
├── renderer/
│   └── index.html        # Desktop app UI
├── cloud-relay.js        # Cloud server (deploy separately)
├── package.json
└── README.md
```

---

## How to Run Locally

### 1. Install Dependencies

```bash
cd ~/Downloads/designflow-connector
npm install
```

### 2. Start the Cloud Relay (simulates cloud backend)

```bash
# In terminal tab 1
node cloud-relay.js
```

You should see:
```
╔════════════════════════════════════════════╗
║    DesignFlow Cloud Relay Server           ║
╠════════════════════════════════════════════╣
║  WebSocket : ws://localhost:4000           ║
║  Health    : http://localhost:4000/health  ║
╚════════════════════════════════════════════╝
```

### 3. Start the Desktop Connector

```bash
# In terminal tab 2
npm start
```

This opens the Electron desktop app. Enter a **Session Key** (e.g. `my-project`) to connect to the cloud relay.

### 4. Run the Figma Plugin

Open Figma → Plugins → Development → DesignAgent

The plugin connects to `ws://localhost:3003` (served by the connector).

### 5. Run the DesignFlow Website

```bash
# In terminal tab 3
cd ~/Downloads/designflow
npm run dev
```

Go to the dashboard and enter the **SAME Session Key** (`my-project`) in the sidebar to sync.

---

## Full Local Stack

| Terminal | Command | Port |
|----------|---------|------|
| Tab 1 | `node cloud-relay.js` | 4000 (cloud relay) |
| Tab 2 | `npm start` (connector) | 3003 (local Figma WS) |
| Tab 3 | `npm run dev` (website) | 3000 (web frontend) |
| Figma | Run DesignAgent plugin | connects to :3003 |
| AE | DesignAgent_Watcher panel | watches ae-scripts/ |

---

## For Production Deployment

### Cloud Relay
Deploy `cloud-relay.js` to any Node.js host (Railway, Render, AWS EC2, etc.):
```bash
# .env
PORT=4000
```

### Desktop Connector
Build distributable with electron-builder:
```bash
# Mac
npm run build:mac

# Windows
npm run build:win

# Both
npm run build:all
```

Output goes to `dist/` folder.

### Update Cloud URL
In the Electron app settings (stored in `electron-store`), set:
```
cloudUrl: wss://api.designflow.io/connector
```

### Auth
Replace the `authenticateToken()` stub in `cloud-relay.js` with real JWT verification from Supabase:
```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function authenticateToken(token) {
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.id || null;
}
```
