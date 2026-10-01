/**
 * @fileoverview FaceToModel — Media Recorder
 *
 * Captures the Three.js canvas stream (optionally with microphone audio)
 * into a WebM or MP4 video using the MediaRecorder API. Fires custom DOM
 * events for recording lifecycle and exposes a Blob URL for inline preview
 * and file download.
 *
 * @module recorder
 */

/* ─── Supported MIME Types (checked in preference order) ───────────────── */

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

/* ─── Recorder ──────────────────────────────────────────────────────────── */

/**
 * Records the Three.js canvas as a video file, with optional microphone audio.
 *
 * Dispatches three custom DOM events on the canvas element:
 *   - `recordingstarted`  — when recording begins
 *   - `recordingstopped`  — when recording ends; `event.detail.url` holds the blob URL
 *   - `durationupdate`    — every second; `event.detail.seconds` is elapsed time
 *
 * @example
 * const recorder = new Recorder(canvas);
 * await recorder.startRecording();
 * // ... later ...
 * const url = await recorder.stopRecording();
 * recorder.downloadRecording('face-capture.webm');
 */
export class Recorder {
  /**
   * @param {HTMLCanvasElement} canvas - The Three.js renderer canvas to capture
   */
  constructor(canvas) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {MediaRecorder|null} */
    this._mediaRecorder = null;

    /** @type {Blob[]} */
    this._chunks = [];

    /** @type {string|null} Blob URL of the last completed recording */
    this._lastRecordingURL = null;

    /** @type {boolean} */
    this.isRecording = false;

    /** @type {number} Elapsed recording time in whole seconds */
    this.duration = 0;

    /** @private @type {number|null} setInterval handle for duration updates */
    this._durationInterval = null;

    /** @private @type {number|null} setInterval handle for start timestamp */
    this._startTime = null;
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */

  /**
   * Begin recording. Requests microphone access (fails gracefully if denied).
   * Resolves when the MediaRecorder has started.
   *
   * @returns {Promise<void>}
   * @throws Will reject if the canvas stream cannot be captured or no MIME type is supported
   */
  async startRecording() {
    if (this.isRecording) {
      console.warn('[Recorder] Already recording.');
      return;
    }

    // ── 1. Canvas video track ──
    const fps = 30;
    let canvasStream;
    try {
      canvasStream = this.canvas.captureStream(fps);
    } catch (err) {
      throw new Error(`[Recorder] canvas.captureStream failed: ${err.message}`);
    }

    // ── 2. Optional microphone audio track ──
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {
      console.warn('[Recorder] Microphone not available — recording video only.');
    }

    // ── 3. Merge tracks into one stream ──
    const tracks = [...canvasStream.getVideoTracks()];
    if (micStream) {
      tracks.push(...micStream.getAudioTracks());
    }
    const combinedStream = new MediaStream(tracks);

    // ── 4. Choose best supported MIME type ──
    const mimeType = PREFERRED_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    if (!mimeType) {
      throw new Error('[Recorder] No supported video MIME type found in this browser.');
    }
    console.log(`[Recorder] Using MIME type: ${mimeType}`);

    // ── 5. Create MediaRecorder ──
    this._chunks  = [];
    const options = { mimeType, videoBitsPerSecond: 8_000_000 };

    try {
      this._mediaRecorder = new MediaRecorder(combinedStream, options);
    } catch (err) {
      throw new Error(`[Recorder] MediaRecorder init failed: ${err.message}`);
    }

    this._mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._chunks.push(event.data);
      }
    };

    this._mediaRecorder.onerror = (event) => {
      console.error('[Recorder] MediaRecorder error:', event.error);
      this._cleanupAfterStop();
    };

    // ── 6. Start ──
    this._mediaRecorder.start(200); // collect data every 200 ms
    this.isRecording = true;
    this.duration    = 0;
    this._startTime  = Date.now();

    // Duration update every second
    this._durationInterval = setInterval(() => {
      this.duration = Math.floor((Date.now() - this._startTime) / 1000);
      this.canvas.dispatchEvent(new CustomEvent('durationupdate', {
        detail: { seconds: this.duration },
        bubbles: true,
      }));
    }, 1_000);

    this.canvas.dispatchEvent(new CustomEvent('recordingstarted', { bubbles: true }));
    console.log('[Recorder] Recording started.');
  }

  /**
   * Stop the current recording and compile the Blob.
   *
   * @returns {Promise<string>} Blob URL of the recorded video
   */
  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this._mediaRecorder || !this.isRecording) {
        reject(new Error('[Recorder] Not currently recording.'));
        return;
      }

      this._mediaRecorder.onstop = () => {
        const mimeType = this._mediaRecorder.mimeType || 'video/webm';
        const blob      = new Blob(this._chunks, { type: mimeType });

        // Revoke old URL to free memory
        if (this._lastRecordingURL) {
          URL.revokeObjectURL(this._lastRecordingURL);
        }
        this._lastRecordingURL = URL.createObjectURL(blob);

        this.canvas.dispatchEvent(new CustomEvent('recordingstopped', {
          detail: { url: this._lastRecordingURL, blob, mimeType },
          bubbles: true,
        }));

        console.log(`[Recorder] Recording stopped — ${blob.size} bytes, ${mimeType}`);
        this._cleanupAfterStop();
        resolve(this._lastRecordingURL);
      };

      this._mediaRecorder.stop();

      // Stop all tracks so the browser releases the camera/mic indicators
      if (this._mediaRecorder.stream) {
        this._mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      }
    });
  }

  /**
   * Trigger a file-system download of the last completed recording.
   *
   * @param {string} [filename='face-capture.webm'] - Desired file name
   */
  downloadRecording(filename = 'face-capture.webm') {
    if (!this._lastRecordingURL) {
      console.warn('[Recorder] No recording available to download.');
      return;
    }

    const a    = document.createElement('a');
    a.href     = this._lastRecordingURL;
    a.download = filename;
    a.click();
  }

  /**
   * @returns {string|null} Blob URL of the last completed recording, or null
   */
  getLastRecordingURL() {
    return this._lastRecordingURL;
  }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  /**
   * Reset state after recording ends (either normally or on error).
   * @private
   */
  _cleanupAfterStop() {
    this.isRecording = false;
    clearInterval(this._durationInterval);
    this._durationInterval = null;
    this._mediaRecorder    = null;
  }
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Format a number of seconds into MM:SS string.
 *
 * @param {number} totalSeconds
 * @returns {string} e.g. '01:34'
 */
export function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
