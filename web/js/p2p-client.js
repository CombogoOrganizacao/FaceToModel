/**
 * @fileoverview FaceToModel — Resilient Hybrid P2P & Local WebSocket Client
 *
 * Provides real-time streaming between the visualizer (desktop) and smartphone sensor:
 *   1. Primary: Direct LAN WebSocket (zero latency, 100% offline/local, zero drops)
 *   2. Secondary: Decentralized P2P WebRTC DataChannel (with high-availability relays)
 *
 * @module p2p-client
 */

import { joinRoom } from './trystero-nostr.js';

const APP_ID = 'facetomodel-p2p-v1';

// Top tier high-uptime public relays with fallback
const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.primal.net',
];

export class P2PClient {
  /**
   * @param {string} roomId
   * @param {boolean} isHost - true if Desktop visualizer, false if smartphone sensor
   */
  constructor(roomId, isHost = false) {
    this.roomId = roomId;
    this.isHost = isHost;
    this.room = null;
    this.sendBlendshapesAction = null;
    this.onBlendshapesReceived = null;
    this.onPeerJoinCallback = null;
    this.onPeerLeaveCallback = null;
    this.onPeerStreamCallback = null;
    this.activeStream = null;
    this.connectedPeers = new Set();
    this.localWs = null;
    this._isLocalWsConnected = false;
  }

  connect() {
    console.log(`[P2P] Conectando sala: ${this.roomId} (Host: ${this.isHost})`);

    // 1. Canal Local Direto (LAN WebSocket) — 100% Gratuito, Sem Quedas, 0ms Latência
    this._connectLocalWebSocket();

    // 2. Canal WebRTC P2P Descentralizado
    try {
      this.room = joinRoom({
        appId: APP_ID,
        relayUrls: RELAY_URLS,
        relayConfig: { urls: RELAY_URLS, warnOnRelayFailure: false }
      }, this.roomId);

      const action = this.room.makeAction('blendshapes');
      if (action && typeof action.send === 'function') {
        this.sendBlendshapesAction = (data) => action.send(data);
        action.onMessage = (data, meta) => {
          const peerId = meta?.peerId || 'webrtc-peer';
          if (this.onBlendshapesReceived) {
            this.onBlendshapesReceived(data, peerId);
          }
        };
      } else if (Array.isArray(action)) {
        const [sendData, getData] = action;
        this.sendBlendshapesAction = sendData;
        getData((data, peerId) => {
          if (this.onBlendshapesReceived) {
            this.onBlendshapesReceived(data, peerId);
          }
        });
      }

      const handleJoin = (peerId) => {
        console.log(`[P2P] Dispositivo WebRTC conectado: ${peerId}`);
        this.connectedPeers.add(peerId);
        if (this.activeStream) {
          this.sendStream(this.activeStream);
        }
        if (this.onPeerJoinCallback) this.onPeerJoinCallback(peerId);
      };

      const handleLeave = (peerId) => {
        console.log(`[P2P] Dispositivo WebRTC desconectado: ${peerId}`);
        this.connectedPeers.delete(peerId);
        if (this.onPeerLeaveCallback && this.connectedPeers.size === 0 && !this._isLocalWsConnected) {
          this.onPeerLeaveCallback(peerId);
        }
      };

      if (typeof this.room.onPeerJoin === 'function') {
        this.room.onPeerJoin(handleJoin);
      } else {
        this.room.onPeerJoin = handleJoin;
      }

      if (typeof this.room.onPeerLeave === 'function') {
        this.room.onPeerLeave(handleLeave);
      } else {
        this.room.onPeerLeave = handleLeave;
      }

      const handleStream = (stream, peerId) => {
        console.log(`[P2P] Stream de vídeo recebido: ${peerId}`);
        if (this.onPeerStreamCallback) this.onPeerStreamCallback(stream, peerId);
      };

      if (typeof this.room.onPeerStream === 'function') {
        this.room.onPeerStream(handleStream);
      } else {
        this.room.onPeerStream = handleStream;
      }
    } catch (err) {
      console.warn('[P2P] WebRTC Room init fallback:', err);
    }
  }

  _connectLocalWebSocket() {
    try {
      let host = window.location.hostname || 'localhost';

      // Verifica se o host foi passado explicitamente na URL (ex: #room=xyz&host=192.168.1.4)
      const rawHash = (window.location.hash || '').replace('#', '');
      const hashParams = new URLSearchParams(rawHash.includes('?') ? rawHash.split('?')[1] : rawHash);
      const searchParams = new URLSearchParams(window.location.search);
      const hostParam = hashParams.get('host') || searchParams.get('host');
      if (hostParam && hostParam !== 'localhost') {
        host = hostParam;
      }

      const isSecure = window.location.protocol === 'https:';
      const wsProto = isSecure ? 'wss:' : 'ws:';
      const wsPort = isSecure ? (window.location.port || '3443') : '8080';
      const role = this.isHost ? 'browser' : 'iphone';
      const wsUrl = `${wsProto}//${host}:${wsPort}?role=${role}`;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log(`[P2P/LAN] WebSocket Local conectado com sucesso (${role}) em ${wsUrl}`);
        this._isLocalWsConnected = true;
        if (this.onPeerJoinCallback) this.onPeerJoinCallback('local-lan');
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (this.onBlendshapesReceived) {
            this.onBlendshapesReceived(payload, 'local-lan');
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        this._isLocalWsConnected = false;
      };

      ws.onerror = () => {
        this._isLocalWsConnected = false;
      };

      this.localWs = ws;
    } catch (e) {
      // Local WS not available, WebRTC will handle
    }
  }

  /**
   * Transmite o stream de vídeo da câmera para os peers conectados
   * @param {MediaStream} stream
   */
  sendStream(stream) {
    this.activeStream = stream;
    if (this.room && typeof this.room.addStream === 'function') {
      try {
        this.room.addStream(stream);
      } catch (err) {
        // Ignore duplicate stream warnings
      }
    }
  }

  /**
   * Envia os coeficientes de blendshapes para todos os canais ativos (LAN e WebRTC)
   * @param {Record<string, number>|Float32Array|object} data
   */
  sendBlendshapes(data) {
    // 1. Enviar via WebSocket Local (se conectado)
    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      try {
        this.localWs.send(JSON.stringify(data));
      } catch (_) {}
    }

    // 2. Enviar via WebRTC P2P DataChannel
    if (this.sendBlendshapesAction) {
      try {
        this.sendBlendshapesAction(data).catch?.(() => {});
      } catch (_) {}
    }
  }

  disconnect() {
    if (this.localWs) {
      try { this.localWs.close(); } catch (_) {}
      this.localWs = null;
    }
    if (this.room) {
      try { this.room.leave(); } catch (_) {}
      this.room = null;
      this.connectedPeers.clear();
    }
  }
}
