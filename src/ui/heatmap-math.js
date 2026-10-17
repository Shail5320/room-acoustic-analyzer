/**
 * src/ui/heatmap-math.js — Pure mathematical logic for RT60 inverse-distance weighting (IDW),
 * band value extraction, tier filtering, range calculation, and perceptually uniform color ramp.
 *
 * Rules:
 *   - Vanilla JS ES module
 *   - Zero external runtime or DOM dependencies (fully testable in node:test)
 *   - Aspect-corrected distance: d = sqrt((dx · R)² + dy²) where R = width / height
 *   - Exact distance 0 (d < 1e-6) returns measured value with NO division by zero
 *   - Per point value = RT60 from the metric actually used (t30 if used is T30, t20 if T20)
 *   - Only measured points with tier 'valid' or 'approximate' contribute
 *   - Exclude pending points and invalid bands
 *   - Honest messaging constants & threshold: < 4 points is unreliable (recommended >= 9)
 *   - Perceptually ordered Viridis-like colour ramp (monotonic in lightness, colour-blind friendly)
 */

export const MIN_USABLE_HEATMAP_POINTS = 4;
export const RECOMMENDED_HEATMAP_POINTS = 9;

export const HEATMAP_UNRELIABLE_MESSAGE =
  'Not enough data for a reliable heatmap. We recommend at least 9 measurement points spread across the room.';

export const HEATMAP_CAPTION =
  'Interpolated between measurement points; not a measurement.';

export const DEV_DATA_BANNER =
  'DEV DATA — contains simulated test measurements';

/**
 * Hardcoded Viridis-like color stops.
 * Perceptually uniform, monotonically increasing in perceived luminance, and colour-blind friendly.
 */
export const VIRIDIS_STOPS = [
  { t: 0.00, r: 68,  g: 1,   b: 84  }, // #440154 deep purple
  { t: 0.15, r: 72,  g: 40,  b: 120 }, // #482878 purple
  { t: 0.30, r: 62,  g: 74,  b: 137 }, // #3e4a89 indigo/blue
  { t: 0.45, r: 49,  g: 104, b: 142 }, // #31688e blue-green
  { t: 0.60, r: 38,  g: 130, b: 142 }, // #26828e teal
  { t: 0.75, r: 53,  g: 183, b: 121 }, // #35b779 green
  { t: 0.90, r: 110, g: 206, b: 88  }, // #6ece58 light green
  { t: 1.00, r: 253, g: 231, b: 37  }, // #fde725 bright yellow
];

/**
 * Compute perceived luminance (Rec. 709 / sRGB relative luminance weights).
 *
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @returns {number} luminance in [0, 255]
 */
export function getLuminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Interpolate a RGB color from the Viridis stops at normalized parameter t in [0, 1].
 * Clamps t to [0, 1].
 *
 * @param {number} t
 * @returns {{ r: number, g: number, b: number, hex: string, rgbString: string, luminance: number }}
 */
export function interpolateViridis(t) {
  const clampedT = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;

  // Find surrounding stops
  let lower = VIRIDIS_STOPS[0];
  let upper = VIRIDIS_STOPS[VIRIDIS_STOPS.length - 1];

  for (let i = 0; i < VIRIDIS_STOPS.length - 1; i++) {
    if (clampedT >= VIRIDIS_STOPS[i].t && clampedT <= VIRIDIS_STOPS[i + 1].t) {
      lower = VIRIDIS_STOPS[i];
      upper = VIRIDIS_STOPS[i + 1];
      break;
    }
  }

  const span = upper.t - lower.t;
  const u = span > 0 ? (clampedT - lower.t) / span : 0;

  const r = Math.round(lower.r + u * (upper.r - lower.r));
  const g = Math.round(lower.g + u * (upper.g - lower.g));
  const b = Math.round(lower.b + u * (upper.b - lower.b));

  const hexR = r.toString(16).padStart(2, '0');
  const hexG = g.toString(16).padStart(2, '0');
  const hexB = b.toString(16).padStart(2, '0');
  const hex = `#${hexR}${hexG}${hexB}`;
  const rgbString = `rgb(${r}, ${g}, ${b})`;
  const luminance = getLuminance(r, g, b);

  return { r, g, b, hex, rgbString, luminance };
}

/**
 * Map a numerical value to a normalized Viridis colour given min and max bounds.
 *
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {{ r: number, g: number, b: number, hex: string, rgbString: string, luminance: number }}
 */
export function valueToColor(val, min, max) {
  if (!Number.isFinite(val)) {
    return interpolateViridis(0);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return interpolateViridis(0.5);
  }
  const t = (val - min) / (max - min);
  return interpolateViridis(t);
}

/**
 * Extract the usable RT60 value for a specific octave band from a measurement object.
 *
 * Rule:
 *  - Must have status === 'measured'
 *  - Selected band tier must be 'valid' or 'approximate'
 *  - Per point value = RT60 from the metric actually used (t30 if used is T30, t20 if T20)
 *  - NEVER fall back to a metric the tier rejected
 *
 * @param {object} measurement
 * @param {number|string} band
 * @returns {{ usable: boolean, value: number|null, metric: string, tier: string, reason?: string }}
 */
export function extractPointBandValue(measurement, band) {
  if (!measurement) {
    return { usable: false, value: null, metric: 'none', tier: 'invalid', reason: 'no_measurement' };
  }

  if (measurement.status !== 'measured') {
    return { usable: false, value: null, metric: 'none', tier: 'pending', reason: 'status_pending' };
  }

  if (!measurement.bands) {
    return { usable: false, value: null, metric: 'none', tier: 'invalid', reason: 'no_bands' };
  }

  const bandData = measurement.bands[band] || measurement.bands[Number(band)] || measurement.bands[String(band)];
  if (!bandData) {
    return { usable: false, value: null, metric: 'none', tier: 'invalid', reason: 'band_not_found' };
  }

  const tier = bandData.tier;
  if (tier !== 'valid' && tier !== 'approximate') {
    return { usable: false, value: null, metric: 'none', tier: tier || 'invalid', reason: 'tier_invalid' };
  }

  const used = (bandData.used || '').toUpperCase();
  let value = null;

  if (used === 'T30') {
    if (Number.isFinite(bandData.t30) && bandData.t30 > 0) {
      value = bandData.t30;
    }
  } else if (used === 'T20') {
    if (Number.isFinite(bandData.t20) && bandData.t20 > 0) {
      value = bandData.t20;
    }
  }

  if (value === null) {
    return { usable: false, value: null, metric: used || 'none', tier, reason: 'rejected_metric' };
  }

  return {
    usable: true,
    value,
    metric: used,
    tier,
  };
}

/**
 * Filter a list of measurements to only those that can contribute to the heatmap for the given band.
 *
 * @param {Array<object>} measurements
 * @param {number|string} band
 * @returns {Array<{ id: number, x: number, y: number, value: number, metric: string, tier: string, fake: boolean }>}
 */
export function getUsablePoints(measurements, band) {
  if (!Array.isArray(measurements)) return [];

  const usable = [];
  for (const m of measurements) {
    const res = extractPointBandValue(m, band);
    if (res.usable && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      usable.push({
        id: m.id,
        x: m.x,
        y: m.y,
        value: res.value,
        metric: res.metric,
        tier: res.tier,
        fake: Boolean(m.fake),
      });
    }
  }
  return usable;
}

/**
 * Aggregate tier counts for a specific octave band across all measurements in a session.
 * Used for the band selector badges (e.g. "500 Hz: 5 valid, 1 approximate, 1 invalid").
 *
 * @param {Array<object>} measurements
 * @param {number|string} band
 * @returns {{ valid: number, approximate: number, invalid: number, pending: number, usable: number, total: number }}
 */
export function getBandTierCounts(measurements, band) {
  let valid = 0;
  let approximate = 0;
  let invalid = 0;
  let pending = 0;

  if (!Array.isArray(measurements)) {
    return { valid: 0, approximate: 0, invalid: 0, pending: 0, usable: 0, total: 0 };
  }

  for (const m of measurements) {
    if (m.status === 'pending') {
      pending++;
      continue;
    }
    const b = m.bands && (m.bands[band] || m.bands[Number(band)] || m.bands[String(band)]);
    if (!b) {
      invalid++;
      continue;
    }
    if (b.tier === 'valid') {
      valid++;
    } else if (b.tier === 'approximate') {
      approximate++;
    } else {
      invalid++;
    }
  }

  return {
    valid,
    approximate,
    invalid,
    pending,
    usable: valid + approximate,
    total: measurements.length,
  };
}

/**
 * Format band tier counts for user display.
 * Example: "5 valid, 1 approximate, 1 invalid"
 *
 * @param {{ valid: number, approximate: number, invalid: number }} counts
 * @returns {string}
 */
export function formatBandTierCounts(counts) {
  return `${counts.valid} valid, ${counts.approximate} approximate, ${counts.invalid} invalid`;
}

/**
 * Compute the color scale range.
 * Modes:
 *   - 'auto': Min and max of visible data with slight padding (+/- 5% span).
 *             Handles single point or identical values without zero-width divide-by-zero.
 *   - 'fixed': 0.0 s to 2.0 s (fixed across all bands for direct visual comparison).
 *
 * @param {Array<{ value: number }>} usablePoints
 * @param {'auto'|'fixed'} [mode='auto']
 * @returns {{ min: number, max: number, isFixed: boolean, dataMin?: number, dataMax?: number }}
 */
export function computeHeatmapRange(usablePoints, mode = 'auto') {
  if (mode === 'fixed') {
    return { min: 0.0, max: 2.0, isFixed: true };
  }

  if (!Array.isArray(usablePoints) || usablePoints.length === 0) {
    return { min: 0.0, max: 2.0, isFixed: false };
  }

  let minVal = Infinity;
  let maxVal = -Infinity;

  for (const p of usablePoints) {
    if (Number.isFinite(p.value)) {
      if (p.value < minVal) minVal = p.value;
      if (p.value > maxVal) maxVal = p.value;
    }
  }

  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    return { min: 0.0, max: 2.0, isFixed: false };
  }

  // Handle single point or identical values (zero-width range)
  if (Math.abs(maxVal - minVal) < 1e-6) {
    const pad = 0.2;
    const min = Math.max(0, Math.round((minVal - pad) * 100) / 100);
    let max = Math.round((maxVal + pad) * 100) / 100;
    if (max <= min) max = min + 0.4;
    return { min, max, isFixed: false, dataMin: minVal, dataMax: maxVal };
  }

  const span = maxVal - minVal;
  const padding = span * 0.05; // 5% padding
  const min = Math.max(0, Math.round((minVal - padding) * 100) / 100);
  const max = Math.round((maxVal + padding) * 100) / 100;

  return {
    min,
    max: max > min ? max : min + 0.1,
    isFixed: false,
    dataMin: minVal,
    dataMax: maxVal,
  };
}

/**
 * Aspect-corrected distance between two relative coordinates in [0, 1].
 * Formula: d = sqrt((dx · R)² + dy²) where R = width / height.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} R aspect ratio
 * @returns {number}
 */
export function aspectCorrectedDist(x1, y1, x2, y2, R) {
  const dx = (x1 - x2) * R;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Evaluate Inverse-Distance Weighting (IDW) with power 2 at relative coordinate (x, y).
 *
 * Rules:
 *  - Distance d is aspect-corrected: d = sqrt((dx · R)² + dy²) where R = width / height.
 *  - Distance 0 (d < 1e-6) returns the measured value exactly, with NO division by zero.
 *  - Power p = 2: weight w_i = 1 / d_i²
 *  - Evaluated value = sum(w_i · v_i) / sum(w_i)
 *
 * @param {number} x in [0, 1]
 * @param {number} y in [0, 1]
 * @param {Array<{ x: number, y: number, value: number }>} usablePoints
 * @param {number} aspectRatio R = width / height
 * @param {number} [power=2]
 * @returns {number} interpolated value, or NaN if no usable points
 */
export function interpolateIDW(x, y, usablePoints, aspectRatio, power = 2) {
  if (!Array.isArray(usablePoints) || usablePoints.length === 0) {
    return NaN;
  }

  if (usablePoints.length === 1) {
    return usablePoints[0].value;
  }

  const R = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 4 / 3;
  const EPSILON = 1e-6;

  let sumWeight = 0;
  let sumWeightedVal = 0;

  for (let i = 0; i < usablePoints.length; i++) {
    const p = usablePoints[i];
    const dx = (x - p.x) * R;
    const dy = y - p.y;
    const distSq = dx * dx + dy * dy;

    // Exact reproduction at measured point: return value immediately with no division by zero
    if (distSq < EPSILON * EPSILON) {
      return p.value;
    }

    // Weight w = 1 / d^p. For power = 2, w = 1 / distSq.
    const weight = power === 2 ? 1 / distSq : 1 / Math.pow(Math.sqrt(distSq), power);

    sumWeight += weight;
    sumWeightedVal += weight * p.value;
  }

  if (sumWeight === 0) {
    return usablePoints[0].value;
  }

  return sumWeightedVal / sumWeight;
}

/**
 * Compute an entire coarse grid of interpolated RT60 values over relative space [0, 1] x [0, 1].
 *
 * @param {Array<{ x: number, y: number, value: number, fake?: boolean }>} usablePoints
 * @param {object} [options]
 * @param {number} [options.aspectRatio=4/3]
 * @param {number} [options.cols=48]
 * @param {number} [options.rows] — defaults to Math.max(4, Math.round(cols / aspectRatio))
 * @param {number} [options.power=2]
 * @returns {{
 *   cols: number,
 *   rows: number,
 *   aspectRatio: number,
 *   values: Float64Array,
 *   isReliable: boolean,
 *   usableCount: number,
 *   hasFakeData: boolean
 * }}
 */
export function computeHeatmapGrid(usablePoints, options = {}) {
  const R = Number.isFinite(options.aspectRatio) && options.aspectRatio > 0 ? options.aspectRatio : 4 / 3;
  const cols = options.cols || 48;
  const rows = options.rows || Math.max(4, Math.round(cols / R));
  const power = options.power || 2;

  const points = Array.isArray(usablePoints) ? usablePoints : [];
  const usableCount = points.length;
  const isReliable = usableCount >= MIN_USABLE_HEATMAP_POINTS;
  const hasFakeData = points.some((p) => p.fake === true);

  const values = new Float64Array(cols * rows);

  if (usableCount === 0) {
    values.fill(NaN);
    return {
      cols,
      rows,
      aspectRatio: R,
      values,
      isReliable: false,
      usableCount: 0,
      hasFakeData: false,
    };
  }

  for (let r = 0; r < rows; r++) {
    // Relative y from 0 to 1
    const y = rows > 1 ? r / (rows - 1) : 0.5;
    const rowOffset = r * cols;

    for (let c = 0; c < cols; c++) {
      // Relative x from 0 to 1
      const x = cols > 1 ? c / (cols - 1) : 0.5;
      values[rowOffset + c] = interpolateIDW(x, y, points, R, power);
    }
  }

  return {
    cols,
    rows,
    aspectRatio: R,
    values,
    isReliable,
    usableCount,
    hasFakeData,
  };
}
