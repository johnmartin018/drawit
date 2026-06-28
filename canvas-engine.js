// canvas-engine.js
// Owns the drawing surface: stroke building with smoothing, history stack
// for undo/redo, eraser compositing, and PNG export. No knowledge of
// MediaPipe or the UI — just takes normalized (0..1) points and settings.

class CanvasEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { desynchronized: true });

    this.color = "#2B2825";
    this.brushSize = 6;
    this.eraserMode = false;

    this.isDrawing = false;
    this.currentStroke = null; // {points:[{x,y}], color, size, erase}

    // History stores full ImageData snapshots — simple and robust for a
    // single-surface drawing app of this scope.
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    this._resizeRaf = null;
    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);

    this._syncSizeToDisplay(true);
  }

  // ---- sizing -------------------------------------------------------
  _onResize() {
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => this._syncSizeToDisplay(false));
  }

  _syncSizeToDisplay(isInit) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width === w && this.canvas.height === h) return;

    // Preserve existing artwork across resizes (e.g. orientation change).
    let snapshot = null;
    if (!isInit && this.canvas.width > 0 && this.canvas.height > 0) {
      snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }

    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.scale(1, 1); // reset; we draw in device-pixel space directly

    if (snapshot) {
      // Best-effort restore: draw old bitmap scaled into the new size via
      // an offscreen canvas, so content doesn't vanish on resize.
      const off = document.createElement("canvas");
      off.width = snapshot.width;
      off.height = snapshot.height;
      off.getContext("2d").putImageData(snapshot, 0, 0);
      this.ctx.drawImage(off, 0, 0, snapshot.width, snapshot.height, 0, 0, w, h);
    }
  }

  // ---- coordinate helpers --------------------------------------------
  /** Convert normalized [0,1] coords to device-pixel canvas coords. */
  toCanvasXY(nx, ny) {
    return { x: nx * this.canvas.width, y: ny * this.canvas.height };
  }

  // ---- stroke lifecycle ----------------------------------------------
  beginStroke(nx, ny) {
    this._pushHistory(); // snapshot BEFORE the stroke for undo
    this.isDrawing = true;
    const { x, y } = this.toCanvasXY(nx, ny);
    this.currentStroke = {
      points: [{ x, y }],
      color: this.color,
      size: this.brushSize,
      erase: this.eraserMode
    };
  }

  extendStroke(nx, ny) {
    if (!this.isDrawing || !this.currentStroke) return;
    const { x, y } = this.toCanvasXY(nx, ny);
    const pts = this.currentStroke.points;
    const last = pts[pts.length - 1];

    // Skip negligible moves to avoid micro-segments that hurt performance.
    const dx = x - last.x, dy = y - last.y;
    if (dx * dx + dy * dy < 0.4) return;

    pts.push({ x, y });
    this._drawSegment(last, { x, y }, this.currentStroke);
  }

  endStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.currentStroke = null;
    this.redoStack.length = 0; // new action invalidates redo timeline
    this._updateHistoryButtons();
  }

  _drawSegment(p0, p1, stroke) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Brush size is authored in CSS-pixel terms; scale to the canvas's
    // actual device-pixel resolution so strokes look consistent at any DPR.
    ctx.lineWidth = stroke.size * (this.canvas.width / this.canvas.clientWidth);

    if (stroke.erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color;
    }

    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.restore();
  }

  // ---- history ---------------------------------------------------------
  _pushHistory() {
    if (this.canvas.width === 0 || this.canvas.height === 0) return;
    const snap = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this._updateHistoryButtons();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    const current = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.redoStack.push(current);
    const prev = this.undoStack.pop();
    this.ctx.putImageData(prev, 0, 0);
    this._updateHistoryButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const current = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.undoStack.push(current);
    const next = this.redoStack.pop();
    this.ctx.putImageData(next, 0, 0);
    this._updateHistoryButtons();
  }

  clear() {
    this._pushHistory();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.redoStack.length = 0;
    this._updateHistoryButtons();
  }

  _updateHistoryButtons() {
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    if (undoBtn) undoBtn.disabled = this.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
  }

  // ---- export ------------------------------------------------------------
  /**
   * Exports the drawing onto a transparent-safe PNG. If a backgroundColor
   * is provided, flattens onto it (useful since the live canvas is
   * transparent over the video feed).
   */
  exportPNG(filename = "pinchdraw.png", backgroundColor = "#FAF7F2") {
    const off = document.createElement("canvas");
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const octx = off.getContext("2d");
    if (backgroundColor) {
      octx.fillStyle = backgroundColor;
      octx.fillRect(0, 0, off.width, off.height);
    }
    octx.drawImage(this.canvas, 0, 0);
    off.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, "image/png");
  }
}

window.CanvasEngine = CanvasEngine;
