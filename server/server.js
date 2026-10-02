/**
 * @fileoverview FaceToModel — Node.js WebSocket Relay + Static File Server
 *
 * Architecture:
 *   - express serves the /web folder as static files on port 3000
 *   - ws handles WebSocket connections on port 8080
 *   - Smartphone sensor connects as role=iphone (or web client) and streams 52 blendshape floats as JSON
 *   - Browser clients connect as role=browser and receive every frame relayed from any sensor
 *   - Each relayed message gets a server-side timestamp injected for latency measurement
 *
 * @module server
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

/* ─── Configuration ────────────────────────────────────────────────────── */

const HTTP_PORT  = process.env.HTTP_PORT  || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const WS_PORT    = process.env.WS_PORT    || 8080;
const WEB_DIR    = path.resolve(__dirname, '..', 'web');

/* ─── Express / Static Server ──────────────────────────────────────────── */

const app = express();

// CORS headers — allow all origins so any local device can reach the API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Serve web/ as the document root with immediate revalidation for models/scripts
app.use(express.static(WEB_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.includes('/models/') || filePath.includes('/js/') || filePath.includes('/css/')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Helper to discover the host machine's Wi-Fi / LAN IP address
function getLocalIpAddress() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  for (const dev in ifaces) {
    for (const details of ifaces[dev]) {
      if (details.family === 'IPv4' && !details.internal && !details.address.startsWith('169.254')) {
        return details.address;
      }
    }
  }
  return 'localhost';
}

// API endpoint for automatic local Wi-Fi IP discovery (QR Code pairing)
app.get('/api/info', (_req, res) => {
  const localIp = getLocalIpAddress();
  res.json({
    localIp,
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    wsPort: WS_PORT,
    cameraUrl: `http://${localIp}:${HTTP_PORT}/camera.html`,
    cameraHttpsUrl: `https://${localIp}:${HTTPS_PORT}/camera.html`,
  });
});

// Catch-all → index.html (SPA support)
app.get('*', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

const httpServer = http.createServer(app);

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log('info', `HTTP   ▶  http://0.0.0.0:${HTTP_PORT}  (serving ${WEB_DIR})`);
});

// HTTPS Server for Safari iOS Camera Support
let httpsServer = null;
try {
  const keyPath  = path.join(__dirname, 'key.pem');
  const certPath = path.join(__dirname, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const credentials = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    httpsServer = https.createServer(credentials, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      log('info', `HTTPS  ▶  https://0.0.0.0:${HTTPS_PORT}  (Safari iPhone Direct Support)`);
    });
  }
} catch (e) {
  log('warn', `Could not start HTTPS server: ${e.message}`);
}

/* ─── WebSocket Server ─────────────────────────────────────────────────── */

/** @type {Set<WebSocket>} All connected browser clients */
const browserClients = new Set();

/** @type {Set<WebSocket>} All connected iPhone / Smartphone sensor clients */
const iphoneClients  = new Set();

const wss = new WebSocketServer({ noServer: true });
const standaloneWss = new WebSocketServer({ port: WS_PORT });

log('info', `WS     ▶  ws://0.0.0.0:${WS_PORT} (and over HTTP/HTTPS ports)`);

function handleWsUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

httpServer.on('upgrade', handleWsUpgrade);
if (httpsServer) {
  httpsServer.on('upgrade', handleWsUpgrade);
}

function handleWsConnection(ws, req) {
  const url    = new URL(req.url, `ws://localhost:${WS_PORT}`);
  const role   = url.searchParams.get('role') || 'unknown';
  const remote = req.socket.remoteAddress;

  log('conn', `[${role.toUpperCase()}] connected from ${remote}`);

  if (role === 'iphone') {
    iphoneClients.add(ws);
    broadcastStatus();

    ws.on('message', (raw) => {
      handleIphoneMessage(raw);
    });

    ws.on('close', () => {
      iphoneClients.delete(ws);
      log('disc', `[IPHONE] disconnected from ${remote}  (${iphoneClients.size} remaining)`);
      broadcastStatus();
    });

    ws.on('error', (err) => {
      log('error', `[IPHONE] socket error from ${remote}: ${err.message}`);
    });

  } else if (role === 'browser') {
    browserClients.add(ws);
    broadcastStatus();

    safeSend(ws, JSON.stringify({
      type: 'server_hello',
      serverTimestamp: Date.now(),
      iphoneCount: iphoneClients.size,
    }));

    ws.on('close', () => {
      browserClients.delete(ws);
      log('disc', `[BROWSER] disconnected from ${remote}  (${browserClients.size} remaining)`);
    });

    ws.on('error', (err) => {
      log('error', `[BROWSER] socket error from ${remote}: ${err.message}`);
    });

  } else {
    log('warn', `[UNKNOWN] role="${role}" from ${remote} — closing`);
    ws.close(1008, 'Unknown role. Use ?role=iphone or ?role=browser');
  }
}

wss.on('connection', handleWsConnection);
standaloneWss.on('connection', handleWsConnection);

wss.on('error', (err) => {
  log('error', `WebSocketServer error: ${err.message}`);
});

/* ─── Message Relay ────────────────────────────────────────────────────── */

/**
 * Parse and relay an iPhone blendshape payload to all connected browsers.
 * Injects a `serverTimestamp` for round-trip latency calculation in the client.
 *
 * Expected payload format from Smartphone sensor:
 * ```json
 * { "browDownLeft": 0.12, "jawOpen": 0.45, ... }
 * ```
 *
 * @param {Buffer|string} raw - Raw WebSocket message from iPhone client
 */
function handleIphoneMessage(raw) {
  if (browserClients.size === 0) return; // no receivers — skip parsing

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log('warn', `Could not parse iPhone message: ${e.message}`);
    return;
  }

  // Inject server-side timestamp so browsers can measure relay latency
  parsed.serverTimestamp = Date.now();

  const relayed = JSON.stringify(parsed);

  let delivered = 0;
  for (const browser of browserClients) {
    if (browser.readyState === WebSocket.OPEN) {
      safeSend(browser, relayed);
      delivered++;
    }
  }

  // Verbose debug (comment out for production)
  // log('data', `Relayed frame to ${delivered}/${browserClients.size} browsers`);
}

/* ─── Status Broadcast ─────────────────────────────────────────────────── */

/**
 * Notify all browser clients whenever the iPhone connection count changes.
 * Browsers use this to update their "source active" UI indicator.
 */
function broadcastStatus() {
  if (browserClients.size === 0) return;

  const msg = JSON.stringify({
    type: 'status',
    serverTimestamp: Date.now(),
    iphoneCount: iphoneClients.size,
    browserCount: browserClients.size,
  });

  for (const browser of browserClients) {
    if (browser.readyState === WebSocket.OPEN) {
      safeSend(browser, msg);
    }
  }
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Send a message to a WebSocket client, swallowing any errors.
 *
 * @param {WebSocket} ws
 * @param {string}    data
 */
function safeSend(ws, data) {
  try {
    ws.send(data);
  } catch (err) {
    log('error', `safeSend failed: ${err.message}`);
  }
}

/**
 * Formatted console logger with timestamp and colour-coded level.
 *
 * @param {'info'|'conn'|'disc'|'data'|'warn'|'error'} level
 * @param {string} message
 */
function log(level, message) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);

  const colours = {
    info:  '\x1b[36m',  // cyan
    conn:  '\x1b[32m',  // green
    disc:  '\x1b[33m',  // yellow
    data:  '\x1b[90m',  // dark grey
    warn:  '\x1b[93m',  // bright yellow
    error: '\x1b[31m',  // red
  };

  const reset = '\x1b[0m';
  const colour = colours[level] || '';
  const label  = level.toUpperCase().padEnd(5);

  console.log(`${colour}[${ts}] ${label}${reset} ${message}`);
}

/* ─── Graceful Shutdown ────────────────────────────────────────────────── */

/**
 * Close all WebSocket connections and stop the HTTP server cleanly.
 */
function shutdown() {
  log('info', 'Shutting down gracefully…');

  for (const ws of [...browserClients, ...iphoneClients]) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) {}
  }

  wss.close(() => {
    httpServer.close(() => {
      log('info', 'All servers closed. Goodbye!');
      process.exit(0);
    });
  });

  // Force exit after 5 s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
