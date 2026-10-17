/**
 * src/dsp/sabine.js — Acoustic absorption and room treatment calculations.
 *
 * Implements:
 *   1. Dimensionless absorption ratio (primary result, requires zero dimensions):
 *        ratio = RT60_measured / RT60_target
 *        ratio > 1.0  => more absorption needed
 *        ratio <= 1.0 => target already met
 *   2. Sabine formula (optional, gated behind room volume V):
 *        A = 0.161 · V / RT60
 *        Delta_A = A_target - A_now
 *        S_panel = Delta_A / (alpha_material - alpha_existing)
 *   3. Eyring formula (cross-check when dimensions L, W, H are provided):
 *        RT60 = 0.161 · V / (-S · ln(1 - alpha_avg))
 *        alpha_avg = 1 - exp(-0.161 · V / (S · RT60))
 *   4. Room geometry calculation (metres or step counts with ~0.7 m/step).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SABINE_CONSTANT = 0.161;   // Metric Sabine constant (c / 4 in SI: 343 / 4 ≈ 85.75, 4*ln(10^6)/c ≈ 0.1611)
export const DEFAULT_EXISTING_ALPHA = 0.05; // Painted concrete / drywall default
export const DEFAULT_STEP_METRES = 0.7; // Average walking step length in metres

// ---------------------------------------------------------------------------
// 1. Dimensionless Absorption Ratio
// ---------------------------------------------------------------------------

/**
 * Compute the dimensionless absorption ratio:
 *   ratio = RT60_measured / RT60_target
 *
 * A ratio of 3 means the room has 3x too much reverberation and requires
 * 3x the current total absorption to reach the target decay time.
 *
 * @param {number} rt60Measured — measured RT60 in seconds
 * @param {number} rt60Target   — target RT60 in seconds
 * @returns {{
 *   ratio: number,
 *   targetMet: boolean,
 *   excessFactor: number
 * }}
 */
export function absorptionRatio(rt60Measured, rt60Target) {
  if (
    typeof rt60Measured !== 'number' ||
    typeof rt60Target !== 'number' ||
    Number.isNaN(rt60Measured) ||
    Number.isNaN(rt60Target) ||
    rt60Target <= 0 ||
    rt60Measured <= 0
  ) {
    return {
      ratio: NaN,
      targetMet: false,
      excessFactor: NaN,
    };
  }

  const ratio = rt60Measured / rt60Target;
  const targetMet = ratio <= 1.0;
  const excessFactor = Math.max(0.0, ratio - 1.0);

  return {
    ratio,
    targetMet,
    excessFactor,
  };
}

/**
 * Compute dimensionless absorption ratios for all octave bands.
 *
 * @param {Record<string|number, number>|Map<number, number>} measuredByBand
 * @param {Record<string|number, number>|Map<number, number>} targetByBand
 * @returns {Record<string, { ratio: number, targetMet: boolean, measured: number, target: number }>}
 */
export function perBandAbsorptionRatios(measuredByBand, targetByBand) {
  const result = {};
  const getVal = (obj, k) => (obj instanceof Map ? obj.get(Number(k)) : obj[k]);

  const keys = measuredByBand instanceof Map
    ? Array.from(measuredByBand.keys()).map(String)
    : Object.keys(measuredByBand);

  for (const k of keys) {
    const m = getVal(measuredByBand, k);
    const t = getVal(targetByBand, k);
    const { ratio, targetMet } = absorptionRatio(m, t);
    result[k] = {
      measured: m,
      target: t,
      ratio,
      targetMet,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// 2. Room Geometry (Volume & Surface Area)
// ---------------------------------------------------------------------------

/**
 * Calculate volume and surface area of a rectangular cuboid room.
 *
 * @param {number} length — length in metres
 * @param {number} width  — width in metres
 * @param {number} height — height in metres
 * @returns {{
 *   volume: number,
 *   surfaceArea: number,
 *   length: number,
 *   width: number,
 *   height: number
 * }}
 */
export function roomGeometry(length, width, height) {
  if (length <= 0 || width <= 0 || height <= 0) {
    throw new Error('Room dimensions must be positive numbers');
  }
  const volume = length * width * height;
  const surfaceArea = 2.0 * (length * width + length * height + width * height);
  return {
    volume,
    surfaceArea,
    length,
    width,
    height,
  };
}

/**
 * Calculate room geometry from step counts.
 *
 * @param {number} lengthSteps
 * @param {number} widthSteps
 * @param {number} heightSteps
 * @param {number} stepMetres   — default 0.7 m/step
 * @returns {{
 *   volume: number,
 *   surfaceArea: number,
 *   length: number,
 *   width: number,
 *   height: number,
 *   isStepEstimate: boolean
 * }}
 */
export function roomGeometryFromSteps(lengthSteps, widthSteps, heightSteps, stepMetres = DEFAULT_STEP_METRES) {
  const geom = roomGeometry(lengthSteps * stepMetres, widthSteps * stepMetres, heightSteps * stepMetres);
  return {
    ...geom,
    isStepEstimate: true,
  };
}

// ---------------------------------------------------------------------------
// 3. Sabine Formula (A = 0.161 · V / RT60)
// ---------------------------------------------------------------------------

/**
 * Calculate Sabine total absorption (in m² or metric Sabins):
 *   A = 0.161 · V / RT60
 *
 * @param {number} volume — room volume in m³
 * @param {number} rt60   — reverberation time in seconds
 * @param {number} c      — Sabine constant (default 0.161)
 * @returns {number}      — total absorption A in metric Sabins (m²)
 */
export function sabineAbsorption(volume, rt60, c = SABINE_CONSTANT) {
  if (volume <= 0 || rt60 <= 0 || Number.isNaN(volume) || Number.isNaN(rt60)) {
    return NaN;
  }
  return (c * volume) / rt60;
}

/**
 * Compute required treatment panel area via Sabine formula:
 *   A_now    = 0.161 · V / RT60_measured
 *   A_target = 0.161 · V / RT60_target
 *   Delta_A  = A_target - A_now
 *   S_panel  = Delta_A / (alpha_material - alpha_existing)
 *
 * @param {number} volume         — room volume in m³
 * @param {number} rt60Measured   — measured RT60 (s)
 * @param {number} rt60Target     — target RT60 (s)
 * @param {number} materialAlpha  — sound absorption coefficient of treatment material [0, 1]
 * @param {number} existingAlpha  — sound absorption coefficient of surface being covered (default 0.05)
 * @param {number} c              — Sabine constant (default 0.161)
 * @returns {{
 *   ratio: number,
 *   aNow: number,
 *   aTarget: number,
 *   deltaA: number,
 *   sPanel: number,
 *   targetMet: boolean
 * }}
 */
export function sabineTreatment(
  volume,
  rt60Measured,
  rt60Target,
  materialAlpha,
  existingAlpha = DEFAULT_EXISTING_ALPHA,
  c = SABINE_CONSTANT,
) {
  const { ratio, targetMet } = absorptionRatio(rt60Measured, rt60Target);
  const aNow = sabineAbsorption(volume, rt60Measured, c);
  const aTarget = sabineAbsorption(volume, rt60Target, c);

  if (Number.isNaN(aNow) || Number.isNaN(aTarget)) {
    return {
      ratio,
      aNow: NaN,
      aTarget: NaN,
      deltaA: NaN,
      sPanel: NaN,
      targetMet,
    };
  }

  const deltaA = aTarget - aNow;
  const netAlpha = materialAlpha - existingAlpha;

  let sPanel = 0.0;
  if (!targetMet && deltaA > 0) {
    if (netAlpha <= 0) {
      sPanel = Infinity; // Material provides no net absorption over existing surface
    } else {
      sPanel = deltaA / netAlpha;
    }
  }

  return {
    ratio,
    aNow,
    aTarget,
    deltaA,
    sPanel,
    targetMet,
  };
}

// ---------------------------------------------------------------------------
// 4. Eyring Formula (Cross-check when room dimensions are provided)
// ---------------------------------------------------------------------------

/**
 * Calculate average absorption coefficient and total absorption under Eyring:
 *   alpha_avg = 1 - exp(-0.161 · V / (S · RT60))
 *   A_eyring  = S · alpha_avg
 *
 * @param {number} surfaceArea — total boundary surface area in m²
 * @param {number} volume      — room volume in m³
 * @param {number} rt60        — reverberation time in seconds
 * @param {number} c           — constant (default 0.161)
 * @returns {{
 *   alphaAvg: number,
 *   aEyring: number
 * }}
 */
export function eyringAbsorption(surfaceArea, volume, rt60, c = SABINE_CONSTANT) {
  if (surfaceArea <= 0 || volume <= 0 || rt60 <= 0 || Number.isNaN(surfaceArea) || Number.isNaN(volume) || Number.isNaN(rt60)) {
    return { alphaAvg: NaN, aEyring: NaN };
  }
  const exponent = (c * volume) / (surfaceArea * rt60);
  const alphaAvg = 1.0 - Math.exp(-exponent);
  const aEyring = surfaceArea * alphaAvg;
  return { alphaAvg, aEyring };
}

/**
 * Compute treatment panel area under Eyring formula:
 *
 * @param {number} surfaceArea
 * @param {number} volume
 * @param {number} rt60Measured
 * @param {number} rt60Target
 * @param {number} materialAlpha
 * @param {number} existingAlpha
 * @param {number} c
 * @returns {{
 *   alphaAvgNow: number,
 *   alphaAvgTarget: number,
 *   aNow: number,
 *   aTarget: number,
 *   deltaA: number,
 *   sPanel: number
 * }}
 */
export function eyringTreatment(
  surfaceArea,
  volume,
  rt60Measured,
  rt60Target,
  materialAlpha,
  existingAlpha = DEFAULT_EXISTING_ALPHA,
  c = SABINE_CONSTANT,
) {
  const now = eyringAbsorption(surfaceArea, volume, rt60Measured, c);
  const target = eyringAbsorption(surfaceArea, volume, rt60Target, c);

  if (Number.isNaN(now.aEyring) || Number.isNaN(target.aEyring)) {
    return {
      alphaAvgNow: NaN,
      alphaAvgTarget: NaN,
      aNow: NaN,
      aTarget: NaN,
      deltaA: NaN,
      sPanel: NaN,
    };
  }

  const deltaA = target.aEyring - now.aEyring;
  const netAlpha = materialAlpha - existingAlpha;

  let sPanel = 0.0;
  if (deltaA > 0) {
    sPanel = netAlpha > 0 ? deltaA / netAlpha : Infinity;
  }

  return {
    alphaAvgNow: now.alphaAvg,
    alphaAvgTarget: target.alphaAvg,
    aNow: now.aEyring,
    aTarget: target.aEyring,
    deltaA,
    sPanel,
  };
}

// ---------------------------------------------------------------------------
// 5. Unified Calculator (Primary Dimensionless + Optional Sabine/Eyring)
// ---------------------------------------------------------------------------

/**
 * High-level treatment calculation supporting dimension-optional design.
 *
 * @param {Object} options
 * @param {number} options.rt60Measured   — measured RT60 in seconds
 * @param {number} options.rt60Target     — target RT60 in seconds
 * @param {Object} [options.dimensions]   — optional room dimensions { length, width, height }
 * @param {number} [options.volume]       — optional direct volume in m³
 * @param {number} [options.materialAlpha]— absorption coefficient of proposed material
 * @param {number} [options.existingAlpha]— absorption coefficient of existing surface (default 0.05)
 * @returns {{
 *   ratio: number,
 *   targetMet: boolean,
 *   sabine?: { aNow: number, aTarget: number, deltaA: number, sPanel: number },
 *   eyring?: { aNow: number, aTarget: number, deltaA: number, sPanel: number, alphaAvgNow: number, alphaAvgTarget: number },
 *   geometry?: { volume: number, surfaceArea: number, length?: number, width?: number, height?: number },
 *   isDeadRoom?: boolean
 * }}
 */
export function calculateTreatment({
  rt60Measured,
  rt60Target,
  dimensions = null,
  volume = null,
  materialAlpha = null,
  existingAlpha = DEFAULT_EXISTING_ALPHA,
}) {
  // Primary result: always computed, requires NO dimensions
  const primary = absorptionRatio(rt60Measured, rt60Target);

  let calcVolume = volume;
  let calcSurfaceArea = null;
  let geom = null;

  if (dimensions != null) {
    const { length, width, height } = dimensions;
    if (length > 0 && width > 0 && height > 0) {
      geom = roomGeometry(length, width, height);
      calcVolume = geom.volume;
      calcSurfaceArea = geom.surfaceArea;
    }
  }

  const result = {
    ratio: primary.ratio,
    targetMet: primary.targetMet,
    excessFactor: primary.excessFactor,
  };

  // Optional: Sabine treatment calculation when volume is known
  if (calcVolume != null && calcVolume > 0) {
    result.geometry = geom || { volume: calcVolume };
    if (materialAlpha != null) {
      const sResult = sabineTreatment(
        calcVolume,
        rt60Measured,
        rt60Target,
        materialAlpha,
        existingAlpha,
      );
      result.sabine = {
        aNow: sResult.aNow,
        aTarget: sResult.aTarget,
        deltaA: sResult.deltaA,
        sPanel: sResult.sPanel,
      };

      // Optional: Eyring cross-check when surface area is known
      if (calcSurfaceArea != null && calcSurfaceArea > 0) {
        const eResult = eyringTreatment(
          calcSurfaceArea,
          calcVolume,
          rt60Measured,
          rt60Target,
          materialAlpha,
          existingAlpha,
        );
        result.eyring = eResult;
        // Flag when room is relatively dead (average alpha > 0.2), where Eyring is recommended
        result.isDeadRoom = eResult.alphaAvgTarget > 0.2;
      }
    }
  }

  return result;
}
