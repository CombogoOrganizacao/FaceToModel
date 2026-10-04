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

    // Audio & Waveform state
    this.waveformCanvas = null;
    /** @type {AudioBuffer|null} */
    this.audioBuffer = null;
    /** @type {Blob|null} */
    this.audioBlob = null;
    /** @type {Float32Array|null} */
    this.waveformPeaks = null;
    /** @type {AudioContext|null} */
    this._audioContext = null;
    /** @type {AudioBufferSourceNode|null} */
    this._audioSourceNode = null;
    /** @type {MediaRecorder|null} */
    this._audioRecorder = null;
    /** @type {Blob[]} */
    this._audioChunks = [];
    /** @type {MediaStream|null} */
    this._audioStream = null;
    this.isAudioMuted = false;

    // Call state change
    this._notify();
  }

  /* ─── Waveform Canvas Binding ─────────────────────────────────────────── */

  /**
   * Bind the timeline waveform canvas element.
   * @param {HTMLCanvasElement} canvas
   */
  setWaveformCanvas(canvas) {
    this.waveformCanvas = canvas;
    if (this.waveformCanvas && window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        this.drawWaveform();
      });
      ro.observe(this.waveformCanvas);
    }
    this.drawWaveform();
  }

  /* ─── Recording Controls ────────────────────────────────────────────────── */

  /**
   * Start or continue recording motion frames and synchronized audio.
   * @param {string|null} [audioDeviceId=null]
   */
  async startRecording(audioDeviceId = null) {
    this.stopPlayback();

    if (this.isPaused) {
      // Continuing from previous pause
      this.isPaused = false;
      this.isRecording = true;
      this._recordStartTime = performance.now();
      if (this._audioRecorder && this._audioRecorder.state === 'paused') {
        try {
          this._audioRecorder.resume();
        } catch (_) {}
      }
    } else {
      // New or first take
      if (this.frames.length === 0) {
        this._accumulatedTime = 0;
        this.totalDuration = 0;
        this.trimIn = 0;
        this.trimOut = 0;
        this.currentTime = 0;
        this.audioBuffer = null;
        this.audioBlob = null;
        this.waveformPeaks = null;
        this._audioChunks = [];
        this.drawWaveform();
      } else {
        // Continuing on existing timeline
        this._accumulatedTime = this.totalDuration;
      }
      this.isRecording = true;
      this.isPaused = false;
      this._recordStartTime = performance.now();
      await this._startAudioCapture(audioDeviceId);
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
      if (this._audioRecorder && this._audioRecorder.state === 'recording') {
        try {
          this._audioRecorder.pause();
        } catch (_) {}
      }
      this._notify();
    } else if (this.isPlaying) {
      this.pausePlayback();
    }
  }

  /**
   * Stop recording or playback and rewind playhead to trimIn.
   */
  async stop() {
    if (this.isRecording) {
      this.isRecording = false;
      this.isPaused = false;
      this._accumulatedTime = this.totalDuration;
      this.currentTime = this.trimIn;

      await this._stopAudioCapture();

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
    this._stopAudioCapture();
    this.isRecording = false;
    this.isPaused = false;
    this.frames = [];
    this.currentTime = 0;
    this.totalDuration = 0;
    this.trimIn = 0;
    this.trimOut = 0;
    this._accumulatedTime = 0;
    this.audioBuffer = null;
    this.audioBlob = null;
    this.waveformPeaks = null;
    this._audioChunks = [];
    this.drawWaveform();
    this._notify();
  }

  /**
   * Capture an incoming motion frame from MediaPipe face tracking.
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
    this._startAudioPlayback();
    this._playbackLoop();
    this._notify();
  }

  /**
   * Pause current playback.
   */
  pausePlayback() {
    this.isPlaying = false;
    this._stopAudioPlayback();
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
    this._stopAudioPlayback();
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

    if (this.isPlaying) {
      // Re-anchor audio to scrubbed time during playback
      this._startAudioPlayback();
    } else {
      this._stopAudioPlayback();
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

    this.drawWaveform();
    this.scrub(this.currentTime);
    this._notify();
  }

  /**
   * Toggle audio playback mute.
   * @returns {boolean} New mute state
   */
  toggleAudioMute() {
    this.isAudioMuted = !this.isAudioMuted;
    if (this.isAudioMuted) {
      this._stopAudioPlayback();
    } else if (this.isPlaying) {
      this._startAudioPlayback();
    }
    return this.isAudioMuted;
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

  /* ─── Waveform Rendering & Audio Engine ─────────────────────────────────── */

  /**
   * Initializes microphone capture for synchronized take recording.
   * @private
   */
  async _startAudioCapture(audioDeviceId = null) {
    try {
      if (!this._audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this._audioContext = new AudioContextClass();
        }
      }
      if (this._audioContext && this._audioContext.state === 'suspended') {
        await this._audioContext.resume();
      }

      if (!this._audioStream || !this._audioStream.active) {
        const constraints = audioDeviceId
          ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true };
        this._audioStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      }

      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        '',
      ].find((t) => !t || (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t))) || '';

      this._audioRecorder = new MediaRecorder(this._audioStream, mimeType ? { mimeType } : undefined);
      this._audioChunks = [];
      this._audioRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this._audioChunks.push(e.data);
        }
      };
      this._audioRecorder.start(100);
      console.log(`[MotionTimeline] Gravação de áudio sincronizada iniciada (${mimeType || 'default'}).`);
    } catch (err) {
      console.warn('[MotionTimeline] Microfone indisponível para gravação de timeline:', err.message);
      this._audioRecorder = null;
    }
  }

  /**
   * Stops audio recorder and decodes audio into buffer.
   * @private
   */
  async _stopAudioCapture() {
    if (!this._audioRecorder || this._audioRecorder.state === 'inactive') {
      return;
    }

    try {
      await new Promise((resolve) => {
        this._audioRecorder.onstop = resolve;
        this._audioRecorder.stop();
      });

      if (this._audioChunks && this._audioChunks.length > 0) {
        const mime = (this._audioRecorder && this._audioRecorder.mimeType) || 'audio/webm';
        this.audioBlob = new Blob(this._audioChunks, { type: mime });
        const arrayBuffer = await this.audioBlob.arrayBuffer();

        if (!this._audioContext) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          this._audioContext = new AudioContextClass();
        }
        if (this._audioContext.state === 'suspended') {
          await this._audioContext.resume();
        }

        // Support both callback and Promise-based decodeAudioData
        this.audioBuffer = await new Promise((res, rej) => {
          this._audioContext.decodeAudioData(
            arrayBuffer.slice(0),
            (decoded) => res(decoded),
            (err) => rej(err)
          );
        });

        console.log(`[MotionTimeline] Áudio decodificado: ${this.audioBuffer.duration.toFixed(2)}s, ${this.audioBuffer.numberOfChannels}ch`);
        this._computeWaveformPeaks();
        this.drawWaveform();
      }
    } catch (err) {
      console.warn('[MotionTimeline] Falha ao decodificar buffer de áudio gravado:', err.message);
    }
  }

  /**
   * Extract normalized amplitude peaks across timeline for smooth rendering.
   * @private
   */
  _computeWaveformPeaks(numBins = 480) {
    if (!this.audioBuffer) {
      this.waveformPeaks = null;
      return;
    }

    const rawData = this.audioBuffer.getChannelData(0);
    const totalSamples = rawData.length;
    const blockSize = Math.max(1, Math.floor(totalSamples / numBins));
    const peaks = new Float32Array(numBins);

    for (let i = 0; i < numBins; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, totalSamples);
      let max = 0;
      for (let j = start; j < end; j++) {
        const val = Math.abs(rawData[j]);
        if (val > max) max = val;
      }
      peaks[i] = max;
    }

    // Normalize
    let peakMax = 0;
    for (let i = 0; i < numBins; i++) {
      if (peaks[i] > peakMax) peakMax = peaks[i];
    }
    if (peakMax > 0.001) {
      for (let i = 0; i < numBins; i++) {
        peaks[i] = peaks[i] / peakMax;
      }
    }

    this.waveformPeaks = peaks;
  }

  /**
   * Draw Apple HIG styled audio waveform into the timeline canvas.
   */
  drawWaveform() {
    if (!this.waveformCanvas) return;

    const canvas = this.waveformCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
    const height = canvas.clientHeight || 28;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (!this.waveformPeaks || this.waveformPeaks.length === 0) {
      ctx.restore();
      return;
    }

    const peaks = this.waveformPeaks;
    const numBins = peaks.length;
    const midY = height / 2;
    const barWidth = Math.max(1.2, width / numBins);

    // Audio duration vs total timeline duration
    const audioDur = this.audioBuffer ? this.audioBuffer.duration : this.totalDuration;
    const durRatio = this.totalDuration > 0 ? Math.min(1.0, audioDur / this.totalDuration) : 1.0;
    const activeWidth = width * durRatio;

    // Gradient styling: Electric Indigo to Cyan (Apple HIG)
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.7)');
    gradient.addColorStop(0.5, 'rgba(6, 182, 212, 0.85)');
    gradient.addColorStop(1, 'rgba(129, 140, 248, 0.7)');

    ctx.fillStyle = gradient;

    for (let i = 0; i < numBins; i++) {
      const x = (i / numBins) * activeWidth;
      const amp = peaks[i];
      const barHeight = Math.max(1.5, amp * (height * 0.78));
      const y = midY - barHeight / 2;

      // Check if within trim range
      const timeAtBar = (x / width) * this.totalDuration;
      const isInsideTrim = timeAtBar >= this.trimIn && timeAtBar <= this.trimOut;

      ctx.globalAlpha = isInsideTrim ? 0.9 : 0.28;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, Math.max(1, barWidth - 0.5), barHeight, 1);
      } else {
        ctx.rect(x, y, Math.max(1, barWidth - 0.5), barHeight);
      }
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Start audio playback synchronized to current playhead.
   * @private
   */
  _startAudioPlayback() {
    this._stopAudioPlayback();
    if (this.isAudioMuted || !this.audioBuffer || !this._audioContext) return;

    try {
      if (this._audioContext.state === 'suspended') {
        this._audioContext.resume();
      }

      this._audioSourceNode = this._audioContext.createBufferSource();
      this._audioSourceNode.buffer = this.audioBuffer;
      this._audioSourceNode.connect(this._audioContext.destination);

      const offset = Math.max(0, this.currentTime);
      const duration = Math.max(0, this.trimOut - offset);

      if (offset < this.audioBuffer.duration && duration > 0) {
        this._audioSourceNode.start(0, offset, duration);
      }
    } catch (e) {
      console.warn('[MotionTimeline] Erro ao sincronizar áudio:', e.message);
      this._audioSourceNode = null;
    }
  }

  /**
   * Stop active audio source node.
   * @private
   */
  _stopAudioPlayback() {
    if (this._audioSourceNode) {
      try {
        this._audioSourceNode.stop();
        this._audioSourceNode.disconnect();
      } catch (_) {}
      this._audioSourceNode = null;
    }
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
        this._startAudioPlayback();
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
