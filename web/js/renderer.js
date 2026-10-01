/**
 * @fileoverview FaceToModel — Three.js Renderer
 *
 * Encapsulates the entire Three.js rendering pipeline:
 *   - WebGLRenderer with antialiasing and shadow maps
 *   - Scene with dark background, ambient + key + fill + rim lighting
 *   - PerspectiveCamera configured for close-up face view
 *   - OrbitControls for mouse / touch navigation
 *   - GLTFLoader + KTX2Loader + MeshoptDecoder for modern .glb / .gltf models
 *   - ResizeObserver for responsive canvas sizing
 *   - Blendshape application via the blendshape-mapper module
 *
 * @module renderer
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }    from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader }    from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/libs/meshopt_decoder.module.js';
import { buildModelMap, applyBlendShapes } from './blendshape-mapper.js';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Default background colour matches the app's CSS variable --bg-base */
const BG_COLOR = 0x0d0d1a;

/** Desirable FOV for a face close-up */
const CAMERA_FOV = 30;

/** Camera start position in model space */
const CAMERA_Z = 2.5;

/* ─── Renderer ──────────────────────────────────────────────────────────── */

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas - The canvas element to render into
   */
  constructor(canvas) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /* ── WebGLRenderer ── */
    this._renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this._renderer.outputColorSpace  = THREE.SRGBColorSpace;
    this._renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.0;

    /* ── Scene ── */
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(BG_COLOR);
    this._scene.fog = new THREE.FogExp2(BG_COLOR, 0.04);

    /* ── Camera ── */
    const aspect = canvas.clientWidth / canvas.clientHeight || 1;
    this._camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.01, 100);
    this._camera.position.set(0, 0, CAMERA_Z);

    /* ── Lighting ── */
    this._setupLighting();

    /* ── OrbitControls ── */
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping    = true;
    this._controls.dampingFactor    = 0.07;
    this._controls.rotateSpeed      = 0.6;
    this._controls.zoomSpeed        = 0.8;
    this._controls.minDistance      = 0.3;
    this._controls.maxDistance      = 8;
    this._controls.target.set(0, 0, 0);
    this._controls.update();

    /* ── KTX2 & GLTF Loaders ── */
    this._ktx2Loader = new KTX2Loader();
    this._ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/libs/basis/');
    this._ktx2Loader.detectSupport(this._renderer);

    this._loader = new GLTFLoader();
    this._loader.setKTX2Loader(this._ktx2Loader);
    this._loader.setMeshoptDecoder(MeshoptDecoder);

    /* ── Clock ── */
    this._clock = new THREE.Clock();

    /* ── Model state ── */
    this._model = null;
    this._modelMap = {};
    this.blendshapeCoverage = 0;
    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsLast = performance.now();
    this._running = false;

    /* ── ResizeObserver ── */
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(canvas.parentElement || document.body);
    this._onResize();
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */

  /**
   * Load a GLTF/GLB model, add it to the scene, and rebuild the blendshape map.
   * @param {string} url - URL or object URL of the .glb / .gltf file
   * @returns {Promise<THREE.Object3D>}
   */
  async loadModel(url) {
    if (this._model) {
      this._scene.remove(this._model);
      this._model = null;
      this._modelMap = {};
      this.blendshapeCoverage = 0;
    }

    console.log(`[Renderer] Loading model: ${url}`);

    const gltf = await this._loader.loadAsync(url, (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        console.debug(`[Renderer] Load progress: ${pct}%`);
      }
    });

    const model = gltf.scene;

    // Centre and scale
    const box    = new THREE.Box3().setFromObject(model);
    const size   = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const scale  = 1.0 / (maxDim || 1);
    model.scale.setScalar(scale);
    model.position.sub(centre.multiplyScalar(scale));

    // Shadows
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow    = true;
        node.receiveShadow = true;
      }
    });

    this._scene.add(model);
    this._model = model;

    // Blendshape map
    const { map, coverage } = buildModelMap(model);
    this._modelMap          = map;
    this.blendshapeCoverage = coverage;

    this.resetCamera();
    console.log(`[Renderer] Model loaded successfully. Coverage: ${coverage}/52`);
    return model;
  }

  /**
   * Apply a set of ARKit/MediaPipe blendshape values to the model.
   * @param {Record<string, number>} blendShapes
   */
  applyBlendShapes(blendShapes) {
    if (!this._model) return;
    applyBlendShapes(this._modelMap, blendShapes);
  }

  /**
   * Toggle wireframe mode.
   * @param {boolean} enabled
   */
  setWireframe(enabled) {
    if (!this._model) return;
    this._model.traverse((node) => {
      if (node.isMesh && node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => { m.wireframe = enabled; });
      }
    });
  }

  /**
   * Show/hide scene background.
   * @param {boolean} visible
   */
  setBackgroundVisible(visible) {
    this._scene.background = visible ? new THREE.Color(BG_COLOR) : null;
    this._scene.fog        = visible ? new THREE.FogExp2(BG_COLOR, 0.04) : null;
  }

  /**
   * Reset camera position.
   */
  resetCamera() {
    this._camera.position.set(0, 0, CAMERA_Z);
    this._camera.lookAt(0, 0, 0);
    this._controls.target.set(0, 0, 0);
    this._controls.update();
  }

  getCanvas() {
    return this.canvas;
  }

  startLoop() {
    if (this._running) return;
    this._running = true;
    this._loop();
  }

  stopLoop() {
    this._running = false;
  }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  _setupLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this._scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
    keyLight.position.set(1.5, 2.0, 2.0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far  = 20;
    this._scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd0e8ff, 0.8);
    fillLight.position.set(-2.0, 0.5, 1.5);
    this._scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xaa88ff, 0.6);
    rimLight.position.set(0, 1.0, -2.0);
    this._scene.add(rimLight);
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    this._controls.update();

    this._fpsFrames++;
    const now     = performance.now();
    const elapsed = now - this._fpsLast;
    if (elapsed >= 1000) {
      this.fps          = Math.round(this._fpsFrames * (1000 / elapsed));
      this._fpsFrames   = 0;
      this._fpsLast     = now;
    }

    this._renderer.render(this._scene, this._camera);
  }

  _onResize() {
    const el = this.canvas.parentElement || document.body;
    const w  = el.clientWidth;
    const h  = el.clientHeight;

    if (w === 0 || h === 0) return;

    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }
}
