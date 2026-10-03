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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildModelMap, applyBlendShapes } from './blendshape-mapper.js';
import { ensureModelBlendshapes } from './blendshape-synthesizer.js';
import { modelCache } from './model-cache.js';

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

    /* ── WebGLRenderer (Unreal Engine ACES Tone Mapping & PBR Precision) ── */
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
    this._renderer.toneMappingExposure = 1.15;

    /* ── Scene & Unreal Engine Studio IBL Environment ── */
    this._scene = new THREE.Scene();
    const pmremGenerator = new THREE.PMREMGenerator(this._renderer);
    pmremGenerator.compileEquirectangularShader();
    const roomEnv = new RoomEnvironment();
    this._envMap = pmremGenerator.fromScene(roomEnv).texture;
    this._scene.environment = this._envMap;
    pmremGenerator.dispose();
    roomEnv.dispose();

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
    this._neckBone = null;
    this._isFullBody = false;
    this._modelMap = {};
    this.blendshapeCoverage = 0;
    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsLast = performance.now();
    this._running = false;
    this._currentShadingMode = 'unreal';
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
   * Supports texture maps, material files, and high-performance IndexedDB binary caching.
   *
   * @param {string} url - URL or object URL of the model file
   * @param {string} [filename] - Optional filename to determine format extension
   * @param {Record<string, string>} [assetMap] - Optional map of auxiliary files (textures, .mtl)
   * @param {function({ loaded: number, total: number, percent: number }): void} [onProgress] - Progress callback
   * @returns {Promise<THREE.Object3D>}
   */
  async loadModel(url, filename = '', assetMap = {}, onProgress = null) {
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
      // Standard GLTF / GLB loader with KTX2, DRACO and IndexedDB Binary Cache
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        const gltf = await this._loader.loadAsync(url, onProgress ? (xhr) => {
          if (xhr.lengthComputable) {
            onProgress({ loaded: xhr.loaded, total: xhr.total, percent: Math.round((xhr.loaded / xhr.total) * 100) });
          }
        } : undefined);
        model = gltf.scene;
      } else {
        // Stream / load from IndexedDB cache with progress
        const buffer = await modelCache.fetchWithCache(url, onProgress);
        const gltf = await this._loader.parseAsync(buffer, '');
        model = gltf.scene;
      }
    }

    // Ensure all materials are double-sided, properly sorted for alpha blending, and skin/eyes/hair rendered with Unreal Engine realistic PBR
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          const newMats = mats.map((m) => {
            m.side = THREE.DoubleSide;

            const matName = (m.name || '').toLowerCase();

            // 1. Pele / Cabeça / Corpo do MetaHuman e Avatares PBR
            if (matName.includes('head_shader') || matName.includes('body_mi') || matName.includes('skin') || matName.includes('face')) {
              m.roughness = 0.58; // Rugosidade natural de pele humana (micro-textura)
              m.metalness = 0.0;
              if (m.specularIntensity !== undefined) m.specularIntensity = 0.35;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.45;
              return m;
            }
            // 2. Fios de Cabelo do MetaHuman (Strand-Based Groom Shader no padrão Unreal Engine 5.8 / Marschner Dual-Lobe)
            else if (matName.includes('hair') || (matName.includes('cards_m') && !matName.includes('eyebrow'))) {
              const strandGroom = this._createProceduralHairStrands();
              const hairMat = new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(0x1a120d), // Base melanin espresso rica da Unreal Engine (#1a120d)
                map: strandGroom.map,
                alphaMap: strandGroom.alphaMap,
                normalMap: m.normalMap || null,
                roughness: 0.28, // Fibra suave de queratina
                metalness: 0.0,
                clearcoat: 0.45, // Lobo R primário: cutícula superficial nítida e translúcida
                clearcoatRoughness: 0.18,
                specularIntensity: 0.95, // Especularidade nítida dos fios
                specularColor: new THREE.Color(0x9d6c48), // Reflexo secundário TRT córtex
                anisotropy: 0.92, // Anisotropia acentuada ao longo da extensão das fibras
                anisotropyRotation: Math.PI / 2,
                sheen: 0.85, // Dispersão de luz transmitida interna entre os fios
                sheenColor: new THREE.Color(0x422615),
                sheenRoughness: 0.30,
                transparent: true,
                alphaTest: 0.12,
                depthWrite: true,
                depthTest: true,
                alphaToCoverage: true,
                side: THREE.DoubleSide,
                name: m.name,
              });

              // Injeção de Shader Customizado: Marschner Dual-Lobe e Micro-Perturbação de Fios
              hairMat.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                  '#include <roughnessmap_fragment>',
                  `#include <roughnessmap_fragment>
                  // Procedural micro-strand normal shift along hair fibers
                  vec2 strandCoord = vUv * vec2(240.0, 1.0);
                  float strandSheen = sin(strandCoord.x * 3.14159) * 0.08;
                  roughnessFactor = clamp(roughnessFactor + strandSheen, 0.15, 0.65);
                  `
                );
              };

              if (hairMat.envMapIntensity !== undefined) hairMat.envMapIntensity = 0.50;
              return hairMat;
            }
            // 3. Sobrancelhas (Eyebrows — Procedural Micro-Strand Texture + Anisotropia + PolygonOffset)
            else if (matName.includes('eyebrow')) {
              const browGroom = this._createProceduralEyebrowTextures();
              const browMat = new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(0x160f0a),
                map: browGroom.map,
                alphaMap: browGroom.alphaMap,
                roughness: 0.32,
                metalness: 0.0,
                specularIntensity: 0.65,
                specularColor: new THREE.Color(0x5c3b24),
                anisotropy: 0.80,
                anisotropyRotation: Math.PI / 2,
                sheen: 0.45,
                sheenColor: new THREE.Color(0x381f10),
                transparent: true,
                alphaTest: 0.10,
                depthWrite: true,
                depthTest: true,
                polygonOffset: true,
                polygonOffsetFactor: -3,
                polygonOffsetUnits: -6,
                alphaToCoverage: true,
                side: THREE.DoubleSide,
                name: m.name,
              });
              if (browMat.envMapIntensity !== undefined) browMat.envMapIntensity = 0.45;
              return browMat;
            }
            // 4. Cílios (Eyelashes / LashMat — UE 5.8 Vertex Color Root-to-Tip Tapering)
            else if (matName.includes('eyelashes') || matName.includes('lashmat')) {
              const hasVertexColor = Boolean(node.geometry && node.geometry.attributes && node.geometry.attributes.color);
              const lashTex = this._createProceduralEyelashTextures();
              const lashMat = new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(0x100b08), // Tom ébano natural profundo
                map: lashTex.map,
                alphaMap: lashTex.alphaMap,
                roughness: 0.25, // Fios hidratados com brilho delicado
                metalness: 0.0,
                specularIntensity: 0.75,
                specularColor: new THREE.Color(0x604533),
                sheen: 0.40,
                sheenColor: new THREE.Color(0x281910),
                transparent: true,
                alphaTest: 0.14,
                depthWrite: true,
                depthTest: true,
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -4,
                alphaToCoverage: true,
                side: THREE.DoubleSide,
                vertexColors: hasVertexColor,
                name: m.name,
              });

              // Tapering e gradiente raiz-ponta do MetaHuman
              lashMat.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                  '#include <alphamap_fragment>',
                  `#include <alphamap_fragment>
                  // Soft root-to-tip tapering curve
                  float tipTaper = smoothstep(0.0, 0.92, 1.0 - abs(vUv.y - 0.5) * 1.8);
                  diffuseColor.a *= clamp(tipTaper, 0.1, 1.0);
                  `
                );
              };

              if (lashMat.envMapIntensity !== undefined) lashMat.envMapIntensity = 0.55;
              return lashMat;
            }
            // 5. Roupas e Tecidos
            else if (matName.includes('top_') || matName.includes('btm_') || matName.includes('slacks') || matName.includes('shirt') || matName.includes('cloth') || matName.includes('outfit')) {
              m.roughness = 0.85; // Tecido fosco
              m.metalness = 0.0;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.2;
              return m;
            }
            // 6. Dentes e Boca
            else if (matName.includes('teeth')) {
              m.roughness = 0.28;
              m.metalness = 0.0;
              return m;
            }
            // 7. Camadas Oclusoras dos Olhos / Hidden Shells (desativar para não cobrir o globo ocular)
            else if (matName.includes('eyeshell') || matName.includes('eyeedge') || matName.includes('saliva') || matName.includes('cartilage') || matName.includes('m_hide') || matName.includes('lacrimal')) {
              m.transparent = true;
              m.opacity = 0.0;
              m.depthWrite = false;
              m.visible = false;
              return m;
            }
            // 8. Globo Ocular / Íris / Esclera
            else if (matName.includes('eyeleft') || matName.includes('eyeright') || matName.includes('eyeball') || matName.includes('eyel_baked') || matName.includes('eyer_baked')) {
              m.roughness = 0.12; // Córnea nítida com reflexo especular equilibrado
              m.metalness = 0.0;
              m.transparent = false;
              m.opacity = 1.0;
              m.depthWrite = true;
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.2;
              return m;
            }
            return m;
          });

          node.material = Array.isArray(node.material) ? newMats : newMats[0];
        }
      }
    });

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

    // Create a unified Pivot container for harmonious 3DoF head rotation without detached hair
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'FaceToModel_Pivot';

    model.scale.setScalar(scale);
    model.position.sub(centre.multiplyScalar(scale));
    pivotGroup.add(model);

    this._scene.add(pivotGroup);
    this._model = pivotGroup;
    this._innerModel = model;

    // Reset rotation targets
    this._targetRotation = { x: 0, y: 0, z: 0 };
    this._currentRotation = { x: 0, y: 0, z: 0 };

    // Blendshape map
    let { map, coverage } = buildModelMap(model);

    // Auto-Synthesize ARKit 52 Blendshapes if absent (< 10 blendshapes)
    if (coverage < 10) {
      const synthesizedCount = ensureModelBlendshapes(model, coverage);
      if (synthesizedCount > 0) {
        const updated = buildModelMap(model);
        map = updated.map;
        coverage = updated.coverage;
        console.log(`[Renderer] Auto-Blendshapes: ${synthesizedCount} expressões ARKit geradas com sucesso. Nova cobertura: ${coverage}/52`);
      }
    }

    this._modelMap          = map;
    this.blendshapeCoverage = coverage;

    // Discover skeletal head and neck bones (for humanoid rigs, MetaHuman, Mixamo, VRoid/VRM, ReadyPlayerMe)
    let headBone = null;
    let neckBone = null;

    const isExcluded = (n) => /(hair|forehead|headtop|headend|eye|ear|jaw|mouth|teeth|tongue|lip|cheek|eyebrow|12ipv|neckback|neckb|necka|clavicle|skin|facial_c_)/i.test(n);
    const headRegex = /(^|[_\-:])head(_[0-9]+)?($|[_\-:0-9])/i;
    const neckRegex = /(^|[_\-:])neck(_[0-9]+)?($|[_\-:0-9])/i;

    model.traverse((node) => {
      if (node.isBone) {
        const name = node.name || '';
        if (!headBone && headRegex.test(name) && !isExcluded(name)) {
          headBone = node;
        }
        if (!neckBone && neckRegex.test(name) && !isExcluded(name)) {
          neckBone = node;
        }
      }
    });

    if (headBone) {
      headBone.userData.restEuler = headBone.rotation.clone();
      headBone.userData.restQuaternion = headBone.quaternion.clone();
      console.log(`[Renderer] Osso de Cabeça detectado: "${headBone.name}" (O corpo permanecerá 100% fixo)`);
    }
    if (neckBone) {
      neckBone.userData.restEuler = neckBone.rotation.clone();
      neckBone.userData.restQuaternion = neckBone.quaternion.clone();
      console.log(`[Renderer] Osso de Pescoço detectado: "${neckBone.name}"`);
    }

    this._headBone = headBone;
    this._neckBone = neckBone;
    this._isFullBody = isFullBody;

    // Head Attachments: Detect non-skinned meshes attached to the head (hair, eyebrows, scalp, beard, accessories)
    // so they rigidly follow the skeletal head bone rotation instead of remaining static.
    this._headAttachments = [];
    if (headBone) {
      // Force update of world matrices in rest pose
      model.updateMatrixWorld(true);
      const invHeadWorld = new THREE.Matrix4().copy(headBone.matrixWorld).invert();

      model.traverse((node) => {
        if (node.isMesh && !node.isSkinnedMesh) {
          const nName = (node.name || '').toLowerCase();
          const mName = (node.material?.name || '').toLowerCase();
          const isHeadPart = /(hair|eyebrow|beard|mustache|eyelash|scalp|head_att|cap|hat|glasses)/i.test(nName) ||
                             /(hair|eyebrow|beard|mustache|eyelash|scalp)/i.test(mName);

          if (isHeadPart) {
            // Compute transform of mesh relative to head bone at rest pose
            const relativeMatrix = new THREE.Matrix4().multiplyMatrices(invHeadWorld, node.matrixWorld);
            this._headAttachments.push({
              mesh: node,
              relativeMatrix: relativeMatrix,
              originalParent: node.parent
            });
            console.log(`[Renderer] Fixação Dinâmica de Cabeça ativada: "${node.name}" vinculada ao osso "${headBone.name}"`);
          }
        }
      });
    }

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
    console.log(`[Renderer] Model loaded successfully. Coverage: ${coverage}/52 blendshapes`);
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

      case 'unreal':
        // Unreal Engine 5 Lumen / Cinematic Lighting setup matching UE5 studio portrait
        this._keyLight.color.setHex(0xfffaec);
        this._keyLight.intensity = 3.0;
        this._keyLight.position.set(2.2, 2.6, 2.4);
        this._fillLight.color.setHex(0x94a3b8);
        this._fillLight.intensity = 0.85;
        this._fillLight.position.set(-2.4, 0.6, 1.8);
        this._rimLight.color.setHex(0x93c5fd);
        this._rimLight.intensity = 2.0;
        this._rimLight.position.set(0.4, 2.0, -2.6);
        this._ambientLight.color.setHex(0x1e293b);
        this._ambientLight.intensity = 0.5;
        if (this._scene) this._scene.environment = this._envMap;
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
        if (this._scene) this._scene.environment = this._envMap;
        break;
    }

    if (!this._model) return;

    // Apply materials non-destructively preserving alpha cutouts and transparency
    this._model.traverse((node) => {
      if (node.isMesh) {
        const orig = node.userData.originalMaterial;
        if (!orig) return;
        node.material = this._getShaderMaterial(orig, mode, node);
      }
    });

    // Reapply user's light direction
    this._updateLightPosition();
  }

  /**
   * Helper to produce a shader-mode specific material while strictly preserving
   * transparency, alphaCutout maps, opacity, doubleSided properties and hidden layers.
   * Prevents eye highlights, eyelashes, and decals from turning into solid black rectangles.
   *
   * @param {THREE.Material|THREE.Material[]} orig
   * @param {string} mode
   * @param {THREE.Mesh} node
   * @returns {THREE.Material|THREE.Material[]}
   */
  _getShaderMaterial(orig, mode, node) {
    if (!orig) return orig;
    if (Array.isArray(orig)) {
      return orig.map((m) => this._getShaderMaterial(m, mode, node));
    }

    // 1. Layers that must remain invisible / occlusion shells (e.g. MetaHuman eyeshell / saliva / hide)
    if (orig.visible === false || orig.opacity === 0) {
      return orig;
    }
    const matName = (orig.name || '').toLowerCase();
    const isHiddenOccluder = matName.includes('eyeshell') || matName.includes('eyeedge') || matName.includes('saliva') || matName.includes('cartilage') || matName.includes('m_hide') || matName.includes('lacrimal');
    if (isHiddenOccluder) {
      return orig;
    }

    // 2. Detect if material relies on alpha cutout (eyelashes, hair cards, eye highlights, decals)
    const isAlpha = Boolean(
      orig.transparent ||
      (orig.alphaTest && orig.alphaTest > 0) ||
      orig.alphaMap ||
      matName.includes('lash') ||
      matName.includes('hair') ||
      matName.includes('brow') ||
      matName.includes('card') ||
      matName.includes('alpha') ||
      matName.includes('decal')
    );

    const baseAlphaTest = orig.alphaTest > 0 ? orig.alphaTest : (isAlpha ? 0.35 : 0);
    const baseSide = orig.side || THREE.DoubleSide;

    switch (mode) {
      case 'toon': {
        const mat = new THREE.MeshToonMaterial({
          color: orig.color ? orig.color.clone() : new THREE.Color(0xffffff),
          map: orig.map || null,
          alphaMap: orig.alphaMap || null,
          transparent: isAlpha || Boolean(orig.transparent),
          alphaTest: baseAlphaTest,
          side: baseSide,
          depthWrite: orig.depthWrite !== undefined ? orig.depthWrite : true,
          depthTest: orig.depthTest !== undefined ? orig.depthTest : true,
          polygonOffset: Boolean(orig.polygonOffset),
          polygonOffsetFactor: orig.polygonOffsetFactor || 0,
          polygonOffsetUnits: orig.polygonOffsetUnits || 0,
          alphaToCoverage: Boolean(orig.alphaToCoverage),
          wireframe: false,
        });
        return mat;
      }

      case 'smooth': {
        const mat = new THREE.MeshPhysicalMaterial({
          color: orig.color ? orig.color.clone() : new THREE.Color(0xffffff),
          map: orig.map || null,
          alphaMap: orig.alphaMap || null,
          normalMap: orig.normalMap || null,
          transparent: isAlpha || Boolean(orig.transparent),
          alphaTest: baseAlphaTest,
          side: baseSide,
          depthWrite: orig.depthWrite !== undefined ? orig.depthWrite : true,
          depthTest: orig.depthTest !== undefined ? orig.depthTest : true,
          polygonOffset: Boolean(orig.polygonOffset),
          polygonOffsetFactor: orig.polygonOffsetFactor || 0,
          polygonOffsetUnits: orig.polygonOffsetUnits || 0,
          alphaToCoverage: Boolean(orig.alphaToCoverage),
          anisotropy: orig.anisotropy || 0,
          anisotropyRotation: orig.anisotropyRotation || 0,
          sheen: orig.sheen || 0,
          sheenColor: orig.sheenColor ? orig.sheenColor.clone() : null,
          roughness: 0.45 + (this._smoothLevel * 0.5),
          metalness: 0.02,
          wireframe: false,
        });
        return mat;
      }

      case 'clay': {
        const mat = new THREE.MeshStandardMaterial({
          color: isAlpha ? (orig.color ? orig.color.clone() : new THREE.Color(0xffffff)) : new THREE.Color(0xccbba8),
          map: isAlpha ? (orig.map || null) : null,
          alphaMap: orig.alphaMap || null,
          transparent: isAlpha || Boolean(orig.transparent),
          alphaTest: baseAlphaTest,
          side: baseSide,
          depthWrite: orig.depthWrite !== undefined ? orig.depthWrite : true,
          depthTest: orig.depthTest !== undefined ? orig.depthTest : true,
          polygonOffset: Boolean(orig.polygonOffset),
          polygonOffsetFactor: orig.polygonOffsetFactor || 0,
          polygonOffsetUnits: orig.polygonOffsetUnits || 0,
          alphaToCoverage: Boolean(orig.alphaToCoverage),
          roughness: 0.65,
          metalness: 0.05,
          wireframe: false,
        });
        return mat;
      }

      case 'normals': {
        const mat = new THREE.MeshNormalMaterial({
          transparent: isAlpha || Boolean(orig.transparent),
          alphaTest: baseAlphaTest,
          side: baseSide,
          depthWrite: orig.depthWrite !== undefined ? orig.depthWrite : true,
          depthTest: orig.depthTest !== undefined ? orig.depthTest : true,
          polygonOffset: Boolean(orig.polygonOffset),
          polygonOffsetFactor: orig.polygonOffsetFactor || 0,
          polygonOffsetUnits: orig.polygonOffsetUnits || 0,
          alphaToCoverage: Boolean(orig.alphaToCoverage),
          wireframe: false,
        });
        return mat;
      }

      case 'wireframe': {
        if (orig.wireframe !== undefined) orig.wireframe = true;
        return orig;
      }

      case 'unreal':
      case 'studio':
      case 'sunset':
      case 'cyber':
      default: {
        if (orig.wireframe !== undefined) orig.wireframe = false;
        return orig;
      }
    }
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
      this._applyHeadRotation(rx, ry, rz);
    }
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Applies head rotation. If the model has a skeletal head bone (e.g. full-body avatars, MetaHumans, VRoid, Mixamo),
   * only the head (and neck) bones rotate while keeping the torso, arms, legs and entire body stationary.
   * If the model is a standalone head bust with no bones, rotates the bust pivot.
   * @param {number} rx - Pitch
   * @param {number} ry - Yaw
   * @param {number} rz - Roll
   */
  _applyHeadRotation(rx, ry, rz) {
    if (!this._model) return;

    if (this._headBone) {
      // Keep root model / body completely fixed and stationary
      this._model.rotation.set(0, 0, 0);

      if (this._neckBone) {
        // Natural organic distribution: 25% on neck, 75% on head
        const neckRot = new THREE.Euler(rx * 0.25, ry * 0.25, rz * 0.25, 'YXZ');
        const neckDeltaQ = new THREE.Quaternion().setFromEuler(neckRot);
        this._neckBone.quaternion.copy(this._neckBone.userData.restQuaternion).multiply(neckDeltaQ);

        const headRot = new THREE.Euler(rx * 0.75, ry * 0.75, rz * 0.75, 'YXZ');
        const headDeltaQ = new THREE.Quaternion().setFromEuler(headRot);
        this._headBone.quaternion.copy(this._headBone.userData.restQuaternion).multiply(headDeltaQ);
      } else {
        // 100% on head bone
        const headRot = new THREE.Euler(rx, ry, rz, 'YXZ');
        const headDeltaQ = new THREE.Quaternion().setFromEuler(headRot);
        this._headBone.quaternion.copy(this._headBone.userData.restQuaternion).multiply(headDeltaQ);
      }

      // Update world matrix of bones
      this._headBone.updateMatrixWorld(true);

      // Synchronize all rigid head attachments (Hair, Eyebrows, Scalp, Facial Hair)
      // with subtle organic inertia and strand physics on hair cards (Niagara / Hair Groom physics feel)
      if (this._headAttachments && this._headAttachments.length > 0) {
        // Compute delta velocity for hair inertia sway
        const dPitch = rx - (this._prevHeadPitch || 0);
        const dYaw = ry - (this._prevHeadYaw || 0);
        const dRoll = rz - (this._prevHeadRoll || 0);

        this._prevHeadPitch = rx;
        this._prevHeadYaw = ry;
        this._prevHeadRoll = rz;

        // Spring-damper physics accumulator for hair
        if (!this._hairSway) this._hairSway = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
        const springK = 0.22;
        const damping = 0.72;

        this._hairSway.vx = (this._hairSway.vx + (-dPitch * 0.35) - this._hairSway.x * springK) * damping;
        this._hairSway.vy = (this._hairSway.vy + (-dYaw * 0.40) - this._hairSway.y * springK) * damping;
        this._hairSway.vz = (this._hairSway.vz + (-dRoll * 0.35) - this._hairSway.z * springK) * damping;

        this._hairSway.x += this._hairSway.vx;
        this._hairSway.y += this._hairSway.vy;
        this._hairSway.z += this._hairSway.vz;

        const hairInertiaEuler = new THREE.Euler(this._hairSway.x, this._hairSway.y, this._hairSway.z, 'YXZ');
        const hairInertiaQ = new THREE.Quaternion().setFromEuler(hairInertiaEuler);

        for (let i = 0; i < this._headAttachments.length; i++) {
          const att = this._headAttachments[i];
          const mesh = att.mesh;
          const parent = mesh.parent;
          if (!parent) continue;

          const isHair = (mesh.name || '').toLowerCase().includes('hair');

          // Target world matrix = HeadBone world matrix * Relative rest matrix
          const targetWorldMatrix = new THREE.Matrix4().multiplyMatrices(
            this._headBone.matrixWorld,
            att.relativeMatrix
          );

          // Apply hair sway inertia around head pivot
          if (isHair) {
            targetWorldMatrix.multiply(new THREE.Matrix4().makeRotationFromQuaternion(hairInertiaQ));
          }

          // Convert to local space of mesh parent: L = inv(ParentWorld) * TargetWorld
          const invParentWorld = new THREE.Matrix4().copy(parent.matrixWorld).invert();
          const targetLocalMatrix = new THREE.Matrix4().multiplyMatrices(invParentWorld, targetWorldMatrix);

          // Decompose into position, quaternion, scale
          targetLocalMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
          mesh.updateMatrix();
        }
      }
    } else if (!this._isFullBody) {
      // Standalone head/face mesh without skeletal bones: rotate the pivot
      this._model.rotation.set(rx, ry, rz);
    } else {
      // Full body without bones: keep body fixed
      this._model.rotation.set(0, 0, 0);
    }
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

  getModel() {
    return this._model;
  }

  getInnerModel() {
    return this._innerModel || this._model;
  }

  getModelMap() {
    return this._modelMap;
  }

  getHeadBone() {
    return this._headBone;
  }

  getNeckBone() {
    return this._neckBone;
  }

  getHeadAttachments() {
    return this._headAttachments || [];
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
    // Unreal Engine 5.8 Cinematic Portrait Lighting Setup
    this._ambientLight = new THREE.AmbientLight(0xfff8f2, 0.45);
    this._scene.add(this._ambientLight);

    // Key Light: 5500K daylight key light with subtle warmth and crisp specular shaping
    this._keyLight = new THREE.DirectionalLight(0xfff6ee, 2.4);
    this._keyLight.position.set(1.4, 1.8, 2.2);
    this._keyLight.castShadow = true;
    this._keyLight.shadow.mapSize.set(1024, 1024);
    this._keyLight.shadow.bias = -0.0001;
    this._scene.add(this._keyLight);

    // Fill Light: Soft cool fill on shadow side to preserve hair volume & skin micro-contrast
    this._fillLight = new THREE.DirectionalLight(0xbcd7ff, 0.85);
    this._fillLight.position.set(-1.8, 0.4, 1.6);
    this._scene.add(this._fillLight);

    // Rim / Hair Kicker Light: High-angle back kicker to trigger anisotropic cuticle sheen
    this._rimLight = new THREE.DirectionalLight(0xffeedd, 1.6);
    this._rimLight.position.set(0.2, 2.2, -2.2);
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

    this._applyHeadRotation(this._currentRotation.x, this._currentRotation.y, this._currentRotation.z);

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

  /**
   * Generates a high-precision alpha mask from an RGB texture where the background is black.
   * Eliminates cardboard borders on hair and eyebrow cards while preserving fine anti-aliased strand fringes.
   *
   * @param {THREE.Texture} texture
   * @returns {THREE.CanvasTexture|null}
   */
  _synthesizeAlphaFromTexture(texture, isHairCard = false) {
    if (!texture) return null;
    if (texture.userData && texture.userData.synthesizedAlphaMap) {
      return texture.userData.synthesizedAlphaMap;
    }

    const img = texture.image;
    if (!img) return null;

    try {
      const width = img.width || 1024;
      const height = img.height || 1024;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;
      const len = data.length;

      // Detect background color by sampling the 4 corners of the texture
      const cornerR = (data[0] + data[(width - 1) * 4] + data[(height - 1) * width * 4] + data[len - 4]) / 4;
      const cornerG = (data[1] + data[(width - 1) * 4 + 1] + data[(height - 1) * width * 4 + 1] + data[len - 3]) / 4;
      const cornerB = (data[2] + data[(width - 1) * 4 + 2] + data[(height - 1) * width * 4 + 2] + data[len - 2]) / 4;

      const isCornerBrightBg = cornerR > 25 || cornerG > 25 || cornerB > 20;

      // Extract strand luminance and generate crisp antialiased alpha
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (isHairCard && isCornerBrightBg) {
          // MetaHuman hair card texture: background is solid brown ~RGB(52, 40, 29)
          // Hair strands are dark/translucent cuts. Distance from background color defines the strand alpha.
          const diffR = Math.abs(r - cornerR);
          const diffG = Math.abs(g - cornerG);
          const diffB = Math.abs(b - cornerB);
          const dist = (diffR + diffG + diffB) / 3.0;

          if (dist < 4.0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 0;
          } else {
            const alphaVal = Math.min(255, Math.round((dist / 32.0) * 255));
            data[i] = alphaVal;
            data[i + 1] = alphaVal;
            data[i + 2] = alphaVal;
            data[i + 3] = 255;
          }
        } else {
          // Standard dark background texture: dark = transparent, bright = strand
          const maxVal = Math.max(r, g, b);
          if (maxVal <= 4) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 0;
          } else {
            const norm = Math.min(1.0, Math.max(0.0, (maxVal - 4) / 42.0));
            const alpha = Math.round(norm * 255);
            data[i] = alpha;
            data[i + 1] = alpha;
            data[i + 2] = alpha;
            data[i + 3] = 255;
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      const alphaMap = new THREE.CanvasTexture(canvas);
      alphaMap.wrapS = texture.wrapS;
      alphaMap.wrapT = texture.wrapT;
      alphaMap.flipY = texture.flipY;
      alphaMap.needsUpdate = true;

      texture.userData.synthesizedAlphaMap = alphaMap;
      return alphaMap;
    } catch (err) {
      console.warn('[Renderer] Não foi possível sintetizar mapa de transparência da textura:', err);
      return null;
    }
  }

  /**
   * Procedural Micro-Strand Hair Groom Texture Generator (Unreal Engine Niagara / Groom Style).
   * Synthesizes individual hair strands (1.5 - 2.5px width) with natural tip tapering,
   * melanin density gradient, and root-to-tip opacity for photorealistic hair rendering.
   *
   * @param {THREE.Color} baseHairColor - Base melanin tone
   * @returns {{ map: THREE.CanvasTexture, alphaMap: THREE.CanvasTexture }}
   */
  _createProceduralHairStrands(baseHairColor = null) {
    if (this._cachedHairStrandTextures) return this._cachedHairStrandTextures;

    const width = 2048;
    const height = 2048;

    // 1. Color Map Canvas
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = width;
    colorCanvas.height = height;
    const cCtx = colorCanvas.getContext('2d');
    cCtx.fillStyle = '#17100b'; // Unreal Engine MetaHuman natural dark espresso base
    cCtx.fillRect(0, 0, width, height);

    // 2. Alpha Mask Canvas
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = width;
    alphaCanvas.height = height;
    const aCtx = alphaCanvas.getContext('2d');
    aCtx.fillStyle = '#000000';
    aCtx.fillRect(0, 0, width, height);

    // Draw high-density micro-strands along vertical UV hair card columns
    const numCards = 16; // 16 columns for finer micro-strand distribution
    const cardWidth = width / numCards;

    for (let c = 0; c < numCards; c++) {
      const cardX = c * cardWidth;
      const numStrands = 90; // Dense silky groom clumps

      for (let s = 0; s < numStrands; s++) {
        const xOffset = (s / numStrands) * (cardWidth - 6) + 3 + (Math.sin(s * 2.3) * 2.0);
        const startX = cardX + xOffset;
        const waveFreq = 0.0025 + (s % 7) * 0.0008;
        const waveAmp = 4.0 + (s % 5) * 2.5;

        // Strand length with natural cuticle variance
        const strandLen = height * (0.90 + (Math.sin(s * 4.1) * 0.08));
        const startY = height * 0.01;

        // Subtle melanin distribution (natural warm undertones)
        const strandTone = (s % 9 === 0) ? '#3e291c' : (s % 4 === 0) ? '#2c1c13' : '#1e140d';
        cCtx.strokeStyle = strandTone;
        cCtx.lineWidth = 1.4;

        cCtx.beginPath();
        cCtx.moveTo(startX, startY);

        aCtx.strokeStyle = `rgba(255, 255, 255, ${0.82 + (s % 4) * 0.05})`;
        aCtx.lineWidth = 1.3;
        aCtx.beginPath();
        aCtx.moveTo(startX, startY);

        const steps = 36;
        const dy = (strandLen - startY) / steps;

        for (let j = 1; j <= steps; j++) {
          const cy = startY + j * dy;
          const cx = startX + Math.sin(j * waveFreq * 100 + s) * waveAmp;
          cCtx.lineTo(cx, cy);
          aCtx.lineTo(cx, cy);
        }

        cCtx.stroke();
        aCtx.stroke();
      }
    }

    const colorTex = new THREE.CanvasTexture(colorCanvas);
    colorTex.wrapS = THREE.RepeatWrapping;
    colorTex.wrapT = THREE.RepeatWrapping;
    colorTex.needsUpdate = true;

    const alphaTex = new THREE.CanvasTexture(alphaCanvas);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.RepeatWrapping;
    alphaTex.needsUpdate = true;

    this._cachedHairStrandTextures = { map: colorTex, alphaMap: alphaTex };
    return this._cachedHairStrandTextures;
  }

  /**
   * Procedurally generates a photorealistic feathered eyelash atlas texture and alpha mask.
   * Replaces missing or 1x1 dummy lash textures in GLB models with realistic tapered strands.
   *
   * @returns {{ map: THREE.CanvasTexture, alphaMap: THREE.CanvasTexture }}
   */
  _createProceduralEyelashTextures() {
    if (this._cachedLashTextures) return this._cachedLashTextures;

    const width = 1024;
    const height = 1024;

    // 1. Color Map Canvas
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = width;
    colorCanvas.height = height;
    const cCtx = colorCanvas.getContext('2d');
    cCtx.fillStyle = '#140d09'; // Deep natural espresso lash tone
    cCtx.fillRect(0, 0, width, height);

    // 2. Alpha Mask Canvas
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = width;
    alphaCanvas.height = height;
    const aCtx = alphaCanvas.getContext('2d');
    aCtx.fillStyle = '#000000';
    aCtx.fillRect(0, 0, width, height);

    // Draw realistic tapered eyelash strands repeating across UV space
    const numStrands = 48;
    const spacing = width / numStrands;

    aCtx.fillStyle = '#ffffff';

    for (let i = 0; i < numStrands; i++) {
      const xBase = i * spacing + spacing * 0.5 + (Math.sin(i * 3.7) * (spacing * 0.2));
      const strandLen = height * (0.65 + Math.sin(i * 2.1) * 0.25);
      const curlCurve = (Math.sin(i * 1.3) * 35) + (i % 2 === 0 ? 12 : -12);
      const rootWidth = 5.0 + Math.sin(i * 5.1) * 1.5;

      // Root to tip quadratic curve
      aCtx.beginPath();
      aCtx.moveTo(xBase - rootWidth * 0.5, height);
      aCtx.lineTo(xBase + rootWidth * 0.5, height);
      aCtx.quadraticCurveTo(
        xBase + curlCurve * 0.5 + 2, height - strandLen * 0.5,
        xBase + curlCurve, height - strandLen
      );
      aCtx.quadraticCurveTo(
        xBase + curlCurve * 0.5 - 2, height - strandLen * 0.5,
        xBase - rootWidth * 0.5, height
      );
      aCtx.closePath();
      aCtx.fill();
    }

    const colorTex = new THREE.CanvasTexture(colorCanvas);
    colorTex.wrapS = THREE.RepeatWrapping;
    colorTex.wrapT = THREE.ClampToEdgeWrapping;
    colorTex.needsUpdate = true;

    const alphaTex = new THREE.CanvasTexture(alphaCanvas);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.ClampToEdgeWrapping;
    alphaTex.needsUpdate = true;

    this._cachedLashTextures = { map: colorTex, alphaMap: alphaTex };
    return this._cachedLashTextures;
  }

  /**
   * Procedural Micro-Strand Eyebrow Texture Generator.
   * Synthesizes dense, directional fine hair fibers for realistic MetaHuman brows.
   *
   * @returns {{ map: THREE.CanvasTexture, alphaMap: THREE.CanvasTexture }}
   */
  _createProceduralEyebrowTextures() {
    if (this._cachedEyebrowTextures) return this._cachedEyebrowTextures;

    const width = 1024;
    const height = 1024;

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = width;
    colorCanvas.height = height;
    const cCtx = colorCanvas.getContext('2d');
    cCtx.fillStyle = '#1c120c';
    cCtx.fillRect(0, 0, width, height);

    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = width;
    alphaCanvas.height = height;
    const aCtx = alphaCanvas.getContext('2d');
    aCtx.fillStyle = '#000000';
    aCtx.fillRect(0, 0, width, height);

    // Draw directional hair fibers across eyebrow card UV space
    const numStrands = 220;
    for (let i = 0; i < numStrands; i++) {
      const xStart = Math.random() * width;
      const yStart = Math.random() * height;
      const length = 40 + Math.random() * 90;
      const angle = (Math.PI * 0.15) + (Math.random() - 0.5) * 0.35; // ~25 degree growth angle

      const xEnd = xStart + Math.cos(angle) * length;
      const yEnd = yStart + Math.sin(angle) * length;

      cCtx.strokeStyle = (i % 2 === 0) ? '#2e1e14' : '#1a100a';
      cCtx.lineWidth = 1.5;
      cCtx.beginPath();
      cCtx.moveTo(xStart, yStart);
      cCtx.quadraticCurveTo(
        (xStart + xEnd) * 0.5 + (Math.random() - 0.5) * 8,
        (yStart + yEnd) * 0.5 - 4,
        xEnd,
        yEnd
      );
      cCtx.stroke();

      aCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      aCtx.lineWidth = 1.3;
      aCtx.beginPath();
      aCtx.moveTo(xStart, yStart);
      aCtx.quadraticCurveTo(
        (xStart + xEnd) * 0.5 + (Math.random() - 0.5) * 8,
        (yStart + yEnd) * 0.5 - 4,
        xEnd,
        yEnd
      );
      aCtx.stroke();
    }

    const colorTex = new THREE.CanvasTexture(colorCanvas);
    colorTex.wrapS = THREE.RepeatWrapping;
    colorTex.wrapT = THREE.RepeatWrapping;
    colorTex.needsUpdate = true;

    const alphaTex = new THREE.CanvasTexture(alphaCanvas);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.RepeatWrapping;
    alphaTex.needsUpdate = true;

    this._cachedEyebrowTextures = { map: colorTex, alphaMap: alphaTex };
    return this._cachedEyebrowTextures;
  }
}
