/**
 * src/ui/dimensions.js — Pure room dimensions calculation, validation, and conversion.
 *
 * Implements:
 *   - Metres vs Step count input handling (default 0.7 m/step, editable)
 *   - Strict physical bounds validation:
 *       Horizontal (Length, Width): 1.0 m to 50.0 m
 *       Vertical (Height): 2.0 m to 10.0 m
 *   - Room aspect ratio derivation (Length / Width)
 *   - Relative [0, 1] to metric (x_m, y_m) transformation
 *   - Zero DOM / Browser dependencies — fully testable in node:test
 */

export const DEFAULT_STEP_LENGTH = 0.7; // metres per step
export const MIN_HORIZONTAL_M = 1.0;
export const MAX_HORIZONTAL_M = 50.0;
export const MIN_HEIGHT_M = 2.0;
export const MAX_HEIGHT_M = 10.0;

/**
 * Validate and compute converted room dimensions.
 *
 * @param {object} params
 * @param {number|string} params.length
 * @param {number|string} params.width
 * @param {number|string} params.height
 * @param {'metres'|'steps'} [params.unit='metres']
 * @param {number|string} [params.stepLength=0.7]
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   dimensions: {
 *     unit: 'metres'|'steps',
 *     rawLength: number,
 *     rawWidth: number,
 *     rawHeight: number,
 *     stepLength: number,
 *     lengthM: number,
 *     widthM: number,
 *     heightM: number,
 *     isApproximate: boolean
 *   } | null
 * }}
 */
export function parseAndValidateDimensions({
  length,
  width,
  height,
  unit = 'metres',
  stepLength = DEFAULT_STEP_LENGTH,
}) {
  const errors = [];
  const rawL = typeof length === 'string' ? parseFloat(length) : Number(length);
  const rawW = typeof width === 'string' ? parseFloat(width) : Number(width);
  const rawH = typeof height === 'string' ? parseFloat(height) : Number(height);
  const stepL = typeof stepLength === 'string' ? parseFloat(stepLength) : Number(stepLength);

  if (!Number.isFinite(rawL) || rawL <= 0) errors.push('Length must be a positive number');
  if (!Number.isFinite(rawW) || rawW <= 0) errors.push('Width must be a positive number');
  if (!Number.isFinite(rawH) || rawH <= 0) errors.push('Height must be a positive number');

  const isSteps = unit === 'steps';
  if (isSteps && (!Number.isFinite(stepL) || stepL <= 0.1 || stepL > 2.0)) {
    errors.push('Metres per step must be between 0.1 and 2.0 metres');
  }

  if (errors.length > 0) {
    return { valid: false, errors, dimensions: null };
  }

  const lengthM = isSteps ? rawL * stepL : rawL;
  const widthM = isSteps ? rawW * stepL : rawW;
  const heightM = isSteps ? rawH * stepL : rawH;

  if (lengthM < MIN_HORIZONTAL_M || lengthM > MAX_HORIZONTAL_M) {
    errors.push(`Length (${lengthM.toFixed(2)} m) must be between ${MIN_HORIZONTAL_M} m and ${MAX_HORIZONTAL_M} m`);
  }
  if (widthM < MIN_HORIZONTAL_M || widthM > MAX_HORIZONTAL_M) {
    errors.push(`Width (${widthM.toFixed(2)} m) must be between ${MIN_HORIZONTAL_M} m and ${MAX_HORIZONTAL_M} m`);
  }
  if (heightM < MIN_HEIGHT_M || heightM > MAX_HEIGHT_M) {
    errors.push(`Height (${heightM.toFixed(2)} m) must be between ${MIN_HEIGHT_M} m and ${MAX_HEIGHT_M} m`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, dimensions: null };
  }

  return {
    valid: true,
    errors: [],
    dimensions: {
      unit: isSteps ? 'steps' : 'metres',
      rawLength: rawL,
      rawWidth: rawW,
      rawHeight: rawH,
      stepLength: isSteps ? stepL : DEFAULT_STEP_LENGTH,
      lengthM: Math.round(lengthM * 1000) / 1000,
      widthM: Math.round(widthM * 1000) / 1000,
      heightM: Math.round(heightM * 1000) / 1000,
      isApproximate: isSteps,
    },
  };
}

/**
 * Derive aspect ratio string and decimal ratio from length and width.
 * Length maps to horizontal dimension (X), Width maps to vertical dimension (Y).
 *
 * @param {number} lengthM
 * @param {number} widthM
 * @returns {{ ratio: number, ratioStr: string } | null}
 */
export function deriveAspectRatio(lengthM, widthM) {
  if (!Number.isFinite(lengthM) || !Number.isFinite(widthM) || lengthM <= 0 || widthM <= 0) {
    return null;
  }
  const ratio = lengthM / widthM;
  // Format as e.g. "1.50:1" or two decimal places
  const ratioStr = `${parseFloat(ratio.toFixed(2))}:1`;
  return { ratio, ratioStr };
}

/**
 * Convert relative room position [0, 1] to metric coordinates (metres).
 *
 * @param {number} xRel — relative horizontal coordinate in [0, 1]
 * @param {number} yRel — relative vertical coordinate in [0, 1]
 * @param {object|null} roomDimensions
 * @returns {{ xM: number, yM: number, isApproximate: boolean } | null}
 */
export function relativeToMetric(xRel, yRel, roomDimensions) {
  if (!roomDimensions || !Number.isFinite(roomDimensions.lengthM) || !Number.isFinite(roomDimensions.widthM)) {
    return null;
  }
  const clampedX = Math.max(0, Math.min(1, xRel));
  const clampedY = Math.max(0, Math.min(1, yRel));

  return {
    xM: Math.round(clampedX * roomDimensions.lengthM * 1000) / 1000,
    yM: Math.round(clampedY * roomDimensions.widthM * 1000) / 1000,
    isApproximate: Boolean(roomDimensions.isApproximate),
  };
}
