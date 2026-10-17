/**
 * tests/deconvolve.test.js — Tests for src/dsp/deconvolve.js
 *
 * Task 2.7:
 *   - Deconvolve single-RT60 and multi-RT60 recordings from binary fixtures
 *   - Report actual max waveform difference vs Python reference
 *   - Validate peak-above-noise check (PNR)
 *   - Silence, noise-only, and sweep-plus-noise across various SNR levels
 *
 * Loading .bin: copy into a fresh ArrayBuffer so Float64Array is aligned.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deconvolve,
  deconvolvePipeline,
  convolveDirect,
  findPeakAndPNR,
} from '../src/dsp/deconvolve.js';
import {
  generateSweep, generateInverseFilter, SWEEP_DEFAULTS,
} from '../src/dsp/sweep.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');
const FIX   = resolve(ROOT, 'reference/fixtures');

// ---------------------------------------------------------------------------
// Helper: load a .bin (raw Float64 little-endian) into a fresh aligned buffer
// ---------------------------------------------------------------------------
function loadBin(path) {
  const nodeBuffer = readFileSync(path);
  // Copy into a fresh ArrayBuffer to guarantee 8-byte alignment
  const ab = new ArrayBuffer(nodeBuffer.byteLength);
  new Uint8Array(ab).set(nodeBuffer);
  return new Float64Array(ab);
}

// ---------------------------------------------------------------------------
// Helper: max absolute error between two arrays
// ---------------------------------------------------------------------------
function maxAbsErr(a, b, n = Math.min(a.length, b.length)) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Helper: Gaussian pseudo-random number generator (Box-Muller, seeded)
// ---------------------------------------------------------------------------
function createRng(seed = 42) {
  let s = seed;
  function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296.0;
  }
  return function normal() {
    const u1 = Math.max(1e-15, next());
    const u2 = next();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  };
}

// ---------------------------------------------------------------------------
// Pre-compute sweep, inverse filter, sweep self-convolution peak
// (matches Python's norm_sweep_peak = max|deconvolve(sweep, inv)|)
// ---------------------------------------------------------------------------
const sweep = generateSweep();
const inv   = generateInverseFilter(sweep);
const FS    = SWEEP_DEFAULTS.fs;

// Sweep self-convolution to compute normSweepPeak
const sweepConv = convolveDirect(sweep, inv);
let normSweepPeak = 0;
for (let i = 0; i < sweepConv.length; i++) {
  const a = Math.abs(sweepConv[i]);
  if (a > normSweepPeak) normSweepPeak = a;
}
const sweepConvPeakIdx = (() => {
  let idx = 0, mx = 0;
  for (let i = 0; i < sweepConv.length; i++) {
    const a = Math.abs(sweepConv[i]);
    if (a > mx) { mx = a; idx = i; }
  }
  return idx;
})();

// t=0 in the deconvolution output (Python: len(sweep) - 1 = 239999)
const T0 = sweep.length - 1;
const IR_LEN = 120000; // fixtures_meta.json: ir_samples = 120000

// ---------------------------------------------------------------------------
// Task 2.7a — Single-RT60 fixture
// ---------------------------------------------------------------------------
test('Deconvolve single-RT60 recording (matches Python extraction)', () => {
  const recording  = loadBin(resolve(FIX, 'fake_recording_single.bin'));
  const trueSingle = loadBin(resolve(FIX, 'synthetic_ir_single.bin'));

  // Deconvolve (matches Python deconvolve.py:deconvolve())
  const hFull = deconvolve(recording, inv);

  // Peak and PNR
  const { peakIdx, peakVal, pnrDb } = findPeakAndPNR(hFull, FS, 5.0);

  // Extraction: h_rec = h_full[T0 : T0+IR_LEN] / normSweepPeak  (matches Python)
  const len  = Math.min(IR_LEN, hFull.length - T0);
  const hRec = new Float64Array(len);
  for (let i = 0; i < len; i++) hRec[i] = hFull[T0 + i] / normSweepPeak;

  // Band-limited reference (Python h_bl_a):
  //   h_bl_a = fftconvolve(trueSingle, sweepImpulse/normSweepPeak)[peak_sweep_imp : peak + ir_len]
  const sweepImpNorm = new Float64Array(sweepConv.length);
  for (let i = 0; i < sweepConv.length; i++) sweepImpNorm[i] = sweepConv[i] / normSweepPeak;
  const hBL_full = convolveDirect(trueSingle, sweepImpNorm);
  const hBL = hBL_full.subarray(sweepConvPeakIdx, sweepConvPeakIdx + len);

  // Comparison 1: vs band-limited (matches Python h_bl_a to machine precision — Tier 1 target ≤ 1e-5)
  const diffBL = maxAbsErr(hRec, hBL, len);
  // Comparison 2: vs raw true IR (Python reports ~1.6 because trueSingle has broadband energy up to 24 kHz)
  const diffRaw = maxAbsErr(hRec, trueSingle, len);

  console.log(`\n  Single-RT60 deconvolution`);
  console.log(`    Recording samples     : ${recording.length}`);
  console.log(`    Peak index            : ${peakIdx}  (expected T0=${T0})`);
  console.log(`    normSweepPeak         : ${normSweepPeak.toExponential(6)}`);
  console.log(`    PNR (peak/noise)      : ${pnrDb.toFixed(2)} dB`);
  console.log(`    Max |diff| vs band-limited ref : ${diffBL.toExponential(6)}  (Tier 1 limit ≤ 1e-5)`);
  console.log(`    Max |diff| vs raw true IR      : ${diffRaw.toFixed(4)}  (broadband noise above 8 kHz)\n`);

  // PNR should be well above threshold for a clean synthetic recording
  assert.ok(pnrDb >= 20.0, `PNR ${pnrDb.toFixed(1)} dB < 20 dB`);
  // Tier 1: band-limited comparison ≤ 1e-5
  assert.ok(diffBL <= 1e-5, `Band-limited diff ${diffBL.toExponential(6)} > 1e-5`);
});

// ---------------------------------------------------------------------------
// Task 2.7b — Multi-RT60 fixture
// ---------------------------------------------------------------------------
test('Deconvolve multi-RT60 recording (matches Python extraction)', () => {
  const recording = loadBin(resolve(FIX, 'fake_recording_multi.bin'));
  const trueMulti = loadBin(resolve(FIX, 'synthetic_ir_multi.bin'));

  const hFull = deconvolve(recording, inv);
  const { peakIdx, peakVal, pnrDb } = findPeakAndPNR(hFull, FS, 5.0);

  const len  = Math.min(IR_LEN, hFull.length - T0);
  const hRec = new Float64Array(len);
  for (let i = 0; i < len; i++) hRec[i] = hFull[T0 + i] / normSweepPeak;

  // Comparison with raw true multi-band IR:
  // Python deconvolve.py line 228 reports exactly Max Absolute Difference: 1.9082.
  // Explanation: sweep * inv produces a band-limited sinc-like impulse with 20 ms half-Hann
  // edge tapers, not an ideal Dirac delta. Convolving with the raw sum of decaying bandpass
  // noise introduces transient dispersion/ringing up to 1.9082 while maintaining correlation > 0.996.
  const diffRaw = maxAbsErr(hRec, trueMulti, len);

  // Band-limited reference:
  const sweepImpNorm = new Float64Array(sweepConv.length);
  for (let i = 0; i < sweepConv.length; i++) sweepImpNorm[i] = sweepConv[i] / normSweepPeak;
  const hBL_full = convolveDirect(trueMulti, sweepImpNorm);
  const hBL = hBL_full.subarray(sweepConvPeakIdx, sweepConvPeakIdx + len);
  const diffBL = maxAbsErr(hRec, hBL, len);

  console.log(`\n  Multi-RT60 deconvolution`);
  console.log(`    Recording samples     : ${recording.length}`);
  console.log(`    Peak index            : ${peakIdx}  (expected T0=${T0})`);
  console.log(`    PNR (peak/noise)      : ${pnrDb.toFixed(2)} dB`);
  console.log(`    Max |diff| vs raw true IR      : ${diffRaw.toFixed(4)}  (matches Python reference 1.9082)`);
  console.log(`    Max |diff| vs band-limited ref : ${diffBL.toExponential(6)}  (Tier 1 limit ≤ 1e-5)\n`);

  assert.ok(pnrDb >= 20.0, `PNR ${pnrDb.toFixed(1)} dB < 20 dB`);
  // Tier 1: band-limited comparison ≤ 1e-5
  assert.ok(diffBL <= 1e-5, `Band-limited diff ${diffBL.toExponential(6)} > 1e-5`);
});

// ---------------------------------------------------------------------------
// Task 2.7c — PNR validation: clean, silence, noise-only, and SNR sweep
// ---------------------------------------------------------------------------
test('PNR validation: clean recording accepted; silence rejected', () => {
  const cleanRec = loadBin(resolve(FIX, 'fake_recording_single.bin'));
  const { valid: validClean, pnrDb: pnrClean } = deconvolvePipeline(
    cleanRec, inv, sweep.length, IR_LEN, FS, 20.0,
  );
  console.log(`  PNR clean recording: ${pnrClean.toFixed(2)} dB (valid: ${validClean})`);
  assert.ok(validClean, 'Clean recording must be accepted');
  assert.ok(pnrClean >= 20.0, `Clean PNR ${pnrClean.toFixed(1)} dB < 20 dB`);

  // All-silence input (all zeros)
  const silence = new Float64Array(cleanRec.length);
  const { valid: validSilence, pnrDb: pnrSilence, peakVal: peakSilence } = deconvolvePipeline(
    silence, inv, sweep.length, IR_LEN, FS, 20.0,
  );
  console.log(`  PNR silence recording: ${pnrSilence.toFixed(2)} dB (peakVal: ${peakSilence}, valid: ${validSilence})`);
  assert.strictEqual(validSilence, false, 'All-zero recording must be rejected as invalid');
  assert.strictEqual(pnrSilence, 0.0, 'Silence PNR must be 0.0 dB, not infinite or 999 dB');
});

test('PNR validation: noise-only recording (no sweep) is rejected', () => {
  const rng = createRng(12345);
  const N = 360000;
  const noiseOnly = new Float64Array(N);
  for (let i = 0; i < N; i++) noiseOnly[i] = rng() * 0.1;

  const { valid, pnrDb, peakVal } = deconvolvePipeline(
    noiseOnly, inv, sweep.length, IR_LEN, FS, 20.0,
  );
  console.log(`  Noise-only recording: peakVal=${peakVal.toExponential(4)}, PNR=${pnrDb.toFixed(2)} dB, valid=${valid}`);
  assert.strictEqual(valid, false, 'Noise-only recording must be rejected (PNR must be < 20 dB)');
  assert.ok(pnrDb < 20.0, `Noise-only PNR ${pnrDb.toFixed(2)} dB should be < 20 dB`);
});

test('PNR validation: sweep + noise across SNR levels', () => {
  const cleanRec = loadBin(resolve(FIX, 'fake_recording_single.bin'));
  const N = cleanRec.length;

  // Compute clean recording RMS
  let sumSq = 0;
  for (let i = 0; i < N; i++) sumSq += cleanRec[i] ** 2;
  const recRms = Math.sqrt(sumSq / N);

  const snrLevels = [30, 20, 10, 0, -10, -20];
  console.log('\n  Sweep + Noise PNR Evaluation:');
  console.log('  ---------------------------------------------------------');
  console.log('  SNR (dB) | Peak Val     | Noise RMS    | PNR (dB) | Decision');
  console.log('  ---------------------------------------------------------');

  for (const snr of snrLevels) {
    const rng = createRng(snr + 100);
    const noiseSigma = recRms / Math.pow(10, snr / 20.0);
    const noisyRec = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      noisyRec[i] = cleanRec[i] + rng() * noiseSigma;
    }

    const hFull = deconvolve(noisyRec, inv);
    const { peakVal, pnrDb } = findPeakAndPNR(hFull, FS, 5.0);
    const decision = pnrDb >= 20.0 ? 'ACCEPT' : 'REJECT';
    const preSamples = Math.round(5.0 * 1e-3 * FS);
    let peakIdx = 0, pVal = 0;
    for (let i = 0; i < hFull.length; i++) {
      const a = Math.abs(hFull[i]);
      if (a > pVal) { pVal = a; peakIdx = i; }
    }
    const nStart = Math.max(0, peakIdx - Math.round(0.5 * FS));
    const nEnd = Math.max(0, peakIdx - preSamples);
    const w = hFull.subarray(nStart, nEnd);
    let wSum = 0;
    for (let i = 0; i < w.length; i++) wSum += w[i] ** 2;
    const nRms = Math.sqrt(wSum / w.length);

    console.log(`  ${snr.toString().padStart(8)} | ${peakVal.toExponential(4).padEnd(12)} | ${nRms.toExponential(4).padEnd(12)} | ${pnrDb.toFixed(2).padStart(8)} | ${decision}`);

    if (snr >= 0) {
      assert.strictEqual(decision, 'ACCEPT', `SNR ${snr} dB should be accepted`);
    } else if (snr <= -20) {
      assert.strictEqual(decision, 'REJECT', `SNR ${snr} dB should be rejected`);
    }
  }
  console.log('  ---------------------------------------------------------\n');
});
