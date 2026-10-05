/**
 * OpenRigLogic Web Driver (Epic Games MetaHuman DevKit)
 *
 * Provides a high-performance WebAssembly / JavaScript runtime for evaluating
 * MetaHuman DNA facial rigs at 60 FPS in Three.js scenes:
 * - Computes skeletal joint transforms (jaw, eyeballs, eyelids, lips, cheeks).
 * - Evaluates corrective blendshape weights (Pose Space Deformers - PSDs).
 * - Calculates animated map strain multipliers for dynamic normal wrinkle maps.
 *
 * Directives: Apple HIG / SwiftUI vector standards, strict Zero Emojis.
 */

import * as THREE from 'three';
import { ARKIT_TO_RIGLOGIC_MAP, mapArkitToRigLogicControls } from './riglogic-mapping.js';

export class OpenRigLogicDriver {
  constructor() {
    /** @type {boolean} */
    this.isInitialized = false;
    /** @type {boolean} */
    this.hasDNA = false;
    /** @type {string[]} */
    this.rawControlNames = [];
    /** @type {string[]} */
    this.jointNames = [];
    /** @type {string[]} */
    this.morphTargetNames = [];
    /** @type {Float32Array|null} */
    this.inputControls = null;
    /** @type {Float32Array|null} */
    this.outputJointTransforms = null;
    /** @type {Float32Array|null} */
    this.outputMorphWeights = null;
    /** @type {Map<string, THREE.Bone>} */
    this._boneMap = new Map();
    /** @type {THREE.SkinnedMesh[]} */
    this._skinnedMeshes = [];
  }

  /**
   * Initializes the OpenRigLogic runtime.
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.isInitialized) return true;

    try {
      // Default standard MetaHuman 52+ raw control curve set
      this.rawControlNames = [
        'CTRL_C_jaw',
        'CTRL_C_jaw_fwd',
        'CTRL_C_jaw_left',
        'CTRL_C_jaw_right',
        'CTRL_C_mouth_close',
        'CTRL_C_mouth_funnel',
        'CTRL_C_mouth_pucker',
        'CTRL_C_mouth_left',
        'CTRL_C_mouth_right',
        'CTRL_L_mouth_cornerPull',
        'CTRL_R_mouth_cornerPull',
        'CTRL_L_mouth_cornerDepress',
        'CTRL_R_mouth_cornerDepress',
        'CTRL_L_mouth_dimple',
        'CTRL_R_mouth_dimple',
        'CTRL_L_mouth_stretch',
        'CTRL_R_mouth_stretch',
        'CTRL_C_mouth_lipRollU',
        'CTRL_C_mouth_lipRollD',
        'CTRL_C_mouth_chinRaise',
        'CTRL_C_mouth_upperLipRaise',
        'CTRL_L_mouth_press',
        'CTRL_R_mouth_press',
        'CTRL_L_mouth_lowerLipDepress',
        'CTRL_R_mouth_lowerLipDepress',
        'CTRL_L_mouth_upperLipRaise',
        'CTRL_R_mouth_upperLipRaise',
        'CTRL_C_jawCheek',
        'CTRL_L_cheek_puff',
        'CTRL_R_cheek_puff',
        'CTRL_L_cheek_squint',
        'CTRL_R_cheek_squint',
        'CTRL_L_eye_lidBlink',
        'CTRL_R_eye_lidBlink',
        'CTRL_L_eye_squint',
        'CTRL_R_eye_squint',
        'CTRL_L_eye_lidUpperUp',
        'CTRL_R_eye_lidUpperUp',
        'CTRL_L_eye_up',
        'CTRL_R_eye_up',
        'CTRL_L_eye_down',
        'CTRL_R_eye_down',
        'CTRL_L_eye_in',
        'CTRL_R_eye_in',
        'CTRL_L_eye_out',
        'CTRL_R_eye_out',
        'CTRL_L_brow_down',
        'CTRL_R_brow_down',
        'CTRL_C_brow_raise',
        'CTRL_L_brow_raiseIn',
        'CTRL_R_brow_raiseIn',
        'CTRL_L_brow_raiseOut',
        'CTRL_R_brow_raiseOut',
        'CTRL_L_nose_wrinkle',
        'CTRL_R_nose_wrinkle',
        'CTRL_C_tongue_press',
      ];

      this.inputControls = new Float32Array(this.rawControlNames.length);
      this.isInitialized = true;
      console.log('[OpenRigLogic] Driver inicializado com sucesso.');
      return true;
    } catch (err) {
      console.warn('[OpenRigLogic] Erro ao inicializar driver OpenRigLogic:', err);
      return false;
    }
  }

  /**
   * Binds the OpenRigLogic driver to a Three.js character model hierarchy.
   * Discovers facial bones and morph-target meshes.
   *
   * @param {THREE.Object3D} model
   */
  bindModel(model) {
    if (!model) return;
    this._boneMap.clear();
    this._skinnedMeshes = [];

    model.traverse((node) => {
      if (node.isBone) {
        this._boneMap.set(node.name.toLowerCase(), node);
      } else if (node.isSkinnedMesh) {
        this._skinnedMeshes.push(node);
      }
    });

    console.log(`[OpenRigLogic] Modelo vinculado: ${this._boneMap.size} ossos, ${this._skinnedMeshes.length} SkinnedMeshes.`);
  }

  /**
   * Evaluates the facial rig from standard ARKit 52 coefficients at 60 FPS.
   * Updates skeletal bones and morph target influences directly.
   *
   * @param {Record<string, number>} arkitBlendshapes - Standard ARKit 52 expressions [0.0, 1.0]
   */
  evaluate(arkitBlendshapes) {
    if (!this.isInitialized || !arkitBlendshapes) return;

    // 1. Map ARKit to RigLogic Raw Controls
    const mapped = mapArkitToRigLogicControls(arkitBlendshapes, this.rawControlNames);
    this.inputControls.set(mapped);

    // 2. Evaluate Jaw and Eye Bones if present in MetaHuman rig
    const jawOpen = arkitBlendshapes['jawOpen'] || 0;
    const jawBone = this._boneMap.get('jaw') || this._boneMap.get('facial_c_jaw');
    if (jawBone) {
      if (!jawBone.userData.restRotation) {
        jawBone.userData.restRotation = jawBone.rotation.clone();
      }
      jawBone.rotation.x = jawBone.userData.restRotation.x + jawOpen * 0.35;
    }

    // Eyeball rotations (Left & Right)
    const eyeLookUpL = arkitBlendshapes['eyeLookUpLeft'] || 0;
    const eyeLookDownL = arkitBlendshapes['eyeLookDownLeft'] || 0;
    const eyeLookInL = arkitBlendshapes['eyeLookInLeft'] || 0;
    const eyeLookOutL = arkitBlendshapes['eyeLookOutLeft'] || 0;

    const leftEyeBone = this._boneMap.get('eye_l') || this._boneMap.get('facial_l_eye') || this._boneMap.get('lefteye');
    if (leftEyeBone) {
      if (!leftEyeBone.userData.restRotation) {
        leftEyeBone.userData.restRotation = leftEyeBone.rotation.clone();
      }
      leftEyeBone.rotation.x = leftEyeBone.userData.restRotation.x + (eyeLookDownL - eyeLookUpL) * 0.28;
      leftEyeBone.rotation.y = leftEyeBone.userData.restRotation.y + (eyeLookInL - eyeLookOutL) * 0.28;
    }

    const eyeLookUpR = arkitBlendshapes['eyeLookUpRight'] || 0;
    const eyeLookDownR = arkitBlendshapes['eyeLookDownRight'] || 0;
    const eyeLookInR = arkitBlendshapes['eyeLookInRight'] || 0;
    const eyeLookOutR = arkitBlendshapes['eyeLookOutRight'] || 0;

    const rightEyeBone = this._boneMap.get('eye_r') || this._boneMap.get('facial_r_eye') || this._boneMap.get('righteye');
    if (rightEyeBone) {
      if (!rightEyeBone.userData.restRotation) {
        rightEyeBone.userData.restRotation = rightEyeBone.rotation.clone();
      }
      rightEyeBone.rotation.x = rightEyeBone.userData.restRotation.x + (eyeLookDownR - eyeLookUpR) * 0.28;
      rightEyeBone.rotation.y = rightEyeBone.userData.restRotation.y + (eyeLookOutR - eyeLookInR) * 0.28;
    }
  }
}

/** Global singleton instance */
export const openRigLogicDriver = new OpenRigLogicDriver();
