/**
 * src/dsp/sweep.js — Exponential sine sweep and Farina inverse filter.
 *
 * Config constants match the Python reference (sweep.py):
 *   f1 = 50 Hz, f2 = 8000 Hz, T = 5 s, fs = 48000 Hz, fade = 20 ms
 *
 * Exported:
 *   generateSweep(f1, f2, T, fs, fadeMs)  → Float64Array
 *   generateInverseFilter(sweep, f1, f2, T, fs) → Float64Array
 *   computeInverseSpectrum(invFilter, nFft) → Float64Array (interleaved, zero-padded)
 *   computePeakToSidelobe(conv, fs, windowMs) → { psrDb, peakVal, maxSidelobe, peakIdx }
 *   SWEEP_DEFAULTS
 */

import { fftPadded, nextPow2 } from './fft.js';

// ---------------------------------------------------------------------------
// Configuration constants (match Python reference)
// ---------------------------------------------------------------------------
export const SWEEP_DEFAULTS = {
  f1: 50.0,
  f2: 8000.0,
  T: 5.0,
  fs: 48000,
  fadeMs: 20.0,
};

// ---------------------------------------------------------------------------
// Sweep generation
// ---------------------------------------------------------------------------

/**
 * Generate an exponential sine sweep with half-Hann fade-in/out.
 *
 * Theory (Farina 2000):
 *   L = T / ln(f2/f1)
 *   K = 2π·f1·L
 *   φ(t) = K·(exp(t/L) − 1)
 *   x(t) = sin(φ(t))
 *
 * Fades are half-Hann windows of length round(fadeMs·fs/1000):
 *   in : 0.5·(1 − cos(π·n/N_fade))
 *   out: 0.5·(1 + cos(π·n/N_fade))
 *
 * @param {number} f1      — start frequency (Hz)
 * @param {number} f2      — end frequency (Hz)
 * @param {number} T       — duration (s)
 * @param {number} fs      — sample rate (Hz)
 * @param {number} fadeMs  — half-Hann fade length (ms)
 * @returns {Float64Array}
 */
export function generateSweep(
  f1 = SWEEP_DEFAULTS.f1,
  f2 = SWEEP_DEFAULTS.f2,
  T  = SWEEP_DEFAULTS.T,
  fs = SWEEP_DEFAULTS.fs,
  fadeMs = SWEEP_DEFAULTS.fadeMs,
) {
  const N = Math.round(T * fs);
  const L = T / Math.log(f2 / f1);
  const K = 2.0 * Math.PI * f1 * L;

  const sweep = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / fs;
    sweep[i] = Math.sin(K * (Math.exp(t / L) - 1.0));
  }

  // Half-Hann fade-in and fade-out
  const fadeLen = Math.round(fadeMs * 1e-3 * fs);
  if (fadeLen > 0 && 2 * fadeLen <= N) {
    for (let n = 0; n < fadeLen; n++) {
      sweep[n]           *= 0.5 * (1.0 - Math.cos(Math.PI * n / fadeLen));
      sweep[N - fadeLen + n] *= 0.5 * (1.0 + Math.cos(Math.PI * n / fadeLen));
    }
  }

  return sweep;
}

// ---------------------------------------------------------------------------
// Inverse filter
// ---------------------------------------------------------------------------

/**
 * Generate the Farina inverse filter:
 *   x_inv(t) = sweep(T − t) · exp(−t / L)
 *
 * This time-reversal + exponential tapering results in a +3 dB/octave amplitude
 * slope that, when convolved with the sweep, yields a flat spectrum across [f1, f2].
 *
 * @param {Float64Array} sweep  — output of generateSweep()
 * @param {number} f1
 * @param {number} f2
 * @param {number} T
 * @param {number} fs
 * @returns {Float64Array}
 */
export function generateInverseFilter(
  sweep,
  f1 = SWEEP_DEFAULTS.f1,
  f2 = SWEEP_DEFAULTS.f2,
  T  = SWEEP_DEFAULTS.T,
  fs = SWEEP_DEFAULTS.fs,
) {
  const N = sweep.length;
  const L = T / Math.log(f2 / f1);
  const inv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / fs;
    inv[i] = sweep[N - 1 - i] * Math.exp(-t / L);
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Pre-computed inverse spectrum (for reuse across deconvolutions)
// ---------------------------------------------------------------------------

/**
 * Zero-pad the inverse filter to nFft and compute its FFT spectrum.
 * The result is stored as an interleaved Float64Array [re0,im0,re1,im1,…]
 * and can be reused for all deconvolutions in a session.
 *
 * @param {Float64Array} invFilter — output of generateInverseFilter()
 * @param {number}       nFft     — FFT size (power of two); if omitted,
 *                                  uses nextPow2(invFilter.length)
 * @returns {{ spectrum: Float64Array, nFft: number }}
 */
export function computeInverseSpectrum(invFilter, nFft) {
  const size = nFft ?? nextPow2(invFilter.length);
  const spectrum = fftPadded(invFilter, size);
  return { spectrum, nFft: size };
}

// ---------------------------------------------------------------------------
// Peak-to-sidelobe ratio
// ---------------------------------------------------------------------------

/**
 * Compute peak-to-sidelobe ratio (dB) for a convolution result.
 * Matches the Python reference: window_ms half-width excluded from sidelobe.
 *
 * @param {Float64Array} conv     — full convolution output (real samples)
 * @param {number}       fs
 * @param {number}       windowMs — half-width exclusion window (ms), default 5
 * @returns {{ psrDb: number, peakVal: number, maxSidelobe: number, peakIdx: number }}
 */
export function computePeakToSidelobe(conv, fs = SWEEP_DEFAULTS.fs, windowMs = 5.0) {
  const windowSamples = Math.round(windowMs * 1e-3 * fs);
  let peakIdx = 0;
  let peakVal = Math.abs(conv[0]);
  for (let i = 1; i < conv.length; i++) {
    const a = Math.abs(conv[i]);
    if (a > peakVal) { peakVal = a; peakIdx = i; }
  }

  const lo = Math.max(0, peakIdx - windowSamples);
  const hi = Math.min(conv.length, peakIdx + windowSamples + 1);

  let maxSidelobe = 0.0;
  for (let i = 0; i < lo; i++) {
    const a = Math.abs(conv[i]);
    if (a > maxSidelobe) maxSidelobe = a;
  }
  for (let i = hi; i < conv.length; i++) {
    const a = Math.abs(conv[i]);
    if (a > maxSidelobe) maxSidelobe = a;
  }
  if (maxSidelobe < 1e-12) maxSidelobe = 1e-12;

  const psrDb = 20.0 * Math.log10(peakVal / maxSidelobe);
  return { psrDb, peakVal, maxSidelobe, peakIdx };
}
