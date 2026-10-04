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
        let clean = decodeURIComponent(itemUrl).replace(/\\/g, '/').replace(/['"]/g, '').trim();
        // Remove blob origin if present e.g. "blob:http://localhost:3000/UUID/" or "blob:http://localhost:3000/"
        clean = clean.replace(/^blob:[^/]+\/\/[^/]+\/[0-9a-f-]+\//i, '');
        clean = clean.replace(/^blob:[^/]+\/\/[^/]+\//i, '');
        // Remove http(s) origin if present
        clean = clean.replace(/^https?:\/\/[^/]+\//i, '');
        // Remove Windows drive letters e.g. "C:/" or "D:/"
        clean = clean.replace(/^[a-zA-Z]:\/?/i, '');
        // Remove leading slashes or dot-slashes
        clean = clean.replace(/^(\.\/|\/)+/, '');

        const baseName = clean.split('/').pop();

        // 1. Direct match on clean path
        if (assetMap[clean]) return assetMap[clean];
        if (assetMap[clean.toLowerCase()]) return assetMap[clean.toLowerCase()];

        // 2. Direct match on basename
        if (assetMap[baseName]) return assetMap[baseName];
        if (assetMap[baseName.toLowerCase()]) return assetMap[baseName.toLowerCase()];

        // 3. Match by suffix / endsWith or includes
        const match = Object.keys(assetMap).find((k) => {
          const lk = k.toLowerCase();
          const lb = baseName.toLowerCase();
          const lc = clean.toLowerCase();
          return lk === lb || lk === lc || lk.endsWith('/' + lb) || lc.endsWith('/' + lk) || lk.endsWith('/' + lc) || lc.endsWith(lk);
        });
        if (match) return assetMap[match];

        // 4. Token-based matching (e.g. "Head_Normal.jpeg" -> "Head_withpaint_Normal.jpeg")
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

      // Auto-bind de Texturas: se o modelo não tiver texturas aplicadas, vincular automaticamente imagens do assetMap
      const imageKeys = Object.keys(assetMap).filter((k) => /\.(png|jpe?g|webp|bmp)$/i.test(k));
      if (imageKeys.length > 0) {
        let hasAnyMap = false;
        model.traverse((node) => {
          if (node.isMesh && node.material) {
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            if (mats.some((m) => Boolean(m.map))) hasAnyMap = true;
          }
        });

        if (!hasAnyMap) {
          console.log('[Renderer] Auto-bind inteligente: associando imagens arrastadas/da pasta ao modelo .obj');
          const texLoader = new THREE.TextureLoader();
          const loadedTextures = new Map();

          const getTexture = (fileKey, isColor = false) => {
            if (!fileKey || !assetMap[fileKey]) return null;
            const texUrl = assetMap[fileKey];
            if (!loadedTextures.has(texUrl)) {
              const tex = texLoader.load(texUrl);
              if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
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

                const pbrMat = new THREE.MeshStandardMaterial({
                  name: matName || meshName || 'AutoPBR',
                  map: albedoTex,
                  normalMap: normalTex,
                  roughnessMap: roughnessTex,
                  metalnessMap: metallicTex,
                  alphaMap: alphaTex,
                  transparent: Boolean(alphaTex),
                  roughness: roughnessTex ? 1.0 : 0.6,
                  metalness: metallicTex ? 1.0 : 0.05,
                  side: THREE.DoubleSide,
                });
                createdMaterials.set(matKey, pbrMat);
              }

              node.material = createdMaterials.get(matKey);
            }
          });
        }
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

    // Ensure all materials are double-sided, properly sorted for alpha blending, and skin/eyes/hair rendered with Unreal Engine realistic PBR
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          if (!node.userData.originalMaterial) {
            node.userData.originalMaterial = Array.isArray(node.material)
              ? node.material.map((mat) => mat.clone())
              : node.material.clone();
          }

          const mats = Array.isArray(node.material) ? node.material : [node.material];
          const newMats = mats.map((m) => {
            const matName = (m.name || '').toLowerCase();
            const nodeName = (node.name || '').toLowerCase();

            // 0. Converter materiais legados Phong (criados pelo MTLLoader do .obj) para PBR MeshStandardMaterial
            // com busca inteligente de mapas de Roughness, Metallic, Normal e Opacity no assetMap
            if (m.isMeshPhongMaterial) {
              const baseMap = m.map;
              if (baseMap) baseMap.colorSpace = THREE.SRGBColorSpace;

              let normalMap = m.normalMap || m.bumpMap;
              let alphaMap = m.alphaMap;
              let roughnessMap = null;
              let metallicMap = null;

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

                roughnessMap = findMap(/(roughness|rough|ns)/i);
                metallicMap = findMap(/(metallic|metal|refl)/i);
                if (!normalMap) normalMap = findMap(/(normal|norm|nrm|bump)/i);
                if (!alphaMap) alphaMap = findMap(/(opacity|alpha|mask)/i);
              }

              m = new THREE.MeshStandardMaterial({
                name: m.name,
                color: new THREE.Color(0xffffff),
                map: baseMap,
                normalMap: normalMap,
                roughnessMap: roughnessMap,
                metalnessMap: metallicMap,
                alphaMap: alphaMap,
                roughness: roughnessMap ? 1.0 : 0.65,
                metalness: metallicMap ? 1.0 : 0.05,
                transparent: Boolean(alphaMap || m.transparent),
                side: THREE.DoubleSide,
              });
            }

            m.side = THREE.DoubleSide;

            // 1. Pelos de Roupas, Cartões de Pelugem e Pelos Sintéticos (Sketchfab & Unreal PBR Standard)
            const isFurOrCards = matName.includes('fur') || matName.includes('pelo') ||
                                 matName.includes('card') || nodeName.includes('fur');

            if (isFurOrCards) {
              m.roughness = 0.90; // Pelos orgânicos e foscos
              m.metalness = 0.0;
              m.transparent = true;
              // No Sketchfab, alphaTest em cartões de pelo/cabelo é baixo (0.05) para não decepar as pontas finas dos fios
              m.alphaTest = 0.05;
              m.depthWrite = true; // Permite oclusão e profundidade correta sem ver através do corpo
              m.depthTest = true;
              m.alphaToCoverage = true;
              m.side = THREE.DoubleSide; // Ambas as faces visíveis em cartões 2D
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.25;
              return m;
            }

            // 2. Fios de Cabelo do MetaHuman (CardsMesh no padrão Unreal Engine Groom Cards)
            else if (isMetaHuman && (matName.includes('hair') || (matName.includes('cards_m') && !matName.includes('eyebrow')))) {
              const originalNormal = m.normalMap || null;
              // Preservar a textura original dos cards do MetaHuman (Unreal Engine baked PNG)
              const hasOriginalMap = Boolean(m.map);
              const hairGroom = hasOriginalMap ? null : this._createProceduralHairStrands();
              const diffuseMap = hasOriginalMap ? m.map : hairGroom.map;
              const alphaMap = m.alphaMap || (hasOriginalMap ? m.map : hairGroom.alphaMap);

              if (diffuseMap) diffuseMap.colorSpace = THREE.SRGBColorSpace;

              const hairMat = new THREE.MeshPhysicalMaterial({
                color: hasOriginalMap ? new THREE.Color(0xffffff) : new THREE.Color(0x281c14),
                map: diffuseMap,
                alphaMap: alphaMap,
                normalMap: originalNormal,
                roughness: 0.45, // PBR queratina natural do Unreal Hair Shader
                metalness: 0.0,
                clearcoat: 0.40,
                clearcoatRoughness: 0.22,
                specularIntensity: 0.70,
                specularColor: new THREE.Color(0xb5825a),
                sheen: 0.45,
                sheenColor: new THREE.Color(0x52321c),
                sheenRoughness: 0.30,
                transparent: true,
                alphaTest: 0.05, // Recorte fino anti-aliasing preservando 100% da volumetria dos fios originais
                depthWrite: true,
                depthTest: true,
                alphaToCoverage: true,
                side: THREE.DoubleSide,
                name: m.name,
              });

              // Compatibilidade com texturas de Groom do Unreal Engine
              node.userData.groomSlots = {
                diffuse: diffuseMap,
                alpha: alphaMap,
                depth: null,
                rootTip: null,
                normal: originalNormal,
              };

              if (hairMat.envMapIntensity !== undefined) hairMat.envMapIntensity = 0.55;
              return hairMat;
            }
            // 3. Sobrancelhas do MetaHuman (CardsMesh — Preservando Textura Original ou Procedural Fallback)
            else if (isMetaHuman && matName.includes('eyebrow')) {
              const hasOriginalMap = Boolean(m.map);
              const browGroom = hasOriginalMap ? null : this._createProceduralEyebrowTextures();
              const diffuseMap = hasOriginalMap ? m.map : browGroom.map;
              const alphaMap = m.alphaMap || (hasOriginalMap ? m.map : browGroom.alphaMap);

              if (diffuseMap) diffuseMap.colorSpace = THREE.SRGBColorSpace;

              const browMat = new THREE.MeshPhysicalMaterial({
                color: hasOriginalMap ? new THREE.Color(0xffffff) : new THREE.Color(0x1a120c),
                map: diffuseMap,
                alphaMap: alphaMap,
                roughness: 0.38,
                metalness: 0.0,
                specularIntensity: 0.65,
                specularColor: new THREE.Color(0x6e482e),
                sheen: 0.45,
                sheenColor: new THREE.Color(0x3e2314),
                transparent: true,
                alphaTest: 0.05,
                depthWrite: true,
                depthTest: true,
                polygonOffset: true,
                polygonOffsetFactor: -3,
                polygonOffsetUnits: -6,
                alphaToCoverage: true,
                side: THREE.DoubleSide,
                name: m.name,
              });

              node.userData.groomSlots = {
                diffuse: diffuseMap,
                alpha: alphaMap,
                normal: m.normalMap || null,
              };

              if (browMat.envMapIntensity !== undefined) browMat.envMapIntensity = 0.50;
              return browMat;
            }
            // 4. Cílios do MetaHuman (Preservando Textura Original ou Procedural Fallback)
            else if (isMetaHuman && (matName.includes('eyelashes') || matName.includes('lashmat') || matName.includes('lash_mat'))) {
              const hasOriginalMap = Boolean(m.map);
              const lashTex = hasOriginalMap ? null : this._createProceduralEyelashTextures();
              const diffuseMap = hasOriginalMap ? m.map : lashTex.map;
              const alphaMap = m.alphaMap || (hasOriginalMap ? m.map : lashTex.alphaMap);
              const hasVertexColor = Boolean(node.geometry && node.geometry.attributes && node.geometry.attributes.color);

              if (diffuseMap) diffuseMap.colorSpace = THREE.SRGBColorSpace;

              const lashMat = new THREE.MeshPhysicalMaterial({
                color: hasOriginalMap ? new THREE.Color(0xffffff) : new THREE.Color(0x120c09),
                map: diffuseMap,
                alphaMap: alphaMap,
                roughness: 0.30,
                metalness: 0.0,
                specularIntensity: 0.70,
                specularColor: new THREE.Color(0x503525),
                sheen: 0.35,
                sheenColor: new THREE.Color(0x281910),
                transparent: true,
                alphaTest: 0.05,
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

              if (!hasOriginalMap) {
                // Tapering procedural caso não haja textura original
                lashMat.onBeforeCompile = (shader) => {
                  shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <alphamap_fragment>',
                    `#include <alphamap_fragment>
                    float tipTaper = smoothstep(0.0, 0.92, 1.0 - abs(vUv.y - 0.5) * 1.5);
                    diffuseColor.a *= clamp(tipTaper, 0.1, 1.0);
                    `
                  );
                };
              }

              if (lashMat.envMapIntensity !== undefined) lashMat.envMapIntensity = 0.55;
              return lashMat;
            }
            // 5. Cabelos de Personagens Estilizados e Gerais (Winter Girl, etc.)
            else if (matName.includes('hair') || matName.includes('cabelo') || nodeName.includes('hair')) {
              m.roughness = 0.75; // Cabelo fosco estilizado (não-metálico)
              m.metalness = 0.0;
              if (m.alphaMap) {
                m.transparent = true;
                // No Sketchfab, alphaTest em cartões de cabelo é baixo (0.05) para não decepar as pontas finas dos fios
                m.alphaTest = 0.05;
                m.depthWrite = true;
                m.depthTest = true;
                m.alphaToCoverage = true;
              }
              m.side = THREE.DoubleSide;
              if (m.clearcoat !== undefined) m.clearcoat = 0.0;
              if (m.specularIntensity !== undefined) m.specularIntensity = 0.25;
              if (m.specularColor !== undefined) m.specularColor.setHex(0x111111);
              if (m.anisotropy !== undefined) m.anisotropy = 0.0;
              if (m.sheen !== undefined) m.sheen = 0.0;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.40;
              if (m.color) m.color.setHex(0xffffff);
              return m;
            }
            // 6. Pele / Cabeça / Corpo do MetaHuman e Avatares PBR
            else if (matName.includes('head_shader') || matName.includes('body_mi') || matName.includes('skin') || matName.includes('face') || matName.includes('head') || nodeName === 'head') {
              m.roughness = 0.58; // Rugosidade natural de pele humana (micro-textura)
              m.metalness = 0.0;
              // A pele do crânio é sólida: garante gravação de profundidade e remove transparência acidental
              m.transparent = false;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.specularIntensity !== undefined) m.specularIntensity = 0.35;
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.45;
              return m;
            }
            // 7. Roupas, Casacos, Calças, Braços, Peito, Sapatos e Acessórios (excluindo pelos/fur)
            else if (!matName.includes('fur') && !nodeName.includes('fur') && (matName.includes('top_') || matName.includes('btm_') || matName.includes('slacks') || matName.includes('shirt') || matName.includes('cloth') || matName.includes('outfit') || matName.includes('coat') || matName.includes('arm') || matName.includes('chest') || matName.includes('trouser') || matName.includes('skirt') || matName.includes('shoe') || matName.includes('accessoire') || matName.includes('luggage') || matName.includes('tool'))) {
              m.roughness = m.roughnessMap ? 1.0 : 0.80; // Tecido fosco / PBR
              m.metalness = m.metalnessMap ? 1.0 : 0.0;
              m.transparent = false;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.3;
              return m;
            }
            // 8. Dentes e Boca
            else if (matName.includes('teeth')) {
              m.roughness = 0.28;
              m.metalness = 0.0;
              m.depthWrite = true;
              m.side = THREE.DoubleSide;
              return m;
            }
            // 9. Camadas Oclusoras dos Olhos / Hidden Shells (desativar para não cobrir o globo ocular)
            else if (matName.includes('eyeshell') || matName.includes('eyeedge') || matName.includes('saliva') || matName.includes('cartilage') || matName.includes('m_hide') || matName.includes('lacrimal')) {
              m.transparent = true;
              m.opacity = 0.0;
              m.depthWrite = false;
              m.visible = false;
              return m;
            }
            // 10. Globo Ocular / Íris / Esclera
            else if (matName.includes('eyeleft') || matName.includes('eyeright') || matName.includes('eyeball') || matName.includes('eyel_baked') || matName.includes('eyer_baked') || matName.includes('eye') || nodeName === 'eyes') {
              m.roughness = 0.12; // Córnea nítida com reflexo especular equilibrado
              m.metalness = 0.0;
              m.transparent = false;
              m.opacity = 1.0;
              m.depthWrite = true;
              m.depthTest = true;
              m.side = THREE.DoubleSide;
              if (m.color) m.color.setHex(0xffffff);
              if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.2;
              return m;
            }

            m.side = THREE.DoubleSide;
            m.depthWrite = true;
            m.depthTest = true;
            if (m.color) m.color.setHex(0xffffff);
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

      // Synchronize all skeletal head bones across multi-skin models (FaceMesh, Outfits, BodyMesh)
      this._allHeadBones = [];
      this._allNeckBones = [];
      model.traverse((node) => {
        if (node.isBone) {
          const bName = node.name || '';
          if (headRegex.test(bName) && !isExcluded(bName)) {
            if (!this._allHeadBones.includes(node)) {
              node.userData.restEuler = node.rotation.clone();
              node.userData.restQuaternion = node.quaternion.clone();
              this._allHeadBones.push(node);
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

        if (!this._hairSway) this._hairSway = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
        const springK = 0.22;
        const damping = 0.72;

        this._hairSway.vx = (this._hairSway.vx + (-dPitch * 0.20) - this._hairSway.x * springK) * damping;
        this._hairSway.vy = (this._hairSway.vy + (-dYaw * 0.25) - this._hairSway.y * springK) * damping;
        this._hairSway.vz = (this._hairSway.vz + (-dRoll * 0.20) - this._hairSway.z * springK) * damping;

        this._hairSway.x += this._hairSway.vx;
        this._hairSway.y += this._hairSway.vy;
        this._hairSway.z += this._hairSway.vz;

        const hairInertiaEuler = new THREE.Euler(this._hairSway.x, this._hairSway.y, this._hairSway.z, 'YXZ');
        const hairInertiaQ = new THREE.Quaternion().setFromEuler(hairInertiaEuler);

        for (let i = 0; i < this._headAttachments.length; i++) {
          const att = this._headAttachments[i];
          const mesh = att.mesh;
          const isHair = (mesh.name || '').toLowerCase().includes('hair');

          if (isHair) {
            if (!mesh.userData.restRotation) {
              mesh.userData.restRotation = mesh.rotation.clone();
              mesh.userData.restQuaternion = mesh.quaternion.clone();
            }
            mesh.quaternion.copy(mesh.userData.restQuaternion).multiply(hairInertiaQ);
          }
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
}
