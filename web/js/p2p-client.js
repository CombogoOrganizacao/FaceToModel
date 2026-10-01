/**
 * @fileoverview FaceToModel — P2P WebRTC Client via Trystero
 *
 * Provides real-time, serverless peer-to-peer data channel streaming
 * between the Mac desktop visualizer and the iPhone Safari camera sensor.
 *
 * @module p2p-client
 */

import { joinRoom } from './trystero-nostr.js';

const APP_ID = 'facetomodel-p2p-v1';

export class P2PClient {
  /**
   * @param {string} roomId
   * @param {boolean} isHost - true if Desktop Mac receiver, false if iPhone sensor
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
    this.connectedPeers = new Set();
  }

  connect() {
    console.log(`[P2P] Entrando na sala: ${this.roomId} (Host: ${this.isHost})`);
    
    // Conecta na sala descentralizada Nostr (signaling sem servidor próprio)
    this.room = joinRoom({ appId: APP_ID }, this.roomId);

    // Canal ultrarrápido para blendshapes
    const action = this.room.makeAction('blendshapes');
    if (action && typeof action.send === 'function') {
      this.sendBlendshapesAction = (data) => action.send(data);
      action.onMessage = (data, meta) => {
        const peerId = meta?.peerId || null;
        if (this.onBlendshapesReceived) {
          this.onBlendshapesReceived(data, peerId);
        }
      };
    } else if (Array.isArray(action)) {
      // Fallback para versões legadas em tupla [send, get]
      const [sendData, getData] = action;
      this.sendBlendshapesAction = sendData;
      getData((data, peerId) => {
        if (this.onBlendshapesReceived) {
          this.onBlendshapesReceived(data, peerId);
        }
      });
    }

    const handleJoin = (peerId) => {
      console.log(`[P2P] Dispositivo conectado: ${peerId}`);
      this.connectedPeers.add(peerId);
      if (this.onPeerJoinCallback) this.onPeerJoinCallback(peerId);
    };

    const handleLeave = (peerId) => {
      console.log(`[P2P] Dispositivo desconectado: ${peerId}`);
      this.connectedPeers.delete(peerId);
      if (this.onPeerLeaveCallback) this.onPeerLeaveCallback(peerId);
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
      console.log(`[P2P] Vídeo recebido do peer: ${peerId}`);
      if (this.onPeerStreamCallback) this.onPeerStreamCallback(stream, peerId);
    };

    if (typeof this.room.onPeerStream === 'function') {
      this.room.onPeerStream(handleStream);
    } else {
      this.room.onPeerStream = handleStream;
    }
  }

  /**
   * Transmite o stream de vídeo da câmera para os peers conectados
   * @param {MediaStream} stream
   */
  sendStream(stream) {
    if (this.room && typeof this.room.addStream === 'function') {
      try {
        this.room.addStream(stream);
      } catch (err) {
        console.warn('[P2P] Erro ao enviar stream de vídeo:', err);
      }
    }
  }

  /**
   * Envia os coeficientes de blendshapes para todos os peers conectados
   * @param {Record<string, number>|Float32Array} data
   */
  sendBlendshapes(data) {
    if (this.sendBlendshapesAction) {
      this.sendBlendshapesAction(data).catch?.(() => {});
    }
  }

  disconnect() {
    if (this.room) {
      this.room.leave();
      this.room = null;
      this.connectedPeers.clear();
    }
  }
}
