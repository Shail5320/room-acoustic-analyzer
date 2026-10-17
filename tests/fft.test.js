/**
 * tests/fft.test.js — Tests for src/dsp/fft.js
 *
 * Tasks 2.1 / 2.2 / 2.3:
 *   - FFT of known signals (impulse, sine)
 *   - IFFT(FFT(x)) round-trip: max sample error < 1e-10
 *   - Benchmark at N = 2^20; print wall-clock time (no assertion)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fft, ifft, fftPadded, realPart, nextPow2 } from '../src/dsp/fft.js';

// ---------------------------------------------------------------------------
// Helper: max absolute error between two arrays
// ---------------------------------------------------------------------------
function maxAbsErr(a, b, len = Math.min(a.length, b.length)) {
  let max = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Task 2.1 — FFT of known signals
// ---------------------------------------------------------------------------
test('FFT of unit impulse → all ones (real=1, imag=0)', () => {
  const N = 8;
  const signal = new Float64Array(N);
  signal[0] = 1.0;  // δ[0]

  const spec = fft(signal);
  // DFT of δ[0] = 1 for all k
  let maxErrRe = 0, maxErrIm = 0;
  for (let k = 0; k < N; k++) {
    const re = spec[2*k], im = spec[2*k+1];
    const errRe = Math.abs(re - 1.0), errIm = Math.abs(im);
    if (errRe > maxErrRe) maxErrRe = errRe;
    if (errIm > maxErrIm) maxErrIm = errIm;
  }
  console.log(`  impulse FFT: max |Re-1| = ${maxErrRe.toExponential(3)}, max |Im| = ${maxErrIm.toExponential(3)}`);
  assert.ok(maxErrRe < 1e-14, `Re error ${maxErrRe} too large`);
  assert.ok(maxErrIm < 1e-14, `Im error ${maxErrIm} too large`);
});

test('FFT of cosine → single spike at correct bin', () => {
  // x[n] = cos(2π·k0·n/N) → spike at bin k0 and N-k0 with amplitude N/2
  const N = 64, k0 = 5;
  const signal = new Float64Array(N);
  for (let n = 0; n < N; n++) signal[n] = Math.cos(2 * Math.PI * k0 * n / N);

  const spec = fft(signal);

  // Bin k0: Re ≈ N/2, Im ≈ 0
  const reK0 = spec[2*k0], imK0 = spec[2*k0+1];
  const errReK0 = Math.abs(reK0 - N/2);
  const errImK0 = Math.abs(imK0);
  console.log(`  cosine FFT bin ${k0}: Re=${reK0.toFixed(6)} (exp ${N/2}), Im=${imK0.toExponential(3)}`);
  assert.ok(errReK0 < 1e-10, `Bin ${k0} Re error ${errReK0}`);
  assert.ok(errImK0 < 1e-10, `Bin ${k0} Im error ${errImK0}`);

  // All other bins (except N-k0) should be ≈ 0
  let maxOther = 0;
  for (let k = 0; k < N; k++) {
    if (k === k0 || k === N - k0) continue;
    const mag = Math.hypot(spec[2*k], spec[2*k+1]);
    if (mag > maxOther) maxOther = mag;
  }
  console.log(`  max magnitude at other bins: ${maxOther.toExponential(3)}`);
  assert.ok(maxOther < 1e-10, `Leakage ${maxOther}`);
});

// ---------------------------------------------------------------------------
// Task 2.2 — Round-trip: IFFT(FFT(x)) ≈ x, max error < 1e-10
// ---------------------------------------------------------------------------
test('IFFT(FFT(x)) round-trip — random signal N=1024, max error < 1e-10', () => {
  const N = 1024;
  const signal = new Float64Array(N);
  // Deterministic pseudo-random signal (no Math.random dependency on RNG state)
  for (let i = 0; i < N; i++) signal[i] = Math.sin(i * 0.137) * Math.cos(i * 0.031 + 0.7);

  const spec      = fft(signal);
  const recovered = realPart(ifft(spec));

  let maxErr = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(recovered[i] - signal[i]);
    if (d > maxErr) maxErr = d;
  }
  console.log(`  round-trip max |error| = ${maxErr.toExponential(6)}`);
  assert.ok(maxErr < 1e-10, `Round-trip error ${maxErr} ≥ 1e-10`);
});

test('IFFT(FFT(x)) round-trip — large N=65536', () => {
  const N = 65536;
  const signal = new Float64Array(N);
  for (let i = 0; i < N; i++) signal[i] = Math.sin(i * 0.0013) + 0.5 * Math.cos(i * 0.0071);

  const spec      = fft(signal);
  const recovered = realPart(ifft(spec));

  let maxErr = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(recovered[i] - signal[i]);
    if (d > maxErr) maxErr = d;
  }
  console.log(`  round-trip N=${N} max |error| = ${maxErr.toExponential(6)}`);
  assert.ok(maxErr < 1e-10, `Round-trip error ${maxErr} ≥ 1e-10`);
});

// ---------------------------------------------------------------------------
// Task 2.3 — Benchmark FFT at N = 2^20 (print time, no threshold asserted)
// ---------------------------------------------------------------------------
test('Benchmark FFT at N = 2^20', () => {
  const N = 1 << 20; // 1 048 576
  const signal = new Float64Array(N);
  for (let i = 0; i < N; i++) signal[i] = Math.sin(i * 0.0001);

  // Warm-up: one run excluded from timing
  fft(signal);

  const t0 = performance.now();
  fft(signal);
  const t1 = performance.now();
  const wallMs = t1 - t0;

  console.log(`\n  FFT benchmark N=2^20 (${N} samples): ${wallMs.toFixed(2)} ms wall-clock\n`);
  // No threshold assertion — just print the time
});
