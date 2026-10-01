/**
 * @fileoverview FaceToModel — ARKit Blendshape Mapper
 *
 * Provides the canonical mapping from Apple ARKit 52-blendshape names (camelCase,
 * as sent by the iOS app) to the morph-target names used in facecap.glb and
 * compatible face models (underscore + _L/_R suffix convention).
 *
 * Also exports helpers to build a live model map from a loaded Three.js scene
 * and to apply blendshape values to morph targets at runtime.
 *
 * @module blendshape-mapper
 */

/* ─── ARKit Blendshape Names (52 total) ────────────────────────────────── */

/**
 * Complete list of ARKit face tracking blendshape names, in the order sent
 * by the iOS ARFaceAnchor API.
 *
 * @type {string[]}
 */
export const ARKIT_BLENDSHAPES = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'tongueOut',
];

/* ─── ARKit → facecap.glb Morph Target Name Map ────────────────────────── */

/**
 * Maps every ARKit blendshape name to the corresponding morph target name
 * used in facecap.glb (Three.js examples model).
 *
 * Convention:
 *   - Bilateral shapes: Left/Right suffix → _L / _R
 *   - Unilateral shapes: name stays the same
 *
 * @type {Record<string, string>}
 */
export const FACECAP_MAP = {
  // Brow
  browDownLeft:      'browDown_L',
  browDownRight:     'browDown_R',
  browInnerUp:       'browInnerUp',
  browOuterUpLeft:   'browOuterUp_L',
  browOuterUpRight:  'browOuterUp_R',

  // Eye blink
  eyeBlinkLeft:      'eyeBlink_L',
  eyeBlinkRight:     'eyeBlink_R',

  // Eye look direction
  eyeLookDownLeft:   'eyeLookDown_L',
  eyeLookDownRight:  'eyeLookDown_R',
  eyeLookInLeft:     'eyeLookIn_L',
  eyeLookInRight:    'eyeLookIn_R',
  eyeLookOutLeft:    'eyeLookOut_L',
  eyeLookOutRight:   'eyeLookOut_R',
  eyeLookUpLeft:     'eyeLookUp_L',
  eyeLookUpRight:    'eyeLookUp_R',

  // Eye squint / wide
  eyeSquintLeft:     'eyeSquint_L',
  eyeSquintRight:    'eyeSquint_R',
  eyeWideLeft:       'eyeWide_L',
  eyeWideRight:      'eyeWide_R',

  // Cheek
  cheekPuff:         'cheekPuff',
  cheekSquintLeft:   'cheekSquint_L',
  cheekSquintRight:  'cheekSquint_R',

  // Nose
  noseSneerLeft:     'noseSneer_L',
  noseSneerRight:    'noseSneer_R',

  // Jaw
  jawForward:        'jawForward',
  jawLeft:           'jawLeft',
  jawRight:          'jawRight',
  jawOpen:           'jawOpen',

  // Mouth — close / funnel / pucker / sides
  mouthClose:        'mouthClose',
  mouthFunnel:       'mouthFunnel',
  mouthPucker:       'mouthPucker',
  mouthLeft:         'mouthLeft',
  mouthRight:        'mouthRight',

  // Mouth — smile / frown
  mouthSmileLeft:    'mouthSmile_L',
  mouthSmileRight:   'mouthSmile_R',
  mouthFrownLeft:    'mouthFrown_L',
  mouthFrownRight:   'mouthFrown_R',

  // Mouth — stretch / dimple
  mouthStretchLeft:  'mouthStretch_L',
  mouthStretchRight: 'mouthStretch_R',
  mouthDimpleLeft:   'mouthDimple_L',
  mouthDimpleRight:  'mouthDimple_R',

  // Mouth — roll / shrug
  mouthRollLower:    'mouthRollLower',
  mouthRollUpper:    'mouthRollUpper',
  mouthShrugLower:   'mouthShrugLower',
  mouthShrugUpper:   'mouthShrugUpper',

  // Mouth — press / lower-down / upper-up
  mouthPressLeft:      'mouthPress_L',
  mouthPressRight:     'mouthPress_R',
  mouthLowerDownLeft:  'mouthLowerDown_L',
  mouthLowerDownRight: 'mouthLowerDown_R',
  mouthUpperUpLeft:    'mouthUpperUp_L',
  mouthUpperUpRight:   'mouthUpperUp_R',

  // Tongue
  tongueOut:         'tongueOut',
};

/* ─── Fuzzy Normaliser ──────────────────────────────────────────────────── */

/**
 * Normalise a morph target name for fuzzy comparison by lower-casing and
 * stripping common bilateral suffixes (_L, _R, Left, Right, left, right).
 *
 * @param {string} name - Raw morph target name
 * @returns {string} Normalised string
 */
function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/_l$/, '')
    .replace(/_r$/, '')
    .replace(/left$/, '')
    .replace(/right$/, '')
    .trim();
}

/* ─── buildModelMap ─────────────────────────────────────────────────────── */

/**
 * Traverse a loaded Three.js GLTF scene and build a lookup table that maps
 * each ARKit blendshape name to the mesh + morph-target index that should
 * be driven by it.
 *
 * Matching strategy (in priority order):
 *   1. Exact match with the ARKit name (e.g. `browInnerUp`)
 *   2. Exact match with the FACECAP_MAP translation (e.g. `browDown_L`)
 *   3. Fuzzy match — compare normalised base names
 *
 * @param {import('three').Object3D} model - Root of the loaded GLTF scene
 * @returns {{
 *   map: Record<string, { mesh: import('three').SkinnedMesh, index: number }>,
 *   coverage: number,
 *   total: number,
 * }} modelMap, coverage count, and total ARKit shapes
 */
export function buildModelMap(model) {
  /** @type {Record<string, { mesh: import('three').SkinnedMesh, index: number }>} */
  const map = {};

  // Collect all meshes that have morph targets
  /** @type {Array<{ mesh: import('three').SkinnedMesh, dict: Record<string, number> }>} */
  const morphMeshes = [];

  model.traverse((node) => {
    if (node.isMesh && node.morphTargetDictionary) {
      morphMeshes.push({ mesh: node, dict: node.morphTargetDictionary });
    }
  });

  if (morphMeshes.length === 0) {
    console.warn('[BlendshapeMapper] No morph target dictionaries found in model.');
    return { map, coverage: 0, total: ARKIT_BLENDSHAPES.length };
  }

  // Build a flattened set of all morph names present in the model (for fuzzy)
  /** @type {Array<{ name: string, norm: string, mesh: import('three').SkinnedMesh, index: number }>} */
  const allMorphEntries = [];
  for (const { mesh, dict } of morphMeshes) {
    for (const [name, index] of Object.entries(dict)) {
      allMorphEntries.push({ name, norm: normaliseName(name), mesh, index });
    }
  }

  let matched = 0;

  for (const arkitName of ARKIT_BLENDSHAPES) {
    const facecapName = FACECAP_MAP[arkitName]; // translated name (may be same)

    let found = false;

    // --- Pass 1: exact match on ARKit name or FACECAP_MAP name ---
    for (const { mesh, dict } of morphMeshes) {
      if (arkitName in dict) {
        map[arkitName] = { mesh, index: dict[arkitName] };
        found = true;
        break;
      }
      if (facecapName && facecapName in dict) {
        map[arkitName] = { mesh, index: dict[facecapName] };
        found = true;
        break;
      }
    }

    // --- Pass 2: fuzzy normalised base comparison ---
    if (!found) {
      const normArkit    = normaliseName(arkitName);
      const normFacecap  = facecapName ? normaliseName(facecapName) : null;

      for (const entry of allMorphEntries) {
        if (entry.norm === normArkit || (normFacecap && entry.norm === normFacecap)) {
          map[arkitName] = { mesh: entry.mesh, index: entry.index };
          found = true;
          break;
        }
      }
    }

    if (found) {
      matched++;
    } else {
      console.debug(`[BlendshapeMapper] No match for ARKit "${arkitName}" (facecap: "${facecapName}")`);
    }
  }

  console.log(`[BlendshapeMapper] Coverage: ${matched}/${ARKIT_BLENDSHAPES.length} blendshapes mapped.`);
  return { map, coverage: matched, total: ARKIT_BLENDSHAPES.length };
}

/* ─── applyBlendShapes ──────────────────────────────────────────────────── */

/**
 * Apply a set of blendshape values to the model using a pre-built model map.
 * Values outside [0, 1] are clamped. Unknown keys are silently ignored.
 *
 * @param {Record<string, { mesh: import('three').SkinnedMesh, index: number }>} modelMap
 *   The map returned by {@link buildModelMap}.
 * @param {Record<string, number>} blendShapes
 *   Object where each key is an ARKit blendshape name and value is in [0, 1].
 */
export function applyBlendShapes(modelMap, blendShapes) {
  for (const [name, value] of Object.entries(blendShapes)) {
    const entry = modelMap[name];
    if (!entry) continue;

    const { mesh, index } = entry;
    if (!mesh.morphTargetInfluences) continue;

    // Clamp to [0, 1] and write
    mesh.morphTargetInfluences[index] = Math.max(0, Math.min(1, value));
  }
}
