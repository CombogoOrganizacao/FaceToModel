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
import { MotionTimeline } from './motion-timeline.js';

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
let motionTimeline = null;
let p2pClient = null;
let roomId = null;

// Local camera & media state
let localTracking = false;
let localFaceLandmarker = null;
let localStream = null;
let localVideoEl = null;
let selectedCameraDeviceId = null;
let selectedAudioDeviceId = null;
let currentBgImageUrl = null;

/* ─── Init (Non-blocking Bootstrap) ───────────────────────────────────────── */

function bootstrap() {
  console.log('[main] Initializing FaceToModel (Apple HIG + P2P)');

  // 1. Setup UI event listeners FIRST (guarantees buttons always work immediately)
  try {
    setupUI();
    setupDragAndDrop();
    setupDrawer();
    setupAccordions();
    setupModelPresets();
    setupShading();
    setupBackground();
    setupPiP();
    setupMediaDevices();
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
    setupTimeline();

    // 4. Sensor HUD & FPS Counter
    setInterval(() => {
      const fps = renderer ? renderer.fps : 0;
      updateSensorHud(fps);
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
    updateSensorHud(renderer ? renderer.fps : 0);
    $('p2p-status-sub').textContent = 'Smartphone conectado em tempo real';
    $('p2p-status-sub').style.color = 'var(--sys-green)';
    closeQRModal();
    showToast('Smartphone conectado em tempo real!', 'success');
  };

  p2pClient.onPeerLeaveCallback = () => {
    updateSensorHud(renderer ? renderer.fps : 0);
    $('p2p-status-sub').textContent = 'Escanear QR Code com a câmera';
    $('p2p-status-sub').style.color = 'var(--label-secondary)';
    
    // PiP status update
    $('pip-dot').className = 'pip-dot';
    $('pip-empty').style.display = 'flex';
    $('pip-empty').textContent = 'Smartphone desconectado';
    showToast('Smartphone desconectado', 'info');
  };

  // Suporte a dados avançados { blendShapes, rotation }
  p2pClient.onBlendshapesReceived = (data) => {
    const shapes = (data && data.blendShapes) ? data.blendShapes : data;
    const rot = (data && data.rotation) ? data.rotation : null;

    if (motionTimeline && motionTimeline.isRecording && !motionTimeline.isPaused) {
      motionTimeline.addFrame(shapes, rot);
    }

    if (renderer && (!motionTimeline || !motionTimeline.isPlaying)) {
      renderer.applyBlendShapes(shapes, rot);
    }
  };

  // Preview de vídeo do Smartphone via WebRTC PiP
  p2pClient.onPeerStreamCallback = (stream) => {
    console.log('[main] Stream de vídeo recebido do smartphone');
    const pipVideo = /** @type {HTMLVideoElement} */ ($('pip-video'));
    pipVideo.srcObject = stream;
    pipVideo.play().catch(() => {});
    $('pip-dot').className = 'pip-dot active';
    $('pip-empty').style.display = 'none';
    $('chk-pip-preview').checked = true;
    $('pip-container').classList.remove('hidden');
    showToast('Preview da câmera do smartphone ativo em PiP', 'success');
  };

  p2pClient.connect();
}

/* ─── Drawer Lateral Retrátil ─────────────────────────────────────────────── */

function setupDrawer() {
  const drawer = $('sidebar-drawer');
  const btnToggle = $('btn-toggle-drawer');
  const btnClose = $('btn-close-drawer');
  const timelineDock = $('timeline-dock');

  const updateTimelinePosition = () => {
    const isOpen = drawer.classList.contains('open');
    if (timelineDock) {
      if (isOpen) {
        timelineDock.classList.add('drawer-open');
      } else {
        timelineDock.classList.remove('drawer-open');
      }
    }
  };

  const toggle = () => {
    drawer.classList.toggle('open');
    updateTimelinePosition();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  };

  const close = () => {
    drawer.classList.remove('open');
    updateTimelinePosition();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  };

  btnToggle.addEventListener('click', toggle);
  btnClose.addEventListener('click', close);

  // Inicializa a posição da timeline de acordo com o drawer
  updateTimelinePosition();

  // Atalhos de teclado: \ ou Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
      toggle();
    } else if (e.key === 'Escape' && drawer.classList.contains('open')) {
      close();
    }
  });
}

/* ─── Sensor Telemetry HUD ────────────────────────────────────────────────── */

function updateSensorHud(fps = 0) {
  const hudText = $('hud-text');
  const hudDot = $('hud-dot');
  if (!hudText) return;

  if (p2pClient && p2pClient.isConnected) {
    hudDot.className = 'hud-dot active';
    hudText.textContent = `Sensor Conectado (${fps} FPS)`;
  } else if (localTracking) {
    hudDot.className = 'hud-dot active';
    hudText.textContent = `Câmera Local (${fps} FPS)`;
  } else {
    hudDot.className = 'hud-dot';
    hudText.textContent = `Aguardando Sensor da Câmera (${fps} FPS)`;
  }
}

/* ─── Accordions Retráteis ────────────────────────────────────────────────── */

function setupAccordions() {
  const items = document.querySelectorAll('.accordion-item');
  items.forEach((item) => {
    const header = item.querySelector('.accordion-header');
    if (!header) return;

    header.addEventListener('click', () => {
      item.classList.toggle('open');
    });
  });
}

/* ─── Model Presets (Padrão, Anime, Realista, Estilizado, Furry) ──────────── */

function setupModelPresets() {
  const selectPreset = /** @type {HTMLSelectElement} */ ($('select-model-preset'));
  if (!selectPreset) return;

  selectPreset.addEventListener('change', async () => {
    const url = selectPreset.value;
    const optText = selectPreset.selectedOptions[0]?.textContent || 'Modelo';
    const filename = url ? url.split('/').pop() : 'model.glb';

    if (url && renderer) {
      showToast(`Carregando modelo ${optText}...`, 'info');
      await loadModel(url, filename);
    }
  });
}

/* ─── Shading & Lighting Modes (Blender Viewport Shading) ─────────────────── */

function setupShading() {
  const container = $('shading-selector');
  if (!container) return;

  const pills = container.querySelectorAll('.shading-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');

      const mode = pill.getAttribute('data-mode') || 'studio';
      if (renderer) {
        renderer.setShadingMode(mode);
        const modeLabels = {
          studio: 'Estúdio PBR',
          sunset: 'Sunset Golden Hour',
          cyber: 'Cyber Neon',
          toon: 'Cel-Shading (Toon)',
          smooth: 'Suave / Beauty Soft',
          clay: 'Argila / Escultura',
          normals: 'Visualizador de Normais',
          wireframe: 'Wireframe Poligonal',
        };
        showToast(`Iluminação: ${modeLabels[mode] || mode}`, 'info');
      }
    });
  });

  // Sliders de Direção de Luz e Suavidade
  const sliderAzimuth = $('slider-light-azimuth');
  const labelAzimuth = $('label-light-azimuth');
  const sliderElevation = $('slider-light-elevation');
  const labelElevation = $('label-light-elevation');
  const sliderSmooth = $('slider-smooth-level');
  const labelSmooth = $('label-smooth-level');

  const updateLightDir = () => {
    if (renderer) {
      renderer.setLightDirection(sliderAzimuth.value, sliderElevation.value);
    }
  };

  sliderAzimuth.addEventListener('input', (e) => {
    labelAzimuth.textContent = `${e.target.value}°`;
    updateLightDir();
  });

  sliderElevation.addEventListener('input', (e) => {
    labelElevation.textContent = `${e.target.value}°`;
    updateLightDir();
  });

  sliderSmooth.addEventListener('input', (e) => {
    labelSmooth.textContent = `${e.target.value}%`;
    if (renderer) {
      renderer.setSmoothLevel(Number(e.target.value) / 100);
    }
  });
}

/* ─── Custom Background & Blur Filter ─────────────────────────────────────── */

function setupBackground() {
  const bgLayer = $('viewport-bg');
  const fileInput = $('file-input-bg');
  const btnChoose = $('btn-choose-bg');
  const btnRemove = $('btn-remove-bg');
  const sliderBlur = /** @type {HTMLInputElement} */ ($('slider-bg-blur'));
  const labelBlur = $('label-bg-blur');

  btnChoose.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (currentBgImageUrl) {
      URL.revokeObjectURL(currentBgImageUrl);
    }

    currentBgImageUrl = URL.createObjectURL(file);
    bgLayer.style.backgroundImage = `url("${currentBgImageUrl}")`;
    btnRemove.style.display = 'inline-flex';
    fileInput.value = '';
    showToast('Imagem de fundo aplicada!', 'success');
  });

  btnRemove.addEventListener('click', () => {
    if (currentBgImageUrl) {
      URL.revokeObjectURL(currentBgImageUrl);
      currentBgImageUrl = null;
    }
    bgLayer.style.backgroundImage = '';
    btnRemove.style.display = 'none';
    showToast('Plano de fundo removido', 'info');
  });

  sliderBlur.addEventListener('input', (e) => {
    const val = e.target.value;
    labelBlur.textContent = `${val}px`;
    bgLayer.style.filter = `blur(${val}px)`;
  });
}

/* ─── Picture-in-Picture Preview (Draggable) ─────────────────────────────── */

function setupPiP() {
  const pip = $('pip-container');
  const chk = /** @type {HTMLInputElement} */ ($('chk-pip-preview'));
  const btnClose = $('btn-close-pip');
  const pipHeader = pip.querySelector('.pip-header');

  chk.addEventListener('change', () => {
    if (chk.checked) {
      pip.classList.remove('hidden');
    } else {
      pip.classList.add('hidden');
    }
  });

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    pip.classList.add('hidden');
    chk.checked = false;
  });

  // Arrastar e soltar (Drag & Drop) da janela PiP
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  const onPointerDown = (e) => {
    if (e.target.closest('#btn-close-pip')) return;

    isDragging = true;
    pip.classList.add('dragging');

    const rect = pip.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = rect.left;
    initialTop = rect.top;

    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
    pip.style.left = `${initialLeft}px`;
    pip.style.top = `${initialTop}px`;

    pip.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const newLeft = Math.max(10, Math.min(window.innerWidth - pip.offsetWidth - 10, initialLeft + dx));
    const newTop = Math.max(10, Math.min(window.innerHeight - pip.offsetHeight - 10, initialTop + dy));

    pip.style.left = `${newLeft}px`;
    pip.style.top = `${newTop}px`;
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    pip.classList.remove('dragging');
    try {
      pip.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  if (pipHeader) {
    pipHeader.addEventListener('pointerdown', onPointerDown);
    pipHeader.addEventListener('pointermove', onPointerMove);
    pipHeader.addEventListener('pointerup', onPointerUp);
    pipHeader.addEventListener('pointercancel', onPointerUp);
  } else {
    pip.addEventListener('pointerdown', onPointerDown);
    pip.addEventListener('pointermove', onPointerMove);
    pip.addEventListener('pointerup', onPointerUp);
    pip.addEventListener('pointercancel', onPointerUp);
  }
}

/* ─── Device Enumeration (Camera & Microphone) ────────────────────────────── */

async function setupMediaDevices() {
  const selectCam = /** @type {HTMLSelectElement} */ ($('select-camera'));
  const selectMic = /** @type {HTMLSelectElement} */ ($('select-mic'));

  try {
    // Solicita uma permissão leve para obter rótulos reais dos dispositivos
    const devices = await navigator.mediaDevices.enumerateDevices();
    
    // 1. Câmeras
    const videoDevices = devices.filter((d) => d.kind === 'videoinput');
    selectCam.innerHTML = '';
    if (videoDevices.length === 0) {
      selectCam.innerHTML = '<option value="">Nenhuma câmera detectada</option>';
    } else {
      videoDevices.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Câmera ${idx + 1}`;
        selectCam.appendChild(opt);
      });
      selectedCameraDeviceId = videoDevices[0].deviceId;
    }

    selectCam.addEventListener('change', async (e) => {
      selectedCameraDeviceId = e.target.value;
      if (localTracking) {
        stopLocalCamera();
        await startLocalCamera();
        showToast('Câmera alternada com sucesso', 'info');
      }
    });

    // 2. Microfones
    const audioDevices = devices.filter((d) => d.kind === 'audioinput');
    selectMic.innerHTML = '';
    if (audioDevices.length === 0) {
      selectMic.innerHTML = '<option value="">Microfone Padrão</option>';
    } else {
      audioDevices.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Microfone ${idx + 1}`;
        selectMic.appendChild(opt);
      });
      selectedAudioDeviceId = audioDevices[0].deviceId;
    }

    selectMic.addEventListener('change', (e) => {
      selectedAudioDeviceId = e.target.value;
      showToast('Microfone selecionado para gravação', 'info');
    });

  } catch (err) {
    console.warn('[main] Não foi possível enumerar dispositivos de mídia:', err);
  }
}

/* ─── UI Interactions ─────────────────────────────────────────────────────── */

function setupUI() {
  // Modal QR Code
  $('btn-open-qr').addEventListener('click', () => openQRModal());
  $('btn-close-modal').addEventListener('click', () => closeQRModal());
  $('modal-qr').addEventListener('click', (e) => {
    if (e.target === $('modal-qr')) closeQRModal();
  });

  // Carregar Modelo 3D (.glb, .gltf, .fbx, .obj)
  const fileInput = $('file-input-model');
  $('btn-choose-model').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    await handleUploadedFiles(files);
    fileInput.value = '';
  });

  // Toggle de Texturas
  const chkTextures = /** @type {HTMLInputElement} */ ($('chk-show-textures'));
  if (chkTextures) {
    chkTextures.addEventListener('change', () => {
      if (renderer) {
        renderer.setTexturesEnabled(chkTextures.checked);
        showToast(chkTextures.checked ? 'Texturas ativadas' : 'Texturas desativadas', 'info');
      }
    });
  }

  // Redefinir Câmera
  $('btn-reset-view').addEventListener('click', () => {
    if (renderer) renderer.resetCamera();
    showToast('Câmera redefinida', 'info');
  });

  // Câmera Local
  $('btn-toggle-local-cam').addEventListener('click', () => toggleLocalCamera());
}

function openQRModal() {
  $('modal-qr').classList.add('open');
}

function closeQRModal() {
  $('modal-qr').classList.remove('open');
}

/* ─── Drag & Drop 3D Model (.glb / .gltf / .fbx / .obj + textures) ────────── */

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

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      await handleUploadedFiles(files);
    }
  });
}

/**
 * Handle a list of uploaded files (single model or model + textures/mtl).
 * @param {File[]} files
 */
async function handleUploadedFiles(files) {
  // Find primary model file
  const modelFile = files.find((f) => {
    const n = f.name.toLowerCase();
    return n.endsWith('.glb') || n.endsWith('.gltf') || n.endsWith('.fbx') || n.endsWith('.obj');
  });

  if (!modelFile) {
    showToast('Nenhum modelo 3D compatível (.glb, .gltf, .fbx, .obj) encontrado.', 'error');
    return;
  }

  // Create asset map of object URLs for textures / mtl files
  const assetMap = {};
  const urlsToRevoke = [];

  for (const f of files) {
    const objUrl = URL.createObjectURL(f);
    urlsToRevoke.push(objUrl);
    assetMap[f.name] = objUrl;
    assetMap[f.name.toLowerCase()] = objUrl;
  }

  const modelUrl = assetMap[modelFile.name];
  await loadModel(modelUrl, modelFile.name, assetMap);

  // Revoke URLs after model has had time to parse and load textures into WebGL memory
  setTimeout(() => {
    urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
  }, 15000);
}

/* ─── Local Webcam Tracking ───────────────────────────────────────────────── */

async function toggleLocalCamera() {
  const badge = $('local-cam-badge');
  const title = $('local-cam-title');
  const sub = $('local-cam-sub');

  if (localTracking) {
    stopLocalCamera();
    badge.textContent = 'Ativar';
    badge.style.color = 'var(--label-secondary)';
    title.textContent = 'Câmera deste Mac';
    if (sub) sub.textContent = 'Rastreamento neste computador';
    updateSensorHud(renderer ? renderer.fps : 0);
    showToast('Câmera desativada', 'info');
  } else {
    badge.textContent = 'Iniciando...';
    try {
      await startLocalCamera();
      badge.textContent = 'Ativa ✓';
      badge.style.color = 'var(--sys-green)';
      title.textContent = 'Câmera (Ativa)';
      if (sub) sub.textContent = 'Rastreamento facial ativo';
      updateSensorHud(renderer ? renderer.fps : 0);
      showToast('Câmera ativada com sucesso', 'success');
    } catch (err) {
      console.error('Erro na câmera:', err);
      badge.textContent = 'Erro';
      badge.style.color = 'var(--sys-red)';
      showToast('Não foi possível iniciar a câmera: ' + err.message, 'error');
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

  const videoConstraints = selectedCameraDeviceId
    ? { deviceId: { exact: selectedCameraDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
    : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };

  localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
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
    localStream.getTracks().forEach((t) => t.stop());
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

      if (motionTimeline && motionTimeline.isRecording && !motionTimeline.isPaused) {
        motionTimeline.addFrame(blendShapesMap, rotation);
      }

      if (renderer && (!motionTimeline || !motionTimeline.isPlaying)) {
        renderer.applyBlendShapes(blendShapesMap, rotation);
      }
    }
  }
  requestAnimationFrame(runLocalLoop);
}

/* ─── Recording in Native MP4 with Preview Modal ─────────────────────────── */



/* ─── Blender-Style Bottom Motion Timeline ────────────────────────────────── */

function setupTimeline() {
  const btnRec = $('btn-tl-rec');
  const btnPause = $('btn-tl-pause');
  const btnStop = $('btn-tl-stop');
  const btnPlay = $('btn-tl-play');
  const iconPlay = $('icon-tl-play');
  const btnLoop = $('btn-tl-loop');
  const btnClear = $('btn-tl-clear');
  const btnExport = $('btn-tl-export');

  const timeCurrent = $('tl-time-current');
  const timeTotal = $('tl-time-total');
  const frameBadge = $('tl-frame-badge');

  const trackArea = $('tl-track-area');
  const trimRange = $('tl-trim-range');
  const handleIn = $('tl-handle-in');
  const handleOut = $('tl-handle-out');
  const playhead = $('tl-playhead');

  motionTimeline = new MotionTimeline({
    onApplyFrame: (blendShapes, rotation) => {
      if (renderer) {
        renderer.applyBlendShapes(blendShapes, rotation);
      }
    },
    onStateChange: (state) => {
      // 1. Botão Gravar / Rec
      if (state.isRecording && !state.isPaused) {
        btnRec.classList.add('recording');
        btnRec.title = 'Pausar Gravação';
      } else {
        btnRec.classList.remove('recording');
        btnRec.title = state.frameCount > 0 ? 'Continuar Gravação' : 'Gravar Movimento';
      }

      // 2. Botão Play / Pause
      if (state.isPlaying) {
        btnPlay.classList.add('playing');
        iconPlay.innerHTML = `
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/>
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>
        `;
      } else {
        btnPlay.classList.remove('playing');
        iconPlay.innerHTML = `
          <polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>
        `;
      }

      // 3. Botão Loop
      if (state.isLooping) {
        btnLoop.classList.add('active');
      } else {
        btnLoop.classList.remove('active');
      }

      // 4. Leituras de Tempo e Frame
      timeCurrent.textContent = MotionTimeline.formatTime(state.currentTime);
      timeTotal.textContent = MotionTimeline.formatTime(state.totalDuration);
      const curFrame = Math.round(state.currentTime * 30);
      frameBadge.textContent = `Quadro ${curFrame} (${state.frameCount} gravados)`;

      // 5. Cursor Scrubber (Playhead)
      const pct = state.totalDuration > 0 ? (state.currentTime / state.totalDuration) * 100 : 0;
      playhead.style.left = `${Math.max(0, Math.min(100, pct))}%`;

      // 6. Faixa e Alças de Trim
      const inPct = state.totalDuration > 0 ? (state.trimIn / state.totalDuration) * 100 : 0;
      const outPct = state.totalDuration > 0 ? (state.trimOut / state.totalDuration) * 100 : 100;

      handleIn.style.left = `${inPct}%`;
      handleOut.style.left = `${outPct}%`;
      trimRange.style.left = `${inPct}%`;
      trimRange.style.width = `${Math.max(0, outPct - inPct)}%`;
    },
  });

  // Botão Gravar / Continuar
  btnRec.addEventListener('click', () => {
    if (motionTimeline.isRecording && !motionTimeline.isPaused) {
      motionTimeline.pause();
      showToast('Gravação pausada na timeline', 'info');
    } else {
      motionTimeline.startRecording();
      showToast(motionTimeline.isPaused ? 'Continuando gravação...' : 'Gravando movimentos na timeline...', 'success');
    }
  });

  // Botão Pausar
  btnPause.addEventListener('click', () => {
    motionTimeline.pause();
    showToast('Timeline pausada', 'info');
  });

  // Botão Parar
  btnStop.addEventListener('click', () => {
    motionTimeline.stop();
    showToast('Gravação finalizada. Playhead no início do trecho.', 'info');
  });

  // Botão Play / Pause
  btnPlay.addEventListener('click', () => {
    if (motionTimeline.frames.length < 2) {
      showToast('Grave movimentos primeiro usando o botão Gravar (⏺)', 'info');
      return;
    }
    motionTimeline.togglePlay();
  });

  // Botão Loop
  btnLoop.addEventListener('click', () => {
    motionTimeline.setLooping(!motionTimeline.isLooping);
  });

  // Botão Limpar
  btnClear.addEventListener('click', () => {
    motionTimeline.clear();
    showToast('Timeline limpa. Pronto para novo take.', 'info');
  });

  // Botão Exportar MP4 do Trecho Recortado
  btnExport.addEventListener('click', async () => {
    if (!recorder || motionTimeline.frames.length < 2) {
      showToast('Grave um trecho na timeline antes de exportar.', 'info');
      return;
    }

    const previewModal = $('modal-video-preview');
    const videoPlayer = /** @type {HTMLVideoElement} */ ($('preview-video-player'));
    const btnSave = $('btn-save-recording');
    const btnDiscard = $('btn-discard-recording');
    const durationLabel = $('preview-duration-label');

    try {
      showToast('Renderizando trecho selecionado em MP4...', 'info');
      btnExport.disabled = true;

      motionTimeline.pausePlayback();
      motionTimeline.scrub(motionTimeline.trimIn);

      await recorder.startRecording(selectedAudioDeviceId);

      const startT = performance.now();
      const trimDuration = motionTimeline.trimOut - motionTimeline.trimIn;

      const renderStep = async () => {
        const elapsed = (performance.now() - startT) / 1000;
        const currentTargetTime = motionTimeline.trimIn + elapsed;

        if (currentTargetTime < motionTimeline.trimOut) {
          motionTimeline.scrub(currentTargetTime);
          requestAnimationFrame(renderStep);
        } else {
          motionTimeline.scrub(motionTimeline.trimOut);
          const url = await recorder.stopRecording();
          btnExport.disabled = false;
          btnExport.innerHTML = `
            <svg class="svg-icon sm" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          `;

          if (url && previewModal && videoPlayer) {
            videoPlayer.src = url;
            if (durationLabel) {
              durationLabel.textContent = MotionTimeline.formatTime(trimDuration);
            }
            previewModal.classList.add('open');
            videoPlayer.play().catch(() => {});

            btnSave.onclick = () => {
              recorder.downloadRecording(`FaceToModel_Take_${Date.now()}.mp4`);
              previewModal.classList.remove('open');
              videoPlayer.pause();
              showToast('Vídeo MP4 salvo com sucesso!', 'success');
            };

            btnDiscard.onclick = () => {
              previewModal.classList.remove('open');
              videoPlayer.pause();
              videoPlayer.src = '';
              showToast('Exportação descartada', 'info');
            };
          } else {
            recorder.downloadRecording(`FaceToModel_Take_${Date.now()}.mp4`);
            showToast('Vídeo MP4 exportado com sucesso!', 'success');
          }
        }
      };

      requestAnimationFrame(renderStep);
    } catch (err) {
      console.error('[Export Error]', err);
      btnExport.disabled = false;
      btnExport.innerHTML = `
        <svg class="svg-icon sm" viewBox="0 0 24 24">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      showToast('Erro ao exportar vídeo: ' + err.message, 'error');
    }
  });

  // Scrubbing interativo com Mouse / Touch
  let isDraggingScrubber = false;
  let isDraggingHandleIn = false;
  let isDraggingHandleOut = false;

  const getTimeFromEvent = (e) => {
    const rect = trackArea.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    return ratio * motionTimeline.totalDuration;
  };

  trackArea.addEventListener('pointerdown', (e) => {
    if (e.target === handleIn || handleIn.contains(e.target)) {
      isDraggingHandleIn = true;
      e.preventDefault();
      return;
    }
    if (e.target === handleOut || handleOut.contains(e.target)) {
      isDraggingHandleOut = true;
      e.preventDefault();
      return;
    }
    isDraggingScrubber = true;
    motionTimeline.pausePlayback();
    const time = getTimeFromEvent(e);
    motionTimeline.scrub(time);
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (isDraggingScrubber) {
      const time = getTimeFromEvent(e);
      motionTimeline.scrub(time);
    } else if (isDraggingHandleIn) {
      const time = getTimeFromEvent(e);
      motionTimeline.setTrim(time, motionTimeline.trimOut);
    } else if (isDraggingHandleOut) {
      const time = getTimeFromEvent(e);
      motionTimeline.setTrim(motionTimeline.trimIn, time);
    }
  });

  window.addEventListener('pointerup', () => {
    isDraggingScrubber = false;
    isDraggingHandleIn = false;
    isDraggingHandleOut = false;
  });

  // Teclas de Atalho de Estúdio (Espaço para Play/Pause, R para Gravar)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (motionTimeline.frames.length >= 2) {
        motionTimeline.togglePlay();
      }
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      btnRec.click();
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

async function loadModel(url, filename = '', assetMap = {}) {
  $('model-name').textContent = 'Carregando...';
  $('model-coverage').textContent = 'Analisando morph targets';

  const selectPreset = /** @type {HTMLSelectElement} */ ($('select-model-preset'));
  if (selectPreset) {
    const matchingOpt = Array.from(selectPreset.options).find((opt) => opt.value === url || (filename && opt.value.includes(filename)));
    if (matchingOpt) {
      selectPreset.value = matchingOpt.value;
    }
  }

  try {
    await renderer.loadModel(url, filename, assetMap);
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
