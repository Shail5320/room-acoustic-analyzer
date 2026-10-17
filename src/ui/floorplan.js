/**
 * src/ui/floorplan.js — Canvas floor plan renderer and touch/pointer controller.
 *
 * Implements:
 *   - Aspect-ratio responsive canvas rendering with high-DPI scaling
 *   - Movable source marker (repositionable via drag or tap)
 *   - Numbered measurement markers (pending vs measured visual status)
 *   - Active octave band RT60 badges and validity color coding
 *   - Pointer Events interaction with touch-action: none on canvas
 *   - Taps outside room bounds ignored; dragging clamps smoothly to walls
 *   - Clean event dispatching and reactivity with SessionModel
 */

import { getRoomBounds, pixelToRelative, relativeToPixel } from './coordinates.js';
import { HeatmapRenderer, drawHeatmapMeasurementMarker } from './heatmap.js';

const MARKER_RADIUS_PX = 18;
const HIT_RADIUS_PX = 26;

export class FloorPlanView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./session-model.js').SessionModel} model
   * @param {object} [options]
   * @param {'measure'|'source'} [options.mode='measure']
   */
  constructor(canvas, model, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.mode = options.mode || 'measure'; // 'measure' | 'source' | 'heatmap'

    this.heatmapRenderer = new HeatmapRenderer();
    this.lastHeatmapStatus = null;

    this.dragTarget = null; // { type: 'source' } | { type: 'point', id: number }
    this.dragMoved = false;
    this.startPos = { x: 0, y: 0 };

    this._resizeObserver = null;
    this._unsubscribeModel = null;

    this._initCanvas();
    this._attachEvents();
  }

  _initCanvas() {
    // Canvas must have touch-action: none to enable fluid pointer dragging without page scrolling
    this.canvas.style.touchAction = 'none';

    this._resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this._resizeObserver.observe(this.canvas.parentElement || this.canvas);

    this._unsubscribeModel = this.model.subscribe(() => {
      this.render();
    });

    this.resize();
  }

  setMode(mode) {
    if (mode === 'measure' || mode === 'source' || mode === 'heatmap') {
      this.mode = mode;
      this.render();
    }
  }

  setHeatmapRangeMode(rangeMode) {
    this.heatmapRenderer.setRangeMode(rangeMode);
    this.render();
  }

  setPlacementHint(enabled) {
    this.heatmapRenderer.setPlacementHint(enabled);
    this.render();
  }

  getHeatmapStatus() {
    return this.lastHeatmapStatus;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(100, Math.floor(rect.width));
    const height = Math.max(100, Math.floor(rect.height || (width * 3) / 4));

    if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
    }

    this.render();
  }

  getRoomBounds() {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.width / dpr;
    const cssHeight = this.canvas.height / dpr;

    return getRoomBounds({
      canvasWidth: cssWidth,
      canvasHeight: cssHeight,
      aspectRatio: this.model.parsedAspectRatio,
      padding: 24,
    });
  }

  _getCanvasPointerPos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  _attachEvents() {
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerCancel);
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    if (this._unsubscribeModel) {
      this._unsubscribeModel();
    }
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerCancel);
  }

  _findHitTarget(px, py, roomBounds) {
    // 1. Check Source marker
    if (this.model.source) {
      const srcPx = relativeToPixel(this.model.source.x, this.model.source.y, roomBounds);
      if (srcPx && Math.hypot(px - srcPx.x, py - srcPx.y) <= HIT_RADIUS_PX) {
        return { type: 'source' };
      }
    }

    // 2. Check Measurement markers (search reverse order so top-drawn marker is picked first)
    for (let i = this.model.measurements.length - 1; i >= 0; i--) {
      const m = this.model.measurements[i];
      const mPx = relativeToPixel(m.x, m.y, roomBounds);
      if (mPx && Math.hypot(px - mPx.x, py - mPx.y) <= HIT_RADIUS_PX) {
        return { type: 'point', id: m.id };
      }
    }

    return null;
  }

  _onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const { x: px, y: py } = this._getCanvasPointerPos(e);
    const roomBounds = this.getRoomBounds();
    const hit = this._findHitTarget(px, py, roomBounds);

    this.startPos = { x: px, y: py };
    this.dragMoved = false;

    // In heatmap mode, tapping selects marker for details or clears selection
    if (this.mode === 'heatmap') {
      if (hit && hit.type === 'point') {
        this.model.selectPoint(hit.id);
      } else {
        this.model.selectPoint(null);
      }
      this.render();
      return;
    }

    if (hit) {
      this.dragTarget = hit;
      if (hit.type === 'point') {
        this.model.selectPoint(hit.id);
      }
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    } else {
      // Tap outside any marker: check if tap is inside the room
      const relPos = pixelToRelative(px, py, roomBounds, { clamp: false });
      if (relPos === null) {
        // Requirement 1: Taps outside room bounds are ignored
        this.dragTarget = null;
        return;
      }

      // Tap is inside room bounds
      if (this.mode === 'source') {
        this.model.setSource(relPos.x, relPos.y);
        this.dragTarget = { type: 'source' };
      } else {
        // Place new pending measurement
        const newPt = this.model.addPendingMeasurement(relPos.x, relPos.y);
        this.dragTarget = { type: 'point', id: newPt.id };
      }

      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    }

    this.render();
  }

  _onPointerMove(e) {
    if (!this.dragTarget) return;

    const { x: px, y: py } = this._getCanvasPointerPos(e);
    if (!this.dragMoved && Math.hypot(px - this.startPos.x, py - this.startPos.y) > 4) {
      this.dragMoved = true;
    }

    if (!this.dragMoved) return;

    const roomBounds = this.getRoomBounds();
    // Requirement 1: Clamp only while dragging
    const relPos = pixelToRelative(px, py, roomBounds, { clamp: true });
    if (!relPos) return;

    if (this.dragTarget.type === 'source') {
      this.model.setSource(relPos.x, relPos.y);
    } else if (this.dragTarget.type === 'point') {
      this.model.updateMeasurementPosition(this.dragTarget.id, relPos.x, relPos.y);
    }
  }

  _onPointerUp(e) {
    if (this.dragTarget) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      this.dragTarget = null;
      this.dragMoved = false;
      this.render();
    }
  }

  _onPointerCancel(e) {
    this._onPointerUp(e);
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const cssWidth = this.canvas.width / dpr;
    const cssHeight = this.canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const roomBounds = this.getRoomBounds();

    this._drawRoom(ctx, roomBounds, isDark);

    if (this.mode === 'heatmap') {
      this.lastHeatmapStatus = this.heatmapRenderer.render(ctx, roomBounds, this.model);
      this._drawHeatmapMeasurements(ctx, roomBounds, isDark);
    } else {
      this._drawGrid(ctx, roomBounds, isDark);
      this._drawMeasurements(ctx, roomBounds, isDark);
    }

    this._drawSource(ctx, roomBounds, isDark);

    ctx.restore();
  }

  _drawHeatmapMeasurements(ctx, bounds, isDark) {
    const activeBand = this.model.activeBand;
    for (const m of this.model.measurements) {
      const pt = relativeToPixel(m.x, m.y, bounds);
      if (!pt) continue;
      const isSelected = m.id === this.model.selectedPointId;
      drawHeatmapMeasurementMarker(ctx, pt, m, activeBand, isSelected, isDark);
    }
  }

  _drawRoom(ctx, bounds, isDark) {
    const { x, y, width, height } = bounds;
    if (width <= 0 || height <= 0) return;

    // Room interior fill
    ctx.fillStyle = isDark ? '#181a1f' : '#ffffff';
    ctx.fillRect(x, y, width, height);

    // Wall stroke
    ctx.lineWidth = 3;
    ctx.strokeStyle = isDark ? '#4b5563' : '#334155';
    ctx.strokeRect(x, y, width, height);

    // Room ratio label in top corner
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = isDark ? '#9ca3af' : '#64748b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Room [${this.model.aspectRatioString || this.model.aspectRatio}]`, x + 8, y + 8);
  }

  _drawGrid(ctx, bounds, isDark) {
    const { x, y, width, height } = bounds;
    ctx.save();
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    ctx.lineWidth = 1;

    // 4x4 subtle subdivision
    const cols = 4;
    const rows = 4;
    for (let c = 1; c < cols; c++) {
      const gx = x + (width * c) / cols;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + height);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const gy = y + (height * r) / rows;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + width, gy);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSource(ctx, bounds, isDark) {
    if (!this.model.source) return;

    const pt = relativeToPixel(this.model.source.x, this.model.source.y, bounds);
    if (!pt) return;

    ctx.save();
    // Halo / ripple ring
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS_PX + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(234, 88, 12, 0.2)';
    ctx.fill();

    // Source main badge
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = '#ea580c'; // Vibrant orange
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Sound wave glyph or 'S'
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', pt.x, pt.y);

    // Label under marker
    ctx.font = '600 10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = isDark ? '#fb923c' : '#c2410c';
    ctx.fillText('SOURCE', pt.x, pt.y + MARKER_RADIUS_PX + 12);

    ctx.restore();
  }

  _drawMeasurements(ctx, bounds, isDark) {
    const activeBand = this.model.activeBand;

    for (const m of this.model.measurements) {
      const pt = relativeToPixel(m.x, m.y, bounds);
      if (!pt) continue;

      const isSelected = m.id === this.model.selectedPointId;
      const isPending = m.status === 'pending';

      ctx.save();

      // Selected ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, MARKER_RADIUS_PX + 5, 0, Math.PI * 2);
        ctx.strokeStyle = isDark ? '#60a5fa' : '#2563eb';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Marker background
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, MARKER_RADIUS_PX, 0, Math.PI * 2);

      let markerColor = '#2563eb'; // Default blue
      let strokeColor = '#ffffff';

      if (isPending) {
        markerColor = isDark ? '#374151' : '#94a3b8';
      } else if (m.bands && m.bands[activeBand]) {
        const bandData = m.bands[activeBand];
        if (bandData.tier === 'valid') {
          markerColor = '#059669'; // Green
        } else if (bandData.tier === 'approximate') {
          markerColor = '#d97706'; // Amber
        } else {
          markerColor = '#dc2626'; // Red
        }
      }

      ctx.fillStyle = markerColor;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();

      // Measurement point index number
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 12px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.id), pt.x, pt.y);

      // Value badge underneath
      let tagText = isPending ? 'pending' : '';
      if (!isPending && m.bands && m.bands[activeBand]) {
        const b = m.bands[activeBand];
        tagText = Number.isFinite(b.rt60) ? `${b.rt60.toFixed(2)}s` : 'invalid';
      }

      if (tagText) {
        ctx.font = '600 10px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
        ctx.fillText(tagText, pt.x, pt.y + MARKER_RADIUS_PX + 12);
      }

      // Small dev badge if fake
      if (m.fake) {
        ctx.fillStyle = isDark ? '#f59e0b' : '#b45309';
        ctx.font = '700 8px system-ui, -apple-system, sans-serif';
        ctx.fillText('DEV', pt.x, pt.y - MARKER_RADIUS_PX - 6);
      }

      ctx.restore();
    }
  }
}
