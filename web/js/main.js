/**
 * @fileoverview FaceToModel — Main Orchestrator (Apple HIG & P2P WebRTC)
 *
 * Bootstraps the application:
 *   1. Initializes Three.js 3D Viewport with GLTF + KTX2 support
 *   2. Sets up UI interaction listeners immediately (non-blocking)
 *   3. Generates unique Room ID and renders Apple-style QR Code for instant smartphone pairing
 *   4. Connects P2P WebRTC DataChannel (Trystero)
 *   5. Loads default 3D model in background without blocking UI
 *
 * @module main
 */

import { Renderer } from './renderer.js';
import { P2PClient } from './p2p-client.js';
import { Recorder, formatDuration } from './recorder.js';

/* ─── DOM Helpers ─────────────────────────────────────────────────────────── */

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[main] Element #${id} not found`);
  return el;
}

/* ─── State ───────────────────────────────────────────────────────────────── */

let renderer = null;
let recorder = null;
let p2pClient = null;
let roomId = null;

// Local camera state
let localTracking = false;
let localFaceLandmarker = null;
let localStream = null;
let localVideoEl = null;

/* ─── Init (Non-blocking Bootstrap) ───────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  console.log('[main] Initializing FaceToModel (Apple HIG + P2P)');

  // 1. Setup Canvas & 3D Renderer
  const canvas = /** @type {HTMLCanvasElement} */ ($('main-canvas'));
  renderer = new Renderer(canvas);
  recorder = new Recorder(canvas);
  renderer.startLoop();

  // 2. Setup All UI Event Listeners Immediately (Ensures buttons work instantly)
  setupUI();

  // 3. FPS Counter
  setInterval(() => {
    $('fps-counter').textContent = `${renderer.fps} FPS`;
  }, 500);

  // 4. Generate Unique Room & QR Code
  initP2PRoom();

  // 5. Load Default 3D Model in Background
  loadModel('/models/facecap.glb', 'facecap.glb');
});

/* ─── P2P & QR Code Setup ─────────────────────────────────────────────────── */

function initP2PRoom() {
  // Gerar ID de sala único de 6 caracteres
  roomId = Math.random().toString(36).substring(2, 8);
  $('room-code-label').textContent = `SALA: ${roomId.toUpperCase()}`;

  // Criar URL completa para o smartphone
  const baseUrl = window.location.origin;
  const cameraUrl = `${baseUrl}/camera.html#room=${roomId}`;
  console.log('[main] URL da Câmera para QR Code:', cameraUrl);

  // Desenhar QR Code no container do modal
  const qrTarget = $('qr-target');
  qrTarget.innerHTML = '';

  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(qrTarget, {
        text: cameraUrl,
        width: 176,
        height: 176,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      // Fallback para API de imagem de QR Code
      const qrImg = document.createElement('img');
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=${encodeURIComponent(cameraUrl)}`;
      qrImg.alt = 'QR Code de Pareamento';
      qrTarget.appendChild(qrImg);
    }
  } catch (err) {
    console.error('Erro ao gerar QR Code, usando fallback:', err);
    const qrImg = document.createElement('img');
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=${encodeURIComponent(cameraUrl)}`;
    qrTarget.appendChild(qrImg);
  }

  // Inicializar Cliente P2P no Mac (Host)
  p2pClient = new P2PClient(roomId, true);
  
  p2pClient.onPeerJoinCallback = () => {
    $('hud-dot').className = 'hud-dot active';
    $('hud-text').textContent = 'Smartphone Conectado ✓';
    $('p2p-status-sub').textContent = 'Smartphone conectado em tempo real';
    $('p2p-status-sub').style.color = 'var(--sys-green)';
    closeQRModal();
  };

  p2pClient.onPeerLeaveCallback = () => {
    $('hud-dot').className = 'hud-dot';
    $('hud-text').textContent = 'Aguardando Sensor';
    $('p2p-status-sub').textContent = 'Escanear QR Code com a câmera';
    $('p2p-status-sub').style.color = 'var(--label-secondary)';
  };

  p2pClient.onBlendshapesReceived = (blendShapes) => {
    renderer.applyBlendShapes(blendShapes);
  };

  p2pClient.connect();
}

/* ─── UI Interactions ─────────────────────────────────────────────────────── */

function setupUI() {
  // Modal QR Code
  $('btn-open-qr').addEventListener('click', () => openQRModal());
  $('btn-close-modal').addEventListener('click', () => closeQRModal());
  $('modal-qr').addEventListener('click', (e) => {
    if (e.target === $('modal-qr')) closeQRModal();
  });

  // Carregar Modelo 3D
  const fileInput = $('file-input-model');
  $('btn-choose-model').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    await loadModel(url, file.name);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    fileInput.value = '';
  });

  // Controles de Visualização
  $('chk-wireframe').addEventListener('change', (e) => {
    renderer.setWireframe(e.target.checked);
  });
  $('btn-reset-view').addEventListener('click', () => renderer.resetCamera());

  // Câmera Local Mac
  $('btn-toggle-local-cam').addEventListener('click', () => toggleLocalCamera());

  // Gravação de Vídeo
  setupRecording();
}

function openQRModal() {
  $('modal-qr').classList.add('open');
}

function closeQRModal() {
  $('modal-qr').classList.remove('open');
}

/* ─── Local Webcam Tracking ───────────────────────────────────────────────── */

async function toggleLocalCamera() {
  const badge = $('local-cam-badge');
  const title = $('local-cam-title');

  if (localTracking) {
    stopLocalCamera();
    badge.textContent = 'Ativar';
    badge.style.color = 'var(--label-secondary)';
    title.textContent = 'Câmera deste Mac';
    $('hud-dot').className = 'hud-dot';
    $('hud-text').textContent = 'Aguardando Sensor';
  } else {
    badge.textContent = 'Iniciando...';
    try {
      await startLocalCamera();
      badge.textContent = 'Ativa ✓';
      badge.style.color = 'var(--sys-green)';
      title.textContent = 'Câmera do Mac (Ativa)';
      $('hud-dot').className = 'hud-dot active';
      $('hud-text').textContent = 'Câmera Local Ativa';
    } catch (err) {
      console.error('Erro na câmera local:', err);
      badge.textContent = 'Erro';
      badge.style.color = 'var(--sys-red)';
      alert('Não foi possível iniciar a câmera local: ' + err.message);
    }
  }
}

async function startLocalCamera() {
  if (!window.vision) {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    window.vision = vision;
  }
  const { FilesetResolver, FaceLandmarker } = window.vision;

  const filesetResolver = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );

  localFaceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU'
    },
    outputFaceBlendshapes: true,
    runningMode: 'VIDEO',
    numFaces: 1
  });

  localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  localVideoEl = document.createElement('video');
  localVideoEl.autoplay = true;
  localVideoEl.playsInline = true;
  localVideoEl.muted = true;
  localVideoEl.srcObject = localStream;
  await localVideoEl.play();

  localTracking = true;
  runLocalLoop();
}

function stopLocalCamera() {
  localTracking = false;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (localVideoEl) {
    localVideoEl.srcObject = null;
    localVideoEl = null;
  }
}

let lastLocalTime = -1;
function runLocalLoop() {
  if (!localTracking || !localVideoEl) return;

  if (localVideoEl.currentTime !== lastLocalTime && localFaceLandmarker) {
    lastLocalTime = localVideoEl.currentTime;
    const results = localFaceLandmarker.detectForVideo(localVideoEl, performance.now());
    if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
      const blendShapesMap = {};
      for (const shape of results.faceBlendshapes[0].categories) {
        blendShapesMap[shape.categoryName] = shape.score;
      }
      renderer.applyBlendShapes(blendShapesMap);
    }
  }
  requestAnimationFrame(runLocalLoop);
}

/* ─── Recording ───────────────────────────────────────────────────────────── */

function setupRecording() {
  const shutter = $('btn-shutter');
  const label = $('record-label');
  const timer = $('record-timer');
  const btnDownload = $('btn-download-video');
  const canvas = $('main-canvas');

  shutter.addEventListener('click', async () => {
    if (!recorder.isRecording) {
      try {
        await recorder.startRecording();
        shutter.classList.add('recording');
        label.textContent = 'Parar Gravação';
        btnDownload.style.display = 'none';
      } catch (err) {
        alert('Erro ao iniciar gravação: ' + err.message);
      }
    } else {
      const url = await recorder.stopRecording();
      shutter.classList.remove('recording');
      label.textContent = 'Iniciar Gravação';
      timer.textContent = '';
      if (url) {
        btnDownload.style.display = 'flex';
      }
    }
  });

  canvas.addEventListener('durationupdate', (e) => {
    timer.textContent = formatDuration(e.detail.seconds);
  });

  btnDownload.addEventListener('click', () => {
    const lastUrl = recorder.getLastRecordingURL();
    const ext = lastUrl?.includes('mp4') ? 'mp4' : 'webm';
    recorder.downloadRecording(`facetomodel-capture-${Date.now()}.${ext}`);
  });
}

/* ─── Model Loader (Resilient Background Load) ────────────────────────────── */

async function loadModel(url, filename) {
  $('model-name').textContent = 'Carregando...';
  $('model-coverage').textContent = 'Analisando morph targets';

  try {
    await renderer.loadModel(url);
    const coverage = renderer.blendshapeCoverage;
    $('model-name').textContent = filename;
    $('model-coverage').textContent = `${coverage} / 52 blendshapes mapeados`;
  } catch (err) {
    console.error('Erro ao carregar modelo 3D:', err);
    $('model-name').textContent = filename;
    $('model-coverage').textContent = 'Pronto para uso';
  }
}
