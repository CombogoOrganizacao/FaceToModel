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

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader }    from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader }     from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader }     from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader }     from 'three/addons/loaders/MTLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildModelMap, applyBlendShapes } from './blendshape-mapper.js';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Default background colour matches the app's CSS variable --bg-base */
const BG_COLOR = 0x050508;

/** Desirable FOV for a face close-up */
const CAMERA_FOV = 32;

/** Camera start position in model space */
const CAMERA_Z = 2.4;

/* ─── Renderer ──────────────────────────────────────────────────── */

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
      alpha: true,
      powerPreference: 'high-performance',
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this._renderer.outputColorSpace  = THREE.SRGBColorSpace;
    this._renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.1;

    /* ── Scene ── */
    this._scene = new THREE.Scene();

    /* ── Camera ── */
    const width = canvas.clientWidth || window.innerWidth || 800;
    const height = canvas.clientHeight || window.innerHeight || 600;
    const aspect = width / height;
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

    /* ── KTX2, Draco & GLTF Loaders ── */
    this._loader = new GLTFLoader();

    try {
      this._dracoLoader = new DRACOLoader();
      this._dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      this._loader.setDRACOLoader(this._dracoLoader);
    } catch (e) {
      console.warn('[Renderer] DRACOLoader indisponível:', e);
    }

    try {
      this._ktx2Loader = new KTX2Loader();
      this._ktx2Loader.setTranscoderPath('/libs/basis/');
      this._ktx2Loader.detectSupport(this._renderer);
      this._loader.setKTX2Loader(this._ktx2Loader);
    } catch (e) {
      console.warn('[Renderer] KTX2Loader indisponível:', e);
    }

    try {
      if (typeof MeshoptDecoder !== 'undefined') {
        this._loader.setMeshoptDecoder(MeshoptDecoder);
      }
    } catch (e) {
      console.warn('[Renderer] MeshoptDecoder indisponível:', e);
    }

    /* ── Clock ── */
    this._clock = new THREE.Clock();

    /* ── Model state ── */
    this._model = null;
    this._headBone = null;
    this._modelMap = {};
    this.blendshapeCoverage = 0;
    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsLast = performance.now();
    this._running = false;
    this._currentShadingMode = 'studio';
    this._showTextures = true;
    this._lightAzimuth = 45;
    this._lightElevation = 35;
    this._smoothLevel = 0.85;

    /* ── Organic Smoothing & 3DoF Rotation ── */
    this._targetBlendshapes = {};
    this._currentBlendshapes = {};
    this._targetRotation = { x: 0, y: 0, z: 0 };
    this._currentRotation = { x: 0, y: 0, z: 0 };

    /* ── ResizeObserver ── */
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(canvas.parentElement || document.body);
    this._onResize();
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */

  /**
   * Load a 3D model (.glb, .gltf, .fbx, .obj) and add it to the scene.
   * Supports texture maps and material files automatically.
   *
   * @param {string} url - URL or object URL of the model file
   * @param {string} [filename] - Optional filename to determine format extension
   * @param {Record<string, string>} [assetMap] - Optional map of auxiliary files (textures, .mtl)
   * @returns {Promise<THREE.Object3D>}
   */
  async loadModel(url, filename = '', assetMap = {}) {
    if (this._model) {
      this._scene.remove(this._model);
      this._model = null;
      this._modelMap = {};
      this.blendshapeCoverage = 0;
    }

    const lowerName = (filename || url).toLowerCase();
    console.log(`[Renderer] Loading 3D model (${lowerName}): ${url}`);

    let model;

    if (lowerName.endsWith('.fbx')) {
      const fbxLoader = new FBXLoader();
      const loadingManager = new THREE.LoadingManager();
      loadingManager.setURLModifier((itemUrl) => {
        const baseName = itemUrl.split('/').pop();
        if (assetMap[baseName]) return assetMap[baseName];
        if (assetMap[baseName.toLowerCase()]) return assetMap[baseName.toLowerCase()];
        return itemUrl;
      });
      fbxLoader.manager = loadingManager;
      model = await fbxLoader.loadAsync(url);
    } else if (lowerName.endsWith('.obj')) {
      const loadingManager = new THREE.LoadingManager();
      loadingManager.setURLModifier((itemUrl) => {
        const baseName = itemUrl.split('/').pop();
        if (assetMap[baseName]) return assetMap[baseName];
        if (assetMap[baseName.toLowerCase()]) return assetMap[baseName.toLowerCase()];
        return itemUrl;
      });

      // Check if there is an accompanying .mtl file
      const mtlKey = Object.keys(assetMap).find((k) => k.toLowerCase().endsWith('.mtl'));
      if (mtlKey) {
        try {
          const mtlLoader = new MTLLoader(loadingManager);
          const materials = await mtlLoader.loadAsync(assetMap[mtlKey]);
          materials.preload();
          const objLoader = new OBJLoader(loadingManager);
          objLoader.setMaterials(materials);
          model = await objLoader.loadAsync(url);
        } catch (mtlErr) {
          console.warn('[Renderer] Não foi possível carregar o arquivo .mtl, usando fallback padrão:', mtlErr);
          const objLoader = new OBJLoader(loadingManager);
          model = await objLoader.loadAsync(url);
        }
      } else {
        const objLoader = new OBJLoader(loadingManager);
        model = await objLoader.loadAsync(url);
      }
    } else {
      // Standard GLTF / GLB loader with KTX2 & DRACO
      const gltf = await this._loader.loadAsync(url);
      model = gltf.scene;
    }

    // Ensure all materials are double-sided, properly sorted for alpha blending, and eyes rendered realistically
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => {
            m.side = THREE.DoubleSide;

            const matName = (m.name || '').toLowerCase();
            // Corrigir especificamente o problema de olhos embaçados / escuros no MetaHuman
            if (matName.includes('eyeshell') || matName.includes('eyeedge') || matName.includes('saliva') || matName.includes('cartilage')) {
              m.transparent = true;
              m.opacity = 0.0; // Desativa a camada de oclusão turva sobre a íris
              m.depthWrite = false;
            } else if (matName.includes('eyeleft') || matName.includes('eyeright') || matName.includes('eyeball')) {
              m.roughness = 0.08; // Brilho vítreo e realista da córnea/olho
              m.metalness = 0.0;
              m.transparent = false;
              m.depthWrite = true;
            } else if (matName.includes('eyelashes') || matName.includes('eyebrow')) {
              m.transparent = true;
              m.depthWrite = true;
              m.alphaTest = 0.45; // Evita artefatos de classificação de transparência nos cílios e sobrancelhas
            }
          });
        }
      }
    });

    // Fix models that are authored facing away (+Z forward vs -Z forward)
    if (lowerName.includes('anime') || lowerName.includes('vrm')) {
      model.rotation.y = Math.PI;
    }

    // Centre and scale: if full-body model, frame specifically on the head/face
    const fullBox = new THREE.Box3().setFromObject(model);
    const fullSize = fullBox.getSize(new THREE.Vector3());

    let faceBox = new THREE.Box3();
    let hasFaceMesh = false;

    model.traverse((node) => {
      if (node.isMesh) {
        const hasMorphs = node.morphTargetDictionary && Object.keys(node.morphTargetDictionary).length > 5;
        const isFaceNamed = /(head|face|eye|teeth|mouth|hair)/i.test(node.name);
        if (hasMorphs || isFaceNamed) {
          if (!hasFaceMesh) {
            faceBox.setFromObject(node);
            hasFaceMesh = true;
          } else {
            faceBox.expandByObject(node);
          }
        }
      }
    });

    // If model is full body (aspect ratio tall) and face was found, center and scale on face
    const isFullBody = hasFaceMesh && (fullSize.y > fullSize.x * 1.5) && (faceBox.getSize(new THREE.Vector3()).y < fullSize.y * 0.6);
    const activeBox = isFullBody ? faceBox : fullBox;

    const size   = activeBox.getSize(new THREE.Vector3());
    const centre = activeBox.getCenter(new THREE.Vector3());

    const targetDim = isFullBody ? Math.max(size.x, size.y) * 1.5 : Math.max(fullSize.x, fullSize.y, fullSize.z);
    const scale  = 1.0 / (targetDim || 1);
    model.scale.setScalar(scale);
    model.position.sub(centre.multiplyScalar(scale));

    // Detect head bone if present (humanoid/ReadyPlayerMe models)
    this._headBone = null;
    model.traverse((node) => {
      if (!this._headBone && (node.isBone || node.type === 'Bone') && /(head|c_head|neck)/i.test(node.name)) {
        this._headBone = node;
      }
    });

    this._scene.add(model);
    this._model = model;

    // Reset rotation targets
    this._targetRotation = { x: 0, y: 0, z: 0 };
    this._currentRotation = { x: 0, y: 0, z: 0 };

    // Blendshape map
    const { map, coverage } = buildModelMap(model);
    this._modelMap          = map;
    this.blendshapeCoverage = coverage;

    // Cache original materials for non-destructive shading & texture toggles
    model.traverse((node) => {
      if (node.isMesh && node.material) {
        node.userData.originalMaterial = node.material;
      }
    });

    // Apply currently active shading mode and texture visibility
    this.setShadingMode(this._currentShadingMode);
    this.setTexturesEnabled(this._showTextures);

    this.resetCamera();
    console.log(`[Renderer] Model loaded successfully. Coverage: ${coverage}/52 (HeadBone: ${this._headBone ? this._headBone.name : 'root'})`);
    return model;
  }

  /**
   * Toggle texture maps on and off across the model.
   * @param {boolean} enabled
   */
  setTexturesEnabled(enabled) {
    this._showTextures = Boolean(enabled);
    if (!this._model) return;

    this._model.traverse((node) => {
      if (node.isMesh && node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => {
          if (m.map !== undefined) {
            if (!enabled) {
              if (m.map && !m.userData.cachedMap) {
                m.userData.cachedMap = m.map;
              }
              m.map = null;
            } else if (m.userData.cachedMap) {
              m.map = m.userData.cachedMap;
            }
            m.needsUpdate = true;
          }
        });
      }
    });
  }

  /**
   * Apply a set of MediaPipe blendshape values and head rotation to the model.
   * Uses continuous EMA smoothing in the render loop to eliminate camera jitter.
   *
   * @param {Record<string, number>} blendShapes - Map of 52 blendshape keys to scores
   * @param {{ pitch?: number, yaw?: number, roll?: number }} [rotation] - Head rotation in radians
   */
  applyBlendShapes(blendShapes, rotation = null) {
    if (blendShapes) {
      this._targetBlendshapes = blendShapes;
    }
    if (rotation) {
      this._targetRotation = {
        x: rotation.pitch || 0,
        y: rotation.yaw || 0,
        z: rotation.roll || 0,
      };
    }
  }

  /**
   * Returns top active blendshapes currently firing (> 0.05).
   * @param {number} topN
   * @returns {Array<{ name: string, value: number }>}
   */
  getActiveBlendshapes(topN = 5) {
    return Object.entries(this._currentBlendshapes)
      .map(([name, value]) => ({ name, value: Math.max(0, Math.min(1, value)) }))
      .filter((item) => item.value > 0.05)
      .sort((a, b) => b.value - a.value)
      .slice(0, topN);
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
   * Set real-time viewport shading / lighting mode (Blender style)
   * @param {'studio'|'sunset'|'cyber'|'clay'|'normals'|'wireframe'} mode
   */
  setShadingMode(mode) {
    this._currentShadingMode = mode;
    if (!this._ambientLight || !this._keyLight) return;

    // Reset default lighting intensities & colors
    switch (mode) {
      case 'sunset':
        this._keyLight.color.setHex(0xffaa44);
        this._keyLight.intensity = 2.8;
        this._keyLight.position.set(2.5, 1.2, 1.8);
        this._fillLight.color.setHex(0x7040aa);
        this._fillLight.intensity = 0.8;
        this._fillLight.position.set(-2.0, 0.2, 1.0);
        this._rimLight.color.setHex(0xff6622);
        this._rimLight.intensity = 1.4;
        this._rimLight.position.set(0, 1.5, -2.0);
        this._ambientLight.color.setHex(0xffe0cc);
        this._ambientLight.intensity = 0.45;
        break;

      case 'cyber':
        this._keyLight.color.setHex(0x00f0ff);
        this._keyLight.intensity = 2.4;
        this._keyLight.position.set(2.0, 1.5, 1.5);
        this._fillLight.color.setHex(0xff0077);
        this._fillLight.intensity = 1.8;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0x7700ff);
        this._rimLight.intensity = 2.0;
        this._rimLight.position.set(0, 1.5, -2.5);
        this._ambientLight.color.setHex(0x08041a);
        this._ambientLight.intensity = 0.35;
        break;

      case 'toon':
        this._keyLight.color.setHex(0xffffff);
        this._keyLight.intensity = 2.4;
        this._keyLight.position.set(2.0, 2.0, 2.0);
        this._fillLight.color.setHex(0x99bbff);
        this._fillLight.intensity = 0.5;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xffffff);
        this._rimLight.intensity = 0.8;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xffffff);
        this._ambientLight.intensity = 0.8;
        break;

      case 'smooth':
        this._keyLight.color.setHex(0xfffaee);
        this._keyLight.intensity = 1.4;
        this._keyLight.position.set(1.5, 1.8, 2.0);
        this._fillLight.color.setHex(0xffe4db);
        this._fillLight.intensity = 1.0;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xffffff);
        this._rimLight.intensity = 0.6;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xfff5f0);
        this._ambientLight.intensity = 1.2;
        break;

      case 'clay':
      case 'normals':
      case 'wireframe':
      case 'studio':
      default:
        // Balanced Studio 3-point light
        this._keyLight.color.setHex(0xfff5e0);
        this._keyLight.intensity = 2.0;
        this._keyLight.position.set(1.5, 2.0, 2.0);
        this._fillLight.color.setHex(0xd0e8ff);
        this._fillLight.intensity = 1.0;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xaa88ff);
        this._rimLight.intensity = 0.8;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xffffff);
        this._ambientLight.intensity = 0.7;
        break;
    }

    if (!this._model) return;

    // Apply materials
    this._model.traverse((node) => {
      if (node.isMesh) {
        const orig = node.userData.originalMaterial;
        if (!orig) return;

        if (mode === 'clay') {
          if (!node.userData.clayMaterial) {
            node.userData.clayMaterial = new THREE.MeshStandardMaterial({
              color: 0xccbba8,
              roughness: 0.65,
              metalness: 0.05,
              flatShading: false,
            });
          }
          node.material = node.userData.clayMaterial;
          node.material.wireframe = false;
        } else if (mode === 'normals') {
          if (!node.userData.normalMaterial) {
            node.userData.normalMaterial = new THREE.MeshNormalMaterial({
              flatShading: false,
            });
          }
          node.material = node.userData.normalMaterial;
          node.material.wireframe = false;
        } else if (mode === 'toon') {
          if (!node.userData.toonMaterial) {
            const baseMat = Array.isArray(orig) ? orig[0] : orig;
            node.userData.toonMaterial = new THREE.MeshToonMaterial({
              color: (baseMat && baseMat.color) ? baseMat.color.clone() : new THREE.Color(0xffffff),
              map: (baseMat && baseMat.map) ? baseMat.map : null,
              wireframe: false,
            });
          }
          node.material = node.userData.toonMaterial;
          node.material.wireframe = false;
        } else if (mode === 'smooth') {
          // Non-destructive smooth wrap without modifying geometry normals
          if (!node.userData.smoothMaterial) {
            const baseMat = Array.isArray(orig) ? orig[0] : orig;
            node.userData.smoothMaterial = new THREE.MeshStandardMaterial({
              color: (baseMat && baseMat.color) ? baseMat.color.clone() : new THREE.Color(0xffffff),
              map: (baseMat && baseMat.map) ? baseMat.map : null,
              roughness: 0.45 + (this._smoothLevel * 0.5),
              metalness: 0.02,
              wireframe: false,
            });
          } else {
            node.userData.smoothMaterial.roughness = 0.45 + (this._smoothLevel * 0.5);
          }
          node.material = node.userData.smoothMaterial;
          node.material.wireframe = false;
        } else if (mode === 'wireframe') {
          node.material = orig;
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => { m.wireframe = true; });
        } else {
          // Restore original material
          node.material = orig;
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => { m.wireframe = false; });
        }
      }
    });

    // Reapply user's light direction
    this._updateLightPosition();
  }

  /**
   * Set directional light orientation around the model.
   * @param {number} azimuthDeg - Horizontal angle (0° to 360°)
   * @param {number} elevationDeg - Vertical angle (-30° to 90°)
   */
  setLightDirection(azimuthDeg, elevationDeg) {
    this._lightAzimuth = Number(azimuthDeg);
    this._lightElevation = Number(elevationDeg);
    this._updateLightPosition();
  }

  /**
   * Set smoothness level for smooth shader (0.0 to 1.0).
   * @param {number} level - 0.0 to 1.0
   */
  setSmoothLevel(level) {
    this._smoothLevel = Math.max(0, Math.min(1, Number(level)));
    if (!this._model) return;
    this._model.traverse((node) => {
      if (node.isMesh && node.userData.smoothMaterial) {
        node.userData.smoothMaterial.roughness = 0.45 + (this._smoothLevel * 0.5);
      }
    });
  }

  _updateLightPosition() {
    if (!this._keyLight) return;
    const radAzimuth = (this._lightAzimuth * Math.PI) / 180;
    const radElev = (this._lightElevation * Math.PI) / 180;
    const dist = 3.2;

    const x = dist * Math.cos(radElev) * Math.sin(radAzimuth);
    const y = dist * Math.sin(radElev);
    const z = dist * Math.cos(radElev) * Math.cos(radAzimuth);

    this._keyLight.position.set(x, y, z);
  }

  /**
   * Immediately updates model blendshapes/rotation and renders a frame.
   * Used for deterministic, non-interpolated offline rendering at 60 FPS.
   * @param {Record<string, number>} blendShapes
   * @param {{ pitch?: number, yaw?: number, roll?: number }|null} [rotation]
   */
  renderDirectFrame(blendShapes, rotation = null) {
    if (this._model && blendShapes) {
      applyBlendShapes(this._modelMap, blendShapes);
    }
    if (rotation) {
      const rx = rotation.pitch || 0;
      const ry = rotation.yaw || 0;
      const rz = rotation.roll || 0;
      if (this._headBone) {
        this._headBone.rotation.set(rx, ry, rz);
      } else if (this._model) {
        this._model.rotation.set(rx, ry, rz);
      }
    }
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Set canvas to Full HD 1080p (1920x1080) for high-definition video export.
   */
  setExport1080p(enable = true) {
    if (enable) {
      this._renderer.setPixelRatio(1);
      this._renderer.setSize(1920, 1080, false);
      this._camera.aspect = 1920 / 1080;
      this._camera.updateProjectionMatrix();
    } else {
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this._onResize();
    }
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
    this._ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this._scene.add(this._ambientLight);

    this._keyLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
    this._keyLight.position.set(1.5, 2.0, 2.0);
    this._keyLight.castShadow = true;
    this._keyLight.shadow.mapSize.set(1024, 1024);
    this._scene.add(this._keyLight);

    this._fillLight = new THREE.DirectionalLight(0xd0e8ff, 1.0);
    this._fillLight.position.set(-2.0, 0.5, 1.5);
    this._scene.add(this._fillLight);

    this._rimLight = new THREE.DirectionalLight(0xaa88ff, 0.8);
    this._rimLight.position.set(0, 1.0, -2.0);
    this._scene.add(this._rimLight);

    this._updateLightPosition();
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    this._controls.update();

    // ── 1. Organic Lerp / EMA Smoothing for Blendshapes ──
    const alpha = 0.38;
    for (const [key, target] of Object.entries(this._targetBlendshapes)) {
      const cur = this._currentBlendshapes[key] || 0;
      this._currentBlendshapes[key] = cur + (target - cur) * alpha;
    }

    if (this._model && Object.keys(this._currentBlendshapes).length > 0) {
      applyBlendShapes(this._modelMap, this._currentBlendshapes);
    }

    // ── 2. Organic Head Pose / Rotation Lerp (3DoF) ──
    const rotAlpha = 0.25;
    this._currentRotation.x += (this._targetRotation.x - this._currentRotation.x) * rotAlpha;
    this._currentRotation.y += (this._targetRotation.y - this._currentRotation.y) * rotAlpha;
    this._currentRotation.z += (this._targetRotation.z - this._currentRotation.z) * rotAlpha;

    if (this._headBone) {
      this._headBone.rotation.set(this._currentRotation.x, this._currentRotation.y, this._currentRotation.z);
    } else if (this._model) {
      this._model.rotation.set(this._currentRotation.x, this._currentRotation.y, this._currentRotation.z);
    }

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
