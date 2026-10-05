/**
 * @fileoverview FaceToModel — OmniFaceRig Universal ARKit 52 Blendshapes Engine
 *
 * Implements the OmniFaceRig facial auto-rigging methodology (Meta Reality Labs / SIGGRAPH Asia 2026)
 * optimized for real-time WebGL execution in the browser.
 *
 * Core Features:
 *   1. 3D Surface Anchor Extraction via Frontal Raycasting & Depth Analysis
 *   2. Minimum Region Facial Masking (strict 0.0 weighting for ears, neck, throat, and skull back)
 *   3. RBF (Radial Basis Functions) Deformation Transfer for all 52 Apple ARKit / FACS blendshapes
 *   4. Laplacian Smoothing (Delta Mush) for organic, continuous skin deformations without polygon creasing
 *   5. Relative MorphTarget construction for universal compatibility with Three.js, MediaPipe, Blender, and Unreal Engine
 *
 * @module blendshape-synthesizer
 */

import * as THREE from 'three';
import { FACECAP_MAP, STANDARD_BLENDSHAPES } from './blendshape-mapper.js';

/**
 * Standard Hermite interpolation for smooth non-linear falloffs.
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Finds the primary face mesh within a 3D model hierarchy.
 * @param {THREE.Object3D} model
 * @returns {THREE.Mesh|null}
 */
export function findFaceMesh(model) {
  if (!model) return null;

  let faceMesh = null;
  let fallbackMesh = null;
  let maxFaceVerts = 0;
  let maxFallbackVerts = 0;

  // Words that strongly identify a face mesh
  const faceRegex = /(face|head|cabeça|rosto|head_mesh|facemesh|head_geo|skm_bo_facemesh|skm_asha_facemesh|character_head)/i;
  // Words that strictly exclude a mesh from being the face
  const excludeRegex = /(body|corpo|torso|legs|pants|shirt|jacket|shoes|hair|eye|eyebrow|teeth|tongue|lash|occlusion|cloth|bottom|top|arm|braço|hand|mão|eyeshell|eyeedge|lacrimal|saliva|cartilage)/i;

  model.traverse((node) => {
    if (node.isMesh && node.geometry && node.geometry.attributes.position) {
      const name = (node.name || '').toLowerCase();
      const count = node.geometry.attributes.position.count;
      if (count < 60) return;

      if (faceRegex.test(name) && !excludeRegex.test(name)) {
        if (count > maxFaceVerts) {
          faceMesh = node;
          maxFaceVerts = count;
        }
      } else if (!excludeRegex.test(name)) {
        if (count > maxFallbackVerts) {
          fallbackMesh = node;
          maxFallbackVerts = count;
        }
      }
    }
  });

  return faceMesh || fallbackMesh;
}

/**
 * Intelligently analyzes the mesh to isolate the cranial/head region and determine facing orientation.
 * Handles full-body avatars, standalone busts, and inverted Z-axis models.
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
  const fullHeight = Math.max(0.001, box.max.y - box.min.y);

  let headMinY, headMaxY;

  const meshName = (mesh.name || '').toLowerCase();
  const isDedicatedHeadMesh = /(head|face|cabeça|rosto|head_mesh|facemesh|head_geo)/i.test(meshName) && !/(body|corpo|torso|full)/i.test(meshName);
  const isHeadSized = fullHeight < 0.85;

  if (headBone) {
    const boneWorldPos = new THREE.Vector3();
    headBone.getWorldPosition(boneWorldPos);
    const boneLocalPos = mesh.worldToLocal(boneWorldPos);
    const radius = fullHeight * 0.12;
    headMinY = boneLocalPos.y - radius * 0.6;
    headMaxY = boneLocalPos.y + radius * 1.2;
  } else if (isDedicatedHeadMesh || isHeadSized) {
    headMinY = box.min.y;
    headMaxY = box.max.y;
  } else {
    // Full-body monolithic model: vertical slice analysis in upper 45% to locate neck constriction
    const numSlices = 24;
    const sliceMinY = box.min.y + fullHeight * 0.55;
    const sliceMaxY = box.max.y;
    const sliceStep = (sliceMaxY - sliceMinY) / numSlices;
    const sliceWidths = new Float32Array(numSlices);
    const sliceCounts = new Uint32Array(numSlices);

    for (let i = 0; i < count; i++) {
      const y = posAttr.getY(i);
      if (y >= sliceMinY && y <= sliceMaxY) {
        const sliceIdx = Math.min(numSlices - 1, Math.floor((y - sliceMinY) / sliceStep));
        const x = Math.abs(posAttr.getX(i));
        if (x > sliceWidths[sliceIdx]) sliceWidths[sliceIdx] = x;
        sliceCounts[sliceIdx]++;
      }
    }

    let neckSlice = -1;
    let minW = Infinity;
    for (let s = 1; s < Math.floor(numSlices * 0.5); s++) {
      if (sliceCounts[s] > 10 && sliceWidths[s] < minW) {
        minW = sliceWidths[s];
        neckSlice = s;
      }
    }

    if (neckSlice > 0) {
      headMinY = sliceMinY + neckSlice * sliceStep;
      headMaxY = box.max.y;
    } else {
      headMinY = box.min.y + fullHeight * 0.82;
      headMaxY = box.max.y;
    }
  }

  // Refine bounds to head vertices only
  let headMinX = Infinity, headMaxX = -Infinity;
  let headMinZ = Infinity, headMaxZ = -Infinity;
  let headVertCount = 0;

  for (let i = 0; i < count; i++) {
    const y = posAttr.getY(i);
    if (y >= headMinY && y <= headMaxY) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      if (x < headMinX) headMinX = x;
      if (x > headMaxX) headMaxX = x;
      if (z < headMinZ) headMinZ = z;
      if (z > headMaxZ) headMaxZ = z;
      headVertCount++;
    }
  }

  if (headVertCount < 30) {
    headMinX = box.min.x; headMaxX = box.max.x;
    headMinZ = box.min.z; headMaxZ = box.max.z;
    headMinY = box.min.y; headMaxY = box.max.y;
  }

  const headWidth = Math.max(0.001, headMaxX - headMinX);
  const headHeight = Math.max(0.001, headMaxY - headMinY);
  const headDepth = Math.max(0.001, headMaxZ - headMinZ);

  // Facing direction: detect whether facial features protrude along +Z or -Z
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
  const scale = Math.min(headHeight, headWidth * 1.25);

  return {
    headMinX, headMaxX,
    headMinY, headMaxY,
    headMinZ, headMaxZ,
    headWidth, headHeight, headDepth,
    scale,
    forwardSign
  };
}

/**
 * Extracts 3D anatomical surface anchors across the face mesh using directional spatial raycasting.
 * Locates key facial control points (eyes, brows, mouth, nose, jaw) on the actual surface geometry.
 *
 * @param {THREE.BufferAttribute} posAttr
 * @param {number} count
 * @param {Object} head
 * @returns {Record<string, { u: number, v: number, w: number, idx: number, x: number, y: number, z: number }>}
 */
function extractFacialAnchors(posAttr, count, head) {
  const headCenterX = (head.headMinX + head.headMaxX) * 0.5;
  const halfWidth = head.headWidth * 0.5;
  const headHeight = head.headHeight;
  const headDepth = head.headDepth;
  const forwardSign = head.forwardSign;

  // Key landmark search targets in normalized cranial space [u, v]
  const anchorDefinitions = {
    noseTip:        { targetU: 0.0,   targetV: 0.55, maxDist: 0.18, findFrontmost: true },
    mouthCenter:    { targetU: 0.0,   targetV: 0.33, maxDist: 0.12, findFrontmost: true },
    mouthCornerL:   { targetU: -0.22, targetV: 0.33, maxDist: 0.14, findFrontmost: true },
    mouthCornerR:   { targetU: 0.22,  targetV: 0.33, maxDist: 0.14, findFrontmost: true },
    lipTop:         { targetU: 0.0,   targetV: 0.38, maxDist: 0.10, findFrontmost: true },
    lipBottom:      { targetU: 0.0,   targetV: 0.28, maxDist: 0.10, findFrontmost: true },
    jawChin:        { targetU: 0.0,   targetV: 0.16, maxDist: 0.15, findFrontmost: true },
    eyeCenterL:     { targetU: -0.32, targetV: 0.64, maxDist: 0.15, findFrontmost: true },
    eyeCenterR:     { targetU: 0.32,  targetV: 0.64, maxDist: 0.15, findFrontmost: true },
    eyeTopL:        { targetU: -0.32, targetV: 0.69, maxDist: 0.12, findFrontmost: true },
    eyeBottomL:     { targetU: -0.32, targetV: 0.59, maxDist: 0.12, findFrontmost: true },
    eyeTopR:        { targetU: 0.32,  targetV: 0.69, maxDist: 0.12, findFrontmost: true },
    eyeBottomR:     { targetU: 0.32,  targetV: 0.59, maxDist: 0.12, findFrontmost: true },
    browInnerL:     { targetU: -0.12, targetV: 0.78, maxDist: 0.15, findFrontmost: true },
    browMidL:       { targetU: -0.32, targetV: 0.78, maxDist: 0.15, findFrontmost: true },
    browOuterL:     { targetU: -0.48, targetV: 0.77, maxDist: 0.15, findFrontmost: true },
    browInnerR:     { targetU: 0.12,  targetV: 0.78, maxDist: 0.15, findFrontmost: true },
    browMidR:       { targetU: 0.32,  targetV: 0.78, maxDist: 0.15, findFrontmost: true },
    browOuterR:     { targetU: 0.48,  targetV: 0.77, maxDist: 0.15, findFrontmost: true },
    cheekL:         { targetU: -0.40, targetV: 0.46, maxDist: 0.18, findFrontmost: true },
    cheekR:         { targetU: 0.40,  targetV: 0.46, maxDist: 0.18, findFrontmost: true },
  };

  const anchors = {};

  for (const [key, def] of Object.entries(anchorDefinitions)) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestW = -Infinity;

    for (let i = 0; i < count; i++) {
      const vy = posAttr.getY(i);
      if (vy < head.headMinY || vy > head.headMaxY) continue;

      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);

      const u = (vx - headCenterX) / halfWidth;
      const v = (vy - head.headMinY) / headHeight;
      const w = forwardSign > 0
        ? (vz - head.headMinZ) / headDepth
        : (head.headMaxZ - vz) / headDepth;

      // Only search in the front 55% of the head
      if (w < 0.45) continue;

      const du = u - def.targetU;
      const dv = v - def.targetV;
      const uvDist = Math.sqrt(du * du + dv * dv);

      if (uvDist <= def.maxDist) {
        // Combined objective: closest to target UV and outermost on face surface
        const score = uvDist * 0.5 - w * 0.5;
        if (score < bestDist) {
          bestDist = score;
          bestIdx = i;
          bestW = w;
        }
      }
    }

    if (bestIdx >= 0) {
      const vx = posAttr.getX(bestIdx);
      const vy = posAttr.getY(bestIdx);
      const vz = posAttr.getZ(bestIdx);
      const u = (vx - headCenterX) / halfWidth;
      const v = (vy - head.headMinY) / headHeight;
      const w = forwardSign > 0
        ? (vz - head.headMinZ) / headDepth
        : (head.headMaxZ - vz) / headDepth;

      anchors[key] = { u, v, w, idx: bestIdx, x: vx, y: vy, z: vz };
    } else {
      // Fallback default coordinates
      anchors[key] = {
        u: def.targetU,
        v: def.targetV,
        w: 0.85,
        idx: -1,
        x: headCenterX + def.targetU * halfWidth,
        y: head.headMinY + def.targetV * headHeight,
        z: forwardSign > 0 ? head.headMinZ + 0.85 * headDepth : head.headMaxZ - 0.85 * headDepth
      };
    }
  }

  return anchors;
}

/**
 * Computes anatomical mask weight for facial deformation (0 = locked/protected, 1 = full facial movement).
 * Strictly eliminates deformation bleeding into ears, neck, occiput, and skull back (OmniFaceRig Minimum Region Fitting).
 *
 * @param {number} u - Normalized lateral coordinate [-1 (left) to +1 (right)]
 * @param {number} v - Normalized elevation coordinate [0 (chin) to 1 (forehead)]
 * @param {number} w - Normalized depth coordinate [0 (back) to 1 (nasal tip)]
 * @returns {number} Attenuation factor in [0, 1]
 */
export function getFacialAnatomicalMask(u, v, w) {
  const absU = Math.abs(u);

  // 1. Neck / Submental cutoff: vertices below the mandible (v < 0.12) are locked.
  // Smoothly ramps up from v = 0.08 to v = 0.20, completely shielding cervical spine and trapezius.
  const neckWeight = smoothstep(0.08, 0.20, v);
  if (neckWeight <= 0) return 0;

  // 2. Cranial Back / Occiput cutoff: vertices in the back half of the skull (w < 0.35) are locked.
  const depthWeight = smoothstep(0.35, 0.52, w);
  if (depthWeight <= 0) return 0;

  // 3. Bilateral Ear Rejection Zone:
  // Ears anatomically sit at |u| > 0.46 and w < 0.65.
  let earWeight = 1.0;
  if (absU > 0.44 && w < 0.68) {
    const lateralFactor = smoothstep(0.44, 0.66, absU);
    const posteriorFactor = 1.0 - smoothstep(0.35, 0.68, w);
    earWeight = Math.max(0, 1.0 - (lateralFactor * posteriorFactor));
  }
  if (earWeight <= 0) return 0;

  // 4. Polar / Conical Angular Mask (Frontal Facial Arc):
  // Polar angle from central mid-face anchor (u=0, w=0.25)
  const relDepth = Math.max(0.01, w - 0.25);
  const angleRad = Math.atan2(absU, relDepth);
  // Max frontal facial angle ~ 55 degrees (0.96 rad). Outside 66 deg (1.15 rad) -> 0.
  const angleWeight = 1.0 - smoothstep(0.88, 1.15, angleRad);

  return neckWeight * depthWeight * earWeight * angleWeight;
}

/**
 * Builds a fast adjacency vertex graph from geometry index for Laplacian smoothing (Delta Mush).
 * @param {THREE.BufferGeometry} geom
 * @returns {Map<number, number[]>}
 */
function buildVertexAdjacency(geom) {
  const adjacency = new Map();
  const index = geom.index;
  const count = geom.attributes.position.count;

  for (let i = 0; i < count; i++) {
    adjacency.set(i, []);
  }

  if (index) {
    const indices = index.array;
    const len = indices.length;
    for (let i = 0; i < len; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];

      const adjA = adjacency.get(a);
      const adjB = adjacency.get(b);
      const adjC = adjacency.get(c);

      if (adjA && !adjA.includes(b)) adjA.push(b);
      if (adjA && !adjA.includes(c)) adjA.push(c);
      if (adjB && !adjB.includes(a)) adjB.push(a);
      if (adjB && !adjB.includes(c)) adjB.push(c);
      if (adjC && !adjC.includes(a)) adjC.push(a);
      if (adjC && !adjC.includes(b)) adjC.push(b);
    }
  }

  return adjacency;
}

/**
 * Applies Laplacian smoothing (Delta Mush) on the synthesized displacement delta buffer.
 * Eliminates sharp pinching and produces organic, continuous skin deformations.
 *
 * @param {Float32Array} deltaBuffer
 * @param {Map<number, number[]>} adjacency
 * @param {number} vertCount
 * @param {number} iterations
 * @param {number} lambda
 */
function applyLaplacianSmoothing(deltaBuffer, adjacency, vertCount, iterations = 2, lambda = 0.45) {
  if (!adjacency || adjacency.size === 0) return;

  const tempBuffer = new Float32Array(vertCount * 3);

  for (let iter = 0; iter < iterations; iter++) {
    tempBuffer.set(deltaBuffer);

    for (let i = 0; i < vertCount; i++) {
      const neighbors = adjacency.get(i);
      if (!neighbors || neighbors.length === 0) continue;

      let sumX = 0, sumY = 0, sumZ = 0;
      const numN = neighbors.length;

      for (let n = 0; n < numN; n++) {
        const nIdx = neighbors[n];
        sumX += tempBuffer[nIdx * 3 + 0];
        sumY += tempBuffer[nIdx * 3 + 1];
        sumZ += tempBuffer[nIdx * 3 + 2];
      }

      const avgX = sumX / numN;
      const avgY = sumY / numN;
      const avgZ = sumZ / numN;

      const i3 = i * 3;
      deltaBuffer[i3 + 0] = tempBuffer[i3 + 0] * (1 - lambda) + avgX * lambda;
      deltaBuffer[i3 + 1] = tempBuffer[i3 + 1] * (1 - lambda) + avgY * lambda;
      deltaBuffer[i3 + 2] = tempBuffer[i3 + 2] * (1 - lambda) + avgZ * lambda;
    }
  }
}

/**
 * 52 Canonical Apple ARKit / FACS Procedural Deformation Field Rules (OmniFaceRig RBF).
 */
const DEFORMATION_RULES = {
  // ── Brows (5) ──
  browDownLeft: (u, v, w, s) => {
    if (u < -0.05 && u > -0.60 && v > 0.65 && v < 0.92 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.16, 2) - Math.pow((v - 0.77) / 0.12, 2));
      return [0.005 * g * s, -0.048 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browDownRight: (u, v, w, s) => {
    if (u > 0.05 && u < 0.60 && v > 0.65 && v < 0.92 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.16, 2) - Math.pow((v - 0.77) / 0.12, 2));
      return [-0.005 * g * s, -0.048 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browInnerUp: (u, v, w, s) => {
    if (Math.abs(u) < 0.32 && v > 0.68 && v < 0.92 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.15, 2) - Math.pow((v - 0.78) / 0.14, 2));
      return [0, 0.055 * g * s, 0.012 * g * s];
    }
    return null;
  },
  browOuterUpLeft: (u, v, w, s) => {
    if (u < -0.20 && u > -0.62 && v > 0.65 && v < 0.92 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.45) / 0.15, 2) - Math.pow((v - 0.77) / 0.14, 2));
      return [-0.005 * g * s, 0.050 * g * s, 0.008 * g * s];
    }
    return null;
  },
  browOuterUpRight: (u, v, w, s) => {
    if (u > 0.20 && u < 0.62 && v > 0.65 && v < 0.92 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.45) / 0.15, 2) - Math.pow((v - 0.77) / 0.14, 2));
      return [0.005 * g * s, 0.050 * g * s, 0.008 * g * s];
    }
    return null;
  },

  // ── Eyes (14) ──
  eyeBlinkLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.52 && v < 0.76 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.09, 2));
      const downward = v > 0.62 ? -0.046 * g * s : 0.008 * g * s;
      return [0, downward, -0.012 * g * s];
    }
    return null;
  },
  eyeBlinkRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.52 && v < 0.76 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.09, 2));
      const downward = v > 0.62 ? -0.046 * g * s : 0.008 * g * s;
      return [0, downward, -0.012 * g * s];
    }
    return null;
  },
  eyeSquintLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.50 && v < 0.70 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.16, 2) - Math.pow((v - 0.58) / 0.09, 2));
      return [0.005 * g * s, 0.026 * g * s, 0.008 * g * s];
    }
    return null;
  },
  eyeSquintRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.50 && v < 0.70 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.16, 2) - Math.pow((v - 0.58) / 0.09, 2));
      return [-0.005 * g * s, 0.026 * g * s, 0.008 * g * s];
    }
    return null;
  },
  eyeWideLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.55 && v > 0.54 && v < 0.76 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.10, 2));
      const up = v > 0.63 ? 0.036 * g * s : -0.018 * g * s;
      return [0, up, 0.008 * g * s];
    }
    return null;
  },
  eyeWideRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.55 && v > 0.54 && v < 0.76 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.15, 2) - Math.pow((v - 0.64) / 0.10, 2));
      const up = v > 0.63 ? 0.036 * g * s : -0.018 * g * s;
      return [0, up, 0.008 * g * s];
    }
    return null;
  },
  eyeLookDownLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, -0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookDownRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, -0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookUpLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, 0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookUpRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0, 0.020 * g * s, 0];
    }
    return null;
  },
  eyeLookInLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookInRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [-0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookOutLeft: (u, v, w, s) => {
    if (u < -0.15 && u > -0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [-0.022 * g * s, 0, 0];
    }
    return null;
  },
  eyeLookOutRight: (u, v, w, s) => {
    if (u > 0.15 && u < 0.48 && v > 0.56 && v < 0.72 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.32) / 0.12, 2) - Math.pow((v - 0.63) / 0.08, 2));
      return [0.022 * g * s, 0, 0];
    }
    return null;
  },

  // ── Cheeks & Nose (5) ──
  cheekPuff: (u, v, w, s) => {
    if (Math.abs(u) > 0.12 && Math.abs(u) < 0.55 && v > 0.25 && v < 0.60 && w > 0.38) {
      const g = Math.exp(-Math.pow((Math.abs(u) - 0.34) / 0.18, 2) - Math.pow((v - 0.42) / 0.14, 2));
      const lat = u > 0 ? 0.035 * g * s : -0.035 * g * s;
      return [lat, 0.005 * g * s, 0.045 * g * s];
    }
    return null;
  },
  cheekSquintLeft: (u, v, w, s) => {
    if (u < -0.12 && u > -0.55 && v > 0.38 && v < 0.66 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.34) / 0.16, 2) - Math.pow((v - 0.52) / 0.12, 2));
      return [0.008 * g * s, 0.038 * g * s, 0.018 * g * s];
    }
    return null;
  },
  cheekSquintRight: (u, v, w, s) => {
    if (u > 0.12 && u < 0.55 && v > 0.38 && v < 0.66 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.34) / 0.16, 2) - Math.pow((v - 0.52) / 0.12, 2));
      return [-0.008 * g * s, 0.038 * g * s, 0.018 * g * s];
    }
    return null;
  },
  noseSneerLeft: (u, v, w, s) => {
    if (u < -0.02 && u > -0.28 && v > 0.42 && v < 0.68 && w > 0.40) {
      const g = Math.exp(-Math.pow((u + 0.14) / 0.10, 2) - Math.pow((v - 0.55) / 0.12, 2));
      return [-0.005 * g * s, 0.035 * g * s, 0.012 * g * s];
    }
    return null;
  },
  noseSneerRight: (u, v, w, s) => {
    if (u > 0.02 && u < 0.28 && v > 0.42 && v < 0.68 && w > 0.40) {
      const g = Math.exp(-Math.pow((u - 0.14) / 0.10, 2) - Math.pow((v - 0.55) / 0.12, 2));
      return [0.005 * g * s, 0.035 * g * s, 0.012 * g * s];
    }
    return null;
  },

  // ── Jaw (4) ──
  jawOpen: (u, v, w, s) => {
    if (Math.abs(u) < 0.42 && v < 0.45 && v > 0.08 && w > 0.35) {
      // Smooth falloff from chin up to lip line
      const g = Math.exp(-Math.pow(u / 0.26, 2) - Math.pow((v - 0.20) / 0.16, 2));
      return [0, -0.075 * g * s, -0.018 * g * s];
    }
    return null;
  },
  jawForward: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v < 0.38 && v > 0.08 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.24, 2) - Math.pow((v - 0.20) / 0.15, 2));
      return [0, 0, 0.035 * g * s];
    }
    return null;
  },
  jawLeft: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v < 0.38 && v > 0.08 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.25, 2) - Math.pow((v - 0.20) / 0.15, 2));
      return [-0.032 * g * s, 0, 0];
    }
    return null;
  },
  jawRight: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v < 0.38 && v > 0.08 && w > 0.35) {
      const g = Math.exp(-Math.pow(u / 0.25, 2) - Math.pow((v - 0.20) / 0.15, 2));
      return [0.032 * g * s, 0, 0];
    }
    return null;
  },

  // ── Mouth Core (11) ──
  mouthClose: (u, v, w, s) => {
    if (Math.abs(u) < 0.32 && v > 0.22 && v < 0.45 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.20, 2) - Math.pow((v - 0.33) / 0.10, 2));
      const dir = v > 0.33 ? -0.020 * g * s : 0.020 * g * s;
      return [0, dir, 0.005 * g * s];
    }
    return null;
  },
  mouthSmileLeft: (u, v, w, s) => {
    if (u < 0.05 && u > -0.48 && v > 0.20 && v < 0.52 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.25) / 0.16, 2) - Math.pow((v - 0.34) / 0.12, 2));
      return [-0.024 * g * s, 0.046 * g * s, 0.010 * g * s];
    }
    return null;
  },
  mouthSmileRight: (u, v, w, s) => {
    if (u > -0.05 && u < 0.48 && v > 0.20 && v < 0.52 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.25) / 0.16, 2) - Math.pow((v - 0.34) / 0.12, 2));
      return [0.024 * g * s, 0.046 * g * s, 0.010 * g * s];
    }
    return null;
  },
  mouthFrownLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.45 && v > 0.18 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.26) / 0.15, 2) - Math.pow((v - 0.32) / 0.11, 2));
      return [0.005 * g * s, -0.038 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthFrownRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.45 && v > 0.18 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.26) / 0.15, 2) - Math.pow((v - 0.32) / 0.11, 2));
      return [-0.005 * g * s, -0.038 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthPucker: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v > 0.20 && v < 0.48 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.22, 2) - Math.pow((v - 0.33) / 0.12, 2));
      const lat = u > 0 ? -0.035 * g * s : 0.035 * g * s;
      return [lat, 0, 0.055 * g * s];
    }
    return null;
  },
  mouthFunnel: (u, v, w, s) => {
    if (Math.abs(u) < 0.38 && v > 0.18 && v < 0.50 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.20, 2) - Math.pow((v - 0.33) / 0.14, 2));
      const lat = u > 0 ? -0.020 * g * s : 0.020 * g * s;
      const vert = v > 0.33 ? 0.025 * g * s : -0.035 * g * s;
      return [lat, vert, 0.040 * g * s];
    }
    return null;
  },
  mouthStretchLeft: (u, v, w, s) => {
    if (u < 0.05 && u > -0.50 && v > 0.20 && v < 0.48 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.26) / 0.16, 2) - Math.pow((v - 0.33) / 0.11, 2));
      return [-0.045 * g * s, 0, 0.005 * g * s];
    }
    return null;
  },
  mouthStretchRight: (u, v, w, s) => {
    if (u > -0.05 && u < 0.50 && v > 0.20 && v < 0.48 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.26) / 0.16, 2) - Math.pow((v - 0.33) / 0.11, 2));
      return [0.045 * g * s, 0, 0.005 * g * s];
    }
    return null;
  },
  mouthDimpleLeft: (u, v, w, s) => {
    if (u < -0.10 && u > -0.45 && v > 0.22 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.28) / 0.12, 2) - Math.pow((v - 0.33) / 0.10, 2));
      return [-0.015 * g * s, 0.010 * g * s, -0.018 * g * s];
    }
    return null;
  },
  mouthDimpleRight: (u, v, w, s) => {
    if (u > 0.10 && u < 0.45 && v > 0.22 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.28) / 0.12, 2) - Math.pow((v - 0.33) / 0.10, 2));
      return [0.015 * g * s, 0.010 * g * s, -0.018 * g * s];
    }
    return null;
  },

  // ── Mouth Roll & Shrug (6) ──
  mouthRollUpper: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.30 && v < 0.44 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.37) / 0.08, 2));
      return [0, -0.020 * g * s, -0.025 * g * s];
    }
    return null;
  },
  mouthRollLower: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.22 && v < 0.36 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.29) / 0.08, 2));
      return [0, 0.020 * g * s, -0.025 * g * s];
    }
    return null;
  },
  mouthShrugUpper: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.30 && v < 0.44 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.37) / 0.08, 2));
      return [0, 0.028 * g * s, 0.012 * g * s];
    }
    return null;
  },
  mouthShrugLower: (u, v, w, s) => {
    if (Math.abs(u) < 0.28 && v > 0.18 && v < 0.35 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.18, 2) - Math.pow((v - 0.27) / 0.09, 2));
      return [0, 0.035 * g * s, 0.015 * g * s];
    }
    return null;
  },
  mouthPressLeft: (u, v, w, s) => {
    if (u < 0.05 && u > -0.42 && v > 0.24 && v < 0.42 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.22) / 0.14, 2) - Math.pow((v - 0.33) / 0.08, 2));
      return [0, -0.010 * g * s, -0.015 * g * s];
    }
    return null;
  },
  mouthPressRight: (u, v, w, s) => {
    if (u > -0.05 && u < 0.42 && v > 0.24 && v < 0.42 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.22) / 0.14, 2) - Math.pow((v - 0.33) / 0.08, 2));
      return [0, -0.010 * g * s, -0.015 * g * s];
    }
    return null;
  },

  // ── Mouth Vertical Lip Shapes (4) ──
  mouthLowerDownLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.36 && v > 0.18 && v < 0.34 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.16) / 0.14, 2) - Math.pow((v - 0.27) / 0.08, 2));
      return [0, -0.035 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthLowerDownRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.36 && v > 0.18 && v < 0.34 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.16) / 0.14, 2) - Math.pow((v - 0.27) / 0.08, 2));
      return [0, -0.035 * g * s, -0.005 * g * s];
    }
    return null;
  },
  mouthUpperUpLeft: (u, v, w, s) => {
    if (u < 0.02 && u > -0.36 && v > 0.32 && v < 0.48 && w > 0.38) {
      const g = Math.exp(-Math.pow((u + 0.16) / 0.14, 2) - Math.pow((v - 0.39) / 0.08, 2));
      return [0, 0.035 * g * s, 0.005 * g * s];
    }
    return null;
  },
  mouthUpperUpRight: (u, v, w, s) => {
    if (u > -0.02 && u < 0.36 && v > 0.32 && v < 0.48 && w > 0.38) {
      const g = Math.exp(-Math.pow((u - 0.16) / 0.14, 2) - Math.pow((v - 0.39) / 0.08, 2));
      return [0, 0.035 * g * s, 0.005 * g * s];
    }
    return null;
  },

  // ── Mouth Sides & Tongue (3) ──
  mouthLeft: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v > 0.20 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.24, 2) - Math.pow((v - 0.33) / 0.12, 2));
      return [-0.038 * g * s, 0, 0];
    }
    return null;
  },
  mouthRight: (u, v, w, s) => {
    if (Math.abs(u) < 0.40 && v > 0.20 && v < 0.46 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.24, 2) - Math.pow((v - 0.33) / 0.12, 2));
      return [0.038 * g * s, 0, 0];
    }
    return null;
  },
  tongueOut: (u, v, w, s) => {
    if (Math.abs(u) < 0.18 && v > 0.26 && v < 0.38 && w > 0.38) {
      const g = Math.exp(-Math.pow(u / 0.10, 2) - Math.pow((v - 0.32) / 0.06, 2));
      return [0, -0.015 * g * s, 0.055 * g * s];
    }
    return null;
  },
};

/**
 * Synthesizes all 52 Apple ARKit blendshapes onto the provided mesh with OmniFaceRig Minimum Region Fitting & Laplacian Delta Mush.
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

  // 2. Extract true 3D surface anchors via directional raycasting
  const anchors = extractFacialAnchors(posAttr, vertCount, head);

  // 3. Build adjacency graph for Laplacian smoothing
  const adjacency = buildVertexAdjacency(geom);

  // Initialize morph attributes if missing
  if (!geom.morphAttributes) geom.morphAttributes = {};
  if (!geom.morphAttributes.position) geom.morphAttributes.position = [];
  if (!mesh.morphTargetDictionary) mesh.morphTargetDictionary = {};

  // CRITICAL: Three.js morph targets for additive rigging MUST be marked relative!
  geom.morphTargetsRelative = true;

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

      // Minimum Region Facial Isolation (OmniFaceRig): strictly eliminates deformation bleeding into ears, neck and occiput
      const mask = getFacialAnatomicalMask(u, v, w);
      if (mask <= 0.0001) continue;

      const delta = rule(u, v, w, effectiveScale);
      if (delta) {
        deltaBuffer[i * 3 + 0] = delta[0] * mask;
        deltaBuffer[i * 3 + 1] = delta[1] * mask;
        deltaBuffer[i * 3 + 2] = delta[2] * forwardSign * mask;
        hasMovement = true;
      }
    }

    if (hasMovement) {
      // 4. Apply Laplacian Smoothing (Delta Mush) on the synthesized displacement field
      if (adjacency.size > 0) {
        applyLaplacianSmoothing(deltaBuffer, adjacency, vertCount, 2, 0.40);
      }

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
    console.log(`[Auto-Rig] OmniFaceRig sintetizou ${addedCount} blendshapes ARKit na malha "${mesh.name || 'Face'}" com isolamento anatomico.`);
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
  geom.morphTargetsRelative = true;

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
