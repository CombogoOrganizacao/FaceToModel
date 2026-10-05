/**
 * MetaHuman OpenRigLogic Control Curve Mapping Table
 *
 * Maps standard 52 ARKit / MediaPipe blendshape coefficients [0.0, 1.0]
 * to Epic Games MetaHuman Raw Control Curves (CTRL_expressions) evaluated by OpenRigLogic.
 *
 * Directives: Apple HIG / SwiftUI vector standards, strict Zero Emojis.
 */

/**
 * Standard ARKit 52 expression names mapped to MetaHuman RigLogic Raw Control IDs & multipliers.
 * @type {Record<string, Array<{ control: string, multiplier: number, offset?: number }>>}
 */
export const ARKIT_TO_RIGLOGIC_MAP = {
  // --- Mandíbula / Jaw ---
  jawOpen: [
    { control: 'CTRL_C_jaw', multiplier: 1.0 }
  ],
  jawForward: [
    { control: 'CTRL_C_jaw_fwd', multiplier: 1.0 }
  ],
  jawLeft: [
    { control: 'CTRL_C_jaw_left', multiplier: 1.0 }
  ],
  jawRight: [
    { control: 'CTRL_C_jaw_right', multiplier: 1.0 }
  ],

  // --- Boca e Lábios / Mouth & Lips ---
  mouthClose: [
    { control: 'CTRL_C_mouth_close', multiplier: 1.0 }
  ],
  mouthFunnel: [
    { control: 'CTRL_C_mouth_funnel', multiplier: 1.0 }
  ],
  mouthPucker: [
    { control: 'CTRL_C_mouth_pucker', multiplier: 1.0 }
  ],
  mouthLeft: [
    { control: 'CTRL_C_mouth_left', multiplier: 1.0 }
  ],
  mouthRight: [
    { control: 'CTRL_C_mouth_right', multiplier: 1.0 }
  ],
  mouthSmileLeft: [
    { control: 'CTRL_L_mouth_cornerPull', multiplier: 1.0 }
  ],
  mouthSmileRight: [
    { control: 'CTRL_R_mouth_cornerPull', multiplier: 1.0 }
  ],
  mouthFrownLeft: [
    { control: 'CTRL_L_mouth_cornerDepress', multiplier: 1.0 }
  ],
  mouthFrownRight: [
    { control: 'CTRL_R_mouth_cornerDepress', multiplier: 1.0 }
  ],
  mouthDimpleLeft: [
    { control: 'CTRL_L_mouth_dimple', multiplier: 1.0 }
  ],
  mouthDimpleRight: [
    { control: 'CTRL_R_mouth_dimple', multiplier: 1.0 }
  ],
  mouthStretchLeft: [
    { control: 'CTRL_L_mouth_stretch', multiplier: 1.0 }
  ],
  mouthStretchRight: [
    { control: 'CTRL_R_mouth_stretch', multiplier: 1.0 }
  ],
  mouthRollLower: [
    { control: 'CTRL_C_mouth_lipRollU', multiplier: 1.0 }
  ],
  mouthRollUpper: [
    { control: 'CTRL_C_mouth_lipRollD', multiplier: 1.0 }
  ],
  mouthShrugLower: [
    { control: 'CTRL_C_mouth_chinRaise', multiplier: 1.0 }
  ],
  mouthShrugUpper: [
    { control: 'CTRL_C_mouth_upperLipRaise', multiplier: 1.0 }
  ],
  mouthPressLeft: [
    { control: 'CTRL_L_mouth_press', multiplier: 1.0 }
  ],
  mouthPressRight: [
    { control: 'CTRL_R_mouth_press', multiplier: 1.0 }
  ],
  mouthLowerDownLeft: [
    { control: 'CTRL_L_mouth_lowerLipDepress', multiplier: 1.0 }
  ],
  mouthLowerDownRight: [
    { control: 'CTRL_R_mouth_lowerLipDepress', multiplier: 1.0 }
  ],
  mouthUpperUpLeft: [
    { control: 'CTRL_L_mouth_upperLipRaise', multiplier: 1.0 }
  ],
  mouthUpperUpRight: [
    { control: 'CTRL_R_mouth_upperLipRaise', multiplier: 1.0 }
  ],

  // --- Bochechas / Cheeks ---
  cheekPuff: [
    { control: 'CTRL_C_jawCheek', multiplier: 1.0 },
    { control: 'CTRL_L_cheek_puff', multiplier: 1.0 },
    { control: 'CTRL_R_cheek_puff', multiplier: 1.0 }
  ],
  cheekSquintLeft: [
    { control: 'CTRL_L_cheek_squint', multiplier: 1.0 }
  ],
  cheekSquintRight: [
    { control: 'CTRL_R_cheek_squint', multiplier: 1.0 }
  ],

  // --- Olhos e Pálpebras / Eyes & Eyelids ---
  eyeBlinkLeft: [
    { control: 'CTRL_L_eye_lidBlink', multiplier: 1.0 }
  ],
  eyeBlinkRight: [
    { control: 'CTRL_R_eye_lidBlink', multiplier: 1.0 }
  ],
  eyeSquintLeft: [
    { control: 'CTRL_L_eye_squint', multiplier: 1.0 }
  ],
  eyeSquintRight: [
    { control: 'CTRL_R_eye_squint', multiplier: 1.0 }
  ],
  eyeWideLeft: [
    { control: 'CTRL_L_eye_lidUpperUp', multiplier: 1.0 }
  ],
  eyeWideRight: [
    { control: 'CTRL_R_eye_lidUpperUp', multiplier: 1.0 }
  ],
  eyeLookUpLeft: [
    { control: 'CTRL_L_eye_up', multiplier: 1.0 }
  ],
  eyeLookUpRight: [
    { control: 'CTRL_R_eye_up', multiplier: 1.0 }
  ],
  eyeLookDownLeft: [
    { control: 'CTRL_L_eye_down', multiplier: 1.0 }
  ],
  eyeLookDownRight: [
    { control: 'CTRL_R_eye_down', multiplier: 1.0 }
  ],
  eyeLookInLeft: [
    { control: 'CTRL_L_eye_in', multiplier: 1.0 }
  ],
  eyeLookInRight: [
    { control: 'CTRL_R_eye_in', multiplier: 1.0 }
  ],
  eyeLookOutLeft: [
    { control: 'CTRL_L_eye_out', multiplier: 1.0 }
  ],
  eyeLookOutRight: [
    { control: 'CTRL_R_eye_out', multiplier: 1.0 }
  ],

  // --- Sobrancelhas / Eyebrows ---
  browDownLeft: [
    { control: 'CTRL_L_brow_down', multiplier: 1.0 }
  ],
  browDownRight: [
    { control: 'CTRL_R_brow_down', multiplier: 1.0 }
  ],
  browInnerUp: [
    { control: 'CTRL_C_brow_raise', multiplier: 1.0 },
    { control: 'CTRL_L_brow_raiseIn', multiplier: 1.0 },
    { control: 'CTRL_R_brow_raiseIn', multiplier: 1.0 }
  ],
  browOuterUpLeft: [
    { control: 'CTRL_L_brow_raiseOut', multiplier: 1.0 }
  ],
  browOuterUpRight: [
    { control: 'CTRL_R_brow_raiseOut', multiplier: 1.0 }
  ],

  // --- Nariz / Nose ---
  noseSneerLeft: [
    { control: 'CTRL_L_nose_wrinkle', multiplier: 1.0 }
  ],
  noseSneerRight: [
    { control: 'CTRL_R_nose_wrinkle', multiplier: 1.0 }
  ],
  tongueOut: [
    { control: 'CTRL_C_tongue_press', multiplier: 1.0 }
  ],
};

/**
 * Converts a set of 52 ARKit blendshape values into a normalized MetaHuman RigLogic control curve array.
 *
 * @param {Record<string, number>} arkitValues - Object with ARKit standard keys and values [0.0, 1.0]
 * @param {string[]} rigLogicControlNames - Ordered list of MetaHuman raw control names
 * @returns {Float32Array} Array of float control values matching the RigLogic input layout
 */
export function mapArkitToRigLogicControls(arkitValues, rigLogicControlNames) {
  const result = new Float32Array(rigLogicControlNames.length);
  const controlIndexMap = new Map();

  for (let i = 0; i < rigLogicControlNames.length; i++) {
    controlIndexMap.set(rigLogicControlNames[i], i);
  }

  for (const [arkitKey, value] of Object.entries(arkitValues)) {
    if (value <= 0.0001) continue;
    const mappings = ARKIT_TO_RIGLOGIC_MAP[arkitKey];
    if (mappings) {
      for (let m = 0; m < mappings.length; m++) {
        const { control, multiplier } = mappings[m];
        const idx = controlIndexMap.get(control);
        if (idx !== undefined) {
          result[idx] = Math.min(1.0, Math.max(0.0, result[idx] + value * multiplier));
        }
      }
    }
  }

  return result;
}
