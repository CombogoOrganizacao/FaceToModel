/**
 * @fileoverview FaceToModel — WebSocket Client
 *
 * Manages the WebSocket connection to the relay server, auto-reconnect with
 * exponential back-off, latency calculation, and status event emission.
 *
 * @module ws-client
 */

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_MS  = 1_000;

/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_MS  = 30_000;

/** Multiplier applied on each successive reconnect failure. */
const BACKOFF_MULTIPLIER = 2;

/* ─── WSClient ──────────────────────────────────────────────────────────── */

/**
 * @typedef {'disconnected'|'connecting'|'connected'|'error'} WSStatus
 */

/**
 * Encapsulates a WebSocket connection to the FaceToModel relay server.
 *
 * Usage:
 * ```js
 * const client = new WSClient('192.168.1.10', 8080,
 *   (data) => renderer.applyBlendShapes(data),
 *   (status, detail) => updateUI(status, detail)
 * );
 * client.connect();
 * ```
 */
export class WSClient {
  /**
   * @param {string}   serverIp       - IP address or hostname of the relay server
   * @param {number}   port           - WebSocket port (default 8080)
   * @param {function(object): void}  onMessage      - Called with parsed JSON payload on each frame
   * @param {function(WSStatus, object=): void} onStatusChange - Called whenever connection status changes
   */
  constructor(serverIp, port, onMessage, onStatusChange) {
    /** @type {string} */
    this.serverIp = serverIp;

    /** @type {number} */
    this.port = port;

    /** @private @type {function(object): void} */
    this._onMessage = onMessage;

    /** @private @type {function(WSStatus, object=): void} */
    this._onStatusChange = onStatusChange;

    /** @private @type {WebSocket|null} */
    this._ws = null;

    /** @private @type {WSStatus} */
    this._status = 'disconnected';

    /** @private @type {number} Current reconnect delay in ms */
    this._reconnectDelay = MIN_RECONNECT_MS;

    /** @private @type {number|null} setTimeout handle */
    this._reconnectTimer = null;

    /** @private @type {boolean} True when disconnect() was called intentionally */
    this._intentionalDisconnect = false;

    /** @type {number|null} Last measured round-trip latency in ms */
    this.latencyMs = null;

    /** @type {number} Frames received per second (updated externally or by the consumer) */
    this.framesReceived = 0;

    /** @private @type {number} Frame count accumulator for fps */
    this._frameCount = 0;

    /** @private @type {number} Timestamp of last fps window start */
    this._fpsWindowStart = performance.now();
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */

  /**
   * Open (or re-open) the WebSocket connection.
   * Safe to call even if already connected — will do nothing in that case.
   */
  connect() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN ||
                     this._ws.readyState === WebSocket.CONNECTING)) {
      return; // already up
    }

    this._intentionalDisconnect = false;
    this._openSocket();
  }

  /**
   * Permanently close the connection and stop all reconnect attempts.
   */
  disconnect() {
    this._intentionalDisconnect = true;
    this._clearReconnectTimer();

    if (this._ws) {
      try { this._ws.close(1000, 'Client disconnected'); } catch (_) {}
      this._ws = null;
    }

    this._setStatus('disconnected');
  }

  /**
   * @returns {WSStatus} Current connection status string
   */
  get status() { return this._status; }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  /**
   * Build the WebSocket URL and attach all event handlers.
   * @private
   */
  _openSocket() {
    let protocol = 'ws:';
    if (window.location.protocol === 'https:' || this.port === 3443 || this.port === 443) {
      protocol = 'wss:';
    }
    const host = this.serverIp || window.location.hostname || 'localhost';
    const port = this.port || (protocol === 'wss:' ? '3443' : '8080');
    const url = `${protocol}//${host}:${port}?role=browser`;

    this._setStatus('connecting');

    try {
      this._ws = new WebSocket(url);
    } catch (err) {
      console.error('[WSClient] Failed to create WebSocket:', err);
      this._setStatus('error', { message: err.message });
      this._scheduleReconnect();
      return;
    }

    /* open */
    this._ws.addEventListener('open', () => {
      console.log(`[WSClient] Connected to ${url}`);
      this._reconnectDelay = MIN_RECONNECT_MS; // reset backoff on success
      this._setStatus('connected');
    });

    /* message */
    this._ws.addEventListener('message', (event) => {
      this._handleRawMessage(event.data);
    });

    /* close */
    this._ws.addEventListener('close', (event) => {
      console.log(`[WSClient] Connection closed (code=${event.code}, reason="${event.reason}")`);
      this._ws = null;
      this._setStatus('disconnected');

      if (!this._intentionalDisconnect) {
        this._scheduleReconnect();
      }
    });

    /* error */
    this._ws.addEventListener('error', (event) => {
      console.error('[WSClient] WebSocket error:', event);
      this._setStatus('error', { message: 'WebSocket error' });
      // close event will follow; reconnect is handled there
    });
  }

  /**
   * Parse a raw message string and dispatch it to the consumer callback.
   * Also calculates approximate relay latency when `serverTimestamp` is present.
   *
   * @private
   * @param {string} raw - JSON string from server
   */
  _handleRawMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn('[WSClient] Could not parse message:', err);
      return;
    }

    // Latency: difference between now and when the server stamped the message
    if (typeof data.serverTimestamp === 'number') {
      this.latencyMs = Date.now() - data.serverTimestamp;
    }

    // Fps tracking
    this._frameCount++;
    const now = performance.now();
    const elapsed = now - this._fpsWindowStart;
    if (elapsed >= 1000) {
      this.framesReceived = Math.round(this._frameCount * (1000 / elapsed));
      this._frameCount = 0;
      this._fpsWindowStart = now;
    }

    // Hand off to consumer
    try {
      this._onMessage(data);
    } catch (err) {
      console.error('[WSClient] onMessage callback threw:', err);
    }
  }

  /**
   * Schedule an auto-reconnect attempt using the current exponential back-off delay.
   * @private
   */
  _scheduleReconnect() {
    if (this._intentionalDisconnect) return;

    console.log(`[WSClient] Reconnecting in ${this._reconnectDelay / 1000}s…`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, this._reconnectDelay);

    // Increase delay for next failure, capped at MAX_RECONNECT_MS
    this._reconnectDelay = Math.min(
      this._reconnectDelay * BACKOFF_MULTIPLIER,
      MAX_RECONNECT_MS,
    );
  }

  /**
   * Cancel any pending reconnect timer.
   * @private
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Update internal status and fire the consumer's status-change callback.
   *
   * @private
   * @param {WSStatus} status
   * @param {object}  [detail] - Optional extra context (e.g. error message)
   */
  _setStatus(status, detail) {
    this._status = status;
    try {
      this._onStatusChange(status, detail);
    } catch (err) {
      console.error('[WSClient] onStatusChange callback threw:', err);
    }
  }
}
