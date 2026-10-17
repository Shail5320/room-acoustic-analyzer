/**
 * src/dsp/rt60.js — Schroeder backward integration and RT60 estimation.
 *
 * Implements:
 *   - Direct sound peak alignment
 *   - Noise floor estimation (from pre-silence or late 15% tail)
 *   - 20 ms smoothed squared envelope
 *   - Simplified noise-floor truncation (+3 dB threshold & 50 ms floor)
 *   - Steady noise energy compensation in backward integration
 *   - Usable dynamic range estimation
 *   - Ordinary least-squares regression for T20 (-5 to -25 dB), T30 (-5 to -35 dB), EDT (0 to -10 dB)
 *   - Coefficient of determination R^2
 *   - 3-tier validity classification ("valid", "approximate", "invalid")
 *
 * Implements the numbered steps in docs/PLAN.md (Phase 2b) and docs/learning/phase0.md exactly.
 */

// ---------------------------------------------------------------------------
// Named threshold constants for RT60 validity assessment
// ---------------------------------------------------------------------------
export const FIT_RANGE_T30 = 35.0;   // dB required to fit T30 (-5 to -35 dB from direct arrival)
export const FIT_RANGE_T20 = 25.0;   // dB required to fit T20 (-5 to -25 dB from direct arrival)
export const TIER_MARGIN_DB = 10.0;  // dB safety margin required above fit range for "valid" tier
export const MIN_R2 = 0.95;          // Minimum linear fit coefficient of determination R^2

// ---------------------------------------------------------------------------
// Schroeder backward integration (EDC)
// ---------------------------------------------------------------------------

/**
 * Compute the Energy Decay Curve (EDC) using Schroeder backward integration.
 *
 * @param {Float64Array|number[]} h             — impulse response
 * @param {number}                fs            — sample rate (Hz), default 48000
 * @param {boolean}               truncateNoise — whether to apply simplified noise-floor truncation
 * @param {Float64Array|number[]|null} preSilence — optional pre-sweep silence samples
 * @returns {{
 *   t: Float64Array,
 *   edcDb: Float64Array,
 *   edc_db: Float64Array,
 *   availableRangeDb: number,
 *   available_range_db: number
 * }}
 */
export function computeEDC(h, fs = 48000, truncateNoise = true, preSilence = null) {
  // Step 1: Direct sound peak alignment
  let peakIdx = 0;
  let maxAbs = Math.abs(h[0] || 0.0);
  for (let i = 1; i < h.length; i++) {
    const a = Math.abs(h[i]);
    if (a > maxAbs) {
      maxAbs = a;
      peakIdx = i;
    }
  }

  const hDecay = h.subarray ? h.subarray(peakIdx) : h.slice(peakIdx);
  const N = hDecay.length;

  if (N === 0 || maxAbs === 0) {
    const t0 = new Float64Array([0.0]);
    const edc0 = new Float64Array([0.0]);
    return {
      t: t0,
      edcDb: edc0,
      edc_db: edc0,
      availableRangeDb: 0.0,
      available_range_db: 0.0,
    };
  }

  const hSq = new Float64Array(N);
  let peakPower = 0.0;
  for (let i = 0; i < N; i++) {
    const p = hDecay[i] * hDecay[i];
    hSq[i] = p;
    if (p > peakPower) peakPower = p;
  }

  // Step 2: Noise floor estimation (sigma^2)
  let sigma2;
  if (preSilence != null && preSilence.length > 0) {
    let sumSq = 0.0;
    for (let m = 0; m < preSilence.length; m++) {
      sumSq += preSilence[m] * preSilence[m];
    }
    sigma2 = sumSq / preSilence.length;
  } else {
    // Estimate from late 15% tail of decay
    const tailLen = Math.max(Math.floor(0.15 * N), 1);
    let sumSq = 0.0;
    const startTail = N - tailLen;
    for (let k = startTail; k < N; k++) {
      sumSq += hSq[k];
    }
    sigma2 = sumSq / tailLen;
  }

  const noiseFloorRelativeDb = 10.0 * Math.log10(Math.max(sigma2, 1e-15) / Math.max(peakPower, 1e-15));
  const peakToNoiseDr = -noiseFloorRelativeDb;

  // Step 3: Smoothed squared envelope (20 ms window)
  // Moving average using rectangular kernel of length W with centered alignment (mode='same')
  const W = Math.max(Math.floor(0.02 * fs), 1);

  // Use prefix sums for fast O(N) centered moving average
  const pref = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    pref[i + 1] = pref[i] + hSq[i];
  }

  const halfLo = Math.floor(W / 2);
  const halfHi = Math.floor((W - 1) / 2);
  const env = new Float64Array(N);
  const invW = 1.0 / W;

  for (let n = 0; n < N; n++) {
    const lo = Math.max(0, n - halfLo);
    const hi = Math.min(N - 1, n + halfHi);
    env[n] = (pref[hi + 1] - pref[lo]) * invW;
  }

  if (truncateNoise) {
    // Step 4: Truncation point detection (+3 dB threshold & 50 ms floor)
    const threshold = 2.0 * sigma2;
    let truncIdx = -1;
    for (let n = 0; n < N; n++) {
      if (env[n] < threshold) {
        truncIdx = n;
        break;
      }
    }
    if (truncIdx === -1) {
      truncIdx = N - 1;
    }

    // Enforce minimum integration length of 50 ms if signal permits
    const min50ms = Math.min(Math.floor(0.05 * fs), N - 1);
    truncIdx = Math.max(truncIdx, min50ms);

    // Step 5: Noise energy compensation & backward integration
    // Truncate decay array: h_trunc = h_decay[0 : truncIdx]
    const nTrunc = truncIdx;
    let edc = new Float64Array(nTrunc);
    let acc = 0.0;
    for (let k = nTrunc - 1; k >= 0; k--) {
      const compensated = hSq[k] - sigma2;
      if (compensated > 0.0) {
        acc += compensated;
      }
      edc[k] = acc;
    }

    // Fallback: If edc[0] <= 0 or empty, integrate without subtraction
    if (nTrunc === 0 || edc[0] <= 0.0) {
      edc = new Float64Array(nTrunc);
      acc = 0.0;
      for (let k = nTrunc - 1; k >= 0; k--) {
        acc += hSq[k];
        edc[k] = acc;
      }
    }

    const t = new Float64Array(nTrunc);
    const invFs = 1.0 / fs;
    for (let i = 0; i < nTrunc; i++) {
      t[i] = i * invFs;
    }

    const edc0 = Math.max(edc[0], 1e-12);
    const edcDb = new Float64Array(nTrunc);
    for (let i = 0; i < nTrunc; i++) {
      const edcNorm = Math.max(edc[i], 1e-12) / edc0;
      edcDb[i] = 10.0 * Math.log10(edcNorm);
    }

    // Step 6: Usable dynamic range estimation (truncated)
    const lastDb = nTrunc > 0 ? Math.abs(edcDb[nTrunc - 1]) : 0.0;
    const availableRangeDb = Math.min(lastDb, peakToNoiseDr);

    return {
      t,
      edcDb,
      edc_db: edcDb,
      availableRangeDb,
      available_range_db: availableRangeDb,
    };
  } else {
    // Un-truncated Schroeder backward integration
    const edc = new Float64Array(N);
    let acc = 0.0;
    for (let k = N - 1; k >= 0; k--) {
      acc += hSq[k];
      edc[k] = acc;
    }

    const t = new Float64Array(N);
    const invFs = 1.0 / fs;
    for (let i = 0; i < N; i++) {
      t[i] = i * invFs;
    }

    const edc0 = Math.max(edc[0], 1e-12);
    const edcDb = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const edcNorm = Math.max(edc[i], 1e-12) / edc0;
      edcDb[i] = 10.0 * Math.log10(edcNorm);
    }

    // Step 6: Usable dynamic range estimation (un-truncated)
    const threshold = 2.0 * sigma2;
    let truncIdx = -1;
    for (let n = 0; n < N; n++) {
      if (env[n] < threshold) {
        truncIdx = n;
        break;
      }
    }

    let availableRangeDb;
    if (truncIdx !== -1 && truncIdx < N) {
      availableRangeDb = Math.abs(edcDb[truncIdx]);
    } else {
      availableRangeDb = peakToNoiseDr;
    }

    return {
      t,
      edcDb,
      edc_db: edcDb,
      availableRangeDb,
      available_range_db: availableRangeDb,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 7: Least-squares regression & R^2 rule
// ---------------------------------------------------------------------------

/**
 * Fit ordinary least-squares regression line y(t) = m*t + c over a specified dB range [dbStart, dbEnd].
 *
 * @param {Float64Array} t
 * @param {Float64Array} edcDb
 * @param {number}       dbStart   — upper dB bound (e.g. -5.0)
 * @param {number}       dbEnd     — lower dB bound (e.g. -25.0)
 * @param {number}       minPoints — minimum required samples in interval (default 10)
 * @returns {{
 *   rt: number,
 *   r2: number,
 *   m: number,
 *   c: number,
 *   count: number
 * }}
 */
export function fitDecay(t, edcDb, dbStart, dbEnd, minPoints = 10) {
  let count = 0;
  for (let i = 0; i < edcDb.length; i++) {
    const y = edcDb[i];
    if (y <= dbStart && y >= dbEnd) {
      count++;
    }
  }

  if (count < minPoints) {
    return {
      rt: NaN,
      r2: NaN,
      m: NaN,
      c: NaN,
      count,
      [Symbol.iterator]: function* () {
        yield NaN;
        yield NaN;
      },
    };
  }

  let sumT = 0.0;
  let sumY = 0.0;
  for (let i = 0; i < edcDb.length; i++) {
    const y = edcDb[i];
    if (y <= dbStart && y >= dbEnd) {
      sumT += t[i];
      sumY += y;
    }
  }
  const meanT = sumT / count;
  const meanY = sumY / count;

  let num = 0.0;
  let den = 0.0;
  for (let i = 0; i < edcDb.length; i++) {
    const y = edcDb[i];
    if (y <= dbStart && y >= dbEnd) {
      const dt = t[i] - meanT;
      const dy = y - meanY;
      num += dt * dy;
      den += dt * dt;
    }
  }

  if (den === 0.0) {
    return {
      rt: NaN,
      r2: NaN,
      m: NaN,
      c: NaN,
      count,
      [Symbol.iterator]: function* () {
        yield NaN;
        yield NaN;
      },
    };
  }

  const m = num / den;
  const c = meanY - m * meanT;

  // Slope must be strictly negative for decay
  if (m >= 0.0) {
    return {
      rt: NaN,
      r2: NaN,
      m,
      c,
      count,
      [Symbol.iterator]: function* () {
        yield NaN;
        yield NaN;
      },
    };
  }

  let ssRes = 0.0;
  let ssTot = 0.0;
  for (let i = 0; i < edcDb.length; i++) {
    const y = edcDb[i];
    if (y <= dbStart && y >= dbEnd) {
      const yPred = m * t[i] + c;
      const res = y - yPred;
      ssRes += res * res;
      const dev = y - meanY;
      ssTot += dev * dev;
    }
  }

  const r2 = ssTot > 0.0 ? Math.max(0.0, 1.0 - ssRes / ssTot) : 0.0;
  const rtVal = -60.0 / m;

  return {
    rt: rtVal,
    r2,
    m,
    c,
    count,
    [Symbol.iterator]: function* () {
      yield rtVal;
      yield r2;
    },
  };
}

// ---------------------------------------------------------------------------
// Step 8: Full RT60 analysis with 3 validity tiers and priority selection
// ---------------------------------------------------------------------------

/**
 * Full RT60 analysis of an impulse response.
 *
 * Calculates:
 *   - EDT (0 to -10 dB)
 *   - T20 (-5 to -25 dB)
 *   - T30 (-5 to -35 dB)
 *   - R^2 for each fit
 *   - Usable dynamic range
 *   - 3-tier validity classification ("valid", "approximate", "invalid")
 *
 * @param {Float64Array|number[]} h             — impulse response
 * @param {number}                fs            — sample rate (Hz)
 * @param {boolean}               truncateNoise — whether to apply simplified noise-floor truncation
 * @param {Float64Array|number[]|null} preSilence — optional pre-sweep silence samples
 * @param {number}                minR2         — minimum R^2 for linear regression validity (default 0.95)
 * @returns {{
 *   rt60: number,
 *   used: string,
 *   used_metric: string,
 *   valid: boolean,
 *   tier: string,
 *   r2: number,
 *   t20: number,
 *   r2_t20: number,
 *   r2T20: number,
 *   tier_t20: string,
 *   tierT20: string,
 *   t30: number,
 *   r2_t30: number,
 *   r2T30: number,
 *   tier_t30: string,
 *   tierT30: string,
 *   edt: number,
 *   r2_edt: number,
 *   r2Edt: number,
 *   dynamic_range_db: number,
 *   dynamicRangeDb: number,
 *   t: Float64Array,
 *   edc_db: Float64Array,
 *   edcDb: Float64Array
 * }}
 */
export function analyzeRT60(
  h,
  fs = 48000,
  truncateNoise = true,
  preSilence = null,
  minR2 = MIN_R2,
) {
  const { t, edcDb, availableRangeDb } = computeEDC(h, fs, truncateNoise, preSilence);

  const { rt: edt, r2: r2Edt } = fitDecay(t, edcDb, 0.0, -10.0);
  const { rt: t20, r2: r2T20 } = fitDecay(t, edcDb, -5.0, -25.0);
  const { rt: t30, r2: r2T30 } = fitDecay(t, edcDb, -5.0, -35.0);

  const effRange = Math.round(availableRangeDb * 10) / 10;

  // Determine validity tier for T30
  let tierT30;
  if (!Number.isNaN(t30) && r2T30 >= minR2) {
    if (effRange >= FIT_RANGE_T30 + TIER_MARGIN_DB) {
      tierT30 = 'valid';
    } else if (effRange >= FIT_RANGE_T30) {
      tierT30 = 'approximate';
    } else {
      tierT30 = 'invalid';
    }
  } else {
    tierT30 = 'invalid';
  }

  // Determine validity tier for T20
  let tierT20;
  if (!Number.isNaN(t20) && r2T20 >= minR2) {
    if (effRange >= FIT_RANGE_T20 + TIER_MARGIN_DB) {
      tierT20 = 'valid';
    } else if (effRange >= FIT_RANGE_T20) {
      tierT20 = 'approximate';
    } else {
      tierT20 = 'invalid';
    }
  } else {
    tierT20 = 'invalid';
  }

  // Priority selection logic:
  // 1. Prefer T30 if "valid" (45 dB usable range + R^2 >= 0.95)
  // 2. Prefer T20 if "valid" (35 dB usable range + R^2 >= 0.95) over approximate T30
  // 3. Fall back to T30 if "approximate" (35-45 dB usable range + R^2 >= 0.95)
  // 4. Fall back to T20 if "approximate" (25-35 dB usable range + R^2 >= 0.95)
  // 5. Otherwise "invalid"
  let used;
  let tier;
  let rt60;
  let r2;

  if (tierT30 === 'valid') {
    used = 'T30';
    tier = 'valid';
    rt60 = t30;
    r2 = r2T30;
  } else if (tierT20 === 'valid') {
    used = 'T20';
    tier = 'valid';
    rt60 = t20;
    r2 = r2T20;
  } else if (tierT30 === 'approximate') {
    used = 'T30';
    tier = 'approximate';
    rt60 = t30;
    r2 = r2T30;
  } else if (tierT20 === 'approximate') {
    used = 'T20';
    tier = 'approximate';
    rt60 = t20;
    r2 = r2T20;
  } else {
    used = 'none';
    tier = 'invalid';
    rt60 = NaN;
    r2 = NaN;
  }

  const valid = (tier === 'valid');

  return {
    rt60,
    used,
    used_metric: used,
    valid,
    tier,
    r2,
    t20,
    r2_t20: r2T20,
    r2T20,
    tier_t20: tierT20,
    tierT20,
    t30,
    r2_t30: r2T30,
    r2T30,
    tier_t30: tierT30,
    tierT30,
    edt,
    r2_edt: r2Edt,
    r2Edt,
    dynamic_range_db: availableRangeDb,
    dynamicRangeDb: availableRangeDb,
    t,
    edc_db: edcDb,
    edcDb,
  };
}
