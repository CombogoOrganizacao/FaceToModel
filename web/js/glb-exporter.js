/**
 * @fileoverview FaceToModel — 3D Animation & GLB Exporter
 *
 * Packages motion capture takes into standard glTF 2.0 / GLB files:
 *   - Compiles recorded timeline frames into native `THREE.AnimationClip`
 *   - Generates tracks for all active 52 Morph Target blendshapes across all meshes
 *   - Generates quaternion rotational tracks for skeletal Head and Neck bones (or root pivot)
 *   - Exports a single, self-contained `.glb` binary file compatible with:
 *       • Blender 3.x / 4.x (NLA Timeline & Action Editor)
 *       • Unreal Engine 5 (Skeletal Mesh & Animation Sequence Curves)
 *       • Unity 2022+ / 6 (Animator & Morph Controller)
 *       • Godot 4.x (AnimationPlayer & BlendShape tracks)
 *
 * @module glb-exporter
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/**
 * Builds a THREE.AnimationClip from MotionTimeline recorded frames.
 * @param {Object} options
 * @param {Array<{ time: number, blendShapes: Record<string, number>, rotation: { pitch: number, yaw: number, roll: number }|null }>} options.frames
 * @param {number} options.trimIn
 * @param {number} options.trimOut
 * @param {THREE.Object3D} options.model
 * @param {Record<string, Array<{ mesh: THREE.Mesh, index: number }>>} options.modelMap
 * @param {THREE.Bone|null} [options.headBone]
 * @param {THREE.Bone|null} [options.neckBone]
 * @param {string} [options.clipName]
 * @returns {THREE.AnimationClip|null}
 */
export function buildAnimationClip({
  frames,
  trimIn = 0,
  trimOut = 0,
  model,
  modelMap,
  headBone = null,
  neckBone = null,
  headAttachments = [],
  clipName = 'FaceToModel_MotionCapture'
}) {
  if (!frames || frames.length === 0) return null;

  // Filter frames within the trim range [trimIn, trimOut]
  const validFrames = frames.filter((f) => f.time >= trimIn && (trimOut <= trimIn || f.time <= trimOut));
  if (validFrames.length === 0) return null;

  // Normalize time so clip starts exactly at 0.0s and ensure strictly increasing timestamps
  const startTime = validFrames[0].time;
  const times = [];
  const filteredIndices = [];
  let lastT = -1;

  for (let i = 0; i < validFrames.length; i++) {
    const rawT = Math.max(0, validFrames[i].time - startTime);
    // Three.js KeyframeTrack requires strictly increasing times (rawT > lastT)
    if (rawT > lastT + 0.0001) {
      times.push(rawT);
      filteredIndices.push(i);
      lastT = rawT;
    }
  }

  if (times.length < 2) return null;
  const duration = times[times.length - 1] || 0.01;

  const tracks = [];

  // 1. Group meshes by morph targets
  const meshMap = new Map(); // mesh -> Map<morphIndex, valuesArray>
  let meshIndex = 0;
  model.traverse((node) => {
    if (node.isMesh) {
      if (!node.name || node.name.trim() === '') {
        node.name = `Mesh_${meshIndex++}`;
      }
      if (node.morphTargetDictionary) {
        meshMap.set(node, new Map());
      }
    }
  });

  const numKeyframes = filteredIndices.length;

  // Pre-fill mesh morph target tracks
  for (let k = 0; k < numKeyframes; k++) {
    const frame = validFrames[filteredIndices[k]];
    const shapes = frame.blendShapes || {};

    // For each blendshape received, find mapped meshes
    for (const [shapeName, weight] of Object.entries(shapes)) {
      const canonicalKey = shapeName.toLowerCase();
      // Try direct match or ARKit aliases
      const mappedTargets = modelMap[canonicalKey] || modelMap[shapeName] || [];

      mappedTargets.forEach(({ mesh, index }) => {
        if (!meshMap.has(mesh)) return;
        const targetMap = meshMap.get(mesh);
        if (!targetMap.has(index)) {
          // Initialize array filled with zeros for all keyframes
          const arr = new Float32Array(numKeyframes);
          targetMap.set(index, arr);
        }
        targetMap.get(index)[k] = Math.max(0, Math.min(1, weight));
      });
    }
  }

  // Create NumberKeyframeTrack for each mesh and morph target
  const timesArray = new Float32Array(times);
  meshMap.forEach((targetMap, mesh) => {
    const meshName = mesh.name || mesh.uuid;
    targetMap.forEach((valuesArray, morphIndex) => {
      // Check if there is any non-zero value
      let hasMovement = false;
      for (let v = 0; v < valuesArray.length; v++) {
        if (valuesArray[v] > 0.001) {
          hasMovement = true;
          break;
        }
      }
      if (hasMovement) {
        const trackName = `${meshName}.morphTargetInfluences[${morphIndex}]`;
        tracks.push(new THREE.NumberKeyframeTrack(trackName, timesArray, valuesArray));
      }
    });
  });

  // 2. Head and Neck Bone Rotations (or Root Model if bust)
  if (headBone) {
    const headRotations = new Float32Array(numKeyframes * 4);
    const neckRotations = neckBone ? new Float32Array(numKeyframes * 4) : null;

    const restHeadQ = headBone.userData.restQuaternion || headBone.quaternion.clone();
    const restNeckQ = neckBone ? (neckBone.userData.restQuaternion || neckBone.quaternion.clone()) : null;

    for (let k = 0; k < numKeyframes; k++) {
      const frame = validFrames[filteredIndices[k]];
      const rot = frame.rotation || { pitch: 0, yaw: 0, roll: 0 };
      const rx = rot.pitch || 0;
      const ry = rot.yaw || 0;
      const rz = rot.roll || 0;

      if (neckBone && restNeckQ) {
        // 25% Neck distribution
        const nEuler = new THREE.Euler(rx * 0.25, ry * 0.25, rz * 0.25, 'YXZ');
        const nQ = restNeckQ.clone().multiply(new THREE.Quaternion().setFromEuler(nEuler));
        neckRotations[k * 4 + 0] = nQ.x;
        neckRotations[k * 4 + 1] = nQ.y;
        neckRotations[k * 4 + 2] = nQ.z;
        neckRotations[k * 4 + 3] = nQ.w;

        // 75% Head distribution
        const hEuler = new THREE.Euler(rx * 0.75, ry * 0.75, rz * 0.75, 'YXZ');
        const hQ = restHeadQ.clone().multiply(new THREE.Quaternion().setFromEuler(hEuler));
        headRotations[k * 4 + 0] = hQ.x;
        headRotations[k * 4 + 1] = hQ.y;
        headRotations[k * 4 + 2] = hQ.z;
        headRotations[k * 4 + 3] = hQ.w;
      } else {
        // 100% Head
        const hEuler = new THREE.Euler(rx, ry, rz, 'YXZ');
        const hQ = restHeadQ.clone().multiply(new THREE.Quaternion().setFromEuler(hEuler));
        headRotations[k * 4 + 0] = hQ.x;
        headRotations[k * 4 + 1] = hQ.y;
        headRotations[k * 4 + 2] = hQ.z;
        headRotations[k * 4 + 3] = hQ.w;
      }
    }

    tracks.push(new THREE.QuaternionKeyframeTrack(`${headBone.name}.quaternion`, timesArray, headRotations));
    if (neckBone && neckRotations) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${neckBone.name}.quaternion`, timesArray, neckRotations));
    }

    // 3. Synchronize non-skinned head attachments (hair, eyebrows) in exported animation
    if (headAttachments && headAttachments.length > 0) {
      headAttachments.forEach((att) => {
        const mesh = att.mesh;
        const meshName = mesh.name;
        if (!meshName) return;

        const posTrackValues = new Float32Array(numKeyframes * 3);
        const rotTrackValues = new Float32Array(numKeyframes * 4);

        const tempHeadQ = new THREE.Quaternion();
        const tempEuler = new THREE.Euler();
        const targetWorldMat = new THREE.Matrix4();
        const targetLocalMat = new THREE.Matrix4();
        const invParentWorld = new THREE.Matrix4();
        const pVec = new THREE.Vector3();
        const qQuat = new THREE.Quaternion();
        const sVec = new THREE.Vector3();

        for (let k = 0; k < numKeyframes; k++) {
          const frame = validFrames[filteredIndices[k]];
          const rot = frame.rotation || { pitch: 0, yaw: 0, roll: 0 };
          const rx = rot.pitch || 0;
          const ry = rot.yaw || 0;
          const rz = rot.roll || 0;

          // Head bone orientation for this keyframe
          const hRatio = neckBone ? 0.75 : 1.0;
          tempEuler.set(rx * hRatio, ry * hRatio, rz * hRatio, 'YXZ');
          tempHeadQ.copy(restHeadQ).multiply(new THREE.Quaternion().setFromEuler(tempEuler));

          // Compose virtual head bone matrix
          const headMat = new THREE.Matrix4().compose(
            headBone.position,
            tempHeadQ,
            headBone.scale
          );

          targetWorldMat.multiplyMatrices(headMat, att.relativeMatrix);
          if (mesh.parent) {
            invParentWorld.copy(mesh.parent.matrixWorld).invert();
            targetLocalMat.multiplyMatrices(invParentWorld, targetWorldMat);
          } else {
            targetLocalMat.copy(targetWorldMat);
          }

          targetLocalMat.decompose(pVec, qQuat, sVec);

          posTrackValues[k * 3 + 0] = pVec.x;
          posTrackValues[k * 3 + 1] = pVec.y;
          posTrackValues[k * 3 + 2] = pVec.z;

          rotTrackValues[k * 4 + 0] = qQuat.x;
          rotTrackValues[k * 4 + 1] = qQuat.y;
          rotTrackValues[k * 4 + 2] = qQuat.z;
          rotTrackValues[k * 4 + 3] = qQuat.w;
        }

        tracks.push(new THREE.VectorKeyframeTrack(`${meshName}.position`, timesArray, posTrackValues));
        tracks.push(new THREE.QuaternionKeyframeTrack(`${meshName}.quaternion`, timesArray, rotTrackValues));
      });
    }
  } else if (model) {
    // Model pivot rotation (for bust models without bones)
    const modelRotations = new Float32Array(numKeyframes * 4);
    for (let k = 0; k < numKeyframes; k++) {
      const frame = validFrames[filteredIndices[k]];
      const rot = frame.rotation || { pitch: 0, yaw: 0, roll: 0 };
      const euler = new THREE.Euler(rot.pitch || 0, rot.yaw || 0, rot.roll || 0, 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(euler);
      modelRotations[k * 4 + 0] = q.x;
      modelRotations[k * 4 + 1] = q.y;
      modelRotations[k * 4 + 2] = q.z;
      modelRotations[k * 4 + 3] = q.w;
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${model.name || 'FaceToModel_Pivot'}.quaternion`, timesArray, modelRotations));
  }

  if (tracks.length === 0) {
    console.warn('[glb-exporter] Nenhuma trilha de animação válida gerada.');
    return null;
  }

  return new THREE.AnimationClip(clipName, duration, tracks);
}

/**
 * Exports the 3D model with embedded AnimationClip to a binary .GLB file and triggers download.
 * @param {Object} options
 * @param {THREE.Object3D} options.model - The 3D model scene
 * @param {THREE.AnimationClip} options.animationClip - The generated animation clip
 * @param {string} [options.filename] - Output file name
 * @returns {Promise<Blob>}
 */
export function exportModelToGLB({ model, animationClip, filename = 'facetomodel_animation.glb' }) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();

    // Export the inner model (or root model)
    const exportTarget = model;

    const options = {
      binary: true,
      animations: animationClip ? [animationClip] : [],
      embedImages: true,
      truncateDrawRange: false,
    };

    console.log(`[glb-exporter] Exportando GLB com ${animationClip?.tracks.length || 0} trilhas de animação...`);

    exporter.parse(
      exportTarget,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: 'model/gltf-binary' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 15000);
          console.log(`[glb-exporter] GLB exportado com sucesso: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
          resolve(blob);
        } else {
          // JSON fallback if not binary
          const output = JSON.stringify(result, null, 2);
          const blob = new Blob([output], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename.replace('.glb', '.gltf');
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 15000);
          resolve(blob);
        }
      },
      (error) => {
        console.error('[glb-exporter] Erro ao exportar GLB:', error);
        reject(error);
      },
      options
    );
  });
}
