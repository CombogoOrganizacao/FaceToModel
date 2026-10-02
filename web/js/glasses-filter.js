/**
 * @fileoverview FaceToModel — Glasses Optimization & Ocular Anti-Jitter Filter
 *
 * Implements real-time signal conditioning for users wearing glasses / eyewear:
 *   1. Dynamic Baseline Calibration: offsets static frame occlusion over the upper eyelid.
 *   2. Dual-Threshold Hysteresis: eliminates single-frame blink glitches and lens-reflection jitter.
 *   3. 1-Euro Filter for Gaze: smooths fixation tremor while preserving rapid eye saccades.
 *   4. Binocular Glare Coherence: suppresses false unilateral winks caused by light reflections on one lens.
 *
 * @module glasses-filter
 */

class OneEuroFilter {
  constructor(freq = 60, mincutoff = 1.0, beta = 0.007, dcutoff = 1.0) {
    this.freq = freq;
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  _alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(val, timestamp = performance.now()) {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = val;
      this.tPrev = timestamp;
      return val;
    }

    const dt = Math.max(0.001, (timestamp - this.tPrev) / 1000);
    this.tPrev = timestamp;

    // Derivative estimation
    const dx = (val - this.xPrev) / dt;
    const alphaD = this._alpha(this.dcutoff, dt);
    const edx = alphaD * dx + (1 - alphaD) * this.dxPrev;
    this.dxPrev = edx;

    // Filtered value estimation
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    const alpha = this._alpha(cutoff, dt);
    const result = alpha * val + (1 - alpha) * this.xPrev;
    this.xPrev = result;

    return result;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

export class GlassesFilter {
  constructor() {
    this.enabled = false;

    // Dynamic baselines for left & right eye blink
    this._baselineLeft = 0.0;
    this._baselineRight = 0.0;

    // State for hysteresis (true = currently considered closed)
    this._closedLeft = false;
    this._closedRight = false;

    // 1-Euro filters for gaze blendshapes
    this._gazeFilters = {
      eyeLookInLeft: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookOutLeft: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookUpLeft: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookDownLeft: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookInRight: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookOutRight: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookUpRight: new OneEuroFilter(60, 1.2, 0.02),
      eyeLookDownRight: new OneEuroFilter(60, 1.2, 0.02),
    };

    this._lastFilterTime = performance.now();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.reset();
    }
  }

  reset() {
    this._baselineLeft = 0.0;
    this._baselineRight = 0.0;
    this._closedLeft = false;
    this._closedRight = false;
    Object.values(this._gazeFilters).forEach((f) => f.reset());
  }

  /**
   * Processes facial blendshapes dictionary and returns clean ocular blendshapes.
   * @param {Record<string, number>} blendShapes
   * @returns {Record<string, number>}
   */
  process(blendShapes) {
    if (!this.enabled || !blendShapes) return blendShapes;

    const out = { ...blendShapes };
    const now = performance.now();

    // 1. Raw blink readings
    let blinkL = out.eyeBlinkLeft ?? out.eyeBlink_L ?? 0;
    let blinkR = out.eyeBlinkRight ?? out.eyeBlink_R ?? 0;

    // Dynamic baseline tracking (updates slowly when eyes are open to adapt to frame position)
    if (blinkL < 0.45) {
      this._baselineLeft = this._baselineLeft * 0.96 + blinkL * 0.04;
    }
    if (blinkR < 0.45) {
      this._baselineRight = this._baselineRight * 0.96 + blinkR * 0.04;
    }

    // Remap values above baseline to clean 0..1 scale
    const remapBlink = (val, baseline) => {
      const clampedBase = Math.min(0.35, baseline);
      return Math.max(0, Math.min(1, (val - clampedBase) / (1.0 - clampedBase)));
    };

    let normL = remapBlink(blinkL, this._baselineLeft);
    let normR = remapBlink(blinkR, this._baselineRight);

    // 2. Dual-Threshold Hysteresis
    // Closing requires passing 0.48, reopening requires dropping below 0.22
    if (!this._closedLeft && normL > 0.48) this._closedLeft = true;
    else if (this._closedLeft && normL < 0.22) this._closedLeft = false;

    if (!this._closedRight && normR > 0.48) this._closedRight = true;
    else if (this._closedRight && normR < 0.22) this._closedRight = false;

    // Smooth transition curve when open vs closed
    let finalL = this._closedLeft ? Math.max(0.65, normL) : Math.min(0.18, normL * 0.7);
    let finalR = this._closedRight ? Math.max(0.65, normR) : Math.min(0.18, normR * 0.7);

    // 3. Binocular Glare Coherence:
    // If one eye closes for < 100ms while other is wide open due to single-lens reflection, blend towards bilateral coherence
    const disparity = Math.abs(finalL - finalR);
    if (disparity > 0.55 && (finalL < 0.2 || finalR < 0.2)) {
      const avg = (finalL + finalR) * 0.5;
      finalL = finalL * 0.4 + avg * 0.6;
      finalR = finalR * 0.4 + avg * 0.6;
    }

    if (out.eyeBlinkLeft !== undefined) out.eyeBlinkLeft = finalL;
    if (out.eyeBlink_L !== undefined) out.eyeBlink_L = finalL;
    if (out.eyeBlinkRight !== undefined) out.eyeBlinkRight = finalR;
    if (out.eyeBlink_R !== undefined) out.eyeBlink_R = finalR;

    // 4. Gaze Direction 1-Euro Filtering
    for (const [key, filter] of Object.entries(this._gazeFilters)) {
      if (out[key] !== undefined) {
        out[key] = filter.filter(out[key], now);
      }
    }

    this._lastFilterTime = now;
    return out;
  }
}
