/**
 * @fileoverview FaceToModel — P2P WebRTC Client via Trystero
 *
 * Provides real-time, serverless peer-to-peer data channel streaming
 * between the Mac desktop visualizer and the iPhone Safari camera sensor.
 *
 * @module p2p-client
 */

import { joinRoom } from 'https://cdn.jsdelivr.net/npm/trystero@0.20.0/nostr.js';

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
    this.connectedPeers = new Set();
  }

  connect() {
    console.log(`[P2P] Entrando na sala: ${this.roomId} (Host: ${this.isHost})`);
    
    // Conecta na sala descentralizada Nostr (signaling sem servidor próprio)
    this.room = joinRoom({ appId: APP_ID }, this.roomId);

    // Canal binário ultrarrápido para blendshapes (Float32Array)
    const [sendData, getData] = this.room.makeAction('blendshapes');
    this.sendBlendshapesAction = sendData;

    getData((data, peerId) => {
      if (this.onBlendshapesReceived) {
        this.onBlendshapesReceived(data, peerId);
      }
    });

    this.room.onPeerJoin((peerId) => {
      console.log(`[P2P] Dispositivo conectado: ${peerId}`);
      this.connectedPeers.add(peerId);
      if (this.onPeerJoinCallback) this.onPeerJoinCallback(peerId);
    });

    this.room.onPeerLeave((peerId) => {
      console.log(`[P2P] Dispositivo desconectado: ${peerId}`);
      this.connectedPeers.delete(peerId);
      if (this.onPeerLeaveCallback) this.onPeerLeaveCallback(peerId);
    });
  }

  /**
   * Envia os coeficientes de blendshapes para todos os peers conectados
   * @param {Record<string, number>|Float32Array} data
   */
  sendBlendshapes(data) {
    if (this.sendBlendshapesAction && this.connectedPeers.size > 0) {
      this.sendBlendshapesAction(data);
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
