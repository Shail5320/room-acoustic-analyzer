/**
 * src/ui/heatmap.js — Canvas renderer and interactive UI controller for the RT60 Heatmap.
 *
 * Implements:
 *   - Coarse grid IDW evaluation scaled up to canvas with smooth interpolation
 *   - Cache / memoization: recomputes grid only when data, band, aspect ratio, or scale range changes
 *   - Distinct marker styles: solid circle for 'valid', dashed outline with '≈' badge for 'approximate'
 *   - Interactive marker tapping to inspect value, tier, and used metric
 *   - Colour scale bar legend with tick marks, values, and seconds unit (s)
 *   - Range toggle: Auto range (padded min-max) vs Fixed range (0 to 2 s)
 *   - Band selector integration with live tier counts per band
 *   - Honest messaging:
 *       - Fewer than 4 usable points displays reliability warning and dims/hides heatmap
 *       - Always shows "Interpolated between measurement points; not a measurement."
 *       - Shows "DEV DATA" banner if any simulated test points are present
 */

import {
  MIN_USABLE_HEATMAP_POINTS,
  HEATMAP_UNRELIABLE_MESSAGE,
  HEATMAP_CAPTION,
  DEV_DATA_BANNER,
  interpolateViridis,
  valueToColor,
  getUsablePoints,
  getBandTierCounts,
  formatBandTierCounts,
  computeHeatmapRange,
  computeHeatmapGrid,
  extractPointBandValue,
} from './heatmap-math.js';
import { relativeToPixel } from './coordinates.js';

export const COARSE_GRID_COLS = 48;

/**
 * HeatmapRenderer handles offscreen coarse grid generation and canvas rendering.
 */
export class HeatmapRenderer {
  constructor() {
    this.rangeMode = 'auto'; // 'auto' | 'fixed'
    this._offscreenCanvas = null;
    this._offscreenCtx = null;
    this._cacheKey = null;
    this._cachedGrid = null;
    this._cachedRange = null;
  }

  setRangeMode(mode) {
    if (mode === 'auto' || mode === 'fixed') {
      if (this.rangeMode !== mode) {
        this.rangeMode = mode;
        this.invalidateCache();
      }
    }
  }

  invalidateCache() {
    this._cacheKey = null;
    this._cachedGrid = null;
    this._cachedRange = null;
  }

  /**
   * Build a cache key from relevant session inputs.
   */
  _buildCacheKey(model, band, aspectRatio) {
    const measurements = model.measurements || [];
    // Hash key from band, count, aspect ratio, range mode, and measurement values
    const ptsHash = measurements
      .map((m) => {
        const b = m.bands && m.bands[band];
        return `${m.id}:${m.status}:${m.x.toFixed(3)},${m.y.toFixed(3)}:${b ? b.tier + (b.rt60 || '') : 'none'}`;
      })
      .join('|');

    return `${band}@${aspectRatio.toFixed(3)}@${this.rangeMode}@${ptsHash}`;
  }

  /**
   * Render the coarse grid to an offscreen canvas.
   */
  _updateOffscreenCanvas(usablePoints, aspectRatio, cols, rows, range) {
    if (!this._offscreenCanvas) {
      if (typeof document !== 'undefined' && document.createElement) {
        this._offscreenCanvas = document.createElement('canvas');
      }
    }

    if (!this._offscreenCanvas) return;

    if (this._offscreenCanvas.width !== cols || this._offscreenCanvas.height !== rows) {
      this._offscreenCanvas.width = cols;
      this._offscreenCanvas.height = rows;
      this._offscreenCtx = this._offscreenCanvas.getContext('2d');
    }

    const ctx = this._offscreenCtx;
    if (!ctx) return;

    const imgData = ctx.createImageData(cols, rows);
    const data = imgData.data;

    const grid = computeHeatmapGrid(usablePoints, {
      cols,
      rows,
      aspectRatio,
      power: 2,
    });
    this._cachedGrid = grid;

    const values = grid.values;
    const { min, max } = range;

    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      const color = valueToColor(val, min, max);
      const pixelIdx = i * 4;
      data[pixelIdx + 0] = color.r;
      data[pixelIdx + 1] = color.g;
      data[pixelIdx + 2] = color.b;
      data[pixelIdx + 3] = 230; // Slightly translucent (90% opacity) to let subtle floor accents show
    }

    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Render the interpolated heatmap onto the target canvas context.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ x: number, y: number, width: number, height: number }} roomBounds
   * @param {object} model SessionModel
   * @param {object} [options]
   * @returns {{ isReliable: boolean, usablePoints: Array<object>, range: object, hasFake: boolean }}
   */
  render(ctx, roomBounds, model, options = {}) {
    const { x, y, width, height } = roomBounds;
    if (width <= 0 || height <= 0) {
      return { isReliable: false, usablePoints: [], range: { min: 0, max: 2 }, hasFake: false };
    }

    const band = model.activeBand || 500;
    const aspectRatio = model.parsedAspectRatio || 4 / 3;
    const usablePoints = getUsablePoints(model.measurements, band);
    const range = computeHeatmapRange(usablePoints, this.rangeMode);
    const isReliable = usablePoints.length >= MIN_USABLE_HEATMAP_POINTS;
    const hasFake = usablePoints.some((p) => p.fake === true);

    const cols = COARSE_GRID_COLS;
    const rows = Math.max(4, Math.round(cols / aspectRatio));

    // Check memoization cache
    const currentKey = this._buildCacheKey(model, band, aspectRatio);
    if (currentKey !== this._cacheKey || !this._offscreenCanvas) {
      this._updateOffscreenCanvas(usablePoints, aspectRatio, cols, rows, range);
      this._cacheKey = currentKey;
      this._cachedRange = range;
    }

    ctx.save();

    // Clip to room interior bounds
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    if (usablePoints.length === 0) {
      // No usable points: keep interior clean
      ctx.restore();
      return { isReliable, usablePoints, range, hasFake };
    }

    if (!isReliable) {
      // Fewer than 4 usable points: heavily dim the heatmap layer (or hide)
      ctx.globalAlpha = 0.18;
    } else {
      ctx.globalAlpha = 0.92;
    }

    // Scale up coarse offscreen canvas to full room bounds with smoothing enabled
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (this._offscreenCanvas) {
      ctx.drawImage(this._offscreenCanvas, x, y, width, height);
    }

    // If unreliable, draw honest messaging overlay inside room
    if (!isReliable) {
      ctx.restore();
      ctx.save();
      this._drawUnreliableOverlay(ctx, roomBounds, usablePoints.length);
      ctx.restore();
      return { isReliable, usablePoints, range, hasFake };
    }

    ctx.restore();
    return { isReliable, usablePoints, range, hasFake };
  }

  /**
   * Draw on-canvas honest warning when fewer than 4 usable points exist.
   */
  _drawUnreliableOverlay(ctx, roomBounds, count) {
    const { x, y, width, height } = roomBounds;
    ctx.save();

    // Semi-transparent dark shroud
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.fillRect(x, y, width, height);

    // Warning banner box in center
    const boxW = Math.min(width - 24, 380);
    const boxH = 90;
    const boxX = x + (width - boxW) / 2;
    const boxY = y + (height - boxH) / 2;

    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(boxX, boxY, boxW, boxH, 8) : ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font = '700 13px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('⚠️ Low Data Reliability', boxX + boxW / 2, boxY + 12);

    // Message
    ctx.font = '500 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`${count} of 4 usable points available for this band.`, boxX + boxW / 2, boxY + 32);
    ctx.fillText('At least 9 points recommended for room coverage.', boxX + boxW / 2, boxY + 48);

    ctx.font = 'italic 10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Map heavily dimmed to prevent false spatial confidence.', boxX + boxW / 2, boxY + 68);

    ctx.restore();
  }
}

/**
 * Draw a measurement marker on the heatmap overlay.
 * Approximated points are drawn with a distinct style (amber dashed double-outline with '≈' glyph).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number }} pt Pixel coordinates
 * @param {object} m Measurement object
 * @param {number|string} activeBand
 * @param {boolean} isSelected
 * @param {boolean} isDark
 */
export function drawHeatmapMeasurementMarker(ctx, pt, m, activeBand, isSelected, isDark) {
  const MARKER_RADIUS = 18;
  const isPending = m.status === 'pending';
  const bandInfo = extractPointBandValue(m, activeBand);

  ctx.save();

  // Selection halo
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS + 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (isPending) {
    // Pending marker
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? '#334155' : '#cbd5e1';
    ctx.fill();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.id), pt.x, pt.y);
  } else if (bandInfo.tier === 'approximate') {
    // DISTINCT MARKER STYLE FOR APPROXIMATE POINTS:
    // Outer dashed amber ring + solid amber inner fill + approximate badge
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS + 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#f59e0b'; // Amber
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#d97706';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Number
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.id), pt.x, pt.y - 1);

    // Approximate glyph '≈' tiny badge on top right
    ctx.beginPath();
    ctx.arc(pt.x + 12, pt.y - 12, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.fillText('≈', pt.x + 12, pt.y - 12);
  } else if (bandInfo.tier === 'valid') {
    // Valid marker: Solid emerald circle
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#059669'; // Emerald
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.id), pt.x, pt.y);
  } else {
    // Invalid band marker: Dimmed crimson circle with diagonal dash
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? '#450a0a' : '#fee2e2';
    ctx.fill();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = isDark ? '#f87171' : '#b91c1c';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(m.id), pt.x, pt.y);
  }

  // Value badge underneath marker
  let badgeText = '';
  if (isPending) {
    badgeText = 'pending';
  } else if (bandInfo.usable) {
    badgeText = `${bandInfo.value.toFixed(2)}s`;
  } else {
    badgeText = 'invalid';
  }

  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillStyle = isDark ? '#f1f5f9' : '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(badgeText, pt.x, pt.y + MARKER_RADIUS + 5);

  // DEV DATA indicator
  if (m.fake) {
    ctx.fillStyle = '#f59e0b';
    ctx.font = '700 8px system-ui, sans-serif';
    ctx.fillText('DEV', pt.x, pt.y - MARKER_RADIUS - 6);
  }

  ctx.restore();
}

/**
 * Render the Heatmap Legend Color Bar and scale ticks into a target canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ min: number, max: number, isFixed: boolean }} range
 * @param {boolean} isDark
 */
export function renderHeatmapLegendCanvas(canvas, range, isDark = false) {
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(160, Math.floor(rect.width || 280));
  const height = 48;

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const barX = 12;
  const barY = 8;
  const barW = width - 24;
  const barH = 14;

  // Gradient bar
  const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const col = interpolateViridis(t);
    gradient.addColorStop(t, col.hex);
  }

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(barX, barY, barW, barH, 4) : ctx.rect(barX, barY, barW, barH);
  ctx.fill();
  ctx.strokeStyle = isDark ? '#475569' : '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw 5 tick marks and numerical labels with units (s)
  const ticks = 5;
  ctx.font = '600 10px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = isDark ? '#cbd5e1' : '#334155';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < ticks; i++) {
    const frac = i / (ticks - 1);
    const tx = barX + frac * barW;
    const tickVal = range.min + frac * (range.max - range.min);

    // Tick line
    ctx.beginPath();
    ctx.moveTo(tx, barY + barH);
    ctx.lineTo(tx, barY + barH + 4);
    ctx.strokeStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Value label with seconds unit
    const label = `${tickVal.toFixed(2)}s`;
    let align = 'center';
    if (i === 0) align = 'left';
    if (i === ticks - 1) align = 'right';
    ctx.textAlign = align;
    ctx.fillText(label, tx, barY + barH + 6);
  }

  ctx.restore();
}
