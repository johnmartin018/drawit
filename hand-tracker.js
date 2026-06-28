// hand-tracker.js
// Wraps MediaPipe Tasks Vision HandLandmarker: camera setup, model loading,
// and per-frame detection. Emits plain landmark arrays via callbacks so the
// rest of the app never touches MediaPipe internals directly.

import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

export class HandTracker {
  /**
   * @param {Object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {(landmarks: {x:number,y:number,z:number}[]|null, video: HTMLVideoElement) => void} opts.onResult
   * @param {(state: 'loading'|'ready'|'tracking'|'no-hand'|'error', message?: string) => void} opts.onStatus
   */
  constructor({ video, onResult, onStatus }) {
    this.video = video;
    this.onResult = onResult;
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.running = false;
    this._lastVideoTime = -1;
    this._rafId = null;
  }

  async init() {
    this.onStatus("loading", "Loading hand-tracking model…");
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6
      });
    } catch (gpuErr) {
      // Fallback to CPU delegate if GPU isn't available on this device.
      try {
        const fileset = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
        );
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6
        });
      } catch (cpuErr) {
        this.onStatus("error", "Could not load the hand-tracking model. Check your connection and reload.");
        throw cpuErr;
      }
    }
    return this;
  }

  async startCamera() {
    this.onStatus("loading", "Requesting camera access…");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, min: 320 },
          height: { ideal: 720, min: 240 },
          facingMode: { ideal: "user" }
        },
        audio: false
      });
    } catch (err) {
      this.onStatus("error", err && err.name ? err.name : "camera-error");
      throw err; // preserve original error (name, message) for the caller
    }
    this.video.srcObject = stream;
    await new Promise((resolve) => {
      this.video.onloadedmetadata = () => resolve();
    });
    await this.video.play();
    this.onStatus("ready");
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._detectFrame();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    const stream = this.video.srcObject;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
    }
  }

  _detectFrame() {
    if (!this.landmarker || this.video.readyState < 2) return;
    const now = performance.now();
    if (this.video.currentTime === this._lastVideoTime) {
      // No new frame yet; skip to avoid duplicate work.
      return;
    }
    this._lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (e) {
      return; // transient — skip this frame
    }

    if (result && result.landmarks && result.landmarks.length > 0) {
      this.onStatus("tracking");
      this.onResult(result.landmarks[0], this.video);
    } else {
      this.onStatus("no-hand");
      this.onResult(null, this.video);
    }
  }
}
