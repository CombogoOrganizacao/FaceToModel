/**
 * @fileoverview FaceToModel — Expression Controls & Preview Manager (ARKit Toolset Style)
 *
 * Provides a comprehensive testing suite for facial blendshapes inspired by ARKit Toolset:
 *   1. Sliders grouped by facial regions (Brows, Eyes, Mouth, Jaw, Cheeks)
 *   2. "Test All" continuous automated demo mode cycling through all expressions
 *   3. 2D Look Around joystick trackpad for dynamic eye gaze
 *   4. Instant expression presets (Smile, Surprised, Blink, Angry, Thinking, Neutral)
 *   5. Zero All / Reset button
 *
 * @module expression-controls
 */

import { STANDARD_BLENDSHAPES } from './blendshape-mapper.js';

export const EXPRESSION_CATEGORIES = {
  brows: {
    label: 'Sobrancelhas',
    shapes: ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight']
  },
  eyes: {
    label: 'Olhos & Pálpebras',
    shapes: [
      'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight',
      'eyeWideLeft', 'eyeWideRight', 'eyeLookDownLeft', 'eyeLookDownRight',
      'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookInLeft', 'eyeLookInRight',
      'eyeLookOutLeft', 'eyeLookOutRight'
    ]
  },
  mouth: {
    label: 'Boca & Lábios',
    shapes: [
      'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
      'mouthPucker', 'mouthFunnel', 'mouthLeft', 'mouthRight', 'mouthClose',
      'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
      'mouthShrugUpper', 'mouthShrugLower', 'mouthRollUpper', 'mouthRollLower',
      'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
      'mouthPressLeft', 'mouthPressRight'
    ]
  },
  jaw: {
    label: 'Mandíbula & Queixo',
    shapes: ['jawOpen', 'jawForward', 'jawLeft', 'jawRight']
  },
  cheeks: {
    label: 'Bochechas & Nariz',
    shapes: [
      'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
      'noseSneerLeft', 'noseSneerRight', 'tongueOut'
    ]
  }
};

export const EXPRESSION_PRESETS = {
  neutral: {
    label: 'Neutro',
    shapes: {}
  },
  smile: {
    label: 'Sorriso Natural',
    shapes: {
      mouthSmileLeft: 0.85,
      mouthSmileRight: 0.85,
      eyeSquintLeft: 0.40,
      eyeSquintRight: 0.40,
      cheekSquintLeft: 0.50,
      cheekSquintRight: 0.50
    }
  },
  surprised: {
    label: 'Surpresa',
    shapes: {
      browInnerUp: 0.90,
      browOuterUpLeft: 0.80,
      browOuterUpRight: 0.80,
      eyeWideLeft: 0.85,
      eyeWideRight: 0.85,
      jawOpen: 0.65,
      mouthFunnel: 0.45
    }
  },
  blink: {
    label: 'Piscada Dupla',
    shapes: {
      eyeBlinkLeft: 1.0,
      eyeBlinkRight: 1.0
    }
  },
  angry: {
    label: 'Raiva / Bravo',
    shapes: {
      browDownLeft: 0.95,
      browDownRight: 0.95,
      noseSneerLeft: 0.70,
      noseSneerRight: 0.70,
      eyeSquintLeft: 0.60,
      eyeSquintRight: 0.60,
      mouthFrownLeft: 0.65,
      mouthFrownRight: 0.65
    }
  },
  thinking: {
    label: 'Dúvida / Olhar',
    shapes: {
      browOuterUpLeft: 0.85,
      browDownRight: 0.60,
      mouthLeft: 0.55,
      eyeLookUpRight: 0.75,
      eyeLookInLeft: 0.75
    }
  }
};

export class ExpressionControls {
  /**
   * @param {Object} options
   * @param {Function} options.onApply - Callback (blendShapes) => void to drive 3D renderer
   */
  constructor({ onApply }) {
    this.onApply = onApply;
    this.values = {};
    this.activeCategory = 'brows';
    this.isTestingAll = false;
    this._testAnimId = null;
    this._testStartTime = 0;

    // Zero initial state
    STANDARD_BLENDSHAPES.forEach((s) => {
      this.values[s] = 0.0;
    });
  }

  setShape(shapeName, val) {
    this.values[shapeName] = Math.max(0, Math.min(1, val));
    if (this.onApply) {
      this.onApply({ ...this.values });
    }
  }

  zeroAll() {
    this.stopTestAll();
    STANDARD_BLENDSHAPES.forEach((s) => {
      this.values[s] = 0.0;
    });
    if (this.onApply) {
      this.onApply({ ...this.values });
    }
    this.syncSlidersUI();
  }

  applyPreset(presetKey) {
    this.stopTestAll();
    const preset = EXPRESSION_PRESETS[presetKey];
    if (!preset) return;

    // Reset all shapes first
    STANDARD_BLENDSHAPES.forEach((s) => {
      this.values[s] = 0.0;
    });

    // Apply preset overrides
    Object.assign(this.values, preset.shapes);

    if (this.onApply) {
      this.onApply({ ...this.values });
    }
    this.syncSlidersUI();
  }

  /**
   * Continuous automated demonstration cycling through all 52 expressions smoothly.
   */
  startTestAll(onComplete = null) {
    this.zeroAll();
    this.isTestingAll = true;
    this._testStartTime = performance.now();

    const shapesList = STANDARD_BLENDSHAPES;
    const durationPerShape = 650; // ms per expression
    const totalDuration = shapesList.length * durationPerShape;

    const tick = () => {
      if (!this.isTestingAll) return;

      const elapsed = performance.now() - this._testStartTime;
      if (elapsed >= totalDuration) {
        this.stopTestAll();
        if (onComplete) onComplete();
        return;
      }

      const currentIndex = Math.floor(elapsed / durationPerShape);
      const phase = (elapsed % durationPerShape) / durationPerShape;
      // Smooth sinusoidal pulse 0 -> 1 -> 0
      const pulseWeight = Math.sin(phase * Math.PI);

      // Clear all
      STANDARD_BLENDSHAPES.forEach((s) => {
        this.values[s] = 0.0;
      });

      const currentShape = shapesList[currentIndex];
      if (currentShape) {
        this.values[currentShape] = pulseWeight;
      }

      if (this.onApply) {
        this.onApply({ ...this.values });
      }

      this.syncSlidersUI();
      this._testAnimId = requestAnimationFrame(tick);
    };

    this._testAnimId = requestAnimationFrame(tick);
  }

  stopTestAll() {
    this.isTestingAll = false;
    if (this._testAnimId) {
      cancelAnimationFrame(this._testAnimId);
      this._testAnimId = null;
    }
  }

  /**
   * Updates slider elements in the DOM to reflect current values.
   */
  syncSlidersUI() {
    for (const [shape, val] of Object.entries(this.values)) {
      const slider = document.getElementById(`exp-slider-${shape}`);
      const valLabel = document.getElementById(`exp-val-${shape}`);
      if (slider) slider.value = String(val);
      if (valLabel) valLabel.textContent = (val * 100).toFixed(0) + '%';
    }
  }
}
