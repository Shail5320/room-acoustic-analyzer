/**
 * src/analysis/uncertainty.js — RT60 uncertainty interpolation from empirical Monte Carlo data.
 *
 * Interpolates typical 2-sigma measurement scatter by octave band based on the
 * band's measured RT60 using empirical byTarget data.
 * Clamps outside the supported study range [0.3s, 1.5s] and reports clamping status.
 */

export const RT60_TARGET_STEPS = [0.3, 0.6, 0.8, 1.2, 1.5];

export const DEFAULT_BY_TARGET = {
  0.3: { 125: 17.84, 250: 13.39, 500: 8.87, 1000: 5.96, 2000: 5.26, 4000: 2.79 },
  0.6: { 125: 9.52, 250: 9.76, 500: 6.30, 1000: 3.97, 2000: 3.07, 4000: 2.95 },
  0.8: { 125: 9.03, 250: 7.12, 500: 5.94, 1000: 3.19, 2000: 2.88, 4000: 2.81 },
  1.2: { 125: 7.86, 250: 5.62, 500: 4.11, 1000: 2.77, 2000: 1.84, 4000: 1.64 },
  1.5: { 125: 8.14, 250: 4.80, 500: 4.06, 1000: 2.64, 2000: 1.88, 4000: 1.20 },
};

/**
 * Extract 2-sigma percentage for a target key and band.
 * Handles both { twoSigmaPct: X } object format and direct numeric values.
 */
function getTwoSigma(byTarget, targetKey, bandKey) {
  const tObj = byTarget[targetKey] || byTarget[String(targetKey)];
  if (!tObj) return null;
  const bVal = tObj[bandKey] || tObj[String(bandKey)];
  if (bVal == null) return null;
  if (typeof bVal === 'number') return bVal;
  if (typeof bVal === 'object' && typeof bVal.twoSigmaPct === 'number') return bVal.twoSigmaPct;
  return null;
}

/**
 * Interpolate typical 2-sigma scatter percentage for a measured RT60 in a given octave band.
 *
 * @param {number} rt60 - Measured RT60 in seconds.
 * @param {number|string} bandHz - Octave band centre frequency (125, 250, 500, 1000, 2000, 4000).
 * @param {object} [data] - Optional uncertainty JSON or byTarget map.
 * @returns {{
 *   twoSigmaPct: number,
 *   clamped: 'low' | 'high' | null,
 *   clampedTarget: number | null,
 *   displayText: string
 * }}
 */
export function interpolateUncertainty(rt60, bandHz, data) {
  const bandKey = String(bandHz);
  const byTarget = (data && data.byTarget) ? data.byTarget : (data || DEFAULT_BY_TARGET);

  if (!Number.isFinite(rt60)) {
    return {
      twoSigmaPct: 10,
      clamped: null,
      clampedTarget: null,
      displayText: 'typical scatter ±10%',
    };
  }

  const minTarget = RT60_TARGET_STEPS[0]; // 0.3
  const maxTarget = RT60_TARGET_STEPS[RT60_TARGET_STEPS.length - 1]; // 1.5

  let clamped = null;
  let clampedTarget = null;
  let effectiveRt60 = rt60;

  if (rt60 < minTarget) {
    clamped = 'low';
    clampedTarget = minTarget;
    effectiveRt60 = minTarget;
  } else if (rt60 > maxTarget) {
    clamped = 'high';
    clampedTarget = maxTarget;
    effectiveRt60 = maxTarget;
  }

  let twoSigmaPct = 10;

  if (effectiveRt60 <= minTarget) {
    twoSigmaPct = getTwoSigma(byTarget, '0.3', bandKey) ?? 10;
  } else if (effectiveRt60 >= maxTarget) {
    twoSigmaPct = getTwoSigma(byTarget, '1.5', bandKey) ?? 2;
  } else {
    // Find enclosing segment [T_i, T_{i+1}]
    for (let i = 0; i < RT60_TARGET_STEPS.length - 1; i++) {
      const tLow = RT60_TARGET_STEPS[i];
      const tHigh = RT60_TARGET_STEPS[i + 1];
      if (effectiveRt60 >= tLow && effectiveRt60 <= tHigh) {
        const uLow = getTwoSigma(byTarget, tLow, bandKey);
        const uHigh = getTwoSigma(byTarget, tHigh, bandKey);
        if (uLow != null && uHigh != null) {
          const alpha = (effectiveRt60 - tLow) / (tHigh - tLow);
          twoSigmaPct = (1.0 - alpha) * uLow + alpha * uHigh;
        }
        break;
      }
    }
  }

  const rounded = Math.round(twoSigmaPct * 10) / 10;
  let displayText = `typical scatter ±${rounded}%`;
  if (clamped === 'low') {
    displayText = `typical scatter ±${rounded}%, clamped at 0.3s`;
  } else if (clamped === 'high') {
    displayText = `typical scatter ±${rounded}%, clamped at 1.5s`;
  }

  return {
    twoSigmaPct: rounded,
    clamped,
    clampedTarget,
    displayText,
  };
}
