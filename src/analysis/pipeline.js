/**
 * src/analysis/pipeline.js — Pure end-to-end audio recording analysis pipeline.
 *
 * Pipeline Stages:
 *   1. Validation: sample rate (min 22050), recording duration (8s to 30s),
 *      silence detection (max |sample| <= 1e-6), clipping detection (|sample| > 0.99).
 *   2. Sweep Synthesis: generate exponential sine sweep and inverse filter
 *      at the recording's EXACT sample rate (never resample the recording).
 *   3. Deconvolution: linear frequency-domain deconvolution (padded to 2^k).
 *   4. Peak Detection & PNR Validation: locate direct arrival spike and verify
 *      PNR >= 20 dB against pre-peak noise window.
 *   5. Cut-off Decay Check: verify that the tail envelope has decayed to within
 *      ~6 dB of the pre-peak noise floor; if not, set decayTruncated: true and
 *      cap affected tiers at "approximate".
 *   6. IR Extraction: extract 2.5 s tail starting pre-peak.
 *   7. Octave Filtering & RT60 Estimation: 4th-order Butterworth filters
 *      (125–4000 Hz) with Schroeder backward integration, noise-floor truncation,
 *      and 3-tier validity classification.
 *   8. Dynamic Range Derivation: per-point dynamicRangeDb = minimum across all 6 bands,
 *      with weakestBandHz returned alongside.
 *   9. Lightweight Plot Decimation: downsampled irPlot and per-band edcPlot for UI rendering.
 */

import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
  PNR_THRESHOLD_DB,
  LOW_PNR_OVERRIDE_MIN_DB,
  LOW_PNR_POST_PRE_MARGIN_DB,
  TEMPLATE_GATE_WIN_HALF_S,
  TEMPLATE_GATE_MIN_MARGIN_DB,
  TEMPLATE_GATE_MIN_BANDS,
  TEMPLATE_GATE_BLOCK_MS,
  TEMPLATE_GATE_HOP_MS,
  CLAP_MAX_SPREAD_S,
  formatTemplateGateRejectMessage,
  SWEEP_SIG_MIN_SCORE,
  SWEEP_SIG_MIN_MONOTONIC_STEPS,
  SWEEP_SIG_MIN_SPAN_S,
  SWEEP_SIG_MAX_SPAN_S,
  SWEEP_SIG_BLOCK_MS,
  SWEEP_SIG_HOP_MS,
  SWEEP_REJECT_NOT_SWEEP,
  SWEEP_REJECT_NO_SWEEP,
  MIN_SAMPLE_RATE,
  MIN_RECORDING_DURATION_S,
  MAX_RECORDING_DURATION_S,
  CLIPPING_THRESHOLD,
  SILENCE_THRESHOLD,
  DECAY_TAIL_MARGIN_DB,
  OCTAVE_CENTRES,
  IR_DURATION_S,
  PRE_PEAK_MS,
  IR_PLOT_POINTS,
  EDC_PLOT_POINTS,
} from './config.js';

import { generateSweep, generateInverseFilter } from '../dsp/sweep.js';
import { deconvolve, findPeakAndPNR, extractIR } from '../dsp/deconvolve.js';
import { designOctaveFilters, sosFilt } from '../dsp/bands.js';
import { analyzeRT60 } from '../dsp/rt60.js';

// ---------------------------------------------------------------------------
// Helpers: Downsampling for Canvas / UI Plotting
// ---------------------------------------------------------------------------

/**
 * Downsample 1D signal to target number of points using peak-preserving min/max or decimation.
 *
 * @param {Float64Array} signal
 * @param {number} sampleRate
 * @param {number} targetPoints
 * @returns {{ t: Float32Array, values: Float32Array }}
 */
export function downsampleWaveform(signal, sampleRate, targetPoints = IR_PLOT_POINTS) {
  const N = signal.length;
  if (N === 0) {
    return { t: new Float32Array(0), values: new Float32Array(0) };
  }
  if (N <= targetPoints) {
    const t = new Float32Array(N);
    const values = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      t[i] = i / sampleRate;
      values[i] = signal[i];
    }
    return { t, values };
  }

  const outT = new Float32Array(targetPoints);
  const outVal = new Float32Array(targetPoints);
  const step = (N - 1) / (targetPoints - 1);

  for (let i = 0; i < targetPoints; i++) {
    const idx = Math.round(i * step);
    outT[i] = idx / sampleRate;
    outVal[i] = signal[idx];
  }
  return { t: outT, values: outVal };
}

/**
 * Downsample 2D curve (t, y) to target number of points.
 *
 * @param {Float64Array} t
 * @param {Float64Array} y
 * @param {number} targetPoints
 * @returns {{ t: Float32Array, edcDb: Float32Array }}
 */
export function downsampleCurve(t, y, targetPoints = EDC_PLOT_POINTS) {
  const N = t.length;
  if (N === 0) {
    return { t: new Float32Array(0), edcDb: new Float32Array(0) };
  }
  if (N <= targetPoints) {
    const outT = new Float32Array(N);
    const outY = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      outT[i] = t[i];
      outY[i] = y[i];
    }
    return { t: outT, edcDb: outY };
  }

  const outT = new Float32Array(targetPoints);
  const outY = new Float32Array(targetPoints);
  const step = (N - 1) / (targetPoints - 1);

  for (let i = 0; i < targetPoints; i++) {
    const idx = Math.round(i * step);
    outT[i] = t[idx];
    outY[i] = y[idx];
  }
  return { t: outT, edcDb: outY };
}

// ---------------------------------------------------------------------------
// Sweep Template Gate Validation (Predicted-Time Gate)
// ---------------------------------------------------------------------------

/**
 * Validate presence of the exponential test sweep using the predicted-time template gate.
 *
 * Principle:
 *   1. Obtains sweep start time from deconvolution peak:
 *      t_start = (peakIdx - (sweepLen - 1)) / fs.
 *   2. Predicts expected octave center arrival times:
 *      t_k = t_start + L * ln(fc_k / f1), where L = T / ln(f2 / f1).
 *   3. Calculates band background as the median of 50 ms block energies (25 ms hop).
 *   4. Evaluates energy margin in a +/- 0.15 s window around t_k relative to background:
 *      margin_k = 10 * log10(mean energy in [t_k - 0.15, t_k + 0.15] / background).
 *   5. Accepts when at least 4 of 6 bands exhibit margin >= 10 dB.
 *   6. Windows falling outside recording bounds count as unmatched (-99 dB).
 *
 * @param {Float32Array|Float64Array} signal - Audio samples
 * @param {number} sampleRate - Audio sample rate (Hz)
 * @param {number|null} [deconvPeakIdx=null] - Direct arrival peak index from deconvolution
 * @param {number|null} [sweepLengthSamples=null] - Length of synthesized sweep in samples
 * @param {object} [options={}] - Pipeline options
 * @returns {{
 *   ok: boolean,
 *   matchedBands: number,
 *   requiredBands: number,
 *   tStart: number,
 *   tStartRaw: number,
 *   perBandMarginDb: number[],
 *   peakTimes: number[],
 *   isClap: boolean,
 *   peakSpreadS: number
 * }}
 */
export function checkSweepTemplate(signal, sampleRate, deconvPeakIdx = null, sweepLengthSamples = null, options = {}) {
  const f1 = options.f1 || SWEEP_F1;
  const f2 = options.f2 || SWEEP_F2;
  const T = options.T || SWEEP_DURATION_S;
  const fadeMs = options.fadeMs || SWEEP_FADE_MS;
  const centres = options.octaveCentres || OCTAVE_CENTRES;
  const winHalfS = options.templateGateWinHalfS ?? TEMPLATE_GATE_WIN_HALF_S;
  const minMarginDb = options.templateGateMinMarginDb ?? TEMPLATE_GATE_MIN_MARGIN_DB;
  const minBands = options.templateGateMinBands ?? TEMPLATE_GATE_MIN_BANDS;
  const blockMs = options.templateGateBlockMs ?? TEMPLATE_GATE_BLOCK_MS;
  const hopMs = options.templateGateHopMs ?? TEMPLATE_GATE_HOP_MS;
  const clapSpreadMaxS = options.clapMaxSpreadS ?? CLAP_MAX_SPREAD_S;

  if (!signal || signal.length === 0) {
    return {
      ok: false,
      matchedBands: 0,
      requiredBands: minBands,
      tStart: 0,
      tStartRaw: 0,
      perBandMarginDb: centres.map(() => -99.0),
      peakTimes: [],
      isClap: false,
      peakSpreadS: 0,
    };
  }

  let peakIdx = deconvPeakIdx;
  let sweepLen = sweepLengthSamples;

  if (peakIdx == null || sweepLen == null) {
    const sweep = generateSweep(f1, f2, T, sampleRate, fadeMs);
    sweepLen = sweep.length;
    const invFilter = generateInverseFilter(sweep, f1, f2, T, sampleRate);
    const hFull = deconvolve(signal, invFilter);
    const { peakIdx: foundPeak } = findPeakAndPNR(hFull, sampleRate, PRE_PEAK_MS);
    peakIdx = foundPeak;
  }

  const tStart = (peakIdx - (sweepLen - 1)) / sampleRate;
  const L = T / Math.log(f2 / f1);

  const filters = designOctaveFilters(sampleRate, centres);
  const blk = Math.round(blockMs * 1e-3 * sampleRate);
  const hop = Math.round(hopMs * 1e-3 * sampleRate);

  let matchedBands = 0;
  const perBandMarginDb = [];
  const peakTimes = [];

  for (const fc of centres) {
    const sos = filters.get(fc);
    const f = sosFilt(sos, signal);

    // 1. Background: median of 50 ms block energies (25 ms hop)
    const nh = Math.max(1, Math.floor((f.length - blk) / hop) + 1);
    const blockEnergies = new Float64Array(nh);
    let maxBlockEnergy = 0;
    let maxHop = 0;

    for (let i = 0; i < nh; i++) {
      let sumSq = 0;
      const start = i * hop;
      for (let j = 0; j < blk; j++) {
        const val = f[start + j];
        sumSq += val * val;
      }
      const meanEnergy = sumSq / blk;
      blockEnergies[i] = meanEnergy;
      if (meanEnergy > maxBlockEnergy) {
        maxBlockEnergy = meanEnergy;
        maxHop = i;
      }
    }

    const tPeak = (maxHop * hop + blk / 2) / sampleRate;
    peakTimes.push(tPeak);

    const sortedEnergies = Array.from(blockEnergies).sort((a, b) => a - b);
    const mid = Math.floor(sortedEnergies.length / 2);
    const bg = (sortedEnergies.length % 2 === 0
      ? (sortedEnergies[mid - 1] + sortedEnergies[mid]) / 2
      : sortedEnergies[mid]) + 1e-18;

    // 2. Expected arrival time and window around t_k
    const tk = tStart + L * Math.log(fc / f1);
    const a = Math.floor((tk - winHalfS) * sampleRate);
    const b = Math.floor((tk + winHalfS) * sampleRate);

    // Windows outside the recording count as unmatched
    if (a < 0 || b > f.length || b <= a) {
      perBandMarginDb.push(-99.0);
      continue;
    }

    let sumWin = 0;
    for (let i = a; i < b; i++) {
      const val = f[i];
      sumWin += val * val;
    }
    const meanWinEnergy = sumWin / (b - a);
    const margin = 10.0 * Math.log10(meanWinEnergy / bg + 1e-18);
    const roundedMargin = Math.round(margin * 10) / 10;
    perBandMarginDb.push(roundedMargin);

    if (roundedMargin >= minMarginDb) {
      matchedBands++;
    }
  }

  const ok = matchedBands >= minBands;

  // Clap detection: all six band energy peaks fall within 0.15 s of each other
  const peakSpreadS = peakTimes.length > 0
    ? Math.max(...peakTimes) - Math.min(...peakTimes)
    : 0;
  const isClap = peakTimes.length === 6 && peakSpreadS <= clapSpreadMaxS;

  return {
    ok,
    matchedBands,
    requiredBands: minBands,
    tStart: Math.round(tStart * 1000) / 1000,
    tStartRaw: tStart,
    perBandMarginDb,
    peakTimes,
    isClap,
    peakSpreadS: Math.round(peakSpreadS * 1000) / 1000,
    peakIdx,
  };
}

// ---------------------------------------------------------------------------
// Legacy Sweep Signature Validation (Octave Band Progression Gate - battery only)
// ---------------------------------------------------------------------------

/**
 * Legacy chronological octave band progression gate retained for battery benchmarking.
 * Not used by the primary analysis pipeline.
 */
export function legacyCheckSweepSignature(signal, sampleRate, options = {}) {
  if (!signal || signal.length === 0) {
    return { ok: false, score: 0, monotonicCount: 0, dtValidCount: 0, totalSpan: 0, meanDtError: 0, peakTimes: [], dtList: [] };
  }

  const f1 = options.f1 || SWEEP_F1;
  const f2 = options.f2 || SWEEP_F2;
  const T = options.T || SWEEP_DURATION_S;
  const centres = options.octaveCentres || OCTAVE_CENTRES;

  const filters = designOctaveFilters(sampleRate, centres);
  const blockMs = options.sigBlockMs || SWEEP_SIG_BLOCK_MS;
  const hopMs = options.sigHopMs || SWEEP_SIG_HOP_MS;
  const blockSamples = Math.round(blockMs * 1e-3 * sampleRate);
  const hopSamples = Math.round(hopMs * 1e-3 * sampleRate);
  const numHops = Math.max(1, Math.floor((signal.length - blockSamples) / hopSamples) + 1);

  const peakTimes = [];
  const peakValues = [];

  for (const fc of centres) {
    const sos = filters.get(fc);
    const filtered = sosFilt(sos, signal);

    let maxEnergy = 0;
    let maxHop = 0;

    for (let h = 0; h < numHops; h++) {
      const start = h * hopSamples;
      let sumSq = 0;
      for (let i = 0; i < blockSamples; i++) {
        const val = filtered[start + i];
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / blockSamples);
      if (rms > maxEnergy) {
        maxEnergy = rms;
        maxHop = h;
      }
    }

    const tPeak = (maxHop * hopSamples + blockSamples / 2) / sampleRate;
    peakTimes.push(tPeak);
    peakValues.push(maxEnergy);
  }

  const expectedDt = (T / Math.log(f2 / f1)) * Math.LN2; // ~0.6829 s
  const expectedTotalSpan = (centres.length - 1) * expectedDt; // ~3.414 s

  const dtList = [];
  let monotonicCount = 0;
  let dtValidCount = 0;
  const dtErrors = [];

  for (let k = 0; k < peakTimes.length - 1; k++) {
    const dt = peakTimes[k + 1] - peakTimes[k];
    dtList.push(dt);
    if (dt > 0.05) {
      monotonicCount++;
    }
    if (dt >= 0.20 && dt <= 1.40) {
      dtValidCount++;
    }
    dtErrors.push(Math.abs(dt - expectedDt));
  }

  const totalSpan = peakTimes[peakTimes.length - 1] - peakTimes[0];
  const meanDtError = dtErrors.reduce((a, b) => a + b, 0) / dtErrors.length;

  const minSpan = options.sigMinSpanS ?? SWEEP_SIG_MIN_SPAN_S;
  const maxSpan = options.sigMaxSpanS ?? SWEEP_SIG_MAX_SPAN_S;
  const minScore = options.sigMinScore ?? SWEEP_SIG_MIN_SCORE;
  const minSteps = options.sigMinSteps ?? SWEEP_SIG_MIN_MONOTONIC_STEPS;

  const spanOk = totalSpan >= minSpan && totalSpan <= maxSpan;

  const score = (
    0.40 * (monotonicCount / Math.max(1, peakTimes.length - 1)) +
    0.30 * Math.max(0, 1.0 - meanDtError / expectedDt) +
    0.30 * Math.max(0, 1.0 - Math.abs(totalSpan - expectedTotalSpan) / expectedTotalSpan)
  );

  const ok = (monotonicCount >= minSteps) && spanOk && (score >= minScore);

  return {
    ok,
    score: Math.round(score * 1000) / 1000,
    monotonicCount,
    dtValidCount,
    totalSpan: Math.round(totalSpan * 100) / 100,
    meanDtError: Math.round(meanDtError * 1000) / 1000,
    peakTimes,
    dtList,
  };
}

// Backward compatibility alias for battery script / external callers
export const checkSweepSignature = legacyCheckSweepSignature;

// ---------------------------------------------------------------------------
// Main Analysis Pipeline (Pure, No DOM)
// ---------------------------------------------------------------------------

/**
 * Analyze an acoustic room recording end-to-end.
 *
 * @param {object} input
 * @param {Float32Array|Float64Array} input.samples — Raw microphone recording samples
 * @param {number} input.sampleRate                — Recording sample rate (Hz)
 * @param {Function} [input.onProgress]            — Optional progress callback: ({ stage, progress, message }) => void
 * @param {object} [input.options]                 — Optional threshold overrides
 * @returns {{
 *   ok: boolean,
 *   rejectReason: string|null,
 *   warning: string|null,
 *   decayTruncated: boolean,
 *   pnrDb: number,
 *   dynamicRangeDb: number,
 *   weakestBandHz: number|null,
 *   clipped: boolean,
 *   irPlot: { t: Float32Array, values: Float32Array }|null,
 *   edcPlot: { [fc: number]: { t: Float32Array, edcDb: Float32Array } }|null,
 *   bands: { [fc: number]: {
 *     t20: number,
 *     t30: number,
 *     edt: number,
 *     r2: number,
 *     r2_t20: number,
 *     r2_t30: number,
 *     r2_edt: number,
 *     used: string,
 *     tier: string,
 *     valid: boolean,
 *     rt60: number|null,
 *     dynamicRangeDb: number
 *   } }|null,
 *   timingsMs: {
 *     sweepMs: number,
 *     deconvolveMs: number,
 *     filteringMs: number,
 *     rt60Ms: number,
 *     totalMs: number
 *   }
 * }}
 */
export function analyzeRecording({ samples, sampleRate, onProgress = null, options = {} }) {
  const startTime = performance.now();
  const timingsMs = {
    sweepMs: 0,
    deconvolveMs: 0,
    filteringMs: 0,
    rt60Ms: 0,
    totalMs: 0,
  };

  const reportProgress = (stage, progress, message) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ stage, progress, message });
      } catch (_) {
        // Prevent caller callback error from crashing pipeline
      }
    }
  };

  reportProgress('validating', 0.05, 'Validating recording format and levels...');

  // 1. Validate Input Types & Ensure Float64Array without mutating input
  if (!samples || typeof samples.length !== 'number' || samples.length === 0) {
    return {
      ok: false,
      rejectReason: 'Recording is empty or invalid',
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: 0,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped: false,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: null,
      perBandMarginDb: null,
      matchedBands: null,
      sampleRate: sampleRate || null,
      durationS: 0,
      deltaPostPreDb: null,
      gateFired: 'Sample length gate',
      diagnostics: {
        pnrDb: null,
        pnrThresholdDb: PNR_THRESHOLD_DB,
        deltaPostPreDb: null,
        deltaPostPreThresholdDb: LOW_PNR_POST_PRE_MARGIN_DB,
        tStart: null,
        matchedBands: null,
        perBandMarginDb: null,
        sampleRate: sampleRate || null,
        durationS: 0,
        gateFired: 'Sample length gate',
      },
      timingsMs,
    };
  }

  const signal = new Float64Array(samples);

  if (typeof sampleRate !== 'number' || sampleRate < MIN_SAMPLE_RATE) {
    const dur = sampleRate ? Math.round((signal.length / sampleRate) * 100) / 100 : 0;
    return {
      ok: false,
      rejectReason: `Sample rate too low (${sampleRate || 0} Hz < ${MIN_SAMPLE_RATE} Hz)`,
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: 0,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped: false,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: null,
      perBandMarginDb: null,
      matchedBands: null,
      sampleRate: sampleRate || 0,
      durationS: dur,
      deltaPostPreDb: null,
      gateFired: 'Sample rate gate',
      diagnostics: {
        pnrDb: null,
        pnrThresholdDb: PNR_THRESHOLD_DB,
        deltaPostPreDb: null,
        deltaPostPreThresholdDb: LOW_PNR_POST_PRE_MARGIN_DB,
        tStart: null,
        matchedBands: null,
        perBandMarginDb: null,
        sampleRate: sampleRate || 0,
        durationS: dur,
        gateFired: 'Sample rate gate',
      },
      timingsMs,
    };
  }

  const minDurationS = options.minDurationS ?? MIN_RECORDING_DURATION_S;
  const maxDurationS = options.maxDurationS ?? MAX_RECORDING_DURATION_S;

  const durationS = signal.length / sampleRate;
  if (durationS < minDurationS) {
    return {
      ok: false,
      rejectReason: `Recording too short (${durationS.toFixed(2)} s < ${minDurationS} s)`,
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: 0,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped: false,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: null,
      perBandMarginDb: null,
      matchedBands: null,
      sampleRate,
      durationS: Math.round(durationS * 100) / 100,
      deltaPostPreDb: null,
      gateFired: 'Duration gate (too short)',
      diagnostics: {
        pnrDb: null,
        pnrThresholdDb: options.pnrThresholdDb || PNR_THRESHOLD_DB,
        deltaPostPreDb: null,
        deltaPostPreThresholdDb: options.lowPnrPostPreMarginDb ?? LOW_PNR_POST_PRE_MARGIN_DB,
        tStart: null,
        matchedBands: null,
        perBandMarginDb: null,
        sampleRate,
        durationS: Math.round(durationS * 100) / 100,
        gateFired: 'Duration gate (too short)',
      },
      timingsMs,
    };
  }

  if (durationS > maxDurationS) {
    return {
      ok: false,
      rejectReason: `Recording too long (${durationS.toFixed(2)} s > ${maxDurationS} s)`,
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: 0,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped: false,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: null,
      perBandMarginDb: null,
      matchedBands: null,
      sampleRate,
      durationS: Math.round(durationS * 100) / 100,
      deltaPostPreDb: null,
      gateFired: 'Duration gate (too long)',
      diagnostics: {
        pnrDb: null,
        pnrThresholdDb: options.pnrThresholdDb || PNR_THRESHOLD_DB,
        deltaPostPreDb: null,
        deltaPostPreThresholdDb: options.lowPnrPostPreMarginDb ?? LOW_PNR_POST_PRE_MARGIN_DB,
        tStart: null,
        matchedBands: null,
        perBandMarginDb: null,
        sampleRate,
        durationS: Math.round(durationS * 100) / 100,
        gateFired: 'Duration gate (too long)',
      },
      timingsMs,
    };
  }

  // Detect clipping and silence
  let clipped = false;
  let maxAbs = 0.0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > maxAbs) maxAbs = a;
    if (a > CLIPPING_THRESHOLD) clipped = true;
  }

  if (maxAbs <= SILENCE_THRESHOLD) {
    return {
      ok: false,
      rejectReason: 'Recording is silent',
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: 0,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: null,
      perBandMarginDb: null,
      matchedBands: null,
      sampleRate,
      durationS: Math.round(durationS * 100) / 100,
      deltaPostPreDb: null,
      gateFired: 'Silence gate',
      diagnostics: {
        pnrDb: null,
        pnrThresholdDb: options.pnrThresholdDb || PNR_THRESHOLD_DB,
        deltaPostPreDb: null,
        deltaPostPreThresholdDb: options.lowPnrPostPreMarginDb ?? LOW_PNR_POST_PRE_MARGIN_DB,
        tStart: null,
        matchedBands: null,
        perBandMarginDb: null,
        sampleRate,
        durationS: Math.round(durationS * 100) / 100,
        gateFired: 'Silence gate',
      },
      timingsMs,
    };
  }

  // 2. Synthesize Sweep & Inverse Filter at Recording Sample Rate
  reportProgress('sweep', 0.15, `Synthesizing sweep at ${sampleRate} Hz...`);
  const tSweepStart = performance.now();
  const f1 = options.f1 || SWEEP_F1;
  const f2 = options.f2 || SWEEP_F2;
  const T = options.T || SWEEP_DURATION_S;
  const fadeMs = options.fadeMs || SWEEP_FADE_MS;

  const sweep = generateSweep(f1, f2, T, sampleRate, fadeMs);
  const invFilter = generateInverseFilter(sweep, f1, f2, T, sampleRate);
  timingsMs.sweepMs = performance.now() - tSweepStart;

  // 3. Deconvolve
  reportProgress('deconvolve', 0.35, 'Deconvolving room impulse response...');
  const tDeconvStart = performance.now();
  const hFull = deconvolve(signal, invFilter);

  // 4. Peak Detection and PNR Validation
  const prePeakMs = options.prePeakMs || PRE_PEAK_MS;
  const { peakIdx, peakVal, pnrDb } = findPeakAndPNR(hFull, sampleRate, prePeakMs);
  timingsMs.deconvolveMs = performance.now() - tDeconvStart;

  // Evaluate post-peak direct energy (first 200 ms) against pre-peak noise window
  const preSamples = Math.round(prePeakMs * 1e-3 * sampleRate);
  const noiseStart = Math.max(0, peakIdx - Math.round(0.5 * sampleRate));
  const noiseEnd = Math.max(0, peakIdx - preSamples);
  const noiseWindow = hFull.subarray(noiseStart, noiseEnd);
  let rmsNoise = 1e-12;
  if (noiseWindow.length > 0) {
    let sumNoise = 0;
    for (let i = 0; i < noiseWindow.length; i++) sumNoise += noiseWindow[i] ** 2;
    rmsNoise = Math.sqrt(sumNoise / noiseWindow.length) + 1e-12;
  }

  const postSamples = Math.round(0.2 * sampleRate);
  const postEnd = Math.min(hFull.length, peakIdx + postSamples);
  const postWindow = hFull.subarray(peakIdx, postEnd);
  let rmsPost = 1e-12;
  if (postWindow.length > 0) {
    let sumPost = 0;
    for (let i = 0; i < postWindow.length; i++) sumPost += postWindow[i] ** 2;
    rmsPost = Math.sqrt(sumPost / postWindow.length) + 1e-12;
  }

  const deltaPostPreDb = 20.0 * Math.log10(rmsPost / rmsNoise);

  const roundedPnrDb = Math.round(pnrDb * 10) / 10;
  const pnrThreshold = options.pnrThresholdDb || PNR_THRESHOLD_DB;
  const lowPnrFloor = options.lowPnrOverrideMinDb ?? LOW_PNR_OVERRIDE_MIN_DB;
  const lowPnrMargin = options.lowPnrPostPreMarginDb ?? LOW_PNR_POST_PRE_MARGIN_DB;

  // Template gate: verify the recording contains our test sweep at predicted arrival times
  // Reuses deconvolution peak (no second FFT)
  const tGateStart = performance.now();
  const templateGate = checkSweepTemplate(signal, sampleRate, peakIdx, sweep.length, options);
  timingsMs.templateGateMs = performance.now() - tGateStart;

  // The low-PNR override is strictly gated by all three criteria:
  // 1. PNR inside [lowPnrFloor, pnrThreshold)
  // 2. Post-peak direct energy margin >= 1.5 dB (excludes stationary noise)
  // 3. Template gate confirmed (excludes claps, pops, and bursts)
  const canOverrideLowPnr = (peakVal > 1e-12) &&
    (roundedPnrDb >= lowPnrFloor) &&
    (roundedPnrDb < pnrThreshold) &&
    (deltaPostPreDb >= lowPnrMargin) &&
    templateGate.ok;

  // Gate 1: Template gate check (applies to normal path and override path)
  if (!templateGate.ok) {
    let rejectReason;
    if (roundedPnrDb >= pnrThreshold || (peakVal > 1e-12 && deltaPostPreDb >= lowPnrMargin)) {
      if (templateGate.isClap) {
        rejectReason = SWEEP_REJECT_NOT_SWEEP;
      } else {
        rejectReason = formatTemplateGateRejectMessage(templateGate.matchedBands);
      }
    } else {
      rejectReason = SWEEP_REJECT_NO_SWEEP;
    }

    return {
      ok: false,
      rejectReason,
      warning: null,
      decayTruncated: false,
      canOverrideLowPnr: false,
      lowConfidence: false,
      pnrDb: roundedPnrDb,
      dynamicRangeDb: 0,
      weakestBandHz: null,
      clipped,
      irPlot: null,
      edcPlot: null,
      bands: null,
      tStart: templateGate.tStart,
      perBandMarginDb: templateGate.perBandMarginDb,
      matchedBands: templateGate.matchedBands,
      templateGate,
      sampleRate,
      durationS: Math.round(durationS * 100) / 100,
      deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
      gateFired: 'Template gate',
      diagnostics: {
        pnrDb: roundedPnrDb,
        pnrThresholdDb: pnrThreshold,
        deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
        deltaPostPreThresholdDb: lowPnrMargin,
        tStart: templateGate.tStart,
        matchedBands: templateGate.matchedBands,
        perBandMarginDb: templateGate.perBandMarginDb,
        sampleRate,
        durationS: Math.round(durationS * 100) / 100,
        gateFired: 'Template gate',
      },
      timingsMs: {
        ...timingsMs,
        totalMs: performance.now() - startTime,
      },
    };
  }

  // Gate 2: PNR check
  let lowConfidence = false;
  let warning = null;

  if (peakVal <= 1e-12 || roundedPnrDb < pnrThreshold) {
    const allowLowPnr = Boolean(options.allowLowPnr);
    // Refuse internally unless allowLowPnr is requested AND canOverrideLowPnr is true
    if (allowLowPnr && canOverrideLowPnr) {
      lowConfidence = true;
      warning = 'Low signal-to-noise ratio: results have reduced precision';
    } else {
      return {
        ok: false,
        rejectReason: SWEEP_REJECT_NO_SWEEP,
        warning: null,
        decayTruncated: false,
        canOverrideLowPnr,
        lowConfidence: false,
        pnrDb: roundedPnrDb,
        dynamicRangeDb: 0,
        weakestBandHz: null,
        clipped,
        irPlot: null,
        edcPlot: null,
        bands: null,
        tStart: templateGate.tStart,
        perBandMarginDb: templateGate.perBandMarginDb,
        matchedBands: templateGate.matchedBands,
        templateGate,
        sampleRate,
        durationS: Math.round(durationS * 100) / 100,
        deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
        gateFired: 'PNR gate',
        diagnostics: {
          pnrDb: roundedPnrDb,
          pnrThresholdDb: pnrThreshold,
          deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
          deltaPostPreThresholdDb: lowPnrMargin,
          tStart: templateGate.tStart,
          matchedBands: templateGate.matchedBands,
          perBandMarginDb: templateGate.perBandMarginDb,
          sampleRate,
          durationS: Math.round(durationS * 100) / 100,
          gateFired: 'PNR gate',
        },
        timingsMs: {
          ...timingsMs,
          totalMs: performance.now() - startTime,
        },
      };
    }
  }

  // 5. Cut-Off Decay Check
  // Verify that the signal envelope at the end of the recording has decayed to
  // within about 6 dB of the pre-peak noise floor.
  // Measure signal envelope at the end of the recording (last 50 ms)
  const windowLen = Math.max(10, Math.round(0.05 * sampleRate));
  const endSamples = signal.subarray(signal.length - windowLen);
  let sumSqEnd = 0;
  for (let i = 0; i < endSamples.length; i++) sumSqEnd += endSamples[i] ** 2;
  const endEnvelopeRms = Math.sqrt(sumSqEnd / endSamples.length);

  // Pre-peak noise floor in the recording
  const directIdxInRec = Math.max(0, peakIdx - (sweep.length - 1));
  let prePeakNoiseRms;

  if (directIdxInRec > windowLen) {
    const preWindow = signal.subarray(0, Math.min(directIdxInRec, Math.round(1.0 * sampleRate)));
    let sumSqPre = 0;
    for (let i = 0; i < preWindow.length; i++) sumSqPre += preWindow[i] ** 2;
    prePeakNoiseRms = Math.sqrt(sumSqPre / preWindow.length);
  } else {
    let sumNoise = 0;
    for (let i = 0; i < noiseWindow.length; i++) sumNoise += noiseWindow[i] ** 2;
    const deconvNoiseRms = noiseWindow.length > 50 ? Math.sqrt(sumNoise / noiseWindow.length) : 1e-12;
    prePeakNoiseRms = peakVal > 0 ? (deconvNoiseRms / peakVal) : 1e-6;
  }

  const marginDb = options.decayTailMarginDb ?? DECAY_TAIL_MARGIN_DB;
  const tailAboveNoiseDb = 20.0 * Math.log10(
    Math.max(endEnvelopeRms, 1e-15) / Math.max(prePeakNoiseRms, 1e-15)
  );

  let decayTruncated = false;
  if (endEnvelopeRms > 1e-5 && tailAboveNoiseDb > marginDb) {
    decayTruncated = true;
    const decayMsg = 'Reverberation decay appears cut off before reaching the noise floor';
    warning = warning ? `${warning}; ${decayMsg}` : decayMsg;
  }

  // 6. Extract Impulse Response
  const irDurationS = options.irDurationS || IR_DURATION_S;
  const irLengthSamples = Math.min(
    Math.round(irDurationS * sampleRate),
    hFull.length - Math.max(0, peakIdx - preSamples)
  );
  const ir = extractIR(hFull, peakIdx, irLengthSamples, sampleRate, prePeakMs);

  // 7. Octave Filtering and RT60 Estimation
  reportProgress('filtering', 0.60, 'Filtering 6 octave bands...');
  const tFiltStart = performance.now();
  const octaveCentres = options.octaveCentres || OCTAVE_CENTRES;
  const filters = designOctaveFilters(sampleRate, octaveCentres);
  timingsMs.filteringMs = performance.now() - tFiltStart;

  reportProgress('rt60', 0.80, 'Computing Schroeder decay curves and RT60...');
  const tRt60Start = performance.now();

  const bands = {};
  const edcPlot = {};
  const drList = [];

  for (const fc of octaveCentres) {
    const sos = filters.get(fc);
    const filtered = sosFilt(sos, ir);
    const res = analyzeRT60(filtered, sampleRate, true);

    let tier = res.tier;
    let valid = res.valid;

    // Cut-off decay or low-confidence penalty: cap tier at "approximate" at best
    if (decayTruncated || lowConfidence) {
      if (tier === 'valid') {
        tier = 'approximate';
        valid = true;
      }
    }

    const rt60Val = (res.used === 'none' || tier === 'invalid' || Number.isNaN(res.rt60))
      ? null
      : res.rt60;

    const bandDr = Math.round(res.dynamicRangeDb * 10) / 10;
    drList.push({ dr: bandDr, fc });

    bands[fc] = {
      t20: res.t20,
      t30: res.t30,
      edt: res.edt,
      r2: res.r2,
      r2_t20: res.r2_t20,
      r2_t30: res.r2_t30,
      r2_edt: res.r2_edt,
      used: res.used,
      tier,
      valid,
      rt60: rt60Val,
      dynamicRangeDb: bandDr,
    };

    edcPlot[fc] = downsampleCurve(res.t, res.edcDb, EDC_PLOT_POINTS);
  }
  timingsMs.rt60Ms = performance.now() - tRt60Start;

  // 8. Derive Per-Point Dynamic Range (Minimum over all 6 bands) & Weakest Band
  let minDr = Infinity;
  let weakestBandHz = octaveCentres[0];
  for (const item of drList) {
    if (item.dr < minDr) {
      minDr = item.dr;
      weakestBandHz = item.fc;
    }
  }

  // 9. Downsampled IR Plot
  const irPlot = downsampleWaveform(ir, sampleRate, IR_PLOT_POINTS);

  timingsMs.totalMs = performance.now() - startTime;
  reportProgress('done', 1.0, 'Analysis complete.');

  const roundedPnr = Math.round(pnrDb * 10) / 10;
  const gateFired = lowConfidence ? 'PNR gate (overridden)' : 'None (All gates passed)';
  const diagnostics = {
    pnrDb: roundedPnr,
    pnrThresholdDb: pnrThreshold,
    deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
    deltaPostPreThresholdDb: lowPnrMargin,
    tStart: templateGate.tStart,
    matchedBands: templateGate.matchedBands,
    perBandMarginDb: templateGate.perBandMarginDb,
    sampleRate,
    durationS: Math.round(durationS * 100) / 100,
    gateFired,
  };

  return {
    ok: true,
    rejectReason: null,
    warning,
    decayTruncated,
    canOverrideLowPnr,
    lowConfidence,
    pnrDb: roundedPnr,
    dynamicRangeDb: minDr,
    weakestBandHz,
    clipped,
    irPlot,
    edcPlot,
    bands,
    tStart: templateGate.tStart,
    perBandMarginDb: templateGate.perBandMarginDb,
    matchedBands: templateGate.matchedBands,
    templateGate,
    sampleRate,
    durationS: Math.round(durationS * 100) / 100,
    deltaPostPreDb: Number.isFinite(deltaPostPreDb) ? Math.round(deltaPostPreDb * 10) / 10 : null,
    gateFired,
    diagnostics,
    timingsMs,
  };
}
