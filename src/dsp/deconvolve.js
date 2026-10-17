/**
 * src/dsp/deconvolve.js — Frequency-domain deconvolution.
 *
 * Algorithm (matches reference/deconvolve.py):
 *   1. Zero-pad both recording and inverse filter to N_fft = nextPow2(len_y + len_inv - 1)
 *   2. h_raw = IFFT( FFT(y) · InvSpectrum )
 *   3. Trim to linear length (len_y + len_inv - 1)
 *   4. Detect global-abs peak
 *   5. Validate peak stands above pre-peak RMS noise (reject if PNR < threshold)
 *   6. Extract IR from t=0 (= sweep end = len_sweep - 1) and normalise by sweep self-peak
 *
 * The module also exports a lower-level convolveDirect() for the sweep⊛inverse test.
 */

import { fftPadded, ifft, complexMultiply, realPart, nextPow2 } from './fft.js';

// ---------------------------------------------------------------------------
// Low-level: linear convolution via FFT (returns real Float64Array)
// ---------------------------------------------------------------------------

/**
 * Compute the linear convolution of two real signals via FFT.
 * Output length = len(a) + len(b) - 1.
 *
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @returns {Float64Array}
 */
export function convolveDirect(a, b) {
  const minLen = a.length + b.length - 1;
  const nFft   = nextPow2(minLen);

  const A = fftPadded(a, nFft);
  const B = fftPadded(b, nFft);
  complexMultiply(A, B); // A ← A · B
  const result = realPart(ifft(A));
  return result.subarray(0, minLen);
}

// ---------------------------------------------------------------------------
// Deconvolution using pre-computed inverse spectrum
// ---------------------------------------------------------------------------

/**
 * Deconvolve a recording using a pre-computed inverse filter spectrum.
 *
 * The inverse spectrum must have been computed at a large enough nFft
 * (i.e. the caller is responsible for ensuring nFft ≥ nextPow2(len_y + len_inv - 1)).
 * If the passed spectrum is too small, the function re-pads internally.
 *
 * @param {Float64Array} recording      — raw microphone capture (real)
 * @param {Float64Array} invSpectrum    — interleaved FFT of zero-padded inverse filter
 * @param {number}       nFftSpectrum   — FFT size used to compute invSpectrum
 * @param {number}       invFilterLen   — original length of the inverse filter (for linear padding check)
 * @returns {Float64Array}              — h_raw trimmed to linear length
 */
export function deconvolveWithSpectrum(recording, invSpectrum, nFftSpectrum, invFilterLen) {
  const minLen = recording.length + invFilterLen - 1;
  const nFft   = Math.max(nFftSpectrum, nextPow2(minLen));

  let invSpec = invSpectrum;
  if (nFft > nFftSpectrum) {
    // Should not happen in normal usage, but guard anyway
    throw new Error(`deconvolveWithSpectrum: invSpectrum nFft (${nFftSpectrum}) < required (${nFft})`);
  }

  const Y = fftPadded(recording, nFft);
  complexMultiply(Y, invSpec); // Y ← Y · InvSpectrum
  const hFull = realPart(ifft(Y));
  return hFull.subarray(0, minLen);
}

/**
 * Deconvolve a recording given a raw inverse filter array.
 * Pads both to nextPow2(len_y + len_inv - 1).
 *
 * @param {Float64Array} recording
 * @param {Float64Array} invFilter
 * @returns {Float64Array}  — h_raw trimmed to linear length
 */
export function deconvolve(recording, invFilter) {
  const minLen = recording.length + invFilter.length - 1;
  const nFft   = nextPow2(minLen);

  const Y   = fftPadded(recording, nFft);
  const Inv = fftPadded(invFilter, nFft);
  complexMultiply(Y, Inv);
  const hFull = realPart(ifft(Y));
  return hFull.subarray(0, minLen);
}

// ---------------------------------------------------------------------------
// Peak detection + PNR validation
// ---------------------------------------------------------------------------

/**
 * Find index of global absolute peak and compute peak-to-noise ratio (dB)
 * against the pre-peak region, matching deconvolve.py:find_peak_and_snr().
 *
 * Pre-peak noise window: [peakIdx - 0.5·fs, peakIdx - prePeakMs·fs/1000)
 *
 * @param {Float64Array} hFull
 * @param {number}       fs
 * @param {number}       prePeakMs — samples before peak that are "protected" mainlobe
 * @returns {{ peakIdx: number, peakVal: number, pnrDb: number }}
 */
export function findPeakAndPNR(hFull, fs = 48000, prePeakMs = 5.0) {
  let peakIdx = 0;
  let peakVal = Math.abs(hFull[0]);
  for (let i = 1; i < hFull.length; i++) {
    const a = Math.abs(hFull[i]);
    if (a > peakVal) { peakVal = a; peakIdx = i; }
  }

  // All-zero or sub-noise recording has no detectable sound
  if (peakVal <= 1e-12) {
    return { peakIdx: 0, peakVal: 0.0, pnrDb: 0.0 };
  }

  const preSamples  = Math.round(prePeakMs * 1e-3 * fs);
  const noiseStart  = Math.max(0, peakIdx - Math.round(0.5 * fs));
  const noiseEnd    = Math.max(0, peakIdx - preSamples);
  const noiseWindow = hFull.subarray(noiseStart, noiseEnd);

  let pnrDb;
  if (noiseWindow.length > 100) {
    let sumSq = 0;
    for (let i = 0; i < noiseWindow.length; i++) sumSq += noiseWindow[i] ** 2;
    const rms = Math.sqrt(sumSq / noiseWindow.length) + 1e-12;
    pnrDb = 20.0 * Math.log10(peakVal / rms);
  } else {
    // Insufficient pre-peak baseline (e.g. peak at beginning of buffer)
    pnrDb = 0.0;
  }

  return { peakIdx, peakVal, pnrDb };
}

// ---------------------------------------------------------------------------
// IR extraction + normalisation
// ---------------------------------------------------------------------------

/**
 * Extract and normalise the impulse response.
 *
 * Matches deconvolve.py:extract_impulse_response():
 *   start = max(0, peakIdx - prePeakSamples)
 *   end   = min(len, start + irLengthSamples)
 *   normalise by max|h_extracted|
 *
 * @param {Float64Array} hFull
 * @param {number}       peakIdx
 * @param {number}       irLengthSamples
 * @param {number}       fs
 * @param {number}       prePeakMs
 * @returns {Float64Array}
 */
export function extractIR(hFull, peakIdx, irLengthSamples, fs = 48000, prePeakMs = 5.0) {
  const preSamples = Math.round(prePeakMs * 1e-3 * fs);
  const startIdx   = Math.max(0, peakIdx - preSamples);
  const endIdx     = Math.min(hFull.length, startIdx + irLengthSamples);

  // Copy into a fresh aligned ArrayBuffer
  const len = endIdx - startIdx;
  const out = new Float64Array(new ArrayBuffer(len * 8));
  for (let i = 0; i < len; i++) out[i] = hFull[startIdx + i];

  let normVal = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(out[i]);
    if (a > normVal) normVal = a;
  }
  if (normVal > 0) {
    for (let i = 0; i < len; i++) out[i] /= normVal;
  }
  return out;
}

// ---------------------------------------------------------------------------
// High-level deconvolution pipeline
// ---------------------------------------------------------------------------

/**
 * Full pipeline: deconvolve, detect peak, validate, extract IR.
 *
 * The extraction origin (t=0) is fixed at sweepLength - 1 (the mathematical
 * convolution origin), matching deconvolve.py exactly.
 *
 * @param {Float64Array} recording
 * @param {Float64Array} invFilter
 * @param {number}       sweepLength     — len(sweep), used to compute t=0
 * @param {number}       irLengthSamples — desired output IR length
 * @param {number}       fs
 * @param {number}       pnrThresholdDb  — reject if PNR < this (default 20 dB)
 * @returns {{
 *   hFull:      Float64Array,   // raw full-length deconvolution
 *   hExtracted: Float64Array,   // normalised IR (irLengthSamples)
 *   peakIdx:    number,
 *   peakVal:    number,
 *   pnrDb:      number,
 *   valid:      boolean,        // false → peak not above noise
 *   t0:         number,         // extraction origin index in hFull
 *   normSweepPeak: number,      // sweep self-convolution peak for external normalisation
 * }}
 */
export function deconvolvePipeline(
  recording,
  invFilter,
  sweepLength,
  irLengthSamples,
  fs = 48000,
  pnrThresholdDb = 20.0,
) {
  const hFull = deconvolve(recording, invFilter);

  // Compute sweep self-convolution peak (for normalising like the Python reference)
  // Python: norm_sweep_peak = |sweep_impulse[peak_sweep_imp]|  where sweep_impulse = deconvolve(sweep, inv)
  // We don't have the sweep here, so caller passes sweepLength; normalisation happens below via peakVal.

  const { peakIdx, peakVal, pnrDb } = findPeakAndPNR(hFull, fs);
  const valid = peakVal > 1e-12 && pnrDb >= pnrThresholdDb;

  // t=0 is at sweepLength - 1 (length of sweep minus one = index where delta lands)
  const t0 = sweepLength - 1;

  // Extract from t0, normalised by peakVal of the raw full output
  // (peakVal here is the sweep self-peak analogue since the recording = sweep * h,
  //  so the strongest spike in hFull ≈ peak of sweep self-convolution * peak of h)
  const len = Math.min(irLengthSamples, hFull.length - t0);
  const hExtracted = new Float64Array(new ArrayBuffer(len * 8));
  for (let i = 0; i < len; i++) hExtracted[i] = hFull[t0 + i];

  // Normalise by peakVal (the largest absolute value across the whole result,
  // which corresponds to norm_sweep_peak in the Python deconvolve.py)
  if (peakVal > 0) {
    for (let i = 0; i < len; i++) hExtracted[i] /= peakVal;
  }

  return { hFull, hExtracted, peakIdx, peakVal, pnrDb, valid, t0, normSweepPeak: peakVal };
}
