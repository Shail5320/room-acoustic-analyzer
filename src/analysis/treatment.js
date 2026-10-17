/**
 * src/analysis/treatment.js — Pure acoustic treatment calculation and aggregation logic.
 *
 * Rules:
 *   - Vanilla JS ES module
 *   - Zero external runtime or DOM dependencies (fully testable in node:test)
 *   - Consumes sabine.js exports without modifying src/dsp/
 *   - Pure logic strictly separate from DOM
 *
 * Implements:
 *   1. Session band aggregation (real data only default; toggle for simulated/dev)
 *   2. Primary dimensionless ratio result (no dimensions needed)
 *   3. Optional physical treatment panel sizing (Sabine & Eyring)
 *   4. Mathematical guards (alpha_mat <= alpha_exist, area exceeded, deltaA <= 0)
 *   5. Monotonic corner range propagation (steps uncertainty ~30% volume, measured spread)
 *   6. Top-quartile heatmap placement hint evaluation (>= 6 points and spread > 10% mean)
 *   7. Speech/music headline vs. 125 Hz room-mode caveat separation
 */

import {
  SABINE_CONSTANT,
  DEFAULT_EXISTING_ALPHA,
  DEFAULT_STEP_METRES,
  roomGeometry,
  sabineAbsorption,
  sabineTreatment,
  eyringAbsorption,
  eyringTreatment,
} from '../dsp/sabine.js';

export const OCTAVE_BANDS = [125, 250, 500, 1000, 2000, 4000];
export const SPEECH_MUSIC_BANDS = [250, 500, 1000, 2000, 4000];

export const STEP_VOLUME_UNCERTAINTY = 0.30; // ~30% volume uncertainty for paced step counts
export const STEP_DIMENSION_UNCERTAINTY = 0.10; // ~10% per dimension

export const MIN_HOTSPOT_POINTS = 6;
export const HOTSPOT_SPREAD_RATIO = 0.10; // spread > 10% of mean

export const HOTSPOT_UNIFORM_MESSAGE = 'reverberation is fairly uniform, no hotspot';
export const HOTSPOT_CAPTION =
  'These areas have the longest reverberation. Consider treating nearby walls or ceiling. This is a heuristic, not a calculated placement.';

export const LOW_FREQ_CAVEAT =
  'Small rooms below ~250 Hz are dominated by room modes (standing waves) where diffuse-field assumptions do not hold. Phone speakers also have high distortion and limited output at 125 Hz. This estimate is indicative only; low-frequency control requires dedicated bass traps, not porous panels.';

export const LIMITATIONS_TEXT = {
  diffuseField:
    "Sabine and Eyring equations assume a diffuse sound field with uniformly distributed energy and random phase reflections. In small furnished rooms, local acoustic reflections and geometry cause spatial variations.",
  roomModes:
    "Below approximately 250 Hz (the Schroeder frequency of typical domestic rooms), acoustics are dominated by discrete room modes (standing waves) rather than statistical reverberation. Results at 125 Hz are indicative only.",
  absorptionVsInsulation:
    "Absorption panels reduce internal room reverberation and flutter echo; they DO NOT soundproof a room or prevent sound transmission to adjacent rooms. Sound isolation requires mass, decoupling, and airtight sealing.",
  placeholderCoefficients:
    "Material absorption coefficients in presets are placeholders. Always verify laboratory test coefficients (ISO 354 / ASTM C423) with the manufacturer before fabrication or purchasing."
};

/**
 * Filter and extract usable RT60 from a point for a specific band.
 * Only 'valid' and 'approximate' tiers count.
 *
 * @param {object} point
 * @param {number|string} band
 * @returns {{ usable: boolean, value: number, tier: string, metric: string } | null}
 */
export function extractUsablePointBand(point, band) {
  if (!point || point.status !== 'measured' || !point.bands) return null;
  const b = point.bands[band] || point.bands[Number(band)] || point.bands[String(band)];
  if (!b) return null;

  const tier = b.tier;
  if (tier !== 'valid' && tier !== 'approximate') return null;

  const metric = (b.used || 'T20').toUpperCase();
  let value = NaN;
  if (metric === 'T30' && Number.isFinite(b.t30) && b.t30 > 0) {
    value = b.t30;
  } else if (metric === 'T20' && Number.isFinite(b.t20) && b.t20 > 0) {
    value = b.t20;
  } else if (Number.isFinite(b.rt60) && b.rt60 > 0) {
    value = b.rt60;
  }

  if (!Number.isFinite(value) || value <= 0) return null;

  return {
    usable: true,
    value,
    tier,
    metric,
  };
}

/**
 * Aggregate measured session data per band.
 * Real data only by default; toggle allows including simulated/dev points.
 *
 * @param {Array<object>} measurements
 * @param {object} [options]
 * @param {boolean} [options.includeSimulated=false]
 * @returns {{
 *   bands: Record<number, {
 *     hasData: boolean,
 *     count: number,
 *     validCount: number,
 *     approximateCount: number,
 *     hasApproximate: boolean,
 *     mean: number,
 *     min: number,
 *     max: number,
 *     spread: number,
 *     values: number[],
 *     reason?: string
 *   }>,
 *   dataStatus: {
 *     realCount: number,
 *     simulatedCount: number,
 *     includedCount: number,
 *     hasSimulated: boolean,
 *     statusLine: string
 *   }
 * }}
 */
export function aggregateSessionBands(measurements = [], options = {}) {
  const includeSimulated = Boolean(options.includeSimulated);
  const mList = Array.isArray(measurements) ? measurements : [];

  let realCount = 0;
  let simulatedCount = 0;

  // Filter candidate points
  const candidatePoints = [];
  for (const m of mList) {
    if (m.status !== 'measured') continue;
    const isSim = Boolean(m.fake || m.simulated || m.source === 'dev');
    if (isSim) {
      simulatedCount++;
    } else {
      realCount++;
    }

    if (!isSim || includeSimulated) {
      candidatePoints.push({ point: m, isSim });
    }
  }

  const bands = {};
  let totalValidAcrossBands = 0;
  let totalApproxAcrossBands = 0;

  for (const band of OCTAVE_BANDS) {
    const usableVals = [];
    let validCount = 0;
    let approxCount = 0;

    for (const { point } of candidatePoints) {
      const res = extractUsablePointBand(point, band);
      if (res && res.usable) {
        usableVals.push(res.value);
        if (res.tier === 'valid') validCount++;
        else if (res.tier === 'approximate') approxCount++;
      }
    }

    totalValidAcrossBands += validCount;
    totalApproxAcrossBands += approxCount;

    if (usableVals.length === 0) {
      bands[band] = {
        hasData: false,
        count: 0,
        validCount: 0,
        approximateCount: 0,
        hasApproximate: false,
        mean: NaN,
        min: NaN,
        max: NaN,
        spread: NaN,
        values: [],
        reason: 'insufficient data',
      };
    } else {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of usableVals) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = sum / usableVals.length;
      const spread = max - min;

      bands[band] = {
        hasData: true,
        count: usableVals.length,
        validCount,
        approximateCount: approxCount,
        hasApproximate: approxCount > 0,
        mean: Math.round(mean * 1000) / 1000,
        min: Math.round(min * 1000) / 1000,
        max: Math.round(max * 1000) / 1000,
        spread: Math.round(spread * 1000) / 1000,
        values: usableVals,
      };
    }
  }

  // Build honest data status line
  const activeCount = includeSimulated ? realCount + simulatedCount : realCount;
  const statusLine = `${realCount} real points: ${totalValidAcrossBands} valid, ${totalApproxAcrossBands} approximate`;

  return {
    bands,
    dataStatus: {
      realCount,
      simulatedCount,
      includedCount: activeCount,
      hasSimulated: simulatedCount > 0,
      includeSimulated,
      statusLine,
    },
  };
}

/**
 * Format primary dimensionless absorption ratio interpretation.
 * User requirement:
 *   “total absorption must be about X times what it is now (add about X-1 times the current amount)”
 *   When ratio <= 1.0: "target met (no extra absorption needed)"
 *
 * @param {number} measuredMean
 * @param {number} targetRt60
 * @param {boolean} [hasApproximate=false]
 * @returns {{
 *   ratio: number,
 *   targetMet: boolean,
 *   excessFactor: number,
 *   plainLanguage: string,
 *   hasApproximate: boolean,
 *   approximateLabel: string|null
 * }}
 */
export function formatPrimaryRatio(measuredMean, targetRt60, hasApproximate = false) {
  if (
    !Number.isFinite(measuredMean) ||
    !Number.isFinite(targetRt60) ||
    measuredMean <= 0 ||
    targetRt60 <= 0
  ) {
    return {
      ratio: NaN,
      targetMet: false,
      excessFactor: NaN,
      plainLanguage: 'insufficient data',
      hasApproximate,
      approximateLabel: null,
    };
  }

  const ratio = measuredMean / targetRt60;
  const targetMet = ratio <= 1.0;
  const excessFactor = Math.max(0, ratio - 1.0);

  const xStr = ratio.toFixed(1);
  const xMinus1Str = excessFactor.toFixed(1);

  let plainLanguage = '';
  if (targetMet) {
    plainLanguage = 'target met (no extra absorption needed)';
  } else {
    plainLanguage = `total absorption must be about ${xStr} times what it is now (add about ${xMinus1Str} times the current amount)`;
  }

  return {
    ratio: Math.round(ratio * 100) / 100,
    targetMet,
    excessFactor: Math.round(excessFactor * 100) / 100,
    plainLanguage,
    hasApproximate,
    approximateLabel: hasApproximate ? 'approximate-tier input' : null,
  };
}

/**
 * Compute Sabine & Eyring treatment area for a single band, with guards and monotonic corner propagation.
 *
 * @param {object} params
 * @param {number} params.band                — octave frequency (Hz)
 * @param {number} params.meanRt60            — average measured RT60 (s)
 * @param {number} params.minRt60             — minimum measured RT60 (s)
 * @param {number} params.maxRt60             — maximum measured RT60 (s)
 * @param {number} params.targetRt60          — target RT60 (s)
 * @param {number} params.materialAlpha       — absorption coefficient of treatment material
 * @param {number} [params.existingAlpha=0.05]— absorption coefficient of covered boundary
 * @param {object|null} [params.geometry=null]— room geometry { volume, surfaceArea, wallCeilingArea, length, width, height }
 * @param {boolean} [params.isSteps=false]    — true if room dimensions originated from step counts (~30% volume uncertainty)
 * @param {boolean} [params.hasApproximate=false]
 * @returns {object}
 */
export function calculateBandTreatment({
  band,
  meanRt60,
  minRt60,
  maxRt60,
  targetRt60,
  materialAlpha,
  existingAlpha = DEFAULT_EXISTING_ALPHA,
  geometry = null,
  isSteps = false,
  hasApproximate = false,
}) {
  const primary = formatPrimaryRatio(meanRt60, targetRt60, hasApproximate);

  const result = {
    band,
    meanRt60,
    minRt60,
    maxRt60,
    targetRt60,
    materialAlpha,
    existingAlpha,
    primary,
    hasDimensions: false,
    guards: {
      targetMet: primary.targetMet,
      materialIneffective: false,
      areaExceeded: false,
      message: null,
    },
    sabine: null,
    eyring: null,
    range: null,
  };

  // If insufficient data or no dimensions, return primary ratio
  if (!Number.isFinite(meanRt60) || !geometry || !Number.isFinite(geometry.volume) || geometry.volume <= 0) {
    return result;
  }

  result.hasDimensions = true;

  const V_nom = geometry.volume;
  const S_total = geometry.surfaceArea || 2.0 * (geometry.length * geometry.width + geometry.length * geometry.height + geometry.width * geometry.height);
  const S_wallCeiling = geometry.wallCeilingArea || (2.0 * (geometry.length * geometry.height + geometry.width * geometry.height) + (geometry.length * geometry.width));

  // Guard 1: Measured RT60 at or below target (deltaA <= 0)
  if (primary.targetMet || meanRt60 <= targetRt60) {
    result.guards.targetMet = true;
    result.guards.message = 'Target met (no extra absorption needed)';
    result.sabine = {
      aNow: sabineAbsorption(V_nom, meanRt60),
      aTarget: sabineAbsorption(V_nom, targetRt60),
      deltaA: 0.0,
      sPanel: 0.0,
    };
    result.eyring = {
      alphaAvgNow: eyringAbsorption(S_total, V_nom, meanRt60).alphaAvg,
      alphaAvgTarget: eyringAbsorption(S_total, V_nom, targetRt60).alphaAvg,
      aNow: eyringAbsorption(S_total, V_nom, meanRt60).aEyring,
      aTarget: eyringAbsorption(S_total, V_nom, targetRt60).aEyring,
      deltaA: 0.0,
      sPanel: 0.0,
      isDeadRoom: eyringAbsorption(S_total, V_nom, targetRt60).alphaAvg > 0.3,
    };
    result.range = {
      sPanelNominal: 0.0,
      sPanelMin: 0.0,
      sPanelMax: 0.0,
    };
    return result;
  }

  // Guard 2: Material alpha <= existing surface alpha
  const netAlpha = materialAlpha - existingAlpha;
  if (netAlpha <= 0) {
    result.guards.materialIneffective = true;
    result.guards.message = `Material absorption (α = ${materialAlpha.toFixed(2)}) is less than or equal to existing surface (α = ${existingAlpha.toFixed(2)}). No amount of this panel can help.`;
    result.sabine = {
      aNow: sabineAbsorption(V_nom, meanRt60),
      aTarget: sabineAbsorption(V_nom, targetRt60),
      deltaA: sabineAbsorption(V_nom, targetRt60) - sabineAbsorption(V_nom, meanRt60),
      sPanel: Infinity,
    };
    return result;
  }

  // Nominal Sabine calculation
  const aNow = sabineAbsorption(V_nom, meanRt60);
  const aTarget = sabineAbsorption(V_nom, targetRt60);
  const deltaA = aTarget - aNow;
  const sPanelNom = deltaA / netAlpha;

  // Eyring calculation
  const eyringNow = eyringAbsorption(S_total, V_nom, meanRt60);
  const eyringTarget = eyringAbsorption(S_total, V_nom, targetRt60);
  const deltaAEyring = eyringTarget.aEyring - eyringNow.aEyring;
  const sPanelEyring = deltaAEyring > 0 ? deltaAEyring / netAlpha : 0.0;
  const isDeadRoom = eyringTarget.alphaAvg > 0.3;

  result.sabine = {
    aNow: Math.round(aNow * 100) / 100,
    aTarget: Math.round(aTarget * 100) / 100,
    deltaA: Math.round(deltaA * 100) / 100,
    sPanel: Math.round(sPanelNom * 100) / 100,
  };

  result.eyring = {
    alphaAvgNow: Math.round(eyringNow.alphaAvg * 1000) / 1000,
    alphaAvgTarget: Math.round(eyringTarget.alphaAvg * 1000) / 1000,
    aNow: Math.round(eyringNow.aEyring * 100) / 100,
    aTarget: Math.round(eyringTarget.aEyring * 100) / 100,
    deltaA: Math.round(deltaAEyring * 100) / 100,
    sPanel: Math.round(sPanelEyring * 100) / 100,
    isDeadRoom,
  };

  // Guard 3: Required panel area exceeds available wall and ceiling area
  if (sPanelNom > S_wallCeiling) {
    result.guards.areaExceeded = true;
    result.guards.message = `Target is not reachable with this material (requires ${sPanelNom.toFixed(1)} m², exceeding available wall and ceiling area of ${S_wallCeiling.toFixed(1)} m²).`;
  }

  // Monotonic corners range propagation
  // Step dimensions propagate about 30% volume uncertainty (+/- 30%)
  const volFactor = isSteps ? STEP_VOLUME_UNCERTAINTY : 0.0;
  const V_min = V_nom * (1.0 - volFactor);
  const V_max = V_nom * (1.0 + volFactor);

  const effMinRt = Number.isFinite(minRt60) && minRt60 > 0 ? minRt60 : meanRt60;
  const effMaxRt = Number.isFinite(maxRt60) && maxRt60 > 0 ? maxRt60 : meanRt60;

  // Corner 1: Minimum volume and minimum measured RT60 give minimum area
  const aNowMin = sabineAbsorption(V_min, effMinRt);
  const aTargetMin = sabineAbsorption(V_min, targetRt60);
  const deltaAMin = aTargetMin - aNowMin;
  const sPanelMin = deltaAMin > 0 ? Math.max(0, deltaAMin / netAlpha) : 0.0;

  // Corner 2: Maximum volume and maximum measured RT60 give maximum area
  const aNowMax = sabineAbsorption(V_max, effMaxRt);
  const aTargetMax = sabineAbsorption(V_max, targetRt60);
  const deltaAMax = aTargetMax - aNowMax;
  const sPanelMax = deltaAMax > 0 ? Math.max(0, deltaAMax / netAlpha) : 0.0;

  result.range = {
    sPanelNominal: Math.round(sPanelNom * 100) / 100,
    sPanelMin: Math.round(sPanelMin * 100) / 100,
    sPanelMax: Math.round(sPanelMax * 100) / 100,
    volumeMin: Math.round(V_min * 10) / 10,
    volumeNominal: Math.round(V_nom * 10) / 10,
    volumeMax: Math.round(V_max * 10) / 10,
    isSteps,
  };

  return result;
}

/**
 * Headline summary across speech & music bands (250 Hz - 4000 Hz).
 * 125 Hz is excluded from the headline and reported separately with the low-frequency caveat.
 *
 * @param {Record<number, object>} bandTreatments
 * @returns {{
 *   hasData: boolean,
 *   headlineAreaNominal: number,
 *   headlineAreaMin: number,
 *   headlineAreaMax: number,
 *   activeBandCount: number,
 *   bandAreas: Record<number, number>,
 *   lowFreqCaveat: string
 * }}
 */
export function computeTreatmentHeadline(bandTreatments = {}) {
  const speechAreas = [];
  const speechMinAreas = [];
  const speechMaxAreas = [];
  const bandAreas = {};

  for (const band of SPEECH_MUSIC_BANDS) {
    const t = bandTreatments[band];
    if (t && t.sabine && Number.isFinite(t.sabine.sPanel)) {
      speechAreas.push(t.sabine.sPanel);
      bandAreas[band] = t.sabine.sPanel;
      if (t.range) {
        speechMinAreas.push(t.range.sPanelMin);
        speechMaxAreas.push(t.range.sPanelMax);
      }
    }
  }

  if (speechAreas.length === 0) {
    return {
      hasData: false,
      headlineAreaNominal: NaN,
      headlineAreaMin: NaN,
      headlineAreaMax: NaN,
      activeBandCount: 0,
      bandAreas,
      lowFreqCaveat: LOW_FREQ_CAVEAT,
    };
  }

  // Average or max panel requirement across speech/music bands
  const sumNom = speechAreas.reduce((a, b) => a + b, 0);
  const sumMin = speechMinAreas.length > 0 ? speechMinAreas.reduce((a, b) => a + b, 0) : sumNom;
  const sumMax = speechMaxAreas.length > 0 ? speechMaxAreas.reduce((a, b) => a + b, 0) : sumNom;

  const meanNom = sumNom / speechAreas.length;
  const meanMin = sumMin / speechAreas.length;
  const meanMax = sumMax / speechAreas.length;

  return {
    hasData: true,
    headlineAreaNominal: Math.round(meanNom * 10) / 10,
    headlineAreaMin: Math.round(meanMin * 10) / 10,
    headlineAreaMax: Math.round(meanMax * 10) / 10,
    activeBandCount: speechAreas.length,
    bandAreas,
    lowFreqCaveat: LOW_FREQ_CAVEAT,
  };
}

/**
 * Compute the 75th percentile (Q3 / top quartile) of a dataset.
 *
 * @param {Array<number>|Float64Array} values
 * @returns {number}
 */
export function computePercentile(values, percentile = 0.75) {
  if (!values || values.length === 0) return NaN;
  const validVals = Array.from(values).filter((v) => Number.isFinite(v));
  if (validVals.length === 0) return NaN;
  validVals.sort((a, b) => a - b);

  const n = validVals.length;
  if (n === 1) return validVals[0];

  const p = Math.max(0, Math.min(1, percentile));
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;

  return validVals[lo] * (1.0 - frac) + validVals[hi] * frac;
}

/**
 * Evaluate whether a placement hotspot exists on the heatmap.
 * Rule:
 *   - At least 6 usable points required (usablePoints.length >= 6).
 *   - (max - min) must exceed 10% of mean ((max - min) > 0.10 * mean).
 *   - Otherwise: "reverberation is fairly uniform, no hotspot".
 *
 * @param {Array<{ value: number }>} usablePoints
 * @param {Float64Array|Array<number>} [gridValues]
 * @returns {{
 *   hasHotspot: boolean,
 *   q3Threshold: number|null,
 *   mean: number,
 *   spread: number,
 *   pointCount: number,
 *   caption: string,
 *   message: string
 * }}
 */
export function evaluateHotspot(usablePoints = [], gridValues = null) {
  const points = Array.isArray(usablePoints) ? usablePoints : [];
  const count = points.length;

  if (count < MIN_HOTSPOT_POINTS) {
    return {
      hasHotspot: false,
      q3Threshold: null,
      mean: NaN,
      spread: NaN,
      pointCount: count,
      caption: '',
      message: HOTSPOT_UNIFORM_MESSAGE,
    };
  }

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const vals = [];

  for (const p of points) {
    const v = p.value;
    if (Number.isFinite(v)) {
      vals.push(v);
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (vals.length < MIN_HOTSPOT_POINTS) {
    return {
      hasHotspot: false,
      q3Threshold: null,
      mean: NaN,
      spread: NaN,
      pointCount: vals.length,
      caption: '',
      message: HOTSPOT_UNIFORM_MESSAGE,
    };
  }

  const mean = sum / vals.length;
  const spread = max - min;
  const spreadRatio = mean > 0 ? spread / mean : 0;

  if (spreadRatio <= HOTSPOT_SPREAD_RATIO) {
    return {
      hasHotspot: false,
      q3Threshold: null,
      mean: Math.round(mean * 1000) / 1000,
      spread: Math.round(spread * 1000) / 1000,
      pointCount: vals.length,
      caption: '',
      message: HOTSPOT_UNIFORM_MESSAGE,
    };
  }

  // Calculate 75th percentile (top quartile) of interpolated grid (or points if no grid)
  const sourceValues = gridValues && gridValues.length > 0 ? gridValues : vals;
  const q3 = computePercentile(sourceValues, 0.75);

  return {
    hasHotspot: true,
    q3Threshold: Math.round(q3 * 1000) / 1000,
    mean: Math.round(mean * 1000) / 1000,
    spread: Math.round(spread * 1000) / 1000,
    pointCount: vals.length,
    caption: HOTSPOT_CAPTION,
    message: 'Placement heuristic active (longest reverberation highlighted)',
  };
}
