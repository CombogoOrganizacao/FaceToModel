/**
 * @fileoverview FaceToModel — Main Orchestrator (Apple HIG & P2P WebRTC)
 *
 * Bootstraps the application:
 *   1. Initializes Three.js 3D Viewport with GLTF + KTX2 + EMA Lerp smoothing
 *   2. Sets up UI interaction listeners immediately (non-blocking)
 *   3. Generates unique Room ID and renders Apple-style QR Code for instant smartphone pairing
 *   4. Connects P2P WebRTC DataChannel (Trystero) with 3DoF head rotation support
 *   5. Loads default 3D model in background without blocking UI
 *   6. Handles Drag & Drop 3D model loading (.glb / .gltf)
 *   7. Video recording preview modal & Apple toast notifications
 *   8. Real-time telemetry inspector for active facial blendshapes
 *
 * @module main
 */

import { P2PClient } from './p2p-client.js';
import { Recorder, formatDuration } from './recorder.js';

/* ─── DOM Helpers ─────────────────────────────────────────────────────────── */

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[main] Element #${id} not found`);
  return el;
}

/* ─── Apple Toast Notifications ───────────────────────────────────────────── */

export function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-12px) scale(0.95)';
    setTimeout(() => toast.remove(), 350);
  }, 3200);
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

function bootstrap() {
  console.log('[main] Initializing FaceToModel (Apple HIG + P2P)');

  // 1. Setup UI event listeners FIRST (guarantees buttons always work immediately)
  try {
    setupUI();
    setupDragAndDrop();
  } catch (uiErr) {
    console.error('[main] Erro ao registrar UI:', uiErr);
  }

  // 2. Setup P2P & QR Code (runs independently of 3D)
  try {
    initP2PRoom();
  } catch (p2pErr) {
    console.error('[main] Erro ao inicializar P2P:', p2pErr);
  }

  // 3. Setup Canvas & 3D WebGL Renderer (dynamic import for bulletproof browser compatibility)
  init3DEngine();
}

async function init3DEngine() {
  try {
    const { Renderer } = await import('./renderer.js');
    const canvas = /** @type {HTMLCanvasElement} */ ($('main-canvas'));
    renderer = new Renderer(canvas);
    recorder = new Recorder(canvas);
    renderer.startLoop();
    startInspectorLoop();

    // 4. FPS Counter
    setInterval(() => {
      if (renderer) {
        $('fps-counter').textContent = `${renderer.fps} FPS`;
      }
    }, 500);

    // 5. Load Default 3D Model in Background
    loadModel('/models/facecap.glb', 'facecap.glb');
  } catch (renderErr) {
    console.error('[main] Erro ao inicializar Renderer 3D:', renderErr);
    showToast('Aviso ao iniciar acelerador 3D: ' + renderErr.message, 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

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
    showToast('Smartphone conectado em tempo real!', 'success');
  };

  p2pClient.onPeerLeaveCallback = () => {
    $('hud-dot').className = 'hud-dot';
    $('hud-text').textContent = 'Aguardando Sensor';
    $('p2p-status-sub').textContent = 'Escanear QR Code com a câmera';
    $('p2p-status-sub').style.color = 'var(--label-secondary)';
    showToast('Smartphone desconectado', 'info');
  };

  // Suporte a dados avançados { blendShapes, rotation }
  p2pClient.onBlendshapesReceived = (data) => {
    if (data && data.blendShapes) {
      renderer.applyBlendShapes(data.blendShapes, data.rotation);
    } else if (data) {
      renderer.applyBlendShapes(data, null);
    }
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
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    fileInput.value = '';
  });

  // Controles de Visualização
  $('chk-wireframe').addEventListener('change', (e) => {
    if (renderer) renderer.setWireframe(e.target.checked);
  });
  $('btn-reset-view').addEventListener('click', () => {
    if (renderer) renderer.resetCamera();
    showToast('Câmera redefinida', 'info');
  });

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

/* ─── Drag & Drop 3D Model (.glb / .gltf) ──────────────────────────────────── */

function setupDragAndDrop() {
  const dropOverlay = $('drag-overlay');
  let dragCounter = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('active');
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('active');

    const file = e.dataTransfer?.files?.[0];
    if (file && (file.name.toLowerCase().endsWith('.glb') || file.name.toLowerCase().endsWith('.gltf'))) {
      const url = URL.createObjectURL(file);
      await loadModel(url, file.name);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } else if (file) {
      showToast('Formato não suportado. Use arquivos .glb ou .gltf', 'error');
    }
  });
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
    showToast('Câmera local desativada', 'info');
  } else {
    badge.textContent = 'Iniciando...';
    try {
      await startLocalCamera();
      badge.textContent = 'Ativa ✓';
      badge.style.color = 'var(--sys-green)';
      title.textContent = 'Câmera do Mac (Ativa)';
      $('hud-dot').className = 'hud-dot active';
      $('hud-text').textContent = 'Câmera Local Ativa';
      showToast('Câmera do Mac ativada com sucesso', 'success');
    } catch (err) {
      console.error('Erro na câmera local:', err);
      badge.textContent = 'Erro';
      badge.style.color = 'var(--sys-red)';
      showToast('Não foi possível iniciar a câmera local: ' + err.message, 'error');
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
    outputFacialTransformationMatrixes: true,
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

      // Rotação 3DoF
      let rotation = null;
      if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
        const m = results.facialTransformationMatrixes[0].data;
        const pitch = Math.atan2(m[6], m[10]);
        const yaw   = Math.atan2(-m[2], Math.sqrt(m[6] * m[6] + m[10] * m[10]));
        const roll  = Math.atan2(m[1], m[0]);
        rotation = { pitch: -pitch * 0.75, yaw: yaw * 0.75, roll: -roll * 0.75 };
      }

      renderer.applyBlendShapes(blendShapesMap, rotation);
    }
  }
  requestAnimationFrame(runLocalLoop);
}

/* ─── Recording with Native Video Preview Modal ───────────────────────────── */

function setupRecording() {
  const shutter = $('btn-shutter');
  const label = $('record-label');
  const timer = $('record-timer');
  const canvas = $('main-canvas');
  const previewModal = $('modal-video-preview');
  const videoPlayer = /** @type {HTMLVideoElement} */ ($('preview-video-player'));
  const btnSave = $('btn-save-recording');
  const btnDiscard = $('btn-discard-recording');
  const durationLabel = $('preview-duration-label');

  let currentVideoUrl = null;

  shutter.addEventListener('click', async () => {
    if (!recorder) {
      showToast('Acelerador 3D inicializando...', 'info');
      return;
    }
    if (!recorder.isRecording) {
      try {
        await recorder.startRecording();
        shutter.classList.add('recording');
        label.textContent = 'Parar Gravação';
        showToast('Gravação iniciada', 'info');
      } catch (err) {
        showToast('Erro ao iniciar gravação: ' + err.message, 'error');
      }
    } else {
      const url = await recorder.stopRecording();
      shutter.classList.remove('recording');
      label.textContent = 'Iniciar Gravação';
      const dur = timer.textContent;
      timer.textContent = '';

      if (url) {
        currentVideoUrl = url;
        videoPlayer.src = url;
        durationLabel.textContent = dur || '00:00';
        previewModal.classList.add('open');
        videoPlayer.play().catch(() => {});
      }
    }
  });

  canvas.addEventListener('durationupdate', (e) => {
    timer.textContent = formatDuration(e.detail.seconds);
  });

  btnSave.addEventListener('click', () => {
    if (currentVideoUrl) {
      const ext = currentVideoUrl.includes('mp4') ? 'mp4' : 'webm';
      recorder.downloadRecording(`FaceToModel_Gravacao_${Date.now()}.${ext}`);
      showToast('Download do vídeo iniciado!', 'success');
    }
    previewModal.classList.remove('open');
    videoPlayer.pause();
  });

  btnDiscard.addEventListener('click', () => {
    previewModal.classList.remove('open');
    videoPlayer.pause();
    videoPlayer.src = '';
    currentVideoUrl = null;
    showToast('Gravação descartada', 'info');
  });

  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) {
      previewModal.classList.remove('open');
      videoPlayer.pause();
    }
  });
}

/* ─── Real-time Live Expression Inspector ─────────────────────────────────── */

function startInspectorLoop() {
  const container = $('inspector-container');
  const emptyEl = $('inspector-empty');
  if (!container) return;

  const friendlyNames = {
    eyeBlinkLeft: 'Piscar Olho (E)',
    eyeBlinkRight: 'Piscar Olho (D)',
    jawOpen: 'Abertura da Boca',
    mouthSmileLeft: 'Sorriso (E)',
    mouthSmileRight: 'Sorriso (D)',
    browInnerUp: 'Elevar Sobrancelha',
    browDownLeft: 'Franzir Sobrancelha (E)',
    browDownRight: 'Franzir Sobrancelha (D)',
    mouthFunnel: 'Boca Funil (O)',
    mouthPucker: 'Bico (U)',
    cheekPuff: 'Inflar Bochechas'
  };

  setInterval(() => {
    if (!renderer) return;
    const active = renderer.getActiveBlendshapes(4);

    if (active.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      const oldRows = container.querySelectorAll('.inspector-row');
      oldRows.forEach(r => r.remove());
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    let html = '';
    for (const item of active) {
      const label = friendlyNames[item.name] || item.name;
      const pct = Math.round(item.value * 100);
      html += `
        <div class="inspector-row">
          <div class="inspector-meta">
            <span>${label}</span>
            <span style="font-family: var(--font-mono);">${pct}%</span>
          </div>
          <div class="inspector-track">
            <div class="inspector-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }

    const currentRows = container.querySelectorAll('.inspector-row');
    currentRows.forEach(r => r.remove());
    container.insertAdjacentHTML('beforeend', html);
  }, 100);
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
    showToast(`Modelo "${filename}" pronto! (${coverage}/52 blendshapes)`, 'success');
  } catch (err) {
    console.error('Erro ao carregar modelo 3D:', err);
    $('model-name').textContent = filename;
    $('model-coverage').textContent = 'Pronto para uso';
    showToast(`Erro ao carregar modelo: ${err.message}`, 'error');
  }
}
