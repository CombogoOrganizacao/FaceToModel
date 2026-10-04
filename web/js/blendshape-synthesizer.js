/**
 * @fileoverview FaceToModel — Auto ARKit 52 Blendshapes Synthesizer
 *
 * Procedurally generates all 52 Apple ARKit / FACS facial blendshapes
 * directly on the BufferGeometry of any imported 3D mesh that lacks them.
 *
 * Uses normalized spatial deformation fields with smooth Gaussian falloffs:
 *   - u: Left (-1) to Right (+1)
 *   - v: Chin (0) to Forehead (1)
 *   - w: Back (0) to Tip of Nose (1)
 *
 * @module blendshape-synthesizer
 */

import * as THREE from 'three';
import { FACECAP_MAP, STANDARD_BLENDSHAPES } from './blendshape-mapper.js';

/**
 * Definition of procedural deformation formulas for all 52 ARKit expressions.
 */
const DEFORMATION_RULES = {
  // ── Brows (5) ──
  browDownLeft: (u, v, w, s) => {
    if (u < -0.05 && u > -0.65 && v > 0.65 && v < 0.90 && w > 0.3) {
      const g = Math.exp(-Math.pow((u + 0.35) / 0.18, 2) - Math.pow((v - 0.76) / 0.12, 2));
      return [0.005 * g * s, -0.045 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browDownRight: (u, v, w, s) => {
    if (u > 0.05 && u < 0.65 && v > 0.65 && v < 0.90 && w > 0.3) {
      const g = Math.exp(-Math.pow((u - 0.35) / 0.18, 2) - Math.pow((v - 0.76) / 0.12, 2));
      return [-0.005 * g * s, -0.045 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browInnerUp: (u, v, w, s) => {
    if (Math.abs(u) < 0.35 && v > 0.68 && v < 0.92 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.16, 2) - Math.pow((v - 0.78) / 0.14, 2));
      return [0, 0.055 * g * s, 0.012 * g * s];
    }
    return null;
  },
  browOuterUpLeft: (u, v, w, s) => {
    if (u < -0.25 && u > -0.85 && v > 0.65 && v < 0.92 && w > 0.25) {
      const g = Math.exp(-Math.pow((u + 0.52) / 0.18, 2) - Math.pow((v - 0.77) / 0.14, 2));
      return [-0.005 * g * s, 0.050 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browOuterUpRight: (u, v, w, s) => {
    if (u > 0.25 && u < 0.85 && v > 0.65 && v < 0.92 && w > 0.25) {
      const g = Math.exp(-Math.pow((u - 0.52) / 0.18, 2) - Math.pow((v - 0.77) / 0.14, 2));
      return [0.005 * g * s, 0.050 * g * s, 0.008 * g * s];
    }
    return null;
  },

  // ── Eyes (12) ──
  eyeBlinkLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.52 && v < 0.74 && w > 0.35) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.09, 2));
      const downward = v > 0.62 ? -0.045 * g * s : 0.008 * g * s;
      return [0, downward, -0.012 * g * s];
    }
    return null;
  },
  eyeBlinkRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.52 && v < 0.74 && w > 0.35) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.09, 2));
      const downward = v > 0.62 ? -0.045 * g * s : 0.008 * g * s;
      return [0, downward, -0.012 * g * s];
    }
    return null;
  },
  eyeSquintLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.50 && v < 0.68 && w > 0.35) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.16, 2) - Math.pow((v - 0.58) / 0.09, 2));
      return [0.005 * g * s, 0.025 * g * s, 0.008 * g * s];
    }
    return null;
  },
  eyeSquintRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.50 && v < 0.68 && w > 0.35) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.16, 2) - Math.pow((v - 0.58) / 0.09, 2));
      return [-0.005 * g * s, 0.025 * g * s, 0.008 * g * s];
    }
    return null;
  },
  eyeWideLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.54 && v < 0.75 && w > 0.35) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.10, 2));
      const up = v > 0.63 ? 0.035 * g * s : -0.018 * g * s;
      return [0, up, 0.008 * g * s];
    }
    return null;
  },
  eyeWideRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.54 && v < 0.75 && w > 0.35) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.10, 2));
      const up = v > 0.63 ? 0.035 * g * s : -0.018 * g * s;
      return [0, up, 0.008 * g * s];
    }
    return null;
  },
  eyeLookDownLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, -0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookDownRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, -0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookUpLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, 0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookUpRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, 0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookInLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookInRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [-0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookOutLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [-0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookOutRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.70 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0.022 * g * s, 0, 0];
    }
    return null;
  },

  // ── Jaw (4) ──
  jawOpen: (u, v, w, s) => {
    if (v < 0.45 && w > 0.15) {
      const falloff = Math.max(0, (0.45 - v) / 0.45);
      return [0, -0.095 * falloff * s, 0.020 * falloff * s];
    }
    return null;
  },
  jawForward: (u, v, w, s) => {
    if (v < 0.42 && w > 0.15) {
      const falloff = Math.max(0, (0.42 - v) / 0.42);
      return [0, 0, 0.045 * falloff * s];
    }
    return null;
  },
  jawLeft: (u, v, w, s) => {
    if (v < 0.42 && w > 0.15) {
      const falloff = Math.max(0, (0.42 - v) / 0.42);
      return [-0.040 * falloff * s, 0, 0];
    }
    return null;
  },
  jawRight: (u, v, w, s) => {
    if (v < 0.42 && w > 0.15) {
      const falloff = Math.max(0, (0.42 - v) / 0.42);
      return [0.040 * falloff * s, 0, 0];
    }
    return null;
  },

  // ── Mouth (24) ──
  mouthSmileLeft: (u, v, w, s) => {
    if (u < 0.05 && u > -0.45 && v > 0.22 && v < 0.45 && w > 0.32) {
      const g = Math.exp(-Math.pow((u + 0.22) / 0.14, 2) - Math.pow((v - 0.33) / 0.10, 2));
      return [-0.035 * g * s, 0.048 * g * s, 0.010 * g * s];
    }
    return null;
  },
  mouthSmileRight: (u, v, w, s) => {
    if (u > -0.05 && u < 0.45 && v > 0.22 && v < 0.45 && w > 0.32) {
      const g = Math.exp(-Math.pow((u - 0.22) / 0.14, 2) - Math.pow((v - 0.33) / 0.10, 2));
      return [0.035 * g * s, 0.048 * g * s, 0.010 * g * s];
    }
    return null;
  },
  mouthFrownLeft: (u, v, w, s) => {
    if (u < 0.05 && u > -0.45 && v > 0.20 && v < 0.42 && w > 0.32) {
      const g = Math.exp(-Math.pow((u + 0.22) / 0.14, 2) - Math.pow((v - 0.31) / 0.10, 2));
      return [-0.012 * g * s, -0.042 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthFrownRight: (u, v, w, s) => {
    if (u > -0.05 && u < 0.45 && v > 0.20 && v < 0.42 && w > 0.32) {
      const g = Math.exp(-Math.pow((u - 0.22) / 0.14, 2) - Math.pow((v - 0.31) / 0.10, 2));
      return [0.012 * g * s, -0.042 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthPucker: (u, v, w, s) => {
    if (Math.abs(u) < 0.35 && v > 0.22 && v < 0.44 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.33) / 0.10, 2));
      return [-u * 0.25 * g * s, 0, 0.055 * g * s];
    }
    return null;
  },
  mouthFunnel: (u, v, w, s) => {
    if (Math.abs(u) < 0.35 && v > 0.20 && v < 0.46 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.33) / 0.12, 2));
      const dy = v > 0.33 ? 0.025 * g * s : -0.025 * g * s;
      return [-u * 0.15 * g * s, dy, 0.038 * g * s];
    }
    return null;
  },
  mouthLeft: (u, v, w, s) => {
    if (Math.abs(u) < 0.35 && v > 0.22 && v < 0.44 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.22, 2) - Math.pow((v - 0.33) / 0.11, 2));
      return [-0.035 * g * s, 0, 0];
    }
    return null;
  },
  mouthRight: (u, v, w, s) => {
    if (Math.abs(u) < 0.35 && v > 0.22 && v < 0.44 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.22, 2) - Math.pow((v - 0.33) / 0.11, 2));
      return [0.035 * g * s, 0, 0];
    }
    return null;
  },
  mouthClose: (u, v, w, s) => {
    if (Math.abs(u) < 0.32 && v > 0.22 && v < 0.44 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.20, 2) - Math.pow((v - 0.33) / 0.10, 2));
      const dy = v > 0.33 ? -0.015 * g * s : 0.015 * g * s;
      return [0, dy, 0];
    }
    return null;
  },
  mouthUpperUpLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.32 && v > 0.30 && v < 0.45 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.12) / 0.12, 2) - Math.pow((v - 0.36) / 0.08, 2));
      return [0, 0.038 * g * s, 0.008 * g * s];
    }
    return null;
  },
  mouthUpperUpRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.32 && v > 0.30 && v < 0.45 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.12) / 0.12, 2) - Math.pow((v - 0.36) / 0.08, 2));
      return [0, 0.038 * g * s, 0.008 * g * s];
    }
    return null;
  },
  mouthLowerDownLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.32 && v > 0.20 && v < 0.35 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.12) / 0.12, 2) - Math.pow((v - 0.28) / 0.08, 2));
      return [0, -0.038 * g * s, 0.005 * g * s];
    }
    return null;
  },
  mouthLowerDownRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.32 && v > 0.20 && v < 0.35 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.12) / 0.12, 2) - Math.pow((v - 0.28) / 0.08, 2));
      return [0, -0.038 * g * s, 0.005 * g * s];
    }
    return null;
  },
  mouthShrugUpper: (u, v, w, s) => {
    if (Math.abs(u) < 0.30 && v > 0.31 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.37) / 0.08, 2));
      return [0, 0.032 * g * s, 0.010 * g * s];
    }
    return null;
  },
  mouthShrugLower: (u, v, w, s) => {
    if (Math.abs(u) < 0.30 && v > 0.18 && v < 0.34 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.26) / 0.08, 2));
      return [0, 0.035 * g * s, 0.015 * g * s];
    }
    return null;
  },
  mouthRollUpper: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.31 && v < 0.44 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.16, 2) - Math.pow((v - 0.36) / 0.07, 2));
      return [0, -0.018 * g * s, -0.022 * g * s];
    }
    return null;
  },
  mouthRollLower: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.22 && v < 0.35 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.16, 2) - Math.pow((v - 0.28) / 0.07, 2));
      return [0, 0.018 * g * s, -0.022 * g * s];
    }
    return null;
  },
  mouthDimpleLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.50 && v > 0.24 && v < 0.42 && w > 0.30) {
      const g = Math.exp(-Math.pow((u + 0.28) / 0.12, 2) - Math.pow((v - 0.33) / 0.09, 2));
      return [-0.025 * g * s, 0.008 * g * s, -0.015 * g * s];
    }
    return null;
  },
  mouthDimpleRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.50 && v > 0.24 && v < 0.42 && w > 0.30) {
      const g = Math.exp(-Math.pow((u - 0.28) / 0.12, 2) - Math.pow((v - 0.33) / 0.09, 2));
      return [0.025 * g * s, 0.008 * g * s, -0.015 * g * s];
    }
    return null;
  },
  mouthStretchLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.48 && v > 0.24 && v < 0.42 && w > 0.32) {
      const g = Math.exp(-Math.pow((u + 0.26) / 0.14, 2) - Math.pow((v - 0.33) / 0.09, 2));
      return [-0.038 * g * s, -0.008 * g * s, 0];
    }
    return null;
  },
  mouthStretchRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.48 && v > 0.24 && v < 0.42 && w > 0.32) {
      const g = Math.exp(-Math.pow((u - 0.26) / 0.14, 2) - Math.pow((v - 0.33) / 0.09, 2));
      return [0.038 * g * s, -0.008 * g * s, 0];
    }
    return null;
  },
  mouthPressLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.35 && v > 0.25 && v < 0.42 && w > 0.35) {
      const g = Math.exp(-Math.pow((u + 0.18) / 0.12, 2) - Math.pow((v - 0.33) / 0.08, 2));
      return [0, 0, -0.018 * g * s];
    }
    return null;
  },
  mouthPressRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.35 && v > 0.25 && v < 0.42 && w > 0.35) {
      const g = Math.exp(-Math.pow((u - 0.18) / 0.12, 2) - Math.pow((v - 0.33) / 0.08, 2));
      return [0, 0, -0.018 * g * s];
    }
    return null;
  },

  // ── Cheeks & Nose (7) ──
  cheekPuff: (u, v, w, s) => {
    if (Math.abs(u) > 0.15 && Math.abs(u) < 0.65 && v > 0.25 && v < 0.55 && w > 0.20) {
      const sign = u >= 0 ? 1 : -1;
      const g = Math.exp(-Math.pow((Math.abs(u) - 0.38) / 0.16, 2) - Math.pow((v - 0.40) / 0.12, 2));
      return [sign * 0.055 * g * s, 0, 0.035 * g * s];
    }
    return null;
  },
  cheekSquintLeft: (u, v, w, s) => {
    if (u < -0.12 && u > -0.55 && v > 0.38 && v < 0.62 && w > 0.30) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.14, 2) - Math.pow((v - 0.50) / 0.10, 2));
      return [-0.012 * g * s, 0.038 * g * s, 0.022 * g * s];
    }
    return null;
  },
  cheekSquintRight: (u, v, w, s) => {
    if (u > 0.12 && u < 0.55 && v > 0.38 && v < 0.62 && w > 0.30) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.14, 2) - Math.pow((v - 0.50) / 0.10, 2));
      return [0.012 * g * s, 0.038 * g * s, 0.022 * g * s];
    }
    return null;
  },
  noseSneerLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.32 && v > 0.42 && v < 0.64 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.12) / 0.10, 2) - Math.pow((v - 0.52) / 0.09, 2));
      return [-0.010 * g * s, 0.035 * g * s, 0.015 * g * s];
    }
    return null;
  },
  noseSneerRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.32 && v > 0.42 && v < 0.64 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.12) / 0.10, 2) - Math.pow((v - 0.52) / 0.09, 2));
      return [0.010 * g * s, 0.035 * g * s, 0.015 * g * s];
    }
    return null;
  },
  tongueOut: (u, v, w, s) => {
    if (Math.abs(u) < 0.20 && v > 0.22 && v < 0.38 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.12, 2) - Math.pow((v - 0.30) / 0.07, 2));
      return [0, -0.020 * g * s, 0.065 * g * s];
    }
    return null;
  },
};

/**
 * Finds the primary face mesh of a model or the mesh with the most vertices.
 * @param {THREE.Object3D} model
 * @returns {THREE.Mesh|null}
 */
export function findFaceMesh(model) {
  let bestMesh = null;
  let maxVerts = -1;

  model.traverse((node) => {
    if (node.isMesh && node.geometry && node.geometry.attributes.position) {
      const name = (node.name || '').toLowerCase();
      const count = node.geometry.attributes.position.count;

      // Priority to nodes explicitly named head/face
      const isFaceNamed = /(head|face|corpo|body|avatar)/i.test(name) && !/(hair|eye|eyebrow|teeth|tongue|lash|occlusion)/i.test(name);

      if (isFaceNamed && count > 100) {
        if (!bestMesh || count > maxVerts) {
          bestMesh = node;
          maxVerts = count;
        }
      } else if (!bestMesh && count > maxVerts) {
        bestMesh = node;
        maxVerts = count;
      }
    }
  });

  return bestMesh;
}

/**
 * Intelligently analyzes the mesh to isolate the cranial/head region and determine facing orientation.
 * Handles full-body avatars, standalone busts, and inverted Z-axis models seamlessly.
 *
 * @param {THREE.Mesh} mesh
 * @param {THREE.Bone|null} [headBone]
 * @returns {Object} Head region bounds, scale, and orientation parameters
 */
export function analyzeHeadRegion(mesh, headBone = null) {
  const geom = mesh.geometry;
  const posAttr = geom.attributes.position;
  const count = posAttr.count;

  geom.computeBoundingBox();
  const box = geom.boundingBox;
  const fullWidth = Math.max(0.001, box.max.x - box.min.x);
  const fullHeight = Math.max(0.001, box.max.y - box.min.y);
  const fullDepth = Math.max(0.001, box.max.z - box.min.z);

  // 1. Detect if model is full-body (aspect ratio tall)
  const isFullBody = fullHeight > fullWidth * 1.5;

  let headMinY, headMaxY;
  let headMinX = box.min.x, headMaxX = box.max.x;
  let headMinZ = box.min.z, headMaxZ = box.max.z;

  if (headBone) {
    const boneWorldPos = new THREE.Vector3();
    headBone.getWorldPosition(boneWorldPos);
    const boneLocalPos = mesh.worldToLocal(boneWorldPos);
    const radius = fullHeight * 0.16;
    headMinY = boneLocalPos.y - radius * 0.7;
    headMaxY = boneLocalPos.y + radius * 1.3;
  } else if (isFullBody) {
    // Top 22% of character represents head and face
    headMinY = box.min.y + fullHeight * 0.76;
    headMaxY = box.max.y;
  } else {
    // Bust / standalone head
    headMinY = box.min.y;
    headMaxY = box.max.y;
  }

  // Refine bounds to head vertices only
  let hMinX = Infinity, hMaxX = -Infinity;
  let hMinZ = Infinity, hMaxZ = -Infinity;
  let headVertCount = 0;

  for (let i = 0; i < count; i++) {
    const y = posAttr.getY(i);
    if (y >= headMinY && y <= headMaxY) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      if (x < hMinX) hMinX = x;
      if (x > hMaxX) hMaxX = x;
      if (z < hMinZ) hMinZ = z;
      if (z > hMaxZ) hMaxZ = z;
      headVertCount++;
    }
  }

  if (headVertCount > 30) {
    headMinX = hMinX;
    headMaxX = hMaxX;
    headMinZ = hMinZ;
    headMaxZ = hMaxZ;
  }

  const headWidth = Math.max(0.001, headMaxX - headMinX);
  const headHeight = Math.max(0.001, headMaxY - headMinY);
  const headDepth = Math.max(0.001, headMaxZ - headMinZ);

  // 2. Facing direction: detect whether facial features protrude along +Z or -Z
  const midZ = (headMinZ + headMaxZ) * 0.5;
  const midY = (headMinY + headMaxY) * 0.5;
  let plusZConvexity = 0;
  let minusZConvexity = 0;

  for (let i = 0; i < count; i++) {
    const y = posAttr.getY(i);
    if (y >= midY - headHeight * 0.25 && y <= midY + headHeight * 0.25) {
      const z = posAttr.getZ(i);
      if (z > midZ) plusZConvexity = Math.max(plusZConvexity, z - midZ);
      else minusZConvexity = Math.max(minusZConvexity, midZ - z);
    }
  }

  const forwardSign = plusZConvexity >= minusZConvexity ? 1 : -1;

  return {
    headMinX, headMaxX,
    headMinY, headMaxY,
    headMinZ, headMaxZ,
    headWidth, headHeight, headDepth,
    scale: headHeight,
    forwardSign,
    isFullBody
  };
}

/**
 * Synthesizes all 52 Apple ARKit blendshapes onto the provided mesh with intelligent anatomical framing.
 *
 * @param {THREE.Mesh} mesh
 * @param {Object} [options]
 * @param {number} [options.globalIntensity] - Global deformation scale (default 1.0)
 * @param {number} [options.mouthIntensity] - Mouth and jaw deformation multiplier (default 1.0)
 * @param {number} [options.eyeIntensity] - Eye and eyelid deformation multiplier (default 1.0)
 * @param {number} [options.browIntensity] - Brow deformation multiplier (default 1.0)
 * @param {THREE.Bone|null} [options.headBone] - Optional skeletal head bone for precise cranial isolation
 * @returns {number} Count of blendshapes synthesized
 */
export function synthesizeARKitBlendshapes(mesh, options = {}) {
  if (!mesh || !mesh.geometry) return 0;

  const geom = mesh.geometry;
  const posAttr = geom.attributes.position;
  if (!posAttr) return 0;

  const {
    globalIntensity = 1.0,
    mouthIntensity = 1.0,
    eyeIntensity = 1.0,
    browIntensity = 1.0,
    headBone = null
  } = options;

  // 1. Analyze and isolate the cranial/head region
  const head = analyzeHeadRegion(mesh, headBone);

  const headCenterX = (head.headMinX + head.headMaxX) * 0.5;
  const halfWidth = head.headWidth * 0.5;
  const headHeight = head.headHeight;
  const headDepth = head.headDepth;
  const baseScale = head.scale * globalIntensity;
  const forwardSign = head.forwardSign;

  const vertCount = posAttr.count;

  // Initialize morph attributes if missing
  if (!geom.morphAttributes) geom.morphAttributes = {};
  if (!geom.morphAttributes.position) geom.morphAttributes.position = [];
  if (!mesh.morphTargetDictionary) mesh.morphTargetDictionary = {};

  let addedCount = 0;

  // Loop through all 52 canonical standard shapes
  for (const stdName of STANDARD_BLENDSHAPES) {
    const faceCapName = FACECAP_MAP[stdName] || stdName;

    // Check if mesh already has this morph target
    if (mesh.morphTargetDictionary[stdName] !== undefined || mesh.morphTargetDictionary[faceCapName] !== undefined) {
      continue;
    }

    const rule = DEFORMATION_RULES[stdName];
    if (!rule) continue;

    // Determine category multiplier
    let catMultiplier = 1.0;
    if (stdName.startsWith('brow')) catMultiplier = browIntensity;
    else if (stdName.startsWith('eye')) catMultiplier = eyeIntensity;
    else if (stdName.startsWith('mouth') || stdName.startsWith('jaw')) catMultiplier = mouthIntensity;

    const effectiveScale = baseScale * catMultiplier;

    // Create delta buffer
    const deltaBuffer = new Float32Array(vertCount * 3);
    let hasMovement = false;

    for (let i = 0; i < vertCount; i++) {
      const vy = posAttr.getY(i);

      // Only deform vertices within the cranial/head elevation window
      if (vy < head.headMinY - headHeight * 0.05 || vy > head.headMaxY + headHeight * 0.05) {
        continue;
      }

      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);

      // Normalized coordinates within the isolated cranial frame
      // u in [-1, 1], v in [0, 1] (chin to forehead), w in [0, 1] (back to nose)
      const u = (vx - headCenterX) / halfWidth;
      const v = (vy - head.headMinY) / headHeight;
      const w = forwardSign > 0
        ? (vz - head.headMinZ) / headDepth
        : (head.headMaxZ - vz) / headDepth;

      const delta = rule(u, v, w, effectiveScale);
      if (delta) {
        deltaBuffer[i * 3 + 0] = delta[0];
        deltaBuffer[i * 3 + 1] = delta[1];
        // Flip Z delta if model faces negative Z
        deltaBuffer[i * 3 + 2] = delta[2] * forwardSign;
        hasMovement = true;
      }
    }

    if (hasMovement) {
      const morphAttr = new THREE.BufferAttribute(deltaBuffer, 3);
      morphAttr.name = faceCapName;
      const targetIndex = geom.morphAttributes.position.length;
      geom.morphAttributes.position.push(morphAttr);

      mesh.morphTargetDictionary[faceCapName] = targetIndex;
      mesh.morphTargetDictionary[stdName] = targetIndex;
      addedCount++;
    }
  }

  if (addedCount > 0) {
    const totalTargets = geom.morphAttributes.position.length;
    mesh.morphTargetInfluences = new Array(totalTargets).fill(0);
    if (typeof mesh.updateMorphTargets === 'function') {
      mesh.updateMorphTargets();
    }
    geom.needsUpdate = true;
    mesh.userData.autoRigSettings = { globalIntensity, mouthIntensity, eyeIntensity, browIntensity };
    console.log(`[Auto-Rig] Sintetizados com sucesso ${addedCount} blendshapes ARKit na malha "${mesh.name || 'Face'}"`);
  }

  return addedCount;
}

/**
 * Re-synthesizes or scales blendshapes on the model with custom user rig settings.
 *
 * @param {THREE.Object3D} model
 * @param {Object} [options]
 * @returns {number}
 */
export function rebuildModelBlendshapes(model, options = {}) {
  const faceMesh = findFaceMesh(model);
  if (!faceMesh || !faceMesh.geometry) return 0;

  // Clear existing synthesized morph targets if present
  const geom = faceMesh.geometry;
  if (geom.morphAttributes && geom.morphAttributes.position) {
    geom.morphAttributes.position = [];
  }
  faceMesh.morphTargetDictionary = {};

  return synthesizeARKitBlendshapes(faceMesh, options);
}

/**
 * Checks model and automatically synthesizes 52 ARKit blendshapes if absent.
 * @param {THREE.Object3D} model
 * @param {number} currentCoverage
 * @param {Object} [options]
 * @returns {number} Total count of blendshapes added
 */
export function ensureModelBlendshapes(model, currentCoverage = 0, options = {}) {
  if (currentCoverage >= 40) {
    // Already sufficiently rigged with blendshapes
    return 0;
  }

  const faceMesh = findFaceMesh(model);
  if (!faceMesh) {
    console.warn('[Synthesizer] Nenhuma malha facial encontrada para síntese de blendshapes.');
    return 0;
  }

  return synthesizeARKitBlendshapes(faceMesh, options);
}
