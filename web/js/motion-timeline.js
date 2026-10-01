/**
 * @fileoverview FaceToModel — Motion Timeline Engine (Blender Style)
 *
 * Provides a professional non-linear timeline for facial motion capture:
 *   - Continuous multi-take motion recording (record, pause, continue)
 *   - Live interactive scrubbing: scrubs playhead in 3D viewport at 60 FPS
 *   - Linear interpolation (Lerp) across 52 blendshapes and 3DoF head rotation
 *   - Non-destructive Trim In / Trim Out handles
 *   - Synchronized playback with looping support
 *   - Segment export to native MP4 video
 *
 * @module motion-timeline
 */

export class MotionTimeline {
  /**
   * @param {Object} options
   * @param {Function} options.onApplyFrame - Callback (blendShapes, rotation) => void to drive 3D renderer
   * @param {Function} [options.onStateChange] - Callback (state) => void when timeline state updates
   */
  constructor({ onApplyFrame, onStateChange = null }) {
    this.onApplyFrame = onApplyFrame;
    this.onStateChange = onStateChange;

    /** @type {Array<{ time: number, blendShapes: Record<string, number>, rotation: { pitch: number, yaw: number, roll: number }|null }>} */
    this.frames = [];

    // State
    this.isRecording = false;
    this.isPaused = false;
    this.isPlaying = false;
    this.isLooping = true;
    this.isScrubbing = false;

    // Time & Trim (in seconds)
    this.currentTime = 0;
    this.totalDuration = 0;
    this.trimIn = 0;
    this.trimOut = 0;

    // Internal timing
    this._recordStartTime = 0;
    this._accumulatedTime = 0;
    this._lastPlaybackTime = 0;
    this._playbackAnimId = null;

    // Call state change
    this._notify();
  }

  /* ─── Recording Controls ────────────────────────────────────────────────── */

  /**
   * Start or continue recording motion frames.
   */
  startRecording() {
    this.stopPlayback();

    if (this.isPaused) {
      // Continuing from previous pause
      this.isPaused = false;
      this.isRecording = true;
      this._recordStartTime = performance.now();
    } else {
      // New or first take
      if (this.frames.length === 0) {
        this._accumulatedTime = 0;
        this.totalDuration = 0;
        this.trimIn = 0;
        this.trimOut = 0;
        this.currentTime = 0;
      } else {
        // Continuing on existing timeline
        this._accumulatedTime = this.totalDuration;
      }
      this.isRecording = true;
      this.isPaused = false;
      this._recordStartTime = performance.now();
    }

    this._notify();
  }

  /**
   * Pause recording or playback without losing recorded data.
   */
  pause() {
    if (this.isRecording) {
      this.isPaused = true;
      this._accumulatedTime = this.totalDuration;
      this._notify();
    } else if (this.isPlaying) {
      this.pausePlayback();
    }
  }

  /**
   * Stop recording or playback and rewind playhead to trimIn.
   */
  stop() {
    if (this.isRecording) {
      this.isRecording = false;
      this.isPaused = false;
      this._accumulatedTime = this.totalDuration;
      this.currentTime = this.trimIn;
      this.scrub(this.trimIn);
      this._notify();
    } else if (this.isPlaying) {
      this.stopPlayback();
      this.currentTime = this.trimIn;
      this.scrub(this.trimIn);
      this._notify();
    }
  }

  /**
   * Clear all recorded frames and reset timeline.
   */
  clear() {
    this.stopPlayback();
    this.isRecording = false;
    this.isPaused = false;
    this.frames = [];
    this.currentTime = 0;
    this.totalDuration = 0;
    this.trimIn = 0;
    this.trimOut = 0;
    this._accumulatedTime = 0;
    this._notify();
  }

  /**
   * Capture an incoming motion frame from ARKit or MediaPipe.
   * @param {Record<string, number>} blendShapes
   * @param {{ pitch?: number, yaw?: number, roll?: number }|null} [rotation]
   */
  addFrame(blendShapes, rotation = null) {
    if (!this.isRecording || this.isPaused) return;

    const now = performance.now();
    const elapsedTake = (now - this._recordStartTime) / 1000;
    const time = this._accumulatedTime + elapsedTake;

    // Shallow copy blendShapes for independence
    const copiedShapes = { ...blendShapes };
    const copiedRot = rotation ? {
      pitch: rotation.pitch || 0,
      yaw: rotation.yaw || 0,
      roll: rotation.roll || 0,
    } : null;

    // Update trimOut if it was tracking the end
    const wasAtEnd = Math.abs(this.trimOut - this.totalDuration) < 0.05 || this.totalDuration === 0;

    this.frames.push({
      time,
      blendShapes: copiedShapes,
      rotation: copiedRot,
    });

    this.totalDuration = time;
    this.currentTime = time;

    if (wasAtEnd) {
      this.trimOut = this.totalDuration;
    }

    this._notify();
  }

  /* ─── Playback & Scrubbing Controls ─────────────────────────────────────── */

  /**
   * Start playback of the recorded motion within trim bounds.
   */
  play() {
    if (this.frames.length < 2) return;
    if (this.isRecording) this.stop();

    if (this.currentTime >= this.trimOut - 0.02 || this.currentTime < this.trimIn) {
      this.currentTime = this.trimIn;
    }

    this.isPlaying = true;
    this._lastPlaybackTime = performance.now();
    this._playbackLoop();
    this._notify();
  }

  /**
   * Pause current playback.
   */
  pausePlayback() {
    this.isPlaying = false;
    if (this._playbackAnimId) {
      cancelAnimationFrame(this._playbackAnimId);
      this._playbackAnimId = null;
    }
    this._notify();
  }

  /**
   * Stop current playback and reset playhead to trimIn.
   */
  stopPlayback() {
    this.pausePlayback();
    this.currentTime = this.trimIn;
    this.scrub(this.trimIn);
    this._notify();
  }

  /**
   * Toggle between play and pause.
   */
  togglePlay() {
    if (this.isPlaying) {
      this.pausePlayback();
    } else {
      this.play();
    }
  }

  /**
   * Set playback looping on or off.
   * @param {boolean} loop
   */
  setLooping(loop) {
    this.isLooping = Boolean(loop);
    this._notify();
  }

  /**
   * Interactive scrubbing at a target time in seconds.
   * Immediately updates the 3D model with the interpolated frame.
   * @param {number} time
   */
  scrub(time) {
    if (this.frames.length === 0) {
      this.currentTime = 0;
      this._notify();
      return;
    }

    this.currentTime = Math.max(0, Math.min(this.totalDuration, time));
    const frame = this.getInterpolatedFrame(this.currentTime);
    if (frame && this.onApplyFrame) {
      this.onApplyFrame(frame.blendShapes, frame.rotation);
    }
    this._notify();
  }

  /**
   * Set Trim In and Trim Out range.
   * @param {number} inSec
   * @param {number} outSec
   */
  setTrim(inSec, outSec) {
    if (this.totalDuration <= 0) return;
    this.trimIn = Math.max(0, Math.min(inSec, this.totalDuration));
    this.trimOut = Math.max(this.trimIn + 0.1, Math.min(outSec, this.totalDuration));
    
    // Clamp currentTime within trim if outside
    if (this.currentTime < this.trimIn) this.currentTime = this.trimIn;
    if (this.currentTime > this.trimOut) this.currentTime = this.trimOut;

    this.scrub(this.currentTime);
    this._notify();
  }

  /* ─── Frame Interpolation (Lerp) ────────────────────────────────────────── */

  /**
   * Calculates interpolated blendshapes and rotation at any arbitrary timestamp.
   * Uses binary search for high-frequency scrubbing performance.
   * @param {number} time
   * @returns {{ blendShapes: Record<string, number>, rotation: { pitch: number, yaw: number, roll: number }|null }|null}
   */
  getInterpolatedFrame(time) {
    const len = this.frames.length;
    if (len === 0) return null;
    if (len === 1 || time <= this.frames[0].time) {
      return this.frames[0];
    }
    if (time >= this.frames[len - 1].time) {
      return this.frames[len - 1];
    }

    // Binary search for surrounding frames
    let low = 0;
    let high = len - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.frames[mid].time < time) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const i0 = Math.max(0, low - 1);
    const i1 = Math.min(len - 1, low);
    const f0 = this.frames[i0];
    const f1 = this.frames[i1];

    if (i0 === i1 || f1.time === f0.time) {
      return f0;
    }

    const alpha = Math.max(0, Math.min(1, (time - f0.time) / (f1.time - f0.time)));

    // Interpolate blendshapes
    const outBlendshapes = {};
    const keys0 = Object.keys(f0.blendShapes);
    for (let k = 0; k < keys0.length; k++) {
      const name = keys0[k];
      const v0 = f0.blendShapes[name] || 0;
      const v1 = f1.blendShapes[name] !== undefined ? f1.blendShapes[name] : v0;
      outBlendshapes[name] = v0 + (v1 - v0) * alpha;
    }

    // Interpolate rotation
    let outRotation = null;
    if (f0.rotation && f1.rotation) {
      outRotation = {
        pitch: f0.rotation.pitch + (f1.rotation.pitch - f0.rotation.pitch) * alpha,
        yaw:   f0.rotation.yaw   + (f1.rotation.yaw   - f0.rotation.yaw)   * alpha,
        roll:  f0.rotation.roll  + (f1.rotation.roll  - f0.rotation.roll)  * alpha,
      };
    } else if (f0.rotation) {
      outRotation = f0.rotation;
    } else if (f1.rotation) {
      outRotation = f1.rotation;
    }

    return { blendShapes: outBlendshapes, rotation: outRotation };
  }

  /* ─── Private Internal Loop & Helpers ───────────────────────────────────── */

  _playbackLoop() {
    if (!this.isPlaying) return;

    const now = performance.now();
    const dt = (now - this._lastPlaybackTime) / 1000;
    this._lastPlaybackTime = now;

    this.currentTime += dt;

    if (this.currentTime >= this.trimOut) {
      if (this.isLooping) {
        this.currentTime = this.trimIn;
      } else {
        this.currentTime = this.trimOut;
        this.pausePlayback();
        this.scrub(this.currentTime);
        return;
      }
    }

    const frame = this.getInterpolatedFrame(this.currentTime);
    if (frame && this.onApplyFrame) {
      this.onApplyFrame(frame.blendShapes, frame.rotation);
    }

    this._notify();
    this._playbackAnimId = requestAnimationFrame(() => this._playbackLoop());
  }

  _notify() {
    if (this.onStateChange) {
      this.onStateChange({
        isRecording: this.isRecording,
        isPaused: this.isPaused,
        isPlaying: this.isPlaying,
        isLooping: this.isLooping,
        currentTime: this.currentTime,
        totalDuration: this.totalDuration,
        trimIn: this.trimIn,
        trimOut: this.trimOut,
        frameCount: this.frames.length,
      });
    }
  }

  /**
   * Format seconds to MM:SS.cc
   * @param {number} sec
   * @returns {string}
   */
  static formatTime(sec) {
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const centis = Math.floor((s * 100) % 100);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }
}
