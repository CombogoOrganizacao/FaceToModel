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
import { ensureModelBlendshapes, rebuildModelBlendshapes } from './blendshape-synthesizer.js';
import { modelCache } from './model-cache.js';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Default background colour matches the app's CSS variable --bg-base */
const BG_COLOR = 0x050508;

/** Desirable FOV for a face close-up */
const CAMERA_FOV = 32;

/** Camera start position in model space */
const CAMERA_Z = 2.4;

/* ─── PBR Texture Calibration Helper ──────────────────────────────────────── */

/**
 * Calibrates texture color space, filtering and mipmaps according to PBR standards.
 * Color/Emissive maps MUST be sRGB; Data maps (normal, roughness, metalness, ao, alpha) MUST be Linear.
 * @param {THREE.Texture|null} tex
 * @param {boolean} isColorMap
 * @returns {THREE.Texture|null}
 */
function calibrateTexture(tex, isColorMap = false) {
  if (!tex || !tex.isTexture) return tex;
  tex.colorSpace = isColorMap ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (!tex.isCompressedTexture && !tex.isDataTexture && !tex.isDepthTexture && !tex.isVideoTexture && !tex.isRenderTargetTexture) {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
  }
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.matrixAutoUpdate = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a robust THREE.LoadingManager that intercepts all relative and subfolder paths,
 * resolving them against the assetMap of uploaded/dropped files.
 * @param {Record<string, string>} assetMap
 * @returns {THREE.LoadingManager}
 */
function createLoadingManagerWithAssetMap(assetMap = {}) {
  const loadingManager = new THREE.LoadingManager();
  loadingManager.setURLModifier((itemUrl) => {
    let clean = decodeURIComponent(itemUrl).replace(/\\/g, '/').replace(/['"]/g, '').trim();
    clean = clean.replace(/^blob:[^/]+\/\/[^/]+\/[0-9a-f-]+\//i, '');
    clean = clean.replace(/^blob:[^/]+\/\/[^/]+\//i, '');
    clean = clean.replace(/^https?:\/\/[^/]+\//i, '');
    clean = clean.replace(/^[a-zA-Z]:\/?/i, '');
    clean = clean.replace(/^(\.\/|\/)+/, '');

    const baseName = clean.split('/').pop();

    if (assetMap[clean]) return assetMap[clean];
    if (assetMap[clean.toLowerCase()]) return assetMap[clean.toLowerCase()];
    if (assetMap[baseName]) return assetMap[baseName];
    if (assetMap[baseName.toLowerCase()]) return assetMap[baseName.toLowerCase()];

    const match = Object.keys(assetMap).find((k) => {
      const lk = k.toLowerCase();
      const lb = baseName.toLowerCase();
      const lc = clean.toLowerCase();
      return lk === lb || lk === lc || lk.endsWith('/' + lb) || lc.endsWith('/' + lk) || lk.endsWith('/' + lc) || lc.endsWith(lk);
    });
    if (match) return assetMap[match];

    const baseNoExt = baseName.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const tokens = baseNoExt.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    if (tokens.length >= 2) {
      const tokenMatch = Object.keys(assetMap).find((k) => {
        const lk = k.toLowerCase();
        return tokens.every((t) => lk.includes(t));
      });
      if (tokenMatch) return assetMap[tokenMatch];
    }

    return itemUrl;
  });
  return loadingManager;
}

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

    /* ── Animation System & Clips ── */
    this.animations = [];
    this._mixer = null;

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
    this._lightIntensity = 1.0;
    this._baseKeyIntensity = 3.0;
    this._baseFillIntensity = 0.85;
    this._baseRimIntensity = 2.0;
    this._baseAmbientIntensity = 0.5;
    this._smoothLevel = 0.85;

    /* ── Organic Smoothing & 3DoF Rotation ── */
    this._targetBlendshapes = {};
    this._currentBlendshapes = {};
    this._targetRotation = { x: 0, y: 0, z: 0 };
    this._currentRotation = { x: 0, y: 0, z: 0 };

    /* ── Ground Contact Shadow Plane ── */
    this._groundPlane = null;
    this._groundShadowEnabled = true;

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
    // Reset animation state and mixer before removing the model
    this.animations = [];
    if (this._mixer) {
      this._mixer.stopAllAction();
      if (this._model) {
        this._mixer.uncacheRoot(this._model);
      }
      this._mixer = null;
    }

    if (this._model) {
      this._scene.remove(this._model);
      this._model = null;
      this._innerModel = null;
      this._modelMap = {};
      this.blendshapeCoverage = 0;
    }

    const lowerName = (filename || url).toLowerCase();
    console.log(`[Renderer] Loading 3D model (${lowerName}): ${url}`);

    let model;

    const loadingManager = createLoadingManagerWithAssetMap(assetMap);

    if (lowerName.endsWith('.fbx')) {
      const fbxLoader = new FBXLoader(loadingManager);
      const fbx = await fbxLoader.loadAsync(url);
      model = fbx;
      if (fbx.animations && fbx.animations.length > 0) {
        this.animations = fbx.animations;
      }
    } else if (lowerName.endsWith('.obj')) {
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
          console.warn('[Renderer] Erro ao carregar arquivo .mtl, executando fallback com auto-bind:', mtlErr);
        }
      }

      if (!model) {
        const objLoader = new OBJLoader(loadingManager);
        model = await objLoader.loadAsync(url);
      }

      // Auto-bind de Texturas: para cada malha do modelo .obj sem textura, vincular inteligentemente imagens do assetMap
      const imageKeys = Object.keys(assetMap).filter((k) => /\.(png|jpe?g|webp|bmp)$/i.test(k));
      if (imageKeys.length > 0) {
        console.log('[Renderer] Auto-bind inteligente: associando texturas do assetMap às malhas do modelo');
        const texLoader = new THREE.TextureLoader();
        const loadedTextures = new Map();

        const getTexture = (fileKey, isColor = false) => {
          if (!fileKey || !assetMap[fileKey]) return null;
          const texUrl = assetMap[fileKey];
          if (!loadedTextures.has(texUrl)) {
            const tex = texLoader.load(texUrl);
            calibrateTexture(tex, isColor);
            loadedTextures.set(texUrl, tex);
          }
          return loadedTextures.get(texUrl);
        };

        // Find general fallback textures
        const fallbackAlbedo = imageKeys.find((k) => /(diffuse|albedo|basecolor|base_color|color|col|tex)/i.test(k)) ||
                              (imageKeys.length === 1 ? imageKeys[0] : null);
        const fallbackNormal = imageKeys.find((k) => /(normal|norm|nrm)/i.test(k));
        const fallbackRoughness = imageKeys.find((k) => /(roughness|rough)/i.test(k));
        const fallbackMetallic = imageKeys.find((k) => /(metallic|metalness|metal)/i.test(k));
        const fallbackAlpha = imageKeys.find((k) => /(opacity|alpha|mask)/i.test(k));

        const createdMaterials = new Map();

        model.traverse((node) => {
          if (node.isMesh) {
            const meshName = (node.name || '').toLowerCase();
            const matName = (node.material && node.material.name ? node.material.name : '').toLowerCase();

            // Se o nó já tem textura válida aplicada via MTL, não sobrescreve a menos que falte o mapa difuso
            const currentMats = Array.isArray(node.material) ? node.material : [node.material];
            const hasExistingMap = currentMats.some((m) => Boolean(m.map));
            if (hasExistingMap) return;

            // Try to find textures matching this specific mesh or material name
            const searchKey = meshName || matName;
            let albedoKey = null;
            let normalKey = null;
            let roughnessKey = null;
            let metallicKey = null;
            let alphaKey = null;

            if (searchKey) {
              const tokens = searchKey.split(/[^a-z0-9]/).filter((t) => t.length >= 3);
              for (const token of tokens) {
                if (!albedoKey) {
                  albedoKey = imageKeys.find((k) => {
                    const lk = k.toLowerCase();
                    return lk.includes(token) && /(diffuse|albedo|basecolor|base_color|color|col|tex)/i.test(lk);
                  }) || imageKeys.find((k) => k.toLowerCase().includes(token));
                }
                if (!normalKey) {
                  normalKey = imageKeys.find((k) => k.toLowerCase().includes(token) && /(normal|norm|nrm)/i.test(k));
                }
                if (!roughnessKey) {
                  roughnessKey = imageKeys.find((k) => k.toLowerCase().includes(token) && /(roughness|rough)/i.test(k));
                }
                if (!metallicKey) {
                  metallicKey = imageKeys.find((k) => k.toLowerCase().includes(token) && /(metallic|metalness|metal)/i.test(k));
                }
                if (!alphaKey) {
                  alphaKey = imageKeys.find((k) => k.toLowerCase().includes(token) && /(opacity|alpha|mask)/i.test(k));
                }
              }
            }

            // Fallbacks if not matched per-part
            albedoKey = albedoKey || fallbackAlbedo;
            normalKey = normalKey || fallbackNormal;
            roughnessKey = roughnessKey || fallbackRoughness;
            metallicKey = metallicKey || fallbackMetallic;
            alphaKey = alphaKey || fallbackAlpha;

            const matKey = `${albedoKey || ''}|${normalKey || ''}|${roughnessKey || ''}|${metallicKey || ''}|${alphaKey || ''}`;

            if (!createdMaterials.has(matKey)) {
              const albedoTex = albedoKey ? getTexture(albedoKey, true) : null;
              const normalTex = normalKey ? getTexture(normalKey, false) : null;
              const roughnessTex = roughnessKey ? getTexture(roughnessKey, false) : null;
              const metallicTex = metallicKey ? getTexture(metallicKey, false) : null;
              const alphaTex = alphaKey ? getTexture(alphaKey, false) : null;

              const isCutout = Boolean(alphaTex);

              const pbrMat = new THREE.MeshStandardMaterial({
                name: matName || meshName || 'AutoPBR',
                map: albedoTex,
                normalMap: normalTex,
                roughnessMap: roughnessTex,
                metalnessMap: metallicTex,
                alphaMap: alphaTex,
                transparent: isCutout,
                alphaTest: isCutout ? 0.05 : 0,
                alphaToCoverage: isCutout,
                depthWrite: true,
                depthTest: true,
                roughness: roughnessTex ? 1.0 : 0.6,
                metalness: metallicTex ? 1.0 : 0.05,
                side: THREE.DoubleSide,
              });
              pbrMat.needsUpdate = true;
              createdMaterials.set(matKey, pbrMat);
            }

            node.material = createdMaterials.get(matKey);
          }
        });
      }
    } else {
      // Standard GLTF / GLB loader with KTX2, DRACO and IndexedDB Binary Cache
      this._loader.manager = loadingManager;
      let gltf;
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        gltf = await this._loader.loadAsync(url, onProgress ? (xhr) => {
          if (xhr.lengthComputable) {
            onProgress({ loaded: xhr.loaded, total: xhr.total, percent: Math.round((xhr.loaded / xhr.total) * 100) });
          }
        } : undefined);
        model = gltf.scene;
      } else {
        // Stream / load from IndexedDB cache with progress
        const buffer = await modelCache.fetchWithCache(url, onProgress);
        gltf = await this._loader.parseAsync(buffer, '');
        model = gltf.scene;
      }
      if (gltf && gltf.animations && gltf.animations.length > 0) {
        this.animations = gltf.animations;
      }
    }

    const isGLTF = !lowerName.endsWith('.fbx') && !lowerName.endsWith('.obj');

    // Detect if model is MetaHuman Bo or Epic Games MetaHuman avatar
    let isMetaHuman = false;
    model.traverse((node) => {
      const nName = (node.name || '').toLowerCase();
      const mName = (node.material?.name || '').toLowerCase();
      if (
        nName.includes('skm_bo_') ||
        nName.includes('skm_asha_') ||
        nName.includes('asha') ||
        nName.includes('sidesweptfringe') ||
        mName.includes('cardsmesh') ||
        mName.includes('lashmat') ||
        mName.includes('face_skin_baked')
      ) {
        isMetaHuman = true;
      }
    });

    // Ensure all materials are double-sided, properly sorted for alpha blending, and calibrated
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          const newMats = mats.map((m) => {
            const matName = (m.name || '').toLowerCase();
            const nodeName = (node.name || '').toLowerCase();

            // 1. Calibrar espaços de cor e repetição UV de todas as texturas presentes no material
            if (isGLTF) {
              calibrateTexture(m.map, true);
              calibrateTexture(m.emissiveMap, true);
              calibrateTexture(m.normalMap, false);
              calibrateTexture(m.roughnessMap, false);
              calibrateTexture(m.metalnessMap, false);
              calibrateTexture(m.aoMap, false);
              calibrateTexture(m.alphaMap, false);
              calibrateTexture(m.clearcoatMap, false);
              calibrateTexture(m.clearcoatRoughnessMap, false);
              calibrateTexture(m.transmissionMap, false);
              calibrateTexture(m.sheenColorMap, true);

              // 1.1 Se o material não tiver albedo ou alphaMap vinculados, buscar texturas correspondentes no assetMap
              if (assetMap && Object.keys(assetMap).length > 0) {
                const texLoader = new THREE.TextureLoader();
                const cleanMatName = matName.replace(/[^a-z0-9]/g, '');
                const cleanNodeName = nodeName.replace(/[^a-z0-9]/g, '');

                if (!m.map) {
                  const albedoKey = Object.keys(assetMap).find((k) => {
                    const lk = k.toLowerCase();
                    if (!/(diffuse|albedo|basecolor|base_color|color|col)/i.test(lk)) return false;
                    const cleanK = lk.replace(/[^a-z0-9]/g, '');
                    return (cleanMatName.length >= 3 && cleanK.includes(cleanMatName)) ||
                           (cleanNodeName.length >= 3 && cleanK.includes(cleanNodeName));
                  });
                  if (albedoKey) {
                    m.map = calibrateTexture(texLoader.load(assetMap[albedoKey]), true);
                  }
                }

                if (!m.alphaMap) {
                  const alphaKey = Object.keys(assetMap).find((k) => {
                    const lk = k.toLowerCase();
                    if (!/(opacity|alpha|mask)/i.test(lk)) return false;
                    const cleanK = lk.replace(/[^a-z0-9]/g, '');
                    return (cleanMatName.length >= 3 && cleanK.includes(cleanMatName)) ||
                           (cleanNodeName.length >= 3 && cleanK.includes(cleanNodeName));
                  });
                  if (alphaKey) {
                    m.alphaMap = calibrateTexture(texLoader.load(assetMap[alphaKey]), false);
                  }
                }
              }
            }

            // 2. Camadas Oclusoras dos Olhos / Conchas Corneais Transparentes (MetaHuman / Unreal)
            const isEyeShell = matName.includes('eyeshell') || matName.includes('eyeedge') ||
                               matName.includes('saliva') || matName.includes('cartilage') ||
                               matName.includes('m_hide') || matName.includes('lacrimal') ||
                               matName.includes('fluid') || matName.includes('cornea_shell');
            if (isEyeShell) {
              m.transparent = true;
              m.opacity = 0.0;
              m.depthWrite = false;
              m.depthTest = false;
              m.visible = false;
              return m;
            }

            // 3. Cílios (MetaHuman Bo, Ada e modelos PBR)
            const isLash = matName.includes('lash') || nodeName.includes('lash');
            if (isLash) {
              if (m.map) {
                // Textura Eyelashes_Coverage é máscara de recorte, não albedo difuso
                m.alphaMap = calibrateTexture(m.map, false);
                m.map = null;
              } else if (!m.alphaMap) {
                const proc = this._createProceduralEyelashTextures();
                m.alphaMap = proc.alphaMap;
              }
              m.color = new THREE.Color(0x140e0a); // Tom escuro natural de melanina
              m.roughness = 0.28;
              m.metalness = 0.0;
              m.specularIntensity = 0.85;
              m.specularColor = new THREE.Color(0x503525);
              m.sheen = 0.40;
              m.sheenColor = new THREE.Color(0x281910);
              m.sheenRoughness = 0.25;
              m.transparent = true;
              m.alphaTest = 0.04;
              m.alphaToCoverage = true;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              m.polygonOffset = true;
              m.polygonOffsetFactor = -3.0;
              m.polygonOffsetUnits = -6.0;
              this._applyHairStrandShader(m, true);
              m.needsUpdate = true;
              return m;
            }

            // 4. Sobrancelhas (MetaHuman Bo, Ada e PBR)
            const isBrow = matName.includes('eyebrow') || matName.includes('brow') || nodeName.includes('eyebrow') || nodeName.includes('brow');
            if (isBrow) {
              const hasAttrMap = matName.includes('attribute') || matName.includes('thin_cardsmesh') ||
                                 (m.map && m.map.name && m.map.name.toLowerCase().includes('attribute')) ||
                                 (m.map && m.map.image && m.map.image.src && m.map.image.src.toLowerCase().includes('attribute'));
              if (hasAttrMap) {
                // Groom CardsAtlas_Attribute: canal Alpha é o recorte dos fios
                m.alphaMap = calibrateTexture(m.map || m.alphaMap, false);
                m.map = null;
                m.color = new THREE.Color(0x1a120c);
              } else if (m.map) {
                calibrateTexture(m.map, true);
                m.alphaMap = m.map;
                m.color = new THREE.Color(0xffffff);
              } else {
                const proc = this._createProceduralEyebrowTextures();
                m.alphaMap = proc.alphaMap;
                m.color = new THREE.Color(0x1a120c);
              }
              m.roughness = 0.38;
              m.metalness = 0.0;
              m.specularIntensity = 0.65;
              m.specularColor = new THREE.Color(0x6e482e);
              m.sheen = 0.45;
              m.sheenColor = new THREE.Color(0x3e2314);
              m.transparent = true;
              m.alphaTest = 0.05;
              m.alphaToCoverage = true;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              m.polygonOffset = true;
              m.polygonOffsetFactor = -3.0;
              m.polygonOffsetUnits = -6.0;
              this._applyHairStrandShader(m, false);
              m.needsUpdate = true;
              return m;
            }

            // 5. Cabelos do MetaHuman (Groom Cards & CardsAtlas_Attribute)
            const isHair = matName.includes('hair') || (matName.includes('cards_m') && !matName.includes('eyebrow')) ||
                           matName.includes('sidesweptfringe') || matName.includes('coil_cardsmesh') ||
                           nodeName.includes('hair');
            if (isHair && isMetaHuman) {
              const hasAttrMap = matName.includes('attribute') || matName.includes('coil_cardsmesh') ||
                                 (m.map && m.map.name && m.map.name.toLowerCase().includes('attribute')) ||
                                 (m.map && m.map.image && m.map.image.src && m.map.image.src.toLowerCase().includes('attribute'));
              if (hasAttrMap) {
                // Unreal Groom CardsAtlas_Attribute: R=RootTip, G=Seed, B=AO, A=Alpha
                m.alphaMap = calibrateTexture(m.map || m.alphaMap, false);
                m.map = null;
                m.color = new THREE.Color(0x16100b); // Cabelo preto espresso natural
              } else if (m.map) {
                calibrateTexture(m.map, true);
                m.alphaMap = m.map;
                m.color = new THREE.Color(0xffffff);
              } else {
                const proc = this._createProceduralHairStrands();
                m.alphaMap = proc.alphaMap;
                m.color = new THREE.Color(0x16100b);
              }
              m.roughness = 0.42;
              m.metalness = 0.0;
              m.clearcoat = 0.40;
              m.clearcoatRoughness = 0.22;
              m.specularIntensity = 0.70;
              m.specularColor = new THREE.Color(0xb5825a);
              m.sheen = 0.45;
              m.sheenColor = new THREE.Color(0x52321c);
              m.sheenRoughness = 0.30;
              m.transparent = true;
              m.alphaTest = 0.05;
              m.alphaToCoverage = true;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.55;
              m.needsUpdate = true;
              return m;
            }

            // 6. Olhos / Globo Ocular / Íris / Esclera (T_Iris_A_M com KHR_texture_transform)
            const isEye = matName.includes('eyeleft') || matName.includes('eyeright') ||
                          matName.includes('eyeball') || matName.includes('eyel_baked') ||
                          matName.includes('eyer_baked') || matName.includes('eye') ||
                          nodeName === 'eyes';
            if (isEye && !isEyeShell) {
              if (m.map) {
                calibrateTexture(m.map, true);
              }
              m.roughness = 0.10;
              m.metalness = 0.0;
              m.transparent = false;
              m.opacity = 1.0;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.2;
              m.needsUpdate = true;
              return m;
            }

            // =========================================================================
            // CASO 1: Modelos PBR Modernos GLTF / GLB (Blender, Substance, Maya, Sketchfab)
            // Rigorosamente preserva as cores, texturas e parâmetros autorados pelo artista!
            // =========================================================================
            if (isGLTF && !isMetaHuman) {
              // Cartões de pelos (fur), cabelo, penas e transparência por recorte
              const isHairOrFur = matName.includes('hair') || matName.includes('fur') ||
                                  matName.includes('pelo') || matName.includes('card') ||
                                  matName.includes('feather') || matName.includes('fringe') ||
                                  matName.includes('fluff') || matName.includes('trim') ||
                                  nodeName.includes('hair') || nodeName.includes('fur') ||
                                  nodeName.includes('feather') || nodeName.includes('fringe') ||
                                  nodeName.includes('fluff') || nodeName.includes('trim');

              const hasAlpha = Boolean(
                m.transparent ||
                (m.alphaTest > 0) ||
                m.alphaMap ||
                (m.opacity !== undefined && m.opacity < 0.999) ||
                isHairOrFur
              );

              if (hasAlpha) {
                m.side = THREE.DoubleSide;
                m.depthWrite = true;
                m.depthTest = true;
                m.transparent = true;
                m.alphaToCoverage = true;
                if (m.alphaTest <= 0) {
                  m.alphaTest = 0.05;
                }
                m.needsUpdate = true;
              } else {
                m.side = THREE.DoubleSide;
                m.depthWrite = true;
                m.depthTest = true;
                m.transparent = false;
              }

              return m;
            }

            // =========================================================================
            // CASO 2: Materiais Legados Phong (.obj via MTLLoader ou .fbx legado)
            // =========================================================================
            if (m.isMeshPhongMaterial || !isGLTF) {
              const baseMap = m.map;
              if (baseMap) calibrateTexture(baseMap, true);

              let normalMap = m.normalMap || m.bumpMap;
              let alphaMap = m.alphaMap;
              let roughnessMap = null;
              let metallicMap = null;
              let aoMap = null;

              if (assetMap && Object.keys(assetMap).length > 0) {
                const texLoader = new THREE.TextureLoader();
                const cleanMatName = matName.replace(/[^a-z0-9]/g, '');
                const cleanNodeName = nodeName.replace(/[^a-z0-9]/g, '');

                const findMap = (pattern) => {
                  const matchKey = Object.keys(assetMap).find((k) => {
                    const lk = k.toLowerCase();
                    if (!pattern.test(lk)) return false;
                    const cleanK = lk.replace(/[^a-z0-9]/g, '');
                    return (cleanMatName.length >= 3 && cleanK.includes(cleanMatName)) ||
                           (cleanNodeName.length >= 3 && cleanK.includes(cleanNodeName));
                  });
                  return matchKey ? texLoader.load(assetMap[matchKey]) : null;
                };

                const ormKey = Object.keys(assetMap).find((k) => {
                  const lk = k.toLowerCase();
                  return /(orm|arm|rough.*metal|metal.*rough)/i.test(lk) &&
                         ((cleanMatName.length >= 3 && lk.includes(cleanMatName)) ||
                          (cleanNodeName.length >= 3 && lk.includes(cleanNodeName)));
                }) || Object.keys(assetMap).find((k) => /(orm|arm|rough.*metal|metal.*rough)/i.test(k.toLowerCase()));

                if (ormKey) {
                  const ormTex = texLoader.load(assetMap[ormKey]);
                  calibrateTexture(ormTex, false);
                  roughnessMap = ormTex;
                  metallicMap = ormTex;
                  aoMap = ormTex;
                } else {
                  roughnessMap = findMap(/(roughness|rough|ns)/i);
                  if (roughnessMap) calibrateTexture(roughnessMap, false);
                  metallicMap = findMap(/(metallic|metal|refl)/i);
                  if (metallicMap) calibrateTexture(metallicMap, false);
                }

                if (!normalMap) {
                  normalMap = findMap(/(normal|norm|nrm|bump)/i);
                  if (normalMap) calibrateTexture(normalMap, false);
                }
                if (!alphaMap) {
                  alphaMap = findMap(/(opacity|alpha|mask)/i);
                  if (alphaMap) calibrateTexture(alphaMap, false);
                }
              }

              const shininess = m.shininess !== undefined ? m.shininess : 30;
              const convertedRoughness = Math.min(1.0, Math.max(0.08, Math.sqrt(2.0 / (shininess + 2.0))));

              let convertedMetalness = 0.04;
              if (m.specular) {
                const specLum = m.specular.r * 0.2126 + m.specular.g * 0.7152 + m.specular.b * 0.0722;
                if (specLum > 0.65) convertedMetalness = 0.85;
              }

              const hasAlpha = Boolean(alphaMap || m.transparent || (m.opacity !== undefined && m.opacity < 0.999));

              m = new THREE.MeshStandardMaterial({
                name: m.name,
                color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
                map: baseMap ? calibrateTexture(baseMap, true) : null,
                normalMap: normalMap ? calibrateTexture(normalMap, false) : null,
                roughnessMap: roughnessMap,
                metalnessMap: metallicMap,
                aoMap: aoMap,
                alphaMap: alphaMap ? calibrateTexture(alphaMap, false) : null,
                roughness: roughnessMap ? 1.0 : convertedRoughness,
                metalness: metallicMap ? 1.0 : convertedMetalness,
                transparent: hasAlpha,
                alphaTest: hasAlpha ? 0.05 : 0,
                alphaToCoverage: hasAlpha,
                depthWrite: true,
                depthTest: true,
                side: THREE.DoubleSide,
              });

              return m;
            }

            // =========================================================================
            // CASO 3: Demais Materiais do MetaHuman (Pele, Roupas, Dentes)
            // =========================================================================
            m.side = THREE.DoubleSide;

            // 7. Pele / Cabeça / Corpo do MetaHuman
            if (matName.includes('head_shader') || matName.includes('body_mi') || matName.includes('skin') || matName.includes('face') || matName.includes('head') || nodeName === 'head') {
              m.roughness = m.roughnessMap ? 1.0 : 0.58;
              m.metalness = 0.0;
              m.transparent = false;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.specularIntensity !== undefined) m.specularIntensity = 0.35;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.45;
              return m;
            }
            // 8. Roupas do MetaHuman
            else if (matName.includes('top_') || matName.includes('btm_') || matName.includes('slacks') || matName.includes('shirt') || matName.includes('cloth') || matName.includes('outfit') || matName.includes('coat') || matName.includes('trouser') || matName.includes('shoe')) {
              m.roughness = m.roughnessMap ? 1.0 : 0.80;
              m.metalness = m.metalnessMap ? 1.0 : 0.0;
              m.transparent = false;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.3;
              return m;
            }
            // 9. Dentes e Boca
            else if (matName.includes('teeth')) {
              m.roughness = 0.28;
              m.metalness = 0.0;
              m.depthWrite = true;
              m.side = THREE.DoubleSide;
              return m;
            }

            m.side = THREE.DoubleSide;
            m.depthWrite = true;
            m.depthTest = true;
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

    // Update Ground Contact Shadow Plane position to match character feet
    if (this._groundPlane) {
      const bottomY = (fullBox.min.y - centre.y) * scale;
      this._groundPlane.position.y = bottomY - 0.002;
    }

    // Dynamic key light shadow camera frustum fitting to model bounding box
    if (this._keyLight && this._keyLight.shadow && this._keyLight.shadow.camera) {
      const cam = this._keyLight.shadow.camera;
      const radius = Math.max(fullSize.x, fullSize.y, fullSize.z) * 1.2;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.1;
      cam.far = 25;
      cam.updateProjectionMatrix();
    }

    // Save model's native rest transform (before centering and scaling for viewport)
    model.userData.restTransform = {
      position: model.position.clone(),
      scale: model.scale.clone(),
      quaternion: model.quaternion.clone(),
    };

    // Create a unified Pivot container for harmonious 3DoF head rotation without detached hair
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'FaceToModel_Pivot';

    model.scale.setScalar(scale);
    model.position.sub(centre.multiplyScalar(scale));

    model.userData.viewerTransform = {
      position: model.position.clone(),
      scale: model.scale.clone(),
      quaternion: model.quaternion.clone(),
    };

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

    // Ensure all meshes with morph attributes have valid morphTargetInfluences arrays
    model.traverse((node) => {
      if (node.isMesh && node.geometry && node.geometry.morphAttributes) {
        const morphPos = node.geometry.morphAttributes.position;
        if (morphPos && morphPos.length > 0) {
          node.geometry.morphTargetsRelative = true;
          if (!node.morphTargetInfluences || !Array.isArray(node.morphTargetInfluences)) {
            if (typeof node.updateMorphTargets === 'function') {
              node.updateMorphTargets();
            } else {
              node.morphTargetInfluences = new Array(morphPos.length).fill(0);
            }
          }
        }
      }
    });

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

    // Head Attachments: Directly reparent non-skinned head meshes (hair, eyebrows, beard, scalp)
    // to the head bone so Three.js transforms them rigidly and natively with the skull at 60 FPS
    this._headAttachments = [];
    if (headBone) {
      // Force world matrices update before reparenting
      model.updateMatrixWorld(true);

      const meshesToReparent = [];
      model.traverse((node) => {
        if (node.isMesh && !node.isSkinnedMesh) {
          const nName = (node.name || '').toLowerCase();
          const mName = (node.material?.name || '').toLowerCase();
          const isHeadPart = /(hair|eyebrow|beard|mustache|eyelash|scalp|head_att|cap|hat|glasses)/i.test(nName) ||
                             /(hair|eyebrow|beard|mustache|eyelash|scalp)/i.test(mName);

          if (isHeadPart) {
            meshesToReparent.push(node);
          }
        }
      });

      meshesToReparent.forEach((mesh) => {
        // Calculate world transform of mesh relative to headBone
        headBone.attach(mesh);
        this._headAttachments.push({
          mesh: mesh,
          originalParent: mesh.parent
        });
        console.log(`[Renderer] Fixação Física Direta: "${mesh.name}" ancorado ao osso "${headBone.name}"`);
      });

      // Synchronize all skeletal head bones across multi-skin models (FaceMesh, Outfits, BodyMesh, MetaHuman Facial Rig)
      this._allHeadBones = [];
      this._allNeckBones = [];
      model.traverse((node) => {
        if (node.isBone) {
          const bName = node.name || '';
          const isFacialRoot = /(facial_c_facialroot|facialroot)/i.test(bName);
          const isHead = (headRegex.test(bName) || isFacialRoot) && (!isExcluded(bName) || isFacialRoot);
          if (isHead) {
            if (!this._allHeadBones.includes(node)) {
              node.userData.restEuler = node.rotation.clone();
              node.userData.restQuaternion = node.quaternion.clone();
              this._allHeadBones.push(node);
              console.log(`[Renderer] Sincronização Craniana: osso "${bName}" vinculado à rotação da cabeça`);
            }
          }
          if (neckRegex.test(bName) && !isExcluded(bName)) {
            if (!this._allNeckBones.includes(node)) {
              node.userData.restEuler = node.rotation.clone();
              node.userData.restQuaternion = node.quaternion.clone();
              this._allNeckBones.push(node);
            }
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
    this._applyLightingIntensities();

    if (this.animations.length > 0) {
      this._mixer = new THREE.AnimationMixer(model);
      model.userData.animations = this.animations;
      console.log(`[Renderer] ${this.animations.length} clipe(s) de animação carregado(s) com o modelo.`);
    }

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
   * Rebuild or scale synthesized ARKit blendshapes on the active model.
   * @param {Object} [options] - Calibration intensities { globalIntensity, mouthIntensity, eyeIntensity, browIntensity }
   * @returns {number} Count of blendshapes synthesized
   */
  rebuildBlendshapes(options = {}) {
    if (!this._model) return 0;

    const count = rebuildModelBlendshapes(this._model, options);
    if (count > 0) {
      const updated = buildModelMap(this._model);
      this._modelMap = updated.map;
      this.blendshapeCoverage = updated.coverage;

      // Ensure morph influences array is initialized
      this._model.traverse((node) => {
        if (node.isMesh && node.geometry && node.geometry.morphAttributes) {
          const morphPos = node.geometry.morphAttributes.position;
          if (morphPos && morphPos.length > 0) {
            node.geometry.morphTargetsRelative = true;
            if (typeof node.updateMorphTargets === 'function') {
              node.updateMorphTargets();
            } else {
              node.morphTargetInfluences = new Array(morphPos.length).fill(0);
            }
          }
        }
      });
      console.log(`[Renderer] Auto-Rig facial atualizado: ${count} blendshapes ARKit. Cobertura: ${this.blendshapeCoverage}/52`);
    }
    return count;
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
        this._baseKeyIntensity = 2.8;
        this._keyLight.position.set(2.5, 1.2, 1.8);
        this._fillLight.color.setHex(0x7040aa);
        this._baseFillIntensity = 0.8;
        this._fillLight.position.set(-2.0, 0.2, 1.0);
        this._rimLight.color.setHex(0xff6622);
        this._baseRimIntensity = 1.4;
        this._rimLight.position.set(0, 1.5, -2.0);
        this._ambientLight.color.setHex(0xffe0cc);
        this._baseAmbientIntensity = 0.45;
        break;

      case 'cyber':
        this._keyLight.color.setHex(0x00f0ff);
        this._baseKeyIntensity = 2.4;
        this._keyLight.position.set(2.0, 1.5, 1.5);
        this._fillLight.color.setHex(0xff0077);
        this._baseFillIntensity = 1.8;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0x7700ff);
        this._baseRimIntensity = 2.0;
        this._rimLight.position.set(0, 1.5, -2.5);
        this._ambientLight.color.setHex(0x08041a);
        this._baseAmbientIntensity = 0.35;
        break;

      case 'toon':
        this._keyLight.color.setHex(0xffffff);
        this._baseKeyIntensity = 2.4;
        this._keyLight.position.set(2.0, 2.0, 2.0);
        this._fillLight.color.setHex(0x99bbff);
        this._baseFillIntensity = 0.5;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xffffff);
        this._baseRimIntensity = 0.8;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xffffff);
        this._baseAmbientIntensity = 0.8;
        break;

      case 'smooth':
        this._keyLight.color.setHex(0xfffaee);
        this._baseKeyIntensity = 1.4;
        this._keyLight.position.set(1.5, 1.8, 2.0);
        this._fillLight.color.setHex(0xffe4db);
        this._baseFillIntensity = 1.0;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xffffff);
        this._baseRimIntensity = 0.6;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xfff5f0);
        this._baseAmbientIntensity = 1.2;
        break;

      case 'unreal':
        // Unreal Engine 5 Lumen / Cinematic Lighting setup matching UE5 studio portrait
        this._keyLight.color.setHex(0xfffaec);
        this._baseKeyIntensity = 3.0;
        this._keyLight.position.set(2.2, 2.6, 2.4);
        this._fillLight.color.setHex(0x94a3b8);
        this._baseFillIntensity = 0.85;
        this._fillLight.position.set(-2.4, 0.6, 1.8);
        this._rimLight.color.setHex(0x93c5fd);
        this._baseRimIntensity = 2.0;
        this._rimLight.position.set(0.4, 2.0, -2.6);
        this._ambientLight.color.setHex(0x1e293b);
        this._baseAmbientIntensity = 0.5;
        if (this._scene) this._scene.environment = this._envMap;
        break;

      case 'clay':
      case 'normals':
      case 'wireframe':
      case 'studio':
      default:
        // Balanced Studio 3-point light
        this._keyLight.color.setHex(0xfff5e0);
        this._baseKeyIntensity = 2.0;
        this._keyLight.position.set(1.5, 2.0, 2.0);
        this._fillLight.color.setHex(0xd0e8ff);
        this._baseFillIntensity = 1.0;
        this._fillLight.position.set(-2.0, 0.5, 1.5);
        this._rimLight.color.setHex(0xaa88ff);
        this._baseRimIntensity = 0.8;
        this._rimLight.position.set(0, 1.0, -2.0);
        this._ambientLight.color.setHex(0xffffff);
        this._baseAmbientIntensity = 0.7;
        if (this._scene) this._scene.environment = this._envMap;
        break;
    }

    this._applyLightingIntensities();

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

    const baseAlphaTest = orig.alphaTest > 0 ? orig.alphaTest : (isAlpha ? 0.05 : 0);
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
        const wfMat = orig.clone();
        wfMat.wireframe = true;
        return wfMat;
      }

      case 'unreal':
      case 'studio':
      case 'sunset':
      case 'cyber':
      default: {
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
   * Set overall lighting intensity multiplier (0.0 to 2.5).
   * Controls directional lights, ambient light and environment IBL.
   * @param {number} mult - 0.0 to 2.5
   */
  setLightingIntensity(mult) {
    this._lightIntensity = Math.max(0, Number(mult));
    this._applyLightingIntensities();
  }

  _applyLightingIntensities() {
    const mult = this._lightIntensity;
    if (this._keyLight) this._keyLight.intensity = this._baseKeyIntensity * mult;
    if (this._fillLight) this._fillLight.intensity = this._baseFillIntensity * mult;
    if (this._rimLight) this._rimLight.intensity = this._baseRimIntensity * mult;
    if (this._ambientLight) this._ambientLight.intensity = this._baseAmbientIntensity * mult;

    // Scale scene environment IBL and tone mapping exposure when lighting is lowered
    if (this._scene) {
      if (mult <= 0.001) {
        this._scene.environment = null;
      } else {
        this._scene.environment = this._envMap;
      }
    }

    if (this._model) {
      this._model.traverse((node) => {
        if (node.isMesh && node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => {
            if (m.envMapIntensity !== undefined) {
              if (m.userData && m.userData.baseEnvMapIntensity !== undefined) {
                m.envMapIntensity = m.userData.baseEnvMapIntensity * mult;
              } else {
                m.userData = m.userData || {};
                m.userData.baseEnvMapIntensity = m.envMapIntensity;
                m.envMapIntensity = m.envMapIntensity * mult;
              }
            }
          });
        }
      });
    }
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

  /**
   * Set tone mapping exposure (0.1 to 3.0).
   * @param {number} val
   */
  setExposure(val) {
    const exp = Math.max(0.1, Math.min(3.0, Number(val)));
    this._renderer.toneMappingExposure = exp;
  }

  /**
   * Get current tone mapping exposure.
   * @returns {number}
   */
  getExposure() {
    return this._renderer.toneMappingExposure;
  }

  /**
   * Toggle ground contact shadow plane.
   * @param {boolean} enabled
   */
  setGroundShadow(enabled) {
    this._groundShadowEnabled = Boolean(enabled);
    if (this._groundPlane) {
      this._groundPlane.visible = this._groundShadowEnabled;
    }
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

      const headBones = this._allHeadBones && this._allHeadBones.length > 0 ? this._allHeadBones : [this._headBone];
      const neckBones = this._allNeckBones && this._allNeckBones.length > 0 ? this._allNeckBones : (this._neckBone ? [this._neckBone] : []);

      if (neckBones.length > 0) {
        // Natural organic distribution: 25% on neck, 75% on head
        const neckRot = new THREE.Euler(rx * 0.25, ry * 0.25, rz * 0.25, 'YXZ');
        const neckDeltaQ = new THREE.Quaternion().setFromEuler(neckRot);
        neckBones.forEach((b) => {
          const restQ = b.userData.restQuaternion || b.quaternion;
          b.quaternion.copy(restQ).multiply(neckDeltaQ);
        });

        const headRot = new THREE.Euler(rx * 0.75, ry * 0.75, rz * 0.75, 'YXZ');
        const headDeltaQ = new THREE.Quaternion().setFromEuler(headRot);
        headBones.forEach((b) => {
          const restQ = b.userData.restQuaternion || b.quaternion;
          b.quaternion.copy(restQ).multiply(headDeltaQ);
        });
      } else {
        // 100% on head bones
        const headRot = new THREE.Euler(rx, ry, rz, 'YXZ');
        const headDeltaQ = new THREE.Quaternion().setFromEuler(headRot);
        headBones.forEach((b) => {
          const restQ = b.userData.restQuaternion || b.quaternion;
          b.quaternion.copy(restQ).multiply(headDeltaQ);
        });
      }

      // Update world matrix of all bones
      this._headBone.updateMatrixWorld(true);

      // Organic hair sway physics for hair attachments (now attached directly to head bone)
      if (this._headAttachments && this._headAttachments.length > 0) {
        const dPitch = rx - (this._prevHeadPitch || 0);
        const dYaw = ry - (this._prevHeadYaw || 0);
        const dRoll = rz - (this._prevHeadRoll || 0);

        this._prevHeadPitch = rx;
        this._prevHeadYaw = ry;
        this._prevHeadRoll = rz;
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
    this._keyLight.shadow.mapSize.set(2048, 2048);
    this._keyLight.shadow.bias = -0.0001;
    this._keyLight.shadow.normalBias = 0.02;
    this._keyLight.shadow.camera.near = 0.1;
    this._keyLight.shadow.camera.far = 25;
    this._scene.add(this._keyLight);

    // Fill Light: Soft cool fill on shadow side to preserve hair volume & skin micro-contrast
    this._fillLight = new THREE.DirectionalLight(0xbcd7ff, 0.85);
    this._fillLight.position.set(-1.8, 0.4, 1.6);
    this._scene.add(this._fillLight);

    // Rim / Hair Kicker Light: High-angle back kicker to trigger anisotropic cuticle sheen
    this._rimLight = new THREE.DirectionalLight(0xffeedd, 1.6);
    this._rimLight.position.set(0.2, 2.2, -2.2);
    this._scene.add(this._rimLight);

    // Ground Contact Shadow Plane (Sketchfab & Unreal Studio style)
    const groundGeo = new THREE.PlaneGeometry(14, 14);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this._groundPlane = new THREE.Mesh(groundGeo, groundMat);
    this._groundPlane.rotation.x = -Math.PI / 2;
    this._groundPlane.position.y = -1.0;
    this._groundPlane.receiveShadow = true;
    this._scene.add(this._groundPlane);

    this._updateLightPosition();
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    this._controls.update();

    // ── 0. Animation Mixer Update ──
    const delta = this._clock.getDelta();
    if (this._mixer) {
      this._mixer.update(delta);
    }

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
   * Injects high-fidelity Unreal Groom strand rendering & tip tapering into MeshStandard/Physical materials.
   * Eliminates chunky quad cards and synthesizes fine hair/eyelash micro-filaments with soft alpha falloff.
   *
   * @param {THREE.Material} material
   * @param {boolean} [isEyelash=false]
   */
  _applyHairStrandShader(material, isEyelash = false) {
    if (!material) return;
    material.polygonOffset = true;
    material.polygonOffsetFactor = isEyelash ? -2.5 : -1.5;
    material.polygonOffsetUnits = isEyelash ? -5.0 : -3.0;
    material.alphaToCoverage = true;
    material.transparent = true;
    material.depthWrite = true;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    if (material.alphaTest <= 0 || material.alphaTest > 0.05) {
      material.alphaTest = 0.04;
    }

    const strandShader = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        // High-precision strand generator & tip tapering for hair / lash groom cards
        float getProceduralStrandMask(vec2 uv, bool isLash) {
          float strandRepeat = isLash ? 8.0 : 4.0;
          float strandU = fract(uv.x * strandRepeat);
          float strandDist = abs(strandU - 0.5) * 2.0;

          // Tip tapering: narrow towards card tip (along V coordinate)
          float tipFactor = clamp(1.0 - uv.y * 0.82, 0.08, 1.0);
          float fiberAlpha = smoothstep(tipFactor, tipFactor * 0.28, strandDist);

          // Root-to-tip subtle opacity gradient
          float rootTipGradient = smoothstep(0.99, 0.75, uv.y);
          return clamp(fiberAlpha * rootTipGradient, 0.0, 1.0);
        }
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
        #ifdef USE_UV
          #ifdef USE_MAP
            // If diffuse map has solid alpha or lacks alpha channel, synthesize hair fibers
            if (diffuseColor.a > 0.90) {
              diffuseColor.a = getProceduralStrandMask(vUv, ${isEyelash ? 'true' : 'false'});
            } else {
              // Enhance existing alpha map with subtle tip tapering
              diffuseColor.a *= clamp(1.0 - abs(vUv.x - 0.5) * 0.3, 0.6, 1.0);
            }
          #else
            diffuseColor.a = getProceduralStrandMask(vUv, ${isEyelash ? 'true' : 'false'});
          #endif
        #endif
        `
      );
    };

    material.onBeforeCompile = strandShader;
    material.needsUpdate = true;
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

      // In MetaHuman baked hair/eyebrow textures, empty space outside cards is pure black RGB(0,0,0).
      // Hair and eyebrow strands contain the rich melanin base tone RGB(52, 40, 29).
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const maxVal = Math.max(r, g, b);

        if (maxVal <= 2) {
          // Transparent empty space / card cutout
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 0;
        } else {
          // Hair / Eyebrow card strand area: full opacity with soft anti-aliased edge
          const edgeAlpha = Math.min(255, Math.round(Math.min(1.0, (maxVal - 1.0) / 8.0) * 255));
          data[i] = edgeAlpha;
          data[i + 1] = edgeAlpha;
          data[i + 2] = edgeAlpha;
          data[i + 3] = 255;
        }
      }

      ctx.putImageData(imgData, 0, 0);

      const alphaMap = new THREE.CanvasTexture(canvas);
      alphaMap.wrapS = texture.wrapS || THREE.RepeatWrapping;
      alphaMap.wrapT = texture.wrapT || THREE.RepeatWrapping;
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
    colorTex.flipY = false;
    colorTex.needsUpdate = true;

    const alphaTex = new THREE.CanvasTexture(alphaCanvas);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.RepeatWrapping;
    alphaTex.flipY = false;
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
    const numStrands = 80;
    const spacing = width / numStrands;

    aCtx.fillStyle = '#ffffff';

    for (let i = 0; i < numStrands; i++) {
      const xBase = i * spacing + spacing * 0.5 + (Math.sin(i * 3.7) * (spacing * 0.25));
      const strandLen = height * (0.75 + Math.sin(i * 2.1) * 0.20);
      const curlCurve = (Math.sin(i * 1.3) * 28) + (i % 2 === 0 ? 10 : -10);
      const rootWidth = 4.2 + Math.sin(i * 5.1) * 1.2;

      // Root to tip quadratic curve
      aCtx.beginPath();
      aCtx.moveTo(xBase - rootWidth * 0.5, height);
      aCtx.lineTo(xBase + rootWidth * 0.5, height);
      aCtx.quadraticCurveTo(
        xBase + curlCurve * 0.5 + 1.5, height - strandLen * 0.5,
        xBase + curlCurve, height - strandLen
      );
      aCtx.quadraticCurveTo(
        xBase + curlCurve * 0.5 - 1.5, height - strandLen * 0.5,
        xBase - rootWidth * 0.5, height
      );
      aCtx.closePath();
      aCtx.fill();
    }

    const colorTex = new THREE.CanvasTexture(colorCanvas);
    colorTex.wrapS = THREE.RepeatWrapping;
    colorTex.wrapT = THREE.ClampToEdgeWrapping;
    colorTex.flipY = false;
    colorTex.needsUpdate = true;

    const alphaTex = new THREE.CanvasTexture(alphaCanvas);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.ClampToEdgeWrapping;
    alphaTex.flipY = false;
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

  /**
   * Returns metadata for all animation clips embedded in or attached to the current model.
   * @returns {Array<{ index: number, name: string, duration: number, tracksCount: number }>}
   */
  getAnimationClips() {
    if (!this.animations || this.animations.length === 0) return [];
    return this.animations.map((clip, index) => ({
      index,
      name: clip.name || `Animação ${index + 1}`,
      duration: clip.duration,
      tracksCount: clip.tracks.length,
    }));
  }

  /**
   * Evaluates and extracts all keyframes from an AnimationClip into MotionTimeline frame format.
   * @param {THREE.AnimationClip|number|string} clipOrIndex
   * @param {number} [fps=60]
   * @returns {{ name: string, duration: number, frames: Array, keyframeTimes: number[] }|null}
   */
  extractAnimationClip(clipOrIndex = 0, fps = 60) {
    if (!this._innerModel || !this.animations || this.animations.length === 0) return null;

    let clip = null;
    if (typeof clipOrIndex === 'number') {
      clip = this.animations[clipOrIndex] || this.animations[0];
    } else if (typeof clipOrIndex === 'string') {
      clip = this.animations.find((c) => c.name === clipOrIndex) || this.animations[0];
    } else if (clipOrIndex && clipOrIndex.isAnimationClip) {
      clip = clipOrIndex;
    } else {
      clip = this.animations[0];
    }

    if (!clip) return null;

    const duration = Math.max(0.01, clip.duration);
    const keyframeTimesSet = new Set();

    // 1. Gather all unique keyframe timestamps from tracks
    clip.tracks.forEach((track) => {
      if (track.times && track.times.length > 0) {
        for (let i = 0; i < track.times.length; i++) {
          const t = Math.max(0, Math.min(duration, parseFloat(track.times[i].toFixed(4))));
          keyframeTimesSet.add(t);
        }
      }
    });

    keyframeTimesSet.add(0);
    keyframeTimesSet.add(parseFloat(duration.toFixed(4)));

    const keyframeTimes = Array.from(keyframeTimesSet).sort((a, b) => a - b);

    // 2. Sample the clip across the timeline using an isolated AnimationMixer
    const tempMixer = new THREE.AnimationMixer(this._innerModel);
    const action = tempMixer.clipAction(clip);
    action.play();

    const dt = 1.0 / Math.max(1, fps);
    const totalSteps = Math.ceil(duration / dt) + 1;
    const sampledTimesSet = new Set(keyframeTimes);

    for (let s = 0; s < totalSteps; s++) {
      const t = Math.min(duration, s * dt);
      sampledTimesSet.add(parseFloat(t.toFixed(4)));
    }

    const allSampleTimes = Array.from(sampledTimesSet).sort((a, b) => a - b);
    const frames = [];
    const headBone = this._headBone;

    for (let i = 0; i < allSampleTimes.length; i++) {
      const t = allSampleTimes[i];
      tempMixer.setTime(t);
      tempMixer.update(0);

      // Extract blendshapes
      const blendShapes = {};
      if (this._modelMap) {
        for (const [stdName, targets] of Object.entries(this._modelMap)) {
          let maxVal = 0;
          for (let j = 0; j < targets.length; j++) {
            const { mesh, index } = targets[j];
            if (mesh.morphTargetInfluences && mesh.morphTargetInfluences[index] !== undefined) {
              const val = mesh.morphTargetInfluences[index];
              if (val > maxVal) maxVal = val;
            }
          }
          if (maxVal > 0.001) {
            blendShapes[stdName] = parseFloat(maxVal.toFixed(4));
          }
        }
      }

      // Extract rotation if head bone is animated
      let rotation = null;
      if (headBone) {
        const euler = new THREE.Euler().setFromQuaternion(headBone.quaternion, 'YXZ');
        rotation = {
          pitch: parseFloat(euler.x.toFixed(4)),
          yaw:   parseFloat(euler.y.toFixed(4)),
          roll:  parseFloat(euler.z.toFixed(4)),
        };
      }

      frames.push({
        time: t,
        blendShapes,
        rotation,
      });
    }

    tempMixer.stopAllAction();
    if (this._innerModel) {
      tempMixer.uncacheRoot(this._innerModel);
    }

    return {
      name: clip.name || 'Animation',
      duration,
      frames,
      keyframeTimes,
    };
  }

  /**
   * Imports standalone animation file (.glb / .gltf / .fbx) and adds clips to the current character model.
   * @param {ArrayBuffer|Blob} data
   * @param {string} [filename='animation.glb']
   * @returns {Promise<Array<THREE.AnimationClip>>}
   */
  async importAnimationFromBuffer(data, filename = 'animation.glb') {
    if (!this._innerModel) {
      throw new Error('Nenhum modelo 3D carregado para receber a animação.');
    }

    const lowerName = filename.toLowerCase();
    let importedClips = [];

    if (lowerName.endsWith('.fbx')) {
      const fbxLoader = new FBXLoader();
      let buffer = data;
      if (data instanceof Blob) {
        buffer = await data.arrayBuffer();
      }
      const fbx = fbxLoader.parse(buffer, '');
      if (fbx.animations && fbx.animations.length > 0) {
        importedClips = fbx.animations;
      }
    } else {
      let buffer = data;
      if (data instanceof Blob) {
        buffer = await data.arrayBuffer();
      }
      const gltf = await this._loader.parseAsync(buffer, '');
      if (gltf.animations && gltf.animations.length > 0) {
        importedClips = gltf.animations;
      }
    }

    if (importedClips.length === 0) {
      throw new Error('O arquivo importado não contém trilhas de animação.');
    }

    // Add new clips to animations array
    importedClips.forEach((c, idx) => {
      if (!c.name || c.name === 'default') {
        c.name = `${filename.replace(/\.[^/.]+$/, '')}_${idx + 1}`;
      }
      this.animations.push(c);
    });

    if (!this._mixer) {
      this._mixer = new THREE.AnimationMixer(this._innerModel);
    }
    this._innerModel.userData.animations = this.animations;

    console.log(`[Renderer] ${importedClips.length} novos clipes de animação importados de ${filename}.`);
    return importedClips;
  }
}
