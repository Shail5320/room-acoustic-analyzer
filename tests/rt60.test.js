/**
 * tests/rt60.test.js — Tests for src/dsp/rt60.js
 *
 * Tasks 2.10 - 2.14:
 *   2.10 / 2.11  Schroeder integration, EDC, T20/T30/EDT regression, R^2,
 *                noise floor estimation, simplified truncation, validity tiers.
 *   2.12         End-to-end recovery on single-RT60 fixture:
 *                  - Tier 1: JS matches expected_outputs.json within ≤ 0.001 s (≤ 0.1%).
 *                  - Tier 2: Recovers true 0.800 s within Monte Carlo 2σ bounds.
 *   2.13         End-to-end recovery on multi-RT60 fixture:
 *                  - Tier 1: JS matches expected_outputs.json within ≤ 0.001 s (≤ 0.1%).
 *                  - Tier 2: Recovers target values within Monte Carlo mean ± 2σ bounds.
 *   2.14         Noise dynamic-range table (DR 45/35/25/15 dB):
 *                  - Tiers match Python reference exactly (valid, approximate, invalid).
 *                  - Valid/approximate metrics agree with Python within ≤ 0.005 s.
 *                  - Un-truncated corrupted curves rejected as invalid.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeEDC,
  fitDecay,
  analyzeRT60,
  FIT_RANGE_T30,
  FIT_RANGE_T20,
  TIER_MARGIN_DB,
  MIN_R2,
} from '../src/dsp/rt60.js';
import {
  designOctaveFilters,
  sosFilt,
  CENTRE_FREQUENCIES,
  DEFAULT_FS,
} from '../src/dsp/bands.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');
const FIX   = resolve(ROOT, 'reference/fixtures');
const EXP   = JSON.parse(readFileSync(resolve(ROOT, 'reference/expected_outputs.json'), 'utf8'));

// Helper: load raw Float64 binary fixture into aligned Float64Array
function loadBin(path) {
  const nodeBuf = readFileSync(path);
  const ab = new ArrayBuffer(nodeBuf.byteLength);
  new Uint8Array(ab).set(nodeBuf);
  return new Float64Array(ab);
}

// ---------------------------------------------------------------------------
// Unit Tests: Algorithm Building Blocks & Edge Cases
// ---------------------------------------------------------------------------

test('fitDecay: fits known linear slope and calculates exact RT60 and R^2', () => {
  // A perfect exponential decay of -60 dB in 1.2 seconds:
  // EDC_dB(t) = -50 * t
  // Slope m = -50 dB/s => RT60 = -60 / -50 = 1.200 s.
  const fs = 1000;
  const N = 1500;
  const t = new Float64Array(N);
  const edcDb = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    t[i] = i / fs;
    edcDb[i] = -50.0 * t[i];
  }

  const { rt: t30, r2: r2T30 } = fitDecay(t, edcDb, -5.0, -35.0);
  assert.ok(Math.abs(t30 - 1.2) < 1e-10, `Expected 1.2 s, got ${t30}`);
  assert.ok(Math.abs(r2T30 - 1.0) < 1e-10, `Expected R^2 = 1.0, got ${r2T30}`);

  const { rt: t20, r2: r2T20 } = fitDecay(t, edcDb, -5.0, -25.0);
  assert.ok(Math.abs(t20 - 1.2) < 1e-10, `Expected 1.2 s, got ${t20}`);
  assert.ok(Math.abs(r2T20 - 1.0) < 1e-10, `Expected R^2 = 1.0, got ${r2T20}`);
});

test('fitDecay: returns NaN if fewer than minPoints or positive slope', () => {
  const t = new Float64Array([0, 1, 2]);
  const y = new Float64Array([-5, -10, -20]);
  const resFew = fitDecay(t, y, -5, -25, 10);
  assert.ok(Number.isNaN(resFew.rt));
  assert.ok(Number.isNaN(resFew.r2));

  // Positive slope (increasing energy)
  const tRising = new Float64Array(20);
  const yRising = new Float64Array(20);
  for (let i = 0; i < 20; i++) {
    tRising[i] = i;
    yRising[i] = -25 + i; // rises from -25 to -6
  }
  const resRising = fitDecay(tRising, yRising, -5, -25, 10);
  assert.ok(Number.isNaN(resRising.rt));
});

test('computeEDC: handles empty or zero impulse response gracefully', () => {
  const zeroIR = new Float64Array(100);
  const resZero = computeEDC(zeroIR, 48000, true);
  assert.strictEqual(resZero.availableRangeDb, 0.0);
  assert.strictEqual(resZero.t.length, 1);
});

// ---------------------------------------------------------------------------
// Task 2.12 — Single-RT60 End-to-End Recovery vs expected_outputs.json
// ---------------------------------------------------------------------------

test('Task 2.12: Single-RT60 recovery on fixture (Tier 1 <= 0.001 s, Tier 2 within bounds)', () => {
  const irSingle = loadBin(resolve(FIX, 'synthetic_ir_single.bin'));
  const filters = designOctaveFilters(DEFAULT_FS, CENTRE_FREQUENCIES);
  const expSingle = EXP.single_rt60_recovery;

  // Monte Carlo 2-sigma bounds from PLAN.md (Single RT60 = 0.800 s)
  const tier2Bounds = {
    125:  { min: 0.696, max: 0.904, tolPct: 13.0 },
    250:  { min: 0.736, max: 0.864, tolPct: 8.0 },
    500:  { min: 0.752, max: 0.848, tolPct: 6.0 },
    1000: { min: 0.768, max: 0.832, tolPct: 4.0 },
    2000: { min: 0.776, max: 0.824, tolPct: 3.0 },
    4000: { min: 0.784, max: 0.816, tolPct: 2.0 },
  };

  console.log('\n========================================================================================================');
  console.log('Task 2.12: Single-RT60 Recovery (Fixture vs Python Reference vs Ground Truth)');
  console.log('========================================================================================================');
  console.log('Band (Hz) | JS RT60 (s) | Py Ref (s) | Tier 1 Diff (s) | True (s) | Error (%) | Tier 2 2σ Bounds (s)   | Tier  | Metric');
  console.log('--------------------------------------------------------------------------------------------------------');

  for (const fc of CENTRE_FREQUENCIES) {
    const sos = filters.get(fc);
    const filtered = sosFilt(sos, irSingle);
    const res = analyzeRT60(filtered, DEFAULT_FS, false);

    const ref = expSingle[String(fc)];
    const tier1Diff = Math.abs(res.rt60 - ref.recovered_rt60);
    const trueRT60 = ref.true_rt60;
    const errPct = ((res.rt60 - trueRT60) / trueRT60) * 100.0;
    const bounds = tier2Bounds[fc];

    const boundsStr = `[${bounds.min.toFixed(3)}, ${bounds.max.toFixed(3)}] (±${bounds.tolPct}%)`;

    console.log(
      `${fc.toString().padStart(9)} | ` +
      `${res.rt60.toFixed(4).padStart(11)} | ` +
      `${ref.recovered_rt60.toFixed(4).padStart(10)} | ` +
      `${tier1Diff.toFixed(6).padStart(15)} | ` +
      `${trueRT60.toFixed(3).padStart(8)} | ` +
      `${(errPct >= 0 ? '+' : '') + errPct.toFixed(2) + '%'}`.padStart(9) + ' | ' +
      `${boundsStr.padEnd(22)} | ` +
      `${res.tier.padEnd(5)} | ` +
      `${res.used}`
    );

    // Tier 1 acceptance: absolute difference <= 0.001 s (<= 0.1%)
    assert.ok(
      tier1Diff <= 0.001,
      `Band ${fc} Hz Tier 1 failed: |JS - Py| = ${tier1Diff.toFixed(6)} s > 0.001 s`
    );

    // Tier 2 acceptance: within Monte Carlo 2-sigma bounds
    assert.ok(
      res.rt60 >= bounds.min && res.rt60 <= bounds.max,
      `Band ${fc} Hz Tier 2 failed: ${res.rt60.toFixed(4)} s outside [${bounds.min}, ${bounds.max}] s`
    );

    // Validity tier and metric must match Python
    assert.strictEqual(res.tier, ref.tier, `Band ${fc} Hz tier mismatch`);
    assert.strictEqual(res.used, ref.used_metric, `Band ${fc} Hz metric mismatch`);
    assert.strictEqual(res.valid, ref.valid, `Band ${fc} Hz validity mismatch`);
  }
  console.log('--------------------------------------------------------------------------------------------------------\n');
});

// ---------------------------------------------------------------------------
// Task 2.13 — Multi-RT60 End-to-End Recovery vs expected_outputs.json
// ---------------------------------------------------------------------------

test('Task 2.13: Multi-RT60 recovery on fixture (Tier 1 <= 0.001 s, Tier 2 within bounds)', () => {
  const irMulti = loadBin(resolve(FIX, 'synthetic_ir_multi.bin'));
  const filters = designOctaveFilters(DEFAULT_FS, CENTRE_FREQUENCIES);
  const expMulti = EXP.multi_rt60_recovery;

  // Monte Carlo mean +/- 2-sigma bounds from PLAN.md
  const tier2Bounds = {
    125:  { target: 1.200, min: 1.046, max: 1.342, rangeStr: '[-12.8%, +11.8%]' },
    250:  { target: 1.000, min: 0.968, max: 1.125, rangeStr: '[-3.2%, +12.5%]' },
    500:  { target: 0.800, min: 0.805, max: 0.892, rangeStr: '[+0.6%, +11.5%]' },
    1000: { target: 0.700, min: 0.683, max: 0.740, rangeStr: '[-2.5%, +5.7%]' },
    2000: { target: 0.600, min: 0.598, max: 0.637, rangeStr: '[-0.4%, +6.2%]' },
    4000: { target: 0.500, min: 0.514, max: 0.539, rangeStr: '[+2.8%, +7.9%]' },
  };

  console.log('\n========================================================================================================');
  console.log('Task 2.13: Multi-RT60 Recovery (Fixture vs Python Reference vs Synthesis Targets)');
  console.log('========================================================================================================');
  console.log('Band (Hz) | JS RT60 (s) | Py Ref (s) | Tier 1 Diff (s) | Target(s)| Error (%) | Tier 2 2σ Bounds (s)   | Tier  | Metric');
  console.log('--------------------------------------------------------------------------------------------------------');

  for (const fc of CENTRE_FREQUENCIES) {
    const sos = filters.get(fc);
    const filtered = sosFilt(sos, irMulti);
    const res = analyzeRT60(filtered, DEFAULT_FS, false);

    const ref = expMulti[String(fc)];
    const tier1Diff = Math.abs(res.rt60 - ref.recovered_rt60);
    const bounds = tier2Bounds[fc];
    const target = bounds.target;
    const errPct = ((res.rt60 - target) / target) * 100.0;

    const boundsStr = `[${bounds.min.toFixed(3)}, ${bounds.max.toFixed(3)}] ${bounds.rangeStr}`;

    console.log(
      `${fc.toString().padStart(9)} | ` +
      `${res.rt60.toFixed(4).padStart(11)} | ` +
      `${ref.recovered_rt60.toFixed(4).padStart(10)} | ` +
      `${tier1Diff.toFixed(6).padStart(15)} | ` +
      `${target.toFixed(3).padStart(8)} | ` +
      `${(errPct >= 0 ? '+' : '') + errPct.toFixed(2) + '%'}`.padStart(9) + ' | ' +
      `${boundsStr.padEnd(22)} | ` +
      `${res.tier.padEnd(5)} | ` +
      `${res.used}`
    );

    // Tier 1 acceptance: absolute difference <= 0.001 s (<= 0.1%)
    assert.ok(
      tier1Diff <= 0.001,
      `Band ${fc} Hz Tier 1 failed: |JS - Py| = ${tier1Diff.toFixed(6)} s > 0.001 s`
    );

    // Tier 2 acceptance: within Monte Carlo empirical tolerance bounds
    assert.ok(
      res.rt60 >= bounds.min && res.rt60 <= bounds.max,
      `Band ${fc} Hz Tier 2 failed: ${res.rt60.toFixed(4)} s outside [${bounds.min}, ${bounds.max}] s`
    );

    // Validity tier and metric must match Python
    assert.strictEqual(res.tier, ref.tier, `Band ${fc} Hz tier mismatch`);
    assert.strictEqual(res.used, ref.used_metric, `Band ${fc} Hz metric mismatch`);
    assert.strictEqual(res.valid, ref.valid, `Band ${fc} Hz validity mismatch`);
  }
  console.log('--------------------------------------------------------------------------------------------------------\n');
});

// ---------------------------------------------------------------------------
// Task 2.14 — Noise Dynamic Range Table (DR 45, 35, 25, 15 dB)
// ---------------------------------------------------------------------------

test('Task 2.14: Noise dynamic range table (DR 45/35/25/15, tiers match Python exactly)', () => {
  const hSingle = loadBin(resolve(FIX, 'synthetic_ir_single.bin'));
  const noiseStd = loadBin(resolve(FIX, 'noise_normal_seed123.bin'));
  const expNoise = EXP.noise_test_dr;

  let peakPower = 0.0;
  for (let i = 0; i < hSingle.length; i++) {
    const p = hSingle[i] * hSingle[i];
    if (p > peakPower) peakPower = p;
  }

  const drLevels = [45, 35, 25, 15];

  console.log('\n====================================================================================================================');
  console.log('Task 2.14: Peak-to-Noise Dynamic Range (DR) & Validity Tiers Table (JS vs Python Reference)');
  console.log('====================================================================================================================');
  console.log('Condition                   | JS DR    | Py DR    | JS Tier     | Py Tier     | JS Used | Py Used | JS RT60 (s)| Py RT60 (s)| Diff (s)');
  console.log('--------------------------------------------------------------------------------------------------------------------');

  for (const dr of drLevels) {
    const sigma2 = peakPower / Math.pow(10, dr / 10.0);
    const std = Math.sqrt(sigma2);

    const noisy = new Float64Array(hSingle.length);
    for (let i = 0; i < hSingle.length; i++) {
      noisy[i] = hSingle[i] + noiseStd[i] * std;
    }

    const resRaw = analyzeRT60(noisy, DEFAULT_FS, false);
    const resTrunc = analyzeRT60(noisy, DEFAULT_FS, true);

    const ref = expNoise[`dr_${dr}db`];
    const refRaw = ref.without_truncation;
    const refTrunc = ref.with_truncation;

    // Evaluate un-truncated condition
    const rawCondName = `DR ${dr} dB (no trunc)`;
    const rawJsRt = Number.isNaN(resRaw.rt60) ? 'NaN' : resRaw.rt60.toFixed(4);
    const rawRefRt = 'NaN';
    console.log(
      `${rawCondName.padEnd(27)} | ` +
      `${resRaw.dynamic_range_db.toFixed(1).padStart(6)}dB | ` +
      `${refRaw.estimated_dr_db.toFixed(1).padStart(6)}dB | ` +
      `${resRaw.tier.padEnd(11)} | ` +
      `${refRaw.tier.padEnd(11)} | ` +
      `${resRaw.used.padEnd(7)} | ` +
      `${refRaw.used_metric.padEnd(7)} | ` +
      `${rawJsRt.padStart(11)} | ` +
      `${rawRefRt.padStart(11)} | ` +
      `${'0.000000'.padStart(8)}`
    );

    // Tiers and decision must match Python exactly
    assert.strictEqual(resRaw.tier, refRaw.tier, `${rawCondName} tier mismatch`);
    assert.strictEqual(resRaw.used, refRaw.used_metric, `${rawCondName} used metric mismatch`);
    assert.strictEqual(resRaw.valid, refRaw.valid, `${rawCondName} validity flag mismatch`);
    assert.strictEqual(resRaw.tier, 'invalid', `${rawCondName} must be rejected as invalid`);

    // Evaluate truncated condition
    const truncCondName = `DR ${dr} dB (truncated)`;
    const truncJsRt = Number.isNaN(resTrunc.rt60) ? 'NaN' : resTrunc.rt60.toFixed(4);
    const pyMetricVal = refTrunc.used_metric === 'T30'
      ? refTrunc.t30
      : (refTrunc.used_metric === 'T20' ? refTrunc.t20 : NaN);
    const truncRefRt = Number.isNaN(pyMetricVal) ? 'NaN' : pyMetricVal.toFixed(4);
    const metricDiff = Number.isNaN(resTrunc.rt60) || Number.isNaN(pyMetricVal)
      ? 0.0
      : Math.abs(resTrunc.rt60 - pyMetricVal);

    console.log(
      `${truncCondName.padEnd(27)} | ` +
      `${resTrunc.dynamic_range_db.toFixed(1).padStart(6)}dB | ` +
      `${refTrunc.estimated_dr_db.toFixed(1).padStart(6)}dB | ` +
      `${resTrunc.tier.padEnd(11)} | ` +
      `${refTrunc.tier.padEnd(11)} | ` +
      `${resTrunc.used.padEnd(7)} | ` +
      `${refTrunc.used_metric.padEnd(7)} | ` +
      `${truncJsRt.padStart(11)} | ` +
      `${truncRefRt.padStart(11)} | ` +
      `${metricDiff.toFixed(6).padStart(8)}`
    );

    // Tiers and decision must match Python exactly
    assert.strictEqual(resTrunc.tier, refTrunc.tier, `${truncCondName} tier mismatch`);
    assert.strictEqual(resTrunc.used, refTrunc.used_metric, `${truncCondName} used metric mismatch`);
    assert.strictEqual(resTrunc.valid, refTrunc.valid, `${truncCondName} validity flag mismatch`);

    // Acceptance tolerance from PLAN.md: Valid/approximate metrics agree within <= 0.005 s
    if (resTrunc.tier === 'valid' || resTrunc.tier === 'approximate') {
      assert.ok(
        metricDiff <= 0.005,
        `${truncCondName} metric difference ${metricDiff.toFixed(6)} s > 0.005 s tolerance`
      );
    }
  }

  // Exact tier verification summary:
  // DR 45 dB -> valid T30
  // DR 35 dB -> approximate T20
  // DR 25 & 15 dB -> invalid
  console.log('--------------------------------------------------------------------------------------------------------------------\n');
});

// ---------------------------------------------------------------------------
// Additional: SNR 30 dB and 20 dB noise robustness check from expected_outputs.json
// ---------------------------------------------------------------------------

test('Noise robustness at SNR 30 dB and 20 dB matches expected_outputs.json', () => {
  const hSingle = loadBin(resolve(FIX, 'synthetic_ir_single.bin'));
  const noiseStd = loadBin(resolve(FIX, 'noise_normal_seed123.bin'));
  const expSnr = EXP.noise_test;

  let sigPower = 0.0;
  for (let i = 0; i < hSingle.length; i++) {
    sigPower += hSingle[i] * hSingle[i];
  }
  sigPower /= hSingle.length;

  for (const snr of [30, 20]) {
    const noisePower = sigPower / Math.pow(10, snr / 10.0);
    const std = Math.sqrt(noisePower);

    const noisy = new Float64Array(hSingle.length);
    for (let i = 0; i < hSingle.length; i++) {
      noisy[i] = hSingle[i] + noiseStd[i] * std;
    }

    const resRaw = analyzeRT60(noisy, DEFAULT_FS, false);
    const resTrunc = analyzeRT60(noisy, DEFAULT_FS, true);

    const ref = expSnr[`snr_${snr}db`];
    const refRaw = ref.without_truncation;
    const refTrunc = ref.simplified_noise_floor_truncation;

    // Truncated recovered values match Python reference to <= 0.001 s
    assert.strictEqual(resTrunc.tier, refTrunc.tier);
    assert.strictEqual(resTrunc.used, refTrunc.used_metric);
    assert.strictEqual(resTrunc.valid, refTrunc.valid);
    assert.ok(Math.abs(resTrunc.t20 - refTrunc.t20) <= 0.001);
    assert.ok(Math.abs(resTrunc.t30 - refTrunc.t30) <= 0.001);

    // Raw un-truncated tier match
    assert.strictEqual(resRaw.tier, refRaw.tier);
    assert.strictEqual(resRaw.used, refRaw.used_metric);
    assert.strictEqual(resRaw.valid, refRaw.valid);
  }
});
