/**
 * src/ui/coordinates.js — Pure coordinate transforms and aspect ratio math for floor plan.
 *
 * Implements:
 *   - Aspect-ratio letterboxing/pillarboxing inside canvas bounding box
 *   - Bidirectional transforms: pixelToRelative <-> relativeToPixel
 *   - Taps outside room bounds return null (when clamp is false)
 *   - Dragging clamping to [0, 1] (when clamp is true)
 *   - Pure ES module: zero DOM dependencies, fully testable in node:test
 */

export const DEFAULT_ASPECT_RATIO_STR = '4:3';
export const DEFAULT_ASPECT_RATIO = 4 / 3;

export const ASPECT_RATIO_PRESETS = [
  { label: '4:3 (Standard)', value: '4:3', ratio: 4 / 3 },
  { label: '16:9 (Wide)', value: '16:9', ratio: 16 / 9 },
  { label: '1:1 (Square)', value: '1:1', ratio: 1 / 1 },
  { label: '3:2 (Classic)', value: '3:2', ratio: 3 / 2 },
  { label: '2:1 (Long)', value: '2:1', ratio: 2 / 1 },
];

/**
 * Parse an aspect ratio representation into a positive floating point number (width / height).
 * Accepts numbers, strings like "4:3", "16:9", "1.333", etc.
 *
 * @param {string|number} value
 * @returns {number}
 */
export function parseAspectRatio(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.includes(':') || trimmed.includes('/')) {
      const parts = trimmed.split(/[:/]/);
      const w = parseFloat(parts[0]);
      const h = parseFloat(parts[1]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return w / h;
      }
    }
    const num = parseFloat(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return DEFAULT_ASPECT_RATIO;
}

/**
 * Compute the centered rectangular room bounding box fitted within a canvas viewport.
 *
 * @param {object} options
 * @param {number} options.canvasWidth   — pixel width of canvas
 * @param {number} options.canvasHeight  — pixel height of canvas
 * @param {number|string} [options.aspectRatio=4/3] — width / height ratio
 * @param {number} [options.padding=20]  — padding around room boundary in pixels
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function getRoomBounds({ canvasWidth, canvasHeight, aspectRatio = DEFAULT_ASPECT_RATIO, padding = 20 }) {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const ratio = parseAspectRatio(aspectRatio);
  const effPadX = Math.min(padding, canvasWidth * 0.25);
  const effPadY = Math.min(padding, canvasHeight * 0.25);

  const availW = Math.max(0, canvasWidth - 2 * effPadX);
  const availH = Math.max(0, canvasHeight - 2 * effPadY);

  if (availW === 0 || availH === 0) {
    return { x: effPadX, y: effPadY, width: availW, height: availH };
  }

  let width;
  let height;
  let x;
  let y;

  if (availW / availH > ratio) {
    // Viewport is wider than room aspect ratio -> height-constrained
    height = availH;
    width = height * ratio;
    x = effPadX + (availW - width) / 2;
    y = effPadY;
  } else {
    // Viewport is taller than room aspect ratio -> width-constrained
    width = availW;
    height = width / ratio;
    x = effPadX;
    y = effPadY + (availH - height) / 2;
  }

  return { x, y, width, height };
}

/**
 * Convert pixel canvas coordinates (px, py) to relative room coordinates (rx, ry) in [0, 1].
 *
 * @param {number} px — canvas X coordinate
 * @param {number} py — canvas Y coordinate
 * @param {{ x: number, y: number, width: number, height: number }} roomBounds
 * @param {object} [options]
 * @param {boolean} [options.clamp=false] — If false, returns null when outside room bounds (for tap).
 *                                         If true, clamps to [0, 1] (for dragging).
 * @returns {{ x: number, y: number }|null}
 */
export function pixelToRelative(px, py, roomBounds, { clamp = false } = {}) {
  if (!roomBounds || roomBounds.width <= 0 || roomBounds.height <= 0) {
    return null;
  }

  const isOutside =
    px < roomBounds.x ||
    px > roomBounds.x + roomBounds.width ||
    py < roomBounds.y ||
    py > roomBounds.y + roomBounds.height;

  if (!clamp && isOutside) {
    return null;
  }

  let targetX = px;
  let targetY = py;

  if (clamp) {
    targetX = Math.max(roomBounds.x, Math.min(roomBounds.x + roomBounds.width, px));
    targetY = Math.max(roomBounds.y, Math.min(roomBounds.y + roomBounds.height, py));
  }

  const rx = (targetX - roomBounds.x) / roomBounds.width;
  const ry = (targetY - roomBounds.y) / roomBounds.height;

  return {
    x: Math.max(0, Math.min(1, rx)),
    y: Math.max(0, Math.min(1, ry)),
  };
}

/**
 * Convert relative room coordinates (rx, ry) in [0, 1] to canvas pixel coordinates (px, py).
 *
 * @param {number} rx — relative X coordinate in [0, 1]
 * @param {number} ry — relative Y coordinate in [0, 1]
 * @param {{ x: number, y: number, width: number, height: number }} roomBounds
 * @returns {{ x: number, y: number }|null}
 */
export function relativeToPixel(rx, ry, roomBounds) {
  if (!roomBounds || roomBounds.width <= 0 || roomBounds.height <= 0) {
    return null;
  }

  const px = roomBounds.x + rx * roomBounds.width;
  const py = roomBounds.y + ry * roomBounds.height;

  return { x: px, y: py };
}
