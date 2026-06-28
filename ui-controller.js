// ui-controller.js
// Wires the control rail's DOM elements to a CanvasEngine instance and
// exposes a small settings object the hand-tracking loop reads from
// (mirrorEnabled, pinch threshold) without the UI needing to know about
// MediaPipe.

class UIController {
  /**
   * @param {CanvasEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.mirrorEnabled = true;
    this.pinchThreshold = 0.055; // normalized distance; tuned via slider 1–3 mapped below

    this._bindSwatches();
    this._bindSliders();
    this._bindToggles();
    this._bindActions();
    this._bindMobileSheet();
  }

  _bindSwatches() {
    const swatches = document.querySelectorAll(".swatch[data-color]");
    swatches.forEach((btn) => {
      btn.addEventListener("click", () => {
        swatches.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.engine.color = btn.dataset.color;
        // Picking a real color implicitly exits eraser mode.
        this._setEraser(false);
      });
    });

    const customInput = document.getElementById("customColorInput");
    const customSwatch = document.getElementById("customSwatch");
    customInput.addEventListener("input", () => {
      const hex = customInput.value;
      customSwatch.style.setProperty("--c", hex);
      swatches.forEach((b) => b.classList.remove("active"));
      customSwatch.classList.add("active");
      this.engine.color = hex;
      this._setEraser(false);
    });
  }

  _bindSliders() {
    const sizeSlider = document.getElementById("brushSize");
    const sizeOut = document.getElementById("brushSizeOut");
    sizeSlider.addEventListener("input", () => {
      this.engine.brushSize = Number(sizeSlider.value);
      sizeOut.textContent = sizeSlider.value;
    });

    const pinchSlider = document.getElementById("pinchThresh");
    const pinchOut = document.getElementById("pinchThreshOut");
    const labelFor = (v) => (v < 1.4 ? "Tight" : v < 2.3 ? "Medium" : "Loose");
    pinchSlider.addEventListener("input", () => {
      const v = Number(pinchSlider.value);
      // Map UI slider (1–3) to a normalized-distance threshold (0.03–0.09).
      this.pinchThreshold = 0.03 + ((v - 1) / 2) * 0.06;
      pinchOut.textContent = labelFor(v);
    });
  }

  _bindToggles() {
    this.eraserBtn = document.getElementById("eraserBtn");
    this.eraserBtn.addEventListener("click", () => {
      this._setEraser(!this.engine.eraserMode);
    });

    const mirrorBtn = document.getElementById("mirrorBtn");
    mirrorBtn.addEventListener("click", () => {
      this.mirrorEnabled = !this.mirrorEnabled;
      mirrorBtn.dataset.active = String(this.mirrorEnabled);
      const video = document.getElementById("webcam");
      video.style.transform = this.mirrorEnabled ? "scaleX(-1)" : "scaleX(1)";
    });
  }

  _setEraser(on) {
    this.engine.eraserMode = on;
    this.eraserBtn.dataset.active = String(on);
  }

  _bindActions() {
    document.getElementById("undoBtn").addEventListener("click", () => this.engine.undo());
    document.getElementById("redoBtn").addEventListener("click", () => this.engine.redo());

    document.getElementById("clearBtn").addEventListener("click", () => {
      this.engine.clear();
      showToast("Canvas cleared");
    });

    document.getElementById("saveBtn").addEventListener("click", () => {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      this.engine.exportPNG(`pinchdraw-${ts}.png`);
      showToast("Saved as PNG");
    });

    // Keyboard shortcuts for desktop convenience.
    window.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        this.engine.undo();
      } else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.engine.redo();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        document.getElementById("saveBtn").click();
      }
    });
  }

  _bindMobileSheet() {
    const rail = document.getElementById("controlRail");
    const handle = document.getElementById("railHandle");
    const settingsBtn = document.getElementById("settingsBtn");

    const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

    const toggleSheet = () => {
      rail.classList.toggle("collapsed");
      const expanded = !rail.classList.contains("collapsed");
      settingsBtn.setAttribute("aria-expanded", String(expanded));
    };

    if (isMobile()) rail.classList.add("collapsed");

    handle.addEventListener("click", toggleSheet);
    settingsBtn.addEventListener("click", toggleSheet);

    window.addEventListener("resize", () => {
      if (!isMobile()) rail.classList.remove("collapsed");
    });
  }
}

function showToast(message, duration = 1800) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), duration);
}

window.UIController = UIController;
window.showToast = showToast;
