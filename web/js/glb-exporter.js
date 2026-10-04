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

        // If mesh is already a direct child of headBone, it naturally inherits bone rotation!
        if (mesh.parent === headBone) {
          return;
        }

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

          if (att.relativeMatrix) {
            targetWorldMat.multiplyMatrices(headMat, att.relativeMatrix);
          } else {
            targetWorldMat.copy(headMat);
          }

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
 * Exports facial animation curves to Unreal Engine Live Link Face CSV format.
 * Compatible with Unreal Engine 5.x Live Link Face Importer / Curve Tables for MetaHumans.
 *
 * @param {Object} options
 * @param {Array<{ time: number, blendShapes: Record<string, number>, rotation: { pitch: number, yaw: number, roll: number }|null }>} options.frames
 * @param {number} [options.trimIn]
 * @param {number} [options.trimOut]
 * @param {string} [options.filename]
 * @param {number} [options.fps]
 * @returns {Blob}
 */
export function exportCurvesCSV({
  frames,
  trimIn = 0,
  trimOut = 0,
  filename = 'facetomodel_livelink.csv',
  fps = 60,
}) {
  if (!frames || frames.length === 0) {
    throw new Error('Nenhum quadro de animação para exportar.');
  }

  const validFrames = frames.filter((f) => f.time >= trimIn && (trimOut <= trimIn || f.time <= trimOut));
  if (validFrames.length === 0) {
    throw new Error('Nenhum quadro válido no intervalo de corte selecionado.');
  }

  // Canonical 52 ARKit BlendShape keys in standard Unreal Engine Live Link order
  const ARKIT_LIVE_LINK_KEYS = [
    'EyeBlinkLeft', 'EyeLookDownLeft', 'EyeLookInLeft', 'EyeLookOutLeft', 'EyeLookUpLeft',
    'EyeSquintLeft', 'EyeWideLeft', 'EyeBlinkRight', 'EyeLookDownRight', 'EyeLookInRight',
    'EyeLookOutRight', 'EyeLookUpRight', 'EyeSquintRight', 'EyeWideRight', 'JawForward',
    'JawLeft', 'JawRight', 'JawOpen', 'MouthClose', 'MouthFunnel', 'MouthPucker',
    'MouthLeft', 'MouthRight', 'MouthSmileLeft', 'MouthSmileRight', 'MouthFrownLeft',
    'MouthFrownRight', 'MouthDimpleLeft', 'MouthDimpleRight', 'MouthStretchLeft',
    'MouthStretchRight', 'MouthRollLower', 'MouthRollUpper', 'MouthShrugLower',
    'MouthShrugUpper', 'MouthPressLeft', 'MouthPressRight', 'MouthLowerDownLeft',
    'MouthLowerDownRight', 'MouthUpperUpLeft', 'MouthUpperUpRight', 'BrowDownLeft',
    'BrowDownRight', 'BrowInnerUp', 'BrowOuterUpLeft', 'BrowOuterUpRight', 'CheekPuff',
    'CheekSquintLeft', 'CheekSquintRight', 'NoseSneerLeft', 'NoseSneerRight', 'TongueOut'
  ];

  // Rotation columns (in degrees)
  const ROTATION_KEYS = [
    'HeadYaw', 'HeadPitch', 'HeadRoll',
    'LeftEyeYaw', 'LeftEyePitch', 'LeftEyeRoll',
    'RightEyeYaw', 'RightEyePitch', 'RightEyeRoll'
  ];

  const BLENDSHAPE_COUNT = ARKIT_LIVE_LINK_KEYS.length + ROTATION_KEYS.length; // 61

  // Header
  const header = ['Timecode', 'BlendShapeCount', ...ARKIT_LIVE_LINK_KEYS, ...ROTATION_KEYS].join(',');
  const lines = [header];

  const startTime = validFrames[0].time;

  for (let i = 0; i < validFrames.length; i++) {
    const frame = validFrames[i];
    const relTime = Math.max(0, frame.time - startTime);

    // Calculate timecode HH:MM:SS:FF
    const totalFrames = Math.round(relTime * fps);
    const ff = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mm = totalMinutes % 60;
    const hh = Math.floor(totalMinutes / 60);

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const timecode = `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;

    // Build row values
    const rowValues = [timecode, BLENDSHAPE_COUNT];

    // Build quick lookup dictionary for this frame
    const shapes = frame.blendShapes || {};
    const lowerShapes = {};
    for (const [k, v] of Object.entries(shapes)) {
      lowerShapes[k.toLowerCase()] = v;
    }

    // 52 Blendshapes
    for (const key of ARKIT_LIVE_LINK_KEYS) {
      let val = shapes[key];
      if (val === undefined) {
        val = lowerShapes[key.toLowerCase()] ?? 0.0;
      }
      val = Math.max(0, Math.min(1, Number(val) || 0));
      rowValues.push(val.toFixed(6));
    }

    // Rotations in degrees
    const rot = frame.rotation || { pitch: 0, yaw: 0, roll: 0 };
    const toDeg = 180 / Math.PI;
    const headYawDeg = (rot.yaw || 0) * toDeg;
    const headPitchDeg = (rot.pitch || 0) * toDeg;
    const headRollDeg = (rot.roll || 0) * toDeg;

    rowValues.push(headYawDeg.toFixed(4));
    rowValues.push(headPitchDeg.toFixed(4));
    rowValues.push(headRollDeg.toFixed(4));

    // Eye rotations (LeftEyeYaw, LeftEyePitch, LeftEyeRoll, RightEyeYaw, RightEyePitch, RightEyeRoll)
    rowValues.push('0.0000', '0.0000', '0.0000', '0.0000', '0.0000', '0.0000');

    lines.push(rowValues.join(','));
  }

  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 15000);

  return blob;
}

/**
 * Exports facial animation curves to a universal, lightweight JSON format.
 * Compatible with Godot 4.x, Unity (C# json import), and custom game pipelines.
 *
 * @param {Object} options
 * @param {Array<{ time: number, blendShapes: Record<string, number>, rotation: { pitch: number, yaw: number, roll: number }|null }>} options.frames
 * @param {number} [options.trimIn]
 * @param {number} [options.trimOut]
 * @param {string} [options.filename]
 * @param {number} [options.fps]
 * @returns {Blob}
 */
export function exportCurvesJSON({
  frames,
  trimIn = 0,
  trimOut = 0,
  filename = 'facetomodel_curves.json',
  fps = 60,
}) {
  if (!frames || frames.length === 0) {
    throw new Error('Nenhum quadro de animação para exportar.');
  }

  const validFrames = frames.filter((f) => f.time >= trimIn && (trimOut <= trimIn || f.time <= trimOut));
  if (validFrames.length === 0) {
    throw new Error('Nenhum quadro válido no intervalo de corte selecionado.');
  }

  const startTime = validFrames[0].time;
  const duration = Math.max(0.01, validFrames[validFrames.length - 1].time - startTime);

  // Discover all blendshape names present across frames
  const shapeNameSet = new Set();
  validFrames.forEach((f) => {
    if (f.blendShapes) {
      Object.keys(f.blendShapes).forEach((k) => shapeNameSet.add(k));
    }
  });

  const curves = {};
  shapeNameSet.forEach((name) => {
    curves[name] = [];
  });

  const rotation = {
    pitch: [],
    yaw: [],
    roll: [],
  };
  const timestamps = [];

  for (let i = 0; i < validFrames.length; i++) {
    const f = validFrames[i];
    const t = Math.max(0, Number((f.time - startTime).toFixed(4)));
    timestamps.push(t);

    const shapes = f.blendShapes || {};
    shapeNameSet.forEach((name) => {
      const val = shapes[name] !== undefined ? Number(shapes[name].toFixed(4)) : 0.0;
      curves[name].push(val);
    });

    const rot = f.rotation || { pitch: 0, yaw: 0, roll: 0 };
    rotation.pitch.push(Number((rot.pitch || 0).toFixed(4)));
    rotation.yaw.push(Number((rot.yaw || 0).toFixed(4)));
    rotation.roll.push(Number((rot.roll || 0).toFixed(4)));
  }

  const data = {
    version: '1.0',
    generator: 'FaceToModel',
    fps,
    duration: Number(duration.toFixed(3)),
    frameCount: validFrames.length,
    timestamps,
    curves,
    rotation,
  };

  const jsonContent = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 15000);

  return blob;
}

/**
 * Exports the 3D model with embedded AnimationClip to a binary .GLB file and triggers download.
 * Performs clean unwrap of viewer framing transforms and restores native rest pose for engine compatibility.
 *
 * @param {Object} options
 * @param {THREE.Object3D} options.model - The 3D model scene
 * @param {THREE.AnimationClip} options.animationClip - The generated animation clip
 * @param {string} [options.filename] - Output file name
 * @param {boolean} [options.preserveViewerTransforms] - Whether to keep viewport scale/offsets (default false)
 * @param {boolean} [options.download] - Whether to automatically trigger browser download (default true)
 * @returns {Promise<Blob>}
 */
export function exportModelToGLB({
  model,
  animationClip,
  filename = 'facetomodel_animation.glb',
  preserveViewerTransforms = false,
  download = true,
}) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    const exportTarget = model;

    // 1. Non-destructively preserve and prepare rest transforms and original materials
    const savedTransforms = new Map();
    const savedMaterials = new Map();
    const savedMorphs = new Map();

    exportTarget.traverse((node) => {
      if (node.isMesh) {
        if (!node.name || node.name.trim() === '') {
          node.name = `Mesh_${node.id}`;
        }
        // Swap back to original untouched PBR material for clean GLB export
        if (node.userData && node.userData.originalMaterial) {
          savedMaterials.set(node, node.material);
          node.material = node.userData.originalMaterial;
        }
        // Reset morph target influences to rest (0) for base mesh geometry
        if (node.morphTargetInfluences && Array.isArray(node.morphTargetInfluences)) {
          savedMorphs.set(node, node.morphTargetInfluences.slice());
          node.morphTargetInfluences.fill(0);
        }
      } else if (node.isBone) {
        if (node.userData && node.userData.restQuaternion) {
          savedTransforms.set(node, {
            quaternion: node.quaternion.clone(),
            position: node.position.clone(),
          });
          node.quaternion.copy(node.userData.restQuaternion);
          if (node.userData.restPosition) {
            node.position.copy(node.userData.restPosition);
          }
        }
      }
    });

    // Reset root model transforms to original rest (scale 1.0, position 0,0,0) if viewport framing was applied
    let savedRootTransform = null;
    if (!preserveViewerTransforms && exportTarget.userData && exportTarget.userData.restTransform) {
      savedRootTransform = {
        position: exportTarget.position.clone(),
        scale: exportTarget.scale.clone(),
        quaternion: exportTarget.quaternion.clone(),
      };
      exportTarget.position.copy(exportTarget.userData.restTransform.position);
      exportTarget.scale.copy(exportTarget.userData.restTransform.scale);
      exportTarget.quaternion.copy(exportTarget.userData.restTransform.quaternion);
    }

    exportTarget.updateMatrixWorld(true);

    const restoreState = () => {
      if (savedRootTransform) {
        exportTarget.position.copy(savedRootTransform.position);
        exportTarget.scale.copy(savedRootTransform.scale);
        exportTarget.quaternion.copy(savedRootTransform.quaternion);
      }
      savedMaterials.forEach((mat, node) => {
        node.material = mat;
      });
      savedMorphs.forEach((influences, node) => {
        for (let i = 0; i < influences.length; i++) {
          node.morphTargetInfluences[i] = influences[i];
        }
      });
      savedTransforms.forEach((tf, bone) => {
        bone.quaternion.copy(tf.quaternion);
        bone.position.copy(tf.position);
      });
      exportTarget.updateMatrixWorld(true);
    };

    const options = {
      binary: true,
      animations: animationClip ? [animationClip] : [],
      embedImages: true,
      truncateDrawRange: false,
    };

    console.log(`[glb-exporter] Exportando GLB limpo com ${animationClip?.tracks.length || 0} trilhas de animação...`);

    exporter.parse(
      exportTarget,
      (result) => {
        restoreState();

        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: 'model/gltf-binary' });
          if (download) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 15000);
            console.log(`[glb-exporter] GLB exportado com sucesso: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
          }
          resolve(blob);
        } else {
          // JSON fallback if not binary
          const output = JSON.stringify(result, null, 2);
          const blob = new Blob([output], { type: 'application/json' });
          if (download) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename.replace('.glb', '.gltf');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 15000);
          }
          resolve(blob);
        }
      },
      (error) => {
        restoreState();
        console.error('[glb-exporter] Erro ao exportar GLB:', error);
        reject(error);
      },
      options
    );
  });
}

/**
 * Exports the 3D model with embedded AnimationClip to Autodesk FBX format via the local Blender microservice.
 *
 * @param {Object} options
 * @param {THREE.Object3D} options.model - The 3D model scene
 * @param {THREE.AnimationClip} options.animationClip - The generated animation clip
 * @param {string} [options.filename] - Output file name (.fbx)
 * @returns {Promise<Blob>}
 */
export async function exportModelToFBX({
  model,
  animationClip,
  filename = 'facetomodel_animation.fbx',
}) {
  // 1. Generate clean GLB binary in memory without triggering automatic download
  const glbBlob = await exportModelToGLB({
    model,
    animationClip,
    filename: filename.replace(/\.fbx$/i, '.glb'),
    download: false,
  });

  console.log(`[glb-exporter] Enviando GLB (${(glbBlob.size / 1024 / 1024).toFixed(2)} MB) para conversão FBX via Blender Headless...`);

  const response = await fetch('/api/convert-to-fbx', {
    method: 'POST',
    headers: {
      'Content-Type': 'model/gltf-binary',
    },
    body: glbBlob,
  });

  if (!response.ok) {
    let errMsg = `Falha na conversão (status ${response.status})`;
    try {
      const errJson = await response.json();
      errMsg = errJson.error || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const fbxBlob = await response.blob();
  const url = URL.createObjectURL(fbxBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  console.log(`[glb-exporter] FBX exportado com sucesso: ${filename} (${(fbxBlob.size / 1024 / 1024).toFixed(2)} MB)`);
  return fbxBlob;
}

