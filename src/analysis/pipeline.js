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
// Sweep Signature Validation (Octave Band Progression Gate)
// ---------------------------------------------------------------------------

/**
 * Validate that the recording contains the expected exponential sine sweep
 * by verifying the sequential chronological progression of octave band energy peaks.
 *
 * Principle:
 * An exponential sine sweep from f1 to f2 over duration T has an instantaneous frequency:
 *   f(t) = f1 * exp(t / L), where L = T / ln(f2 / f1).
 * Passing through successive octave band centres (125 to 4000 Hz) takes:
 *   Delta t = L * ln(2) ~= 0.683 s per octave step.
 * A genuine room sweep exhibits sequential energy peaks across all 6 octave bands
 * spaced approximately 0.68 s apart (total span t_4000 - t_125 ~= 3.41 s).
 * In contrast:
 *   - A hand clap or impulse puts energy into all bands at the exact same instant (dt ~= 0).
 *   - Ambient noise, speech bursts, or mains hum exhibit no systematic ordering.
 *
 * @param {Float32Array|Float64Array} signal - Audio samples
 * @param {number} sampleRate - Audio sample rate (Hz)
 * @param {object} [options] - Pipeline options
 * @returns {{
 *   ok: boolean,
 *   score: number,
 *   monotonicCount: number,
 *   dtValidCount: number,
 *   totalSpan: number,
 *   meanDtError: number,
 *   peakTimes: number[],
 *   dtList: number[]
 * }}
 */
export function checkSweepSignature(signal, sampleRate, options = {}) {
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

  // Composite score:
  // 40% weight on monotonicity ratio (intervals > 50ms)
  // 30% weight on interval closeness to theoretical 0.68s
  // 30% weight on total span closeness to theoretical 3.41s
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
      timingsMs,
    };
  }

  const signal = new Float64Array(samples);

  if (typeof sampleRate !== 'number' || sampleRate < MIN_SAMPLE_RATE) {
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

  // Sweep-signature gate: verify the recording contains our test sweep progression
  const tSigStart = performance.now();
  const sweepSig = checkSweepSignature(signal, sampleRate, options);
  timingsMs.sweepSigMs = performance.now() - tSigStart;

  // The low-PNR override is strictly gated by all three criteria:
  // 1. PNR inside [lowPnrFloor, pnrThreshold)
  // 2. Post-peak direct energy margin >= 1.5 dB (excludes stationary noise)
  // 3. Sweep signature progression confirmed (excludes claps, pops, and bursts)
  const canOverrideLowPnr = (peakVal > 1e-12) &&
    (roundedPnrDb >= lowPnrFloor) &&
    (roundedPnrDb < pnrThreshold) &&
    (deltaPostPreDb >= lowPnrMargin) &&
    sweepSig.ok;

  // Gate 1: Sweep signature check (applies to normal path and override path)
  if (!sweepSig.ok) {
    let rejectReason;
    if (roundedPnrDb >= pnrThreshold || (peakVal > 1e-12 && deltaPostPreDb >= lowPnrMargin)) {
      rejectReason = SWEEP_REJECT_NOT_SWEEP;
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
      sweepSignature: sweepSig,
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
        sweepSignature: sweepSig,
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

  return {
    ok: true,
    rejectReason: null,
    warning,
    decayTruncated,
    canOverrideLowPnr,
    lowConfidence,
    pnrDb: Math.round(pnrDb * 10) / 10,
    dynamicRangeDb: minDr,
    weakestBandHz,
    clipped,
    irPlot,
    edcPlot,
    bands,
    sweepSignature: sweepSig,
    timingsMs,
  };
}
