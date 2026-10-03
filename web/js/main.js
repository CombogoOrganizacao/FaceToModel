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
import { GlassesFilter } from './glasses-filter.js';
import { exportModelToGLB, buildAnimationClip } from './glb-exporter.js';
import { ExpressionControls, EXPRESSION_CATEGORIES } from './expression-controls.js';
import { ensureModelBlendshapes } from './blendshape-synthesizer.js';
import { buildModelMap } from './blendshape-mapper.js';

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
let currentModelFilename = 'facecap.glb';
const glassesFilter = new GlassesFilter();
let expressionControls = null;

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
    setupExpressionControls();

    // 4. Sensor HUD & FPS Counter
    setInterval(() => {
      const fps = renderer ? renderer.fps : 0;
      updateSensorHud(fps);
    }, 500);

    // 5. Load Default 3D Model in Background
    loadModel('/models/facecap.glb?v=20261001_v2', 'facecap.glb');
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

async function initP2PRoom() {
  // Gerar ID de sala único de 6 caracteres
  roomId = Math.random().toString(36).substring(2, 8);
  $('room-code-label').textContent = `SALA: ${roomId.toUpperCase()}`;

  let hostIp = window.location.hostname;
  let proto = window.location.protocol;
  let portStr = '';

  // Se estiver acessando por localhost no Mac, busca o IP real da rede local Wi-Fi
  if (hostIp === 'localhost' || hostIp === '127.0.0.1') {
    try {
      const res = await fetch('/api/info');
      if (res.ok) {
        const info = await res.json();
        if (info.localIp && info.localIp !== 'localhost') {
          hostIp = info.localIp;
        }
      }
    } catch (_) {}
    const p = window.location.port || '3000';
    portStr = `:${p}`;
  } else if (window.location.port && window.location.port !== '80' && window.location.port !== '443') {
    portStr = `:${window.location.port}`;
  }

  // Criar URL completa acessível na rede Wi-Fi pelo smartphone
  const cameraUrl = `${proto}//${hostIp}${portStr}/camera.html#room=${roomId}&host=${hostIp}`;
  console.log('[main] URL da Câmera para QR Code:', cameraUrl);

  const roomLabel = $('room-code-label');
  if (roomLabel) {
    roomLabel.innerHTML = `SALA: ${roomId.toUpperCase()}<br/><a href="${cameraUrl}" target="_blank" style="color:var(--sys-blue);word-break:break-all;text-decoration:none;font-size:10px;margin-top:4px;display:inline-block;">${cameraUrl}</a>`;
  }

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
    showToast('Smartphone desconectado', 'info');
  };

  // Suporte a dados avançados { blendShapes, rotation }
  p2pClient.onBlendshapesReceived = (data) => {
    let shapes = (data && data.blendShapes) ? data.blendShapes : data;
    const rot = (data && data.rotation) ? data.rotation : null;

    if (glassesFilter.enabled && shapes) {
      shapes = glassesFilter.process(shapes);
    }

    if (motionTimeline && motionTimeline.isRecording && !motionTimeline.isPaused) {
      motionTimeline.addFrame(shapes, rot);
    }

    if (renderer && (!motionTimeline || !motionTimeline.isPlaying)) {
      renderer.applyBlendShapes(shapes, rot);
    }
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
          unreal: 'Unreal Engine 5 (Lumen Cinematic PBR)',
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

/* ─── Device Enumeration (Camera & Microphone) ────────────────────────────── */

let mediaDevicesListenersBound = false;

async function setupMediaDevices() {
  const selectCam = /** @type {HTMLSelectElement} */ ($('select-camera'));
  const selectMic = /** @type {HTMLSelectElement} */ ($('select-mic'));

  // Request temporary stream to unlock real hardware labels in Safari / Chrome if not yet granted
  let tempStream = null;
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
  } catch (_) {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    } catch (_) {}
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (tempStream) {
      tempStream.getTracks().forEach((t) => t.stop());
    }

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
      if (!selectedCameraDeviceId || !videoDevices.some((d) => d.deviceId === selectedCameraDeviceId)) {
        selectedCameraDeviceId = videoDevices[0].deviceId;
      } else {
        selectCam.value = selectedCameraDeviceId;
      }
    }

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
      if (!selectedAudioDeviceId || !audioDevices.some((d) => d.deviceId === selectedAudioDeviceId)) {
        selectedAudioDeviceId = audioDevices[0].deviceId;
      } else {
        selectMic.value = selectedAudioDeviceId;
      }
    }

    if (!mediaDevicesListenersBound) {
      mediaDevicesListenersBound = true;

      selectCam.addEventListener('change', async (e) => {
        selectedCameraDeviceId = e.target.value;
        if (localTracking) {
          stopLocalCamera();
          await startLocalCamera();
          showToast('Câmera alternada com sucesso', 'info');
        }
      });

      selectMic.addEventListener('change', (e) => {
        selectedAudioDeviceId = e.target.value;
        showToast('Microfone selecionado para gravação', 'info');
      });

      if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', () => {
          setupMediaDevices();
        });
      }
    }
  } catch (err) {
    console.warn('[main] Não foi possível enumerar dispositivos de mídia:', err);
    if (tempStream) {
      tempStream.getTracks().forEach((t) => t.stop());
    }
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

  // Toggle de Modo Óculos (Glasses Optimization)
  const chkGlasses = /** @type {HTMLInputElement} */ ($('chk-glasses-mode'));
  if (chkGlasses) {
    chkGlasses.addEventListener('change', () => {
      glassesFilter.setEnabled(chkGlasses.checked);
      showToast(chkGlasses.checked ? 'Modo Óculos ativado (filtro anti-reflexo e estabilização)' : 'Modo Óculos desativado', 'info');
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
    badge.textContent = 'Ativar Câmera do PC';
    badge.style.color = 'var(--label-secondary)';
    title.textContent = 'Câmera do PC';
    if (sub) sub.textContent = 'Rastreamento neste computador';
    updateSensorHud(renderer ? renderer.fps : 0);
    showToast('Câmera desativada', 'info');
  } else {
    badge.textContent = 'Iniciando...';
    try {
      await startLocalCamera();
      badge.textContent = 'Ativa';
      badge.style.color = 'var(--sys-green)';
      title.textContent = 'Câmera do PC (Ativa)';
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

      const finalShapes = glassesFilter.process(blendShapesMap);

      // Rotação 3DoF calibrada 1:1
      let rotation = null;
      if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
        const m = results.facialTransformationMatrixes[0].data;
        const pitch = Math.atan2(m[6], m[10]);
        const yaw   = Math.atan2(-m[2], Math.sqrt(m[6] * m[6] + m[10] * m[10]));
        const roll  = Math.atan2(m[1], m[0]);
        // Pitch calibrado: inclinar para baixo olha para baixo, para cima olha para cima
        rotation = { pitch: pitch * 0.85, yaw: yaw * 0.85, roll: -roll * 0.85 };
      }

      if (motionTimeline && motionTimeline.isRecording && !motionTimeline.isPaused) {
        motionTimeline.addFrame(finalShapes, rotation);
      }

      if (renderer && (!motionTimeline || !motionTimeline.isPlaying)) {
        renderer.applyBlendShapes(finalShapes, rotation);
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

      // 4. Leituras de Tempo e Frame (60 FPS)
      timeCurrent.textContent = MotionTimeline.formatTime(state.currentTime);
      timeTotal.textContent = MotionTimeline.formatTime(state.totalDuration);
      const curFrame = Math.round(state.currentTime * 60);
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

  // Botão Exportar Animação no Modelo 3D (.GLB) para Unity, Unreal, Blender, Godot
  const btnExportGLB = $('btn-tl-export-glb');
  if (btnExportGLB) {
    btnExportGLB.addEventListener('click', async () => {
      if (!motionTimeline || motionTimeline.frames.length < 2) {
        showToast('Grave movimentos na timeline antes de exportar o modelo 3D.', 'info');
        return;
      }
      if (!renderer || !renderer.getModel()) {
        showToast('Nenhum modelo 3D carregado para exportação.', 'error');
        return;
      }

      btnExportGLB.disabled = true;
      btnExportGLB.style.opacity = '0.5';
      btnExportGLB.style.pointerEvents = 'none';
      showToast('Empacotando animação 3D no modelo (.glb)...', 'info');

      try {
        const model = renderer.getInnerModel();
        const modelMap = renderer.getModelMap();
        const headBone = renderer.getHeadBone();
        const neckBone = renderer.getNeckBone();
        const headAttachments = renderer.getHeadAttachments();

        const animationClip = buildAnimationClip({
          frames: motionTimeline.frames,
          trimIn: motionTimeline.trimIn,
          trimOut: motionTimeline.trimOut,
          model: model,
          modelMap: modelMap,
          headBone: headBone,
          neckBone: neckBone,
          headAttachments: headAttachments,
          clipName: 'FaceToModel_MotionTake'
        });

        if (!animationClip) {
          showToast('Nenhuma faixa de movimento detectada para exportar.', 'error');
          return;
        }

        const baseName = currentModelFilename ? currentModelFilename.replace(/\.[^/.]+$/, '') : 'modelo_3d';
        const filename = `${baseName}_animado.glb`;

        await exportModelToGLB({
          model: model,
          animationClip: animationClip,
          filename: filename
        });

        showToast(`Animação 3D salva no modelo: ${filename}!`, 'success');
      } catch (err) {
        console.error('[main] Erro na exportação do modelo GLB:', err);
        showToast('Erro ao exportar modelo 3D: ' + err.message, 'error');
      } finally {
        btnExportGLB.disabled = false;
        btnExportGLB.style.opacity = '';
        btnExportGLB.style.pointerEvents = '';
      }
    });
  }

  // Botão Exportar MP4 do Trecho Recortado em 1080p 60 FPS
  btnExport.addEventListener('click', async () => {
    if (!recorder || motionTimeline.frames.length < 2) {
      showToast('Grave um trecho na timeline antes de exportar.', 'info');
      return;
    }

    const renderModal = $('modal-render-progress');
    const gaugeCircle = $('render-gauge-circle');
    const gaugePct = $('render-gauge-pct');
    const gaugeEta = $('render-gauge-eta');

    const previewModal = $('modal-video-preview');
    const videoPlayer = /** @type {HTMLVideoElement} */ ($('preview-video-player'));
    const btnSave = $('btn-save-recording');
    const btnDiscard = $('btn-discard-recording');
    const durationLabel = $('preview-duration-label');

    const CIRCUMFERENCE = 2 * Math.PI * 50; // ~314.159

    try {
      btnExport.disabled = true;

      // 1. Bloqueia a interface exibindo o Modal de Renderização Circular
      if (gaugeCircle) gaugeCircle.style.strokeDashoffset = `${CIRCUMFERENCE}`;
      if (gaugePct) gaugePct.textContent = '0%';
      if (gaugeEta) gaugeEta.textContent = 'Iniciando 1080p...';
      if (renderModal) renderModal.classList.add('open');

      motionTimeline.pausePlayback();

      // 2. Coloca o WebGL em modo 1080p Full HD (1920x1080)
      if (renderer) {
        renderer.setExport1080p(true);
      }

      await new Promise((r) => setTimeout(r, 60)); // Permite ao WebGL aplicar o buffer 1080p

      // 3. Inicia o Recorder em 60 FPS
      await recorder.startRecording(selectedAudioDeviceId);

      const trimDuration = Math.max(0.1, motionTimeline.trimOut - motionTimeline.trimIn);
      const startT = performance.now();

      const renderStep = async () => {
        const elapsed = (performance.now() - startT) / 1000;
        const currentTargetTime = motionTimeline.trimIn + elapsed;
        const progress = Math.min(1.0, elapsed / trimDuration);

        // Atualiza a gauge circular e porcentagem central
        const offset = CIRCUMFERENCE * (1 - progress);
        if (gaugeCircle) gaugeCircle.style.strokeDashoffset = `${offset}`;
        const pctNumber = Math.round(progress * 100);
        if (gaugePct) gaugePct.textContent = `${pctNumber}%`;

        const remainingSec = Math.max(0, trimDuration - elapsed);
        if (gaugeEta) gaugeEta.textContent = `${remainingSec.toFixed(1)}s restantes`;

        if (currentTargetTime < motionTimeline.trimOut) {
          motionTimeline.scrub(currentTargetTime);
          requestAnimationFrame(renderStep);
        } else {
          motionTimeline.scrub(motionTimeline.trimOut);
          if (gaugeCircle) gaugeCircle.style.strokeDashoffset = '0';
          if (gaugePct) gaugePct.textContent = '100%';
          if (gaugeEta) gaugeEta.textContent = 'Finalizando...';

          const url = await recorder.stopRecording();

          // Restaura a resolução da tela
          if (renderer) {
            renderer.setExport1080p(false);
          }

          // Fecha o modal de bloqueio
          if (renderModal) renderModal.classList.remove('open');

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
              recorder.downloadRecording(`FaceToModel_1080p_${Date.now()}.mp4`);
              previewModal.classList.remove('open');
              videoPlayer.pause();
              showToast('Vídeo 1080p salvo com sucesso!', 'success');
            };

            btnDiscard.onclick = () => {
              previewModal.classList.remove('open');
              videoPlayer.pause();
              videoPlayer.src = '';
              showToast('Exportação descartada', 'info');
            };
          } else {
            recorder.downloadRecording(`FaceToModel_1080p_${Date.now()}.mp4`);
            showToast('Vídeo 1080p exportado com sucesso!', 'success');
          }
        }
      };

      requestAnimationFrame(renderStep);
    } catch (err) {
      console.error('[Export Error]', err);
      if (renderer) renderer.setExport1080p(false);
      if (renderModal) renderModal.classList.remove('open');
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

/* ─── Expression Controls & Testing Suite (ARKit Toolset Style) ────────────── */

function setupExpressionControls() {
  expressionControls = new ExpressionControls({
    onApply: (blendShapes) => {
      if (renderer && (!motionTimeline || !motionTimeline.isPlaying)) {
        renderer.applyBlendShapes(blendShapes);
      }
    }
  });

  const renderCategorySliders = (categoryKey) => {
    const container = $('exp-sliders-container');
    if (!container) return;
    container.innerHTML = '';

    const catData = EXPRESSION_CATEGORIES[categoryKey];
    if (!catData) return;

    catData.shapes.forEach((shapeName) => {
      const val = expressionControls.values[shapeName] || 0;
      const pct = Math.round(val * 100);

      const row = document.createElement('div');
      row.className = 'slider-control-group';
      row.style.marginBottom = '6px';
      row.innerHTML = `
        <div class="slider-header" style="margin-bottom: 2px;">
          <span class="slider-title" style="font-size: 11px;">${shapeName}</span>
          <span class="slider-value" id="exp-val-${shapeName}" style="font-size: 11px;">${pct}%</span>
        </div>
        <input type="range" id="exp-slider-${shapeName}" min="0" max="1" step="0.01" value="${val}" class="apple-slider" />
      `;

      const input = row.querySelector('input');
      input.addEventListener('input', (e) => {
        const num = parseFloat(e.target.value);
        expressionControls.setShape(shapeName, num);
        const label = document.getElementById(`exp-val-${shapeName}`);
        if (label) label.textContent = `${Math.round(num * 100)}%`;
      });

      container.appendChild(row);
    });
  };

  // Render initial category
  renderCategorySliders('brows');

  // Category tab buttons
  const catTabs = document.querySelectorAll('#exp-category-tabs .shading-pill');
  catTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      catTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const cat = tab.getAttribute('data-cat');
      expressionControls.activeCategory = cat;
      renderCategorySliders(cat);
    });
  });

  // Presets
  const presetBtns = document.querySelectorAll('.btn-exp-preset');
  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      expressionControls.applyPreset(preset);
      showToast(`Preset "${btn.textContent}" aplicado`, 'info');
    });
  });

  // Test All demo mode
  const btnTestAll = $('btn-exp-test-all');
  if (btnTestAll) {
    btnTestAll.addEventListener('click', () => {
      if (expressionControls.isTestingAll) {
        expressionControls.stopTestAll();
        btnTestAll.classList.remove('active');
        btnTestAll.style.background = '';
        showToast('Demonstração de expressões pausada', 'info');
      } else {
        btnTestAll.classList.add('active');
        btnTestAll.style.background = 'rgba(99, 102, 241, 0.4)';
        showToast('Executando Test All (52 expressões ARKit)...', 'info');
        expressionControls.startTestAll(() => {
          btnTestAll.classList.remove('active');
          btnTestAll.style.background = '';
          showToast('Demonstração concluída', 'success');
        });
      }
    });
  }

  // Zero All
  const btnZeroAll = $('btn-exp-zero-all');
  if (btnZeroAll) {
    btnZeroAll.addEventListener('click', () => {
      expressionControls.zeroAll();
      showToast('Expressões faciais zeradas', 'info');
    });
  }

  // 2D Gaze Trackpad (Look Around)
  setupGazePad();

  // Botão Manual no Banner de Auto-Geração
  const btnGenerate = $('btn-generate-blendshapes');
  if (btnGenerate) {
    btnGenerate.addEventListener('click', () => {
      if (!renderer || !renderer.getModel()) {
        showToast('Nenhum modelo carregado na cena.', 'info');
        return;
      }
      const model = renderer.getInnerModel();
      const added = ensureModelBlendshapes(model, 0);
      if (added > 0) {
        const updated = buildModelMap(model);
        renderer._modelMap = updated.map;
        renderer.blendshapeCoverage = updated.coverage;
        $('model-coverage').textContent = `${updated.coverage} / 52 blendshapes mapeados`;
        const banner = $('box-auto-generate-blendshapes');
        if (banner) banner.style.display = 'none';
        showToast(`${added} blendshapes ARKit sintetizados com sucesso!`, 'success');
      } else {
        showToast('Não foi possível identificar malha facial compatível.', 'error');
      }
    });
  }
}

function setupGazePad() {
  const pad = $('gaze-pad');
  const thumb = $('gaze-thumb');
  const btnReset = $('btn-reset-gaze');
  if (!pad || !thumb) return;

  let isDraggingGaze = false;

  const updateGaze = (e) => {
    const rect = pad.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    thumb.style.left = `${x}px`;
    thumb.style.top = `${y}px`;

    // Normalized -1 to +1
    const normX = ((x / rect.width) * 2) - 1;
    const normY = ((y / rect.height) * 2) - 1;

    // Apply to eyeLook shapes
    if (expressionControls) {
      // Horizontal
      if (normX > 0) {
        expressionControls.setShape('eyeLookOutRight', normX);
        expressionControls.setShape('eyeLookInLeft', normX);
        expressionControls.setShape('eyeLookOutLeft', 0);
        expressionControls.setShape('eyeLookInRight', 0);
      } else {
        expressionControls.setShape('eyeLookOutLeft', -normX);
        expressionControls.setShape('eyeLookInRight', -normX);
        expressionControls.setShape('eyeLookOutRight', 0);
        expressionControls.setShape('eyeLookInLeft', 0);
      }

      // Vertical (Y is inverted in screen space: top is up)
      if (normY < 0) {
        expressionControls.setShape('eyeLookUpLeft', -normY);
        expressionControls.setShape('eyeLookUpRight', -normY);
        expressionControls.setShape('eyeLookDownLeft', 0);
        expressionControls.setShape('eyeLookDownRight', 0);
      } else {
        expressionControls.setShape('eyeLookDownLeft', normY);
        expressionControls.setShape('eyeLookDownRight', normY);
        expressionControls.setShape('eyeLookUpLeft', 0);
        expressionControls.setShape('eyeLookUpRight', 0);
      }
    }
  };

  const resetGaze = () => {
    thumb.style.left = '50%';
    thumb.style.top = '50%';
    if (expressionControls) {
      ['eyeLookOutRight', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight',
       'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight'].forEach((s) => {
        expressionControls.setShape(s, 0);
      });
    }
  };

  pad.addEventListener('pointerdown', (e) => {
    isDraggingGaze = true;
    pad.setPointerCapture(e.pointerId);
    updateGaze(e);
  });

  pad.addEventListener('pointermove', (e) => {
    if (isDraggingGaze) {
      updateGaze(e);
    }
  });

  const endGaze = (e) => {
    if (isDraggingGaze) {
      isDraggingGaze = false;
      try { pad.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };

  pad.addEventListener('pointerup', endGaze);
  pad.addEventListener('pointercancel', endGaze);

  if (btnReset) {
    btnReset.addEventListener('click', resetGaze);
  }
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

/* ─── Model Loader (Resilient Progressive Load with UI Blocker) ────────── */

async function loadModel(url, filename = '', assetMap = {}) {
  const displayName = (filename || url.split('/').pop() || 'model.glb').split('?')[0];
  $('model-name').textContent = 'Carregando...';
  $('model-coverage').textContent = 'Analisando morph targets';

  const selectPreset = /** @type {HTMLSelectElement} */ ($('select-model-preset'));
  if (selectPreset) {
    const matchingOpt = Array.from(selectPreset.options).find((opt) => opt.value === url || (displayName && opt.value.includes(displayName)));
    if (matchingOpt) {
      selectPreset.value = matchingOpt.value;
    }
  }

  // 1. Ativar Overlay Visual de Carregamento na Cena 3D e Bloquear Interações
  const overlay = $('model-loading-overlay');
  const titleEl = $('loading-model-title');
  const statusEl = $('loading-model-status');
  const barEl = $('loading-progress-bar');
  const pctEl = $('loading-progress-pct');
  const bytesEl = $('loading-progress-bytes');

  if (overlay) {
    overlay.classList.remove('hidden');
    document.body.classList.add('app-loading-active');
    if (titleEl) titleEl.textContent = displayName;
    if (statusEl) statusEl.textContent = 'Transferindo dados e texturas...';
    if (barEl) barEl.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    if (bytesEl) bytesEl.textContent = 'Iniciando...';
  }

  const onProgress = ({ loaded, total, percent }) => {
    if (percent >= 0) {
      if (barEl) barEl.style.width = `${percent}%`;
      if (pctEl) pctEl.textContent = `${percent}%`;
      if (bytesEl && total > 0) {
        const loadedMb = (loaded / (1024 * 1024)).toFixed(1);
        const totalMb = (total / (1024 * 1024)).toFixed(1);
        bytesEl.textContent = `${loadedMb} MB / ${totalMb} MB`;
      }
      if (percent >= 100 && statusEl) {
        statusEl.textContent = 'Descompactando malhas e compilando shaders...';
      }
    } else if (bytesEl) {
      const loadedMb = (loaded / (1024 * 1024)).toFixed(1);
      bytesEl.textContent = `${loadedMb} MB transferidos`;
    }
  };

  try {
    await renderer.loadModel(url, displayName, assetMap, onProgress);
    currentModelFilename = displayName;
    const coverage = renderer.blendshapeCoverage;
    $('model-name').textContent = displayName;
    $('model-coverage').textContent = `${coverage} / 52 blendshapes mapeados`;

    const bannerGen = $('box-auto-generate-blendshapes');
    if (bannerGen) {
      bannerGen.style.display = coverage < 10 ? 'block' : 'none';
    }

    showToast(`Modelo "${displayName}" pronto! (${coverage}/52 blendshapes)`, 'success');
  } catch (err) {
    console.error('Erro ao carregar modelo 3D:', err);
    $('model-name').textContent = displayName;
    $('model-coverage').textContent = 'Pronto para uso';
    showToast(`Erro ao carregar modelo: ${err.message}`, 'error');
  } finally {
    // 2. Desativar Overlay e Liberar Interações na UI
    if (overlay) {
      overlay.classList.add('hidden');
      document.body.classList.remove('app-loading-active');
    }
  }
}
