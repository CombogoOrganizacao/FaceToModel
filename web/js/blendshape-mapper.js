/**
 * @fileoverview FaceToModel — MediaPipe Facial Blendshape Mapper
 *
 * Provides the canonical mapping from standard 52-blendshape names (camelCase,
 * as output by Google MediaPipe Face Landmarker) to morph-target names used in
 * facecap.glb and industry standard GLTF / VRM / RPM face models (underscore + _L/_R suffix).
 *
 * Also exports helpers to build a live model map from a loaded Three.js scene
 * and to apply blendshape values to morph targets in real-time.
 *
 * @module blendshape-mapper
 */

/* ─── MediaPipe Standard Blendshape Names (52 total) ────────────────────── */

/**
 * Complete list of standard 52 facial blendshapes (FACS Action Units)
 * output by Google MediaPipe FaceLandmarker.
 *
 * @type {string[]}
 */
export const STANDARD_BLENDSHAPES = [
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


/* ─── MediaPipe → facecap.glb Morph Target Name Map ──────────────────────── */

/**
 * Maps standard blendshape names to the corresponding morph target names
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

/**
 * Extended fallback aliases for VRM, VRoid, and ARKit naming variations.
 * @type {Record<string, string[]>}
 */
export const ALIASES_MAP = {
  eyeBlinkLeft:        ['eyeBlink_L', 'eyeBlinkLeft', 'Fcl_EYE_Close_L', 'Fcl_EYE_Close', 'blink_L', 'eye_close', 'EyeBlink_L'],
  eyeBlinkRight:       ['eyeBlink_R', 'eyeBlinkRight', 'Fcl_EYE_Close_R', 'Fcl_EYE_Close', 'blink_R', 'eye_close', 'EyeBlink_R'],
  eyeSquintLeft:       ['eyeSquint_L', 'eyeSquintLeft', 'Fcl_EYE_Joy_L', 'Fcl_EYE_Joy', 'eye_smile'],
  eyeSquintRight:      ['eyeSquint_R', 'eyeSquintRight', 'Fcl_EYE_Joy_R', 'Fcl_EYE_Joy', 'eye_smile'],
  eyeWideLeft:         ['eyeWide_L', 'eyeWideLeft', 'Fcl_EYE_Surprised', 'eye_open', 'Fcl_EYE_Spread'],
  eyeWideRight:        ['eyeWide_R', 'eyeWideRight', 'Fcl_EYE_Surprised', 'eye_open', 'Fcl_EYE_Spread'],
  eyeLookDownLeft:     ['eyeLookDown_L', 'eyeLookDownLeft', 'look_down'],
  eyeLookDownRight:    ['eyeLookDown_R', 'eyeLookDownRight', 'look_down'],
  eyeLookUpLeft:       ['eyeLookUp_L', 'eyeLookUpLeft', 'look_up'],
  eyeLookUpRight:      ['eyeLookUp_R', 'eyeLookUpRight', 'look_up'],
  eyeLookInLeft:       ['eyeLookIn_L', 'eyeLookInLeft', 'look_right'],
  eyeLookOutLeft:      ['eyeLookOut_L', 'eyeLookOutLeft', 'look_left'],
  eyeLookInRight:      ['eyeLookIn_R', 'eyeLookInRight', 'look_left'],
  eyeLookOutRight:     ['eyeLookOut_R', 'eyeLookOutRight', 'look_right'],
  browDownLeft:        ['browDown_L', 'browDownLeft', 'Fcl_BRW_Angry', 'eye_brow_down_L', 'eye_brow_down'],
  browDownRight:       ['browDown_R', 'browDownRight', 'Fcl_BRW_Angry', 'eye_brow_down_R', 'eye_brow_down'],
  browInnerUp:         ['browInnerUp', 'Fcl_BRW_Surprised', 'eye_brow_up'],
  browOuterUpLeft:     ['browOuterUp_L', 'browOuterUpLeft', 'Fcl_BRW_Joy', 'eye_brow_up_L'],
  browOuterUpRight:    ['browOuterUp_R', 'browOuterUpRight', 'Fcl_BRW_Joy', 'eye_brow_up_R'],
  jawOpen:             ['jawOpen', 'Fcl_MTH_A', 'mouse_open', 'lip_a'],
  mouthClose:          ['mouthClose', 'Fcl_MTH_Close'],
  mouthFunnel:         ['mouthFunnel', 'Fcl_MTH_O', 'lip_o'],
  mouthPucker:         ['mouthPucker', 'Fcl_MTH_U', 'lip_u'],
  mouthSmileLeft:      ['mouthSmile_L', 'mouthSmileLeft', 'Fcl_MTH_Joy', 'Fcl_MTH_Fun', 'face_happy'],
  mouthSmileRight:     ['mouthSmile_R', 'mouthSmileRight', 'Fcl_MTH_Joy', 'Fcl_MTH_Fun', 'face_happy'],
  mouthFrownLeft:      ['mouthFrown_L', 'mouthFrownLeft', 'Fcl_MTH_Sorrow', 'Fcl_MTH_Angry', 'face_sad'],
  mouthFrownRight:     ['mouthFrown_R', 'mouthFrownRight', 'Fcl_MTH_Sorrow', 'Fcl_MTH_Angry', 'face_sad'],
  mouthStretchLeft:    ['mouthStretch_L', 'mouthStretchLeft', 'Fcl_MTH_I', 'lip_i'],
  mouthStretchRight:   ['mouthStretch_R', 'mouthStretchRight', 'Fcl_MTH_I', 'lip_i'],
  mouthUpperUpLeft:    ['mouthUpperUp_L', 'mouthUpperUpLeft', 'Fcl_MTH_Up', 'lip_up'],
  mouthUpperUpRight:   ['mouthUpperUp_R', 'mouthUpperUpRight', 'Fcl_MTH_Up', 'lip_up'],
  mouthLowerDownLeft:  ['mouthLowerDown_L', 'mouthLowerDownLeft', 'Fcl_MTH_Down', 'lip_down'],
  mouthLowerDownRight: ['mouthLowerDown_R', 'mouthLowerDownRight', 'Fcl_MTH_Down', 'lip_down'],
  mouthShrugUpper:     ['mouthShrugUpper', 'Fcl_MTH_Up', 'lip_up'],
  mouthShrugLower:     ['mouthShrugLower', 'Fcl_MTH_Down', 'lip_down'],
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
    .replace(/^face_blendshape\./i, '')
    .replace(/_l$/, '')
    .replace(/_r$/, '')
    .replace(/left$/, '')
    .replace(/right$/, '')
    .trim();
}

/* ─── buildModelMap ─────────────────────────────────────────────────────── */

/**
 * Traverse a loaded Three.js GLTF scene and build a lookup table that maps
 * each standard blendshape name to the mesh + morph-target index that should
 * be driven by it.
 *
 * Matching strategy (in priority order):
 *   1. Exact match with standard MediaPipe name (e.g. `browInnerUp`)
 *   2. Exact match with the FACECAP_MAP translation (e.g. `browDown_L`)
 *   3. Match via ALIASES_MAP (e.g. `Fcl_EYE_Close_L`, `blink_L`)
 *   4. Fuzzy match — compare normalised base names
 *
 * @param {import('three').Object3D} model - Root of the loaded GLTF scene
 * @returns {{
 *   map: Record<string, Array<{ mesh: import('three').SkinnedMesh, index: number }>>,
 *   coverage: number,
 *   total: number,
 * }} modelMap, coverage count, and total shapes
 */
export function buildModelMap(model) {
  /** @type {Record<string, Array<{ mesh: import('three').SkinnedMesh, index: number }>>} */
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
    return { map, coverage: 0, total: STANDARD_BLENDSHAPES.length };
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

  for (const shapeName of STANDARD_BLENDSHAPES) {
    const facecapName = FACECAP_MAP[shapeName];
    const aliases = ALIASES_MAP[shapeName] || [];
    const searchNames = [shapeName, facecapName, ...aliases].filter(Boolean);
    const targets = [];

    // --- Pass 1: exact match on search names across ALL meshes ---
    for (const { mesh, dict } of morphMeshes) {
      for (const sName of searchNames) {
        if (sName in dict) {
          if (!targets.some(t => t.mesh === mesh)) {
            targets.push({ mesh, index: dict[sName] });
          }
        }
      }
    }

    // --- Pass 2: fuzzy normalised base comparison if not found in Pass 1 ---
    if (targets.length === 0) {
      const normShape   = normaliseName(shapeName);
      const normFacecap = facecapName ? normaliseName(facecapName) : null;

      for (const entry of allMorphEntries) {
        if (entry.norm === normShape || (normFacecap && entry.norm === normFacecap)) {
          // Avoid duplicate mesh additions
          if (!targets.some(t => t.mesh === entry.mesh)) {
            targets.push({ mesh: entry.mesh, index: entry.index });
          }
        }
      }
    }

    if (targets.length > 0) {
      map[shapeName] = targets;
      matched++;
    } else {
      console.debug(`[BlendshapeMapper] No match for shape "${shapeName}" (facecap: "${facecapName}")`);
    }
  }

  console.log(`[BlendshapeMapper] Coverage: ${matched}/${STANDARD_BLENDSHAPES.length} blendshapes mapped across ${morphMeshes.length} meshes.`);
  return { map, coverage: matched, total: STANDARD_BLENDSHAPES.length };
}

/* ─── applyBlendShapes ──────────────────────────────────────────────────── */

/**
 * Apply a set of blendshape values to the model using a pre-built model map.
 * Values outside [0, 1] are clamped. Unknown keys are silently ignored.
 *
 * @param {Record<string, Array<{ mesh: import('three').SkinnedMesh, index: number }>>} modelMap
 *   The map returned by {@link buildModelMap}.
 * @param {Record<string, number>} blendShapes
 *   Object where each key is a MediaPipe blendshape name and value is in [0, 1].
 */
export function applyBlendShapes(modelMap, blendShapes) {
  for (const [name, value] of Object.entries(blendShapes)) {
    const targets = modelMap[name];
    if (!targets) continue;

    const clamped = Math.max(0, Math.min(1, value));

    if (Array.isArray(targets)) {
      for (let i = 0; i < targets.length; i++) {
        const { mesh, index } = targets[i];
        if (mesh && mesh.morphTargetInfluences) {
          mesh.morphTargetInfluences[index] = clamped;
        }
      }
    } else {
      const { mesh, index } = targets;
      if (mesh && mesh.morphTargetInfluences) {
        mesh.morphTargetInfluences[index] = clamped;
      }
    }
  }
}
