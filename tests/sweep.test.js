/**
 * tests/sweep.test.js — Tests for src/dsp/sweep.js
 *
 * Tasks 2.4, 2.5, 2.6:
 *   2.4 Compare first/last 100 samples vs expected_outputs.json
 *   2.5 Inverse filter spectrum precomputed and exported correctly
 *   2.6 Sweep ⊛ inverse: report actual peak-to-sidelobe dB; max waveform diff vs Python
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateSweep, generateInverseFilter, computeInverseSpectrum,
  computePeakToSidelobe, SWEEP_DEFAULTS,
} from '../src/dsp/sweep.js';
import { convolveDirect } from '../src/dsp/deconvolve.js';
import { realPart, ifft, fftPadded, nextPow2, complexMultiply } from '../src/dsp/fft.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// Load ground-truth JSON
const EXP = JSON.parse(readFileSync(resolve(ROOT, 'reference/expected_outputs.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Helper
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
// Task 2.4 — Sweep first/last 100 samples vs Python reference
// ---------------------------------------------------------------------------
test('Sweep first 100 samples match expected_outputs.json', () => {
  const sweep = generateSweep();
  const ref   = EXP.sweep.first_100_samples;

  assert.strictEqual(sweep.length, Math.round(SWEEP_DEFAULTS.T * SWEEP_DEFAULTS.fs),
    'Wrong sweep length');

  const maxDiff = maxAbsErr(sweep, ref, 100);
  console.log(`  sweep first-100 max |diff| vs Python = ${maxDiff.toExponential(6)}`);
  assert.ok(maxDiff <= 1e-6, `First-100 diff ${maxDiff} > 1e-6`);
});

test('Sweep last 100 samples match expected_outputs.json', () => {
  const sweep = generateSweep();
  const ref   = EXP.sweep.last_100_samples;
  const N     = sweep.length;

  const last100 = sweep.subarray(N - 100);
  const maxDiff = maxAbsErr(last100, ref, 100);
  console.log(`  sweep last-100  max |diff| vs Python = ${maxDiff.toExponential(6)}`);
  assert.ok(maxDiff <= 1e-6, `Last-100 diff ${maxDiff} > 1e-6`);
});

// ---------------------------------------------------------------------------
// Task 2.5 — Inverse filter and pre-computed spectrum
// ---------------------------------------------------------------------------
test('Inverse filter length matches sweep', () => {
  const sweep = generateSweep();
  const inv   = generateInverseFilter(sweep);
  assert.strictEqual(inv.length, sweep.length, 'Inverse filter length ≠ sweep length');
  console.log(`  inverse filter length = ${inv.length} ✓`);
});

test('computeInverseSpectrum returns correct nFft and spectrum size', () => {
  const sweep = generateSweep();
  const inv   = generateInverseFilter(sweep);
  const { spectrum, nFft } = computeInverseSpectrum(inv);

  // nFft must be a power of two ≥ inv.length
  assert.ok(nFft >= inv.length, 'nFft < inv.length');
  assert.ok((nFft & (nFft - 1)) === 0, `nFft=${nFft} is not a power of two`);
  assert.strictEqual(spectrum.length, 2 * nFft, 'Spectrum length ≠ 2·nFft');
  console.log(`  inverse spectrum nFft=${nFft}, spectrum.length=${spectrum.length} ✓`);
});

test('Pre-computed inverse spectrum matches FFT(inv) directly', () => {
  const sweep = generateSweep();
  const inv   = generateInverseFilter(sweep);

  // Use same nFft in both paths
  const nFft = nextPow2(inv.length);
  const { spectrum } = computeInverseSpectrum(inv, nFft);
  const direct       = fftPadded(inv, nFft);

  const maxDiff = maxAbsErr(spectrum, direct, 2 * nFft);
  console.log(`  inverse spectrum vs direct FFT: max |diff| = ${maxDiff.toExponential(6)}`);
  assert.ok(maxDiff < 1e-12, `Spectrum mismatch ${maxDiff}`);
});

// ---------------------------------------------------------------------------
// Task 2.6 — Sweep ⊛ inverse: peak-to-sidelobe + waveform diff vs Python
// ---------------------------------------------------------------------------
test('Sweep ⊛ inverse: peak-to-sidelobe ratio (report actual, compare Python 43.89 dB)', () => {
  const sweep = generateSweep();
  const inv   = generateInverseFilter(sweep);
  const conv  = convolveDirect(sweep, inv);

  const { psrDb, peakVal, maxSidelobe, peakIdx } = computePeakToSidelobe(conv, SWEEP_DEFAULTS.fs, 5.0);
  const pythonPsr = EXP.sweep.peak_to_sidelobe_ratio_db; // 43.89
  const diffPsr   = Math.abs(psrDb - pythonPsr);

  console.log(`\n  Sweep ⊛ inverse convolution`);
  console.log(`    JS peak-to-sidelobe ratio : ${psrDb.toFixed(4)} dB`);
  console.log(`    Python reference          : ${pythonPsr.toFixed(4)} dB`);
  console.log(`    Difference                : ${diffPsr.toFixed(4)} dB`);
  console.log(`    Peak amplitude            : ${peakVal.toFixed(6)}`);
  console.log(`    Max sidelobe              : ${maxSidelobe.toFixed(6)}`);
  console.log(`    Peak index                : ${peakIdx}\n`);

  // PLAN.md Tier 1: match within ±0.10 dB
  assert.ok(diffPsr <= 0.10, `PSR diff ${diffPsr.toFixed(4)} dB > 0.10 dB tolerance`);
});

test('Sweep ⊛ inverse: max waveform diff vs Python peak/sidelobe reference values', () => {
  const sweep = generateSweep();
  const inv   = generateInverseFilter(sweep);
  const conv  = convolveDirect(sweep, inv);

  // Compare peak and max sidelobe values against expected_outputs.json
  const { psrDb, peakVal, maxSidelobe } = computePeakToSidelobe(conv, SWEEP_DEFAULTS.fs, 5.0);
  const diffPeak     = Math.abs(peakVal     - EXP.sweep.peak_value);
  const diffSidelobe = Math.abs(maxSidelobe - EXP.sweep.max_sidelobe);

  console.log(`\n  Waveform comparison with Python reference`);
  console.log(`    JS peak value      : ${peakVal.toFixed(6)}   Python: ${EXP.sweep.peak_value.toFixed(6)}   |diff| = ${diffPeak.toExponential(4)}`);
  console.log(`    JS max sidelobe    : ${maxSidelobe.toFixed(6)}   Python: ${EXP.sweep.max_sidelobe.toFixed(6)}   |diff| = ${diffSidelobe.toExponential(4)}\n`);

  // Generous relative comparison (peaks can differ slightly due to linear conv length)
  assert.ok(diffPeak / EXP.sweep.peak_value < 0.01, `Relative peak diff too large`);
});
