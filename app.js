// app.js
// Top-level orchestration: wires HandTracker results into pinch-gesture
// detection, smooths the index-fingertip position to kill jitter, drives
// CanvasEngine drawing calls, renders the brass pinch-gauge overlay, and
// tracks FPS. This is the only module that knows about all the others.

import { HandTracker } from "./hand-tracker.js";

const THUMB_TIP = 4;
const INDEX_TIP = 8;

class App {
  constructor() {
    this.video = document.getElementById("webcam");
    this.drawCanvas = document.getElementById("drawCanvas");
    this.overlayCanvas = document.getElementById("overlayCanvas");
    this.overlayCtx = this.overlayCanvas.getContext("2d");

    this.engine = new window.CanvasEngine(this.drawCanvas);
    this.ui = new window.UIController(this.engine);

    // Exponential smoothing state for the index fingertip, in normalized
    // [0,1] video coordinates. A higher alpha follows the finger more
    // closely (less lag); lower alpha smooths more (less jitter).
    this.smoothed = null;
    this.smoothingAlpha = 0.5;

    this.isPinching = false;
    this.lastPinchDistance = null;

    // FPS tracking
    this._frameTimes = [];
    this._fpsEl = document.getElementById("fpsBadge");

    this.tracker = new HandTracker({
      video: this.video,
      onResult: (landmarks) => this._onLandmarks(landmarks),
      onStatus: (state, message) => this._onStatus(state, message)
    });

    this._resizeOverlay();
    window.addEventListener("resize", () => this._resizeOverlay());

    this._bindCameraControls();
    this._bindDebugPanel();

    ["pause", "stalled", "suspend", "ended", "waiting", "error"].forEach((evt) => {
      this.video.addEventListener(evt, () => this._logDebug(`video event: ${evt}`));
    });

    // Surface ANY uncaught error or promise rejection on-screen, since
    // mobile users often can't easily open dev tools to see console output.
    window.addEventListener("error", (e) => {
      this._logDebug(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this._logDebug(`unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
    });
  }

  _bindDebugPanel() {
    this._debugLines = [];
    this._debugEl = document.getElementById("debugPanel");
    window.__pinchDrawLogDebug = (line) => this._logDebug(line);
    let tapCount = 0;
    let tapTimer = null;
    document.querySelector(".brand").addEventListener("click", () => {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapCount = 0; }, 600);
      if (tapCount >= 3) {
        tapCount = 0;
        this._debugEl.hidden = !this._debugEl.hidden;
      }
    });
  }

  _logDebug(line) {
    if (!this._debugLines) this._debugLines = [];
    const ts = new Date().toISOString().slice(11, 19);
    this._debugLines.push(`[${ts}] ${line}`);
    if (this._debugLines.length > 12) this._debugLines.shift();
    if (this._debugEl) this._debugEl.textContent = this._debugLines.join("\n");
  }

  async start() {
    try {
      await this.tracker.init();
      await this.tracker.startCamera();
      this.tracker.start();
      document.getElementById("emptyState").style.display = "none";
    } catch (err) {
      this._handleStartError(err);
    }
  }

  _bindCameraControls() {
    document.getElementById("cameraToggleBtn").addEventListener("click", () => {
      if (this.tracker.running) {
        this.tracker.stop();
        this._setStatus("paused", "Camera paused");
        document.getElementById("emptyState").style.display = "flex";
        document.getElementById("emptyStateText").innerHTML = "Camera paused.<br>Click above to resume.";
      } else {
        this.start();
      }
    });
  }

  _handleStartError(err) {
    const name = err && err.name;
    const isPermissionError =
      name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      name === "SecurityError";
    const isNoCameraError = name === "NotFoundError" || name === "DevicesNotFoundError";
    const isInUseError = name === "NotReadableError" || name === "TrackStartError";

    let message;
    if (isPermissionError) {
      message = "Camera access is off.<br>Allow it in your browser's site settings, then click above to retry.";
    } else if (isNoCameraError) {
      message = "No camera found on this device.<br>Connect one and click above to retry.";
    } else if (isInUseError) {
      message = "Camera is in use by another app.<br>Close it and click above to retry.";
    } else {
      message = "Couldn't start the camera or hand-tracking model.<br>Click above to retry.";
    }

    document.getElementById("emptyState").style.display = "flex";
    document.getElementById("emptyStateText").innerHTML = message;
    this._onStatus("error");
  }

  _onStatus(state, message) {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");

    switch (state) {
      case "loading":
        dot.className = "dot";
        text.textContent = message || "Loading…";
        break;
      case "ready":
        dot.className = "dot live";
        text.textContent = "Camera live";
        break;
      case "tracking":
        dot.className = "dot tracking";
        text.textContent = "Hand detected";
        break;
      case "no-hand":
        dot.className = "dot live";
        text.textContent = "Show your hand";
        document.getElementById("emptyState").style.display = "none";
        break;
      case "error":
        dot.className = "dot";
        text.textContent = "Camera error";
        break;
      case "paused":
        dot.className = "dot";
        text.textContent = message;
        break;
    }
  }

  _setStatus(state, message) {
    this._onStatus(state, message);
  }

  _resizeOverlay() {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlayCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.overlayCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  /**
   * @param {{x:number,y:number,z:number}[]|null} landmarks raw, in MediaPipe's
   *   normalized [0,1] space where x=0 is the LEFT edge of the unmirrored frame.
   */
  _onLandmarks(landmarks) {
    this._tickFps();

    if (!landmarks) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      if (this.isPinching) this._releasePinch();
      this.smoothed = null;
      return;
    }

    const thumb = landmarks[THUMB_TIP];
    const index = landmarks[INDEX_TIP];

    // Pinch distance in normalized 2D space (z ignored — depth is noisy
    // and unnecessary since the threshold is tuned empirically on x/y).
    const dx = thumb.x - index.x;
    const dy = thumb.y - index.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    this.lastPinchDistance = distance;

    // Mirror the X coordinate to match the mirrored video feed, so the
    // drawing position matches what the user visually sees on screen.
    const rawX = this.ui.mirrorEnabled ? 1 - index.x : index.x;
    const rawY = index.y;

    if (!this.smoothed) {
      this.smoothed = { x: rawX, y: rawY };
    } else {
      const a = this.smoothingAlpha;
      this.smoothed.x = this.smoothed.x + a * (rawX - this.smoothed.x);
      this.smoothed.y = this.smoothed.y + a * (rawY - this.smoothed.y);
    }

    const threshold = this.ui.pinchThreshold;
    const pinchingNow = distance < threshold;

    if (pinchingNow && !this.isPinching) {
      this._startPinch();
    } else if (!pinchingNow && this.isPinching) {
      this._releasePinch();
    }

    if (this.isPinching) {
      this.engine.extendStroke(this.smoothed.x, this.smoothed.y);
    }

    this._drawOverlay(this.smoothed.x, this.smoothed.y, distance, threshold);
  }

  _startPinch() {
    this.isPinching = true;
    this._logDebug("pinch START");
    this.engine.beginStroke(this.smoothed.x, this.smoothed.y);
  }

  _releasePinch() {
    this.isPinching = false;
    this._logDebug("pinch END");
    this.engine.endStroke();
  }

  /**
   * The signature visual: a brass arc gauge centered on the fingertip that
   * fills in as thumb and index approach the pinch threshold, plus a solid
   * dot once drawing is active. Drawn each frame on the overlay canvas.
   */
  _drawOverlay(nx, ny, distance, threshold) {
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = nx * w;
    const cy = ny * h;
    const baseRadius = Math.min(w, h) * 0.025;

    // Proximity: 0 = far apart, 1 = at/inside the pinch threshold.
    // Widen the visible range a bit beyond threshold so the gauge has room
    // to animate before the pinch actually triggers.
    const farBound = threshold * 2.4;
    const proximity = Math.max(0, Math.min(1, 1 - (distance - threshold) / (farBound - threshold)));

    ctx.save();
    ctx.translate(cx, cy);

    // Background ring (always faintly visible while tracking)
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(250,247,242,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Progress arc — brass, fills clockwise from top as fingers approach.
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, -Math.PI / 2, -Math.PI / 2 + proximity * Math.PI * 2);
    ctx.strokeStyle = this.isPinching ? "#D9C39C" : "#B08D57";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();

    // Filled center dot once actively drawing.
    if (this.isPinching) {
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = this.engine.eraserMode ? "rgba(193,101,74,0.9)" : this.engine.color;
      ctx.fill();
    }

    ctx.restore();
  }

  _tickFps() {
    const now = performance.now();
    this._frameTimes.push(now);
    // Keep last ~1 second of timestamps
    while (this._frameTimes.length > 0 && now - this._frameTimes[0] > 1000) {
      this._frameTimes.shift();
    }
    if (!this._fpsTickCounter) this._fpsTickCounter = 0;
    this._fpsTickCounter++;
    if (this._fpsTickCounter % 10 === 0) {
      this._fpsEl.textContent = `${this._frameTimes.length} FPS`;
      if (this._debugEl && !this._debugEl.hidden) {
        const v = this.video;
        this._debugEl.textContent =
          `fps: ${this._frameTimes.length}\n` +
          `video: ${v.videoWidth}x${v.videoHeight} readyState=${v.readyState} paused=${v.paused} ended=${v.ended}\n` +
          `pinching: ${this.isPinching}\n` +
          `canvas: ${this.drawCanvas.width}x${this.drawCanvas.height}\n` +
          `--- log ---\n` + (this._debugLines || []).join("\n");
      }
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new App();
  app.start();
});
