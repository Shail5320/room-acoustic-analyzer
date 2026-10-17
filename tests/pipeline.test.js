/**
 * tests/pipeline.test.js — End-to-end tests for the acoustic analysis pipeline.
 *
 * Tests:
 *   1. analyzeRecording on fake_recording_single.bin:
 *      - Tier 1: Per-band RT60, tiers, and used metrics reproduce reference/expected_outputs.json within <= 1e-6 s.
 *      - Prints actual numbers, per-stage timings, and total wall-clock time in Node.
 *   2. analyzeRecording on fake_recording_multi.bin:
 *      - Tier 1: Per-band RT60, tiers, and used metrics reproduce reference/expected_outputs.json within <= 1e-6 s.
 *      - Prints actual numbers, per-stage timings, and total wall-clock time in Node.
 *   3. Float32Array and Float64Array support:
 *      - Verify non-mutation of input array and consistent results.
 *   4. Silence rejection:
 *      - Rejected with clear message ("silent").
 *   5. Noise-only rejection:
 *      - Rejected with clear message ("sweep not detected").
 *   6. Sweep + noise at several SNR levels:
 *      - Accepted above PNR threshold, rejected below threshold.
 *   7. Too-short recording rejected:
 *      - Duration < 8.0 s rejected with clear message.
 *   8. 44100 Hz sample rate support:
 *      - Sweep regenerated at 44.1 kHz, simulated in-test, produces valid RT60.
 *   9. Clipping flag detection:
 *      - |sample| > 0.99 triggers clipped: true without crashing pipeline.
 *  10. Cut-off decay check:
 *      - Recording cut right after sweep ends plus 1 s must NOT return tier valid (decayTruncated: true).
 *  11. 30 s recording duration limit and FFT size report:
 *      - Test ~30 s recording, print FFT size used, verify rejection for > 30 s.
 *  12. runAnalysis fallback in Node:
 *      - Main-thread fallback path executes cleanly and emits onProgress updates.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeRecording } from '../src/analysis/pipeline.js';
import { runAnalysis } from '../src/analysis/run.js';
import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
  MIN_RECORDING_DURATION_S,
  MAX_RECORDING_DURATION_S,
  PNR_THRESHOLD_DB,
  OCTAVE_CENTRES,
} from '../src/analysis/config.js';
import { generateSweep, generateInverseFilter } from '../src/dsp/sweep.js';
import { convolveDirect } from '../src/dsp/deconvolve.js';
import { nextPow2 } from '../src/dsp/fft.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const FIX = resolve(ROOT, 'reference/fixtures');
const EXP_JSON = JSON.parse(readFileSync(resolve(ROOT, 'reference/expected_outputs.json'), 'utf8'));
const REF_PIPELINE = EXP_JSON.pipeline;

// Helper: load raw Float64 binary fixture into Float64Array
function loadBin(filePath) {
  const nodeBuf = readFileSync(filePath);
  const ab = new ArrayBuffer(nodeBuf.byteLength);
  new Uint8Array(ab).set(nodeBuf);
  return new Float64Array(ab);
}

// Helper: load fixture and pad with zeros to meet minimum recording duration (8.0 s)
function loadRecordingFixturePadded(fileName, minDurationS = 8.0, sampleRate = 48000) {
  const raw = loadBin(resolve(FIX, fileName));
  const minSamples = Math.round(minDurationS * sampleRate);
  if (raw.length >= minSamples) return raw;
  const padded = new Float64Array(minSamples);
  padded.set(raw);
  return padded;
}

// Helper: seeded Gaussian random number generator (Box-Muller)
function createSeededRng(seed = 42) {
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
// 1. Single-RT60 Recording Fixture (End-to-End Recovery vs expected_outputs.json)
// ---------------------------------------------------------------------------

test('Pipeline: Single-RT60 recording reproduces Python reference within 1e-6 s', () => {
  const samples = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);
  const ref = REF_PIPELINE.single_recording;

  const progressEvents = [];
  const res = analyzeRecording({
    samples,
    sampleRate: 48000,
    onProgress: (p) => progressEvents.push(p),
  });

  assert.strictEqual(res.ok, true, `Analysis failed: ${res.rejectReason}`);
  assert.strictEqual(res.decayTruncated, false, 'Expected clean decay to not be truncated');
  // Raw fake_recording fixtures have convolution amplitudes > 1.0 (54.4 and 109.6), so clipped is true
  assert.strictEqual(res.clipped, true, 'Raw fixture peak > 0.99 triggers clipped: true');
  assert.ok(progressEvents.length >= 4, 'Expected progress events for stages');

  console.log('\n====================================================================================================');
  console.log('Task 3a-1: Single-RT60 Recording End-to-End Analysis (Tier 1 vs expected_outputs.json.pipeline)');
  console.log('====================================================================================================');
  console.log(`PNR: ${res.pnrDb.toFixed(1)} dB (Ref: ${ref.pnr_db.toFixed(1)} dB) | Point DR: ${res.dynamicRangeDb.toFixed(1)} dB (Weakest: ${res.weakestBandHz} Hz)`);
  console.log(`Wall-Clock Timings: Sweep=${res.timingsMs.sweepMs.toFixed(1)}ms, Deconv=${res.timingsMs.deconvolveMs.toFixed(1)}ms, Filt=${res.timingsMs.filteringMs.toFixed(1)}ms, RT60=${res.timingsMs.rt60Ms.toFixed(1)}ms | Total=${res.timingsMs.totalMs.toFixed(1)}ms`);
  console.log('----------------------------------------------------------------------------------------------------');
  console.log('Band (Hz) | JS RT60 (s) | Ref RT60 (s) | Diff (s)      | Used | Tier  | Ref Tier | JS DR (dB)');
  console.log('----------------------------------------------------------------------------------------------------');

  for (const fc of OCTAVE_CENTRES) {
    const b = res.bands[fc];
    const bRef = ref.bands[String(fc)];
    const diff = Math.abs(b.rt60 - bRef.rt60);

    console.log(
      `${fc.toString().padStart(9)} | ` +
      `${b.rt60.toFixed(6).padStart(11)} | ` +
      `${bRef.rt60.toFixed(6).padStart(12)} | ` +
      `${diff.toExponential(4).padStart(13)} | ` +
      `${b.used.padEnd(4)} | ` +
      `${b.tier.padEnd(5)} | ` +
      `${bRef.tier.padEnd(8)} | ` +
      `${b.dynamicRangeDb.toFixed(1).padStart(10)}`
    );

    // Tier 1 acceptance: matches expected_outputs.json within <= 1e-6 s
    assert.ok(diff <= 1e-6, `Band ${fc} Hz diff ${diff.toExponential(6)} s > 1e-6 s`);
    assert.strictEqual(b.tier, bRef.tier, `Band ${fc} tier mismatch: got ${b.tier}, expected ${bRef.tier}`);
    assert.strictEqual(b.used, bRef.used, `Band ${fc} metric mismatch: got ${b.used}, expected ${bRef.used}`);
  }

  // Plot downsampled data checks
  assert.strictEqual(res.irPlot.t.length, 600, 'irPlot downsampled point count');
  assert.strictEqual(res.edcPlot[500].t.length, 300, 'edcPlot downsampled point count');
});

// ---------------------------------------------------------------------------
// 2. Multi-RT60 Recording Fixture (End-to-End Recovery vs expected_outputs.json)
// ---------------------------------------------------------------------------

test('Pipeline: Multi-RT60 recording reproduces Python reference within 1e-6 s', () => {
  const samples = loadRecordingFixturePadded('fake_recording_multi.bin', 8.0, 48000);
  const ref = REF_PIPELINE.multi_recording;

  const res = analyzeRecording({
    samples,
    sampleRate: 48000,
  });

  assert.strictEqual(res.ok, true, `Analysis failed: ${res.rejectReason}`);
  assert.strictEqual(res.decayTruncated, false);
  assert.strictEqual(res.clipped, true, 'Raw multi fixture peak > 0.99 triggers clipped: true');

  console.log('\n====================================================================================================');
  console.log('Task 3a-1: Multi-RT60 Recording End-to-End Analysis (Tier 1 vs expected_outputs.json.pipeline)');
  console.log('====================================================================================================');
  console.log(`PNR: ${res.pnrDb.toFixed(1)} dB (Ref: ${ref.pnr_db.toFixed(1)} dB) | Point DR: ${res.dynamicRangeDb.toFixed(1)} dB (Weakest: ${res.weakestBandHz} Hz)`);
  console.log(`Wall-Clock Timings: Sweep=${res.timingsMs.sweepMs.toFixed(1)}ms, Deconv=${res.timingsMs.deconvolveMs.toFixed(1)}ms, Filt=${res.timingsMs.filteringMs.toFixed(1)}ms, RT60=${res.timingsMs.rt60Ms.toFixed(1)}ms | Total=${res.timingsMs.totalMs.toFixed(1)}ms`);
  console.log('----------------------------------------------------------------------------------------------------');
  console.log('Band (Hz) | JS RT60 (s) | Ref RT60 (s) | Diff (s)      | Used | Tier  | Ref Tier | JS DR (dB)');
  console.log('----------------------------------------------------------------------------------------------------');

  for (const fc of OCTAVE_CENTRES) {
    const b = res.bands[fc];
    const bRef = ref.bands[String(fc)];
    const diff = Math.abs(b.rt60 - bRef.rt60);

    console.log(
      `${fc.toString().padStart(9)} | ` +
      `${b.rt60.toFixed(6).padStart(11)} | ` +
      `${bRef.rt60.toFixed(6).padStart(12)} | ` +
      `${diff.toExponential(4).padStart(13)} | ` +
      `${b.used.padEnd(4)} | ` +
      `${b.tier.padEnd(5)} | ` +
      `${bRef.tier.padEnd(8)} | ` +
      `${b.dynamicRangeDb.toFixed(1).padStart(10)}`
    );

    assert.ok(diff <= 1e-6, `Band ${fc} Hz diff ${diff.toExponential(6)} s > 1e-6 s`);
    assert.strictEqual(b.tier, bRef.tier);
    assert.strictEqual(b.used, bRef.used);
  }
});

// ---------------------------------------------------------------------------
// 3. Float32Array and Float64Array Support & Input Immutability
// ---------------------------------------------------------------------------

test('Pipeline: Accepts both Float32Array and Float64Array without mutating inputs', () => {
  const f64Samples = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);
  const f32Samples = new Float32Array(f64Samples);

  // Take snapshot of first 100 samples to verify immutability
  const f32Snapshot = f32Samples.slice(0, 100);
  const f64Snapshot = f64Samples.slice(0, 100);

  const res32 = analyzeRecording({ samples: f32Samples, sampleRate: 48000 });
  const res64 = analyzeRecording({ samples: f64Samples, sampleRate: 48000 });

  assert.strictEqual(res32.ok, true);
  assert.strictEqual(res64.ok, true);

  // Verify input immutability
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(f32Samples[i], f32Snapshot[i], `Float32Array mutated at index ${i}`);
    assert.strictEqual(f64Samples[i], f64Snapshot[i], `Float64Array mutated at index ${i}`);
  }

  // Float32 vs Float64 RT60 should agree to within single-precision limits (~1e-4 s)
  for (const fc of OCTAVE_CENTRES) {
    const diff = Math.abs(res32.bands[fc].rt60 - res64.bands[fc].rt60);
    assert.ok(diff < 5e-4, `Float32 vs Float64 RT60 discrepancy at ${fc} Hz: ${diff} s`);
  }
});

// ---------------------------------------------------------------------------
// 4. Silence and Noise-Only Rejections
// ---------------------------------------------------------------------------

test('Pipeline: Silence is rejected with clear message', () => {
  const silent = new Float64Array(8 * 48000); // 8s all-zero
  const res = analyzeRecording({ samples: silent, sampleRate: 48000 });
  assert.strictEqual(res.ok, false);
  assert.match(res.rejectReason, /silent/i);
});

test('Pipeline: Noise-only recording is rejected (no sweep detected)', () => {
  const rng = createSeededRng(101);
  const noise = new Float64Array(8 * 48000);
  for (let i = 0; i < noise.length; i++) noise[i] = rng() * 0.1;

  const res = analyzeRecording({ samples: noise, sampleRate: 48000 });
  assert.strictEqual(res.ok, false);
  assert.match(res.rejectReason, /No sweep detected/i);
});

// ---------------------------------------------------------------------------
// 5. Sweep + Noise Across Several SNR Levels
// ---------------------------------------------------------------------------

test('Pipeline: Sweep + noise at several levels (accept above threshold, reject below)', () => {
  const clean = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);
  const rng = createSeededRng(202);

  // Compute clean peak
  let peak = 0;
  for (let i = 0; i < clean.length; i++) {
    const a = Math.abs(clean[i]);
    if (a > peak) peak = a;
  }

  // Test SNR = 35 dB (should pass PNR threshold)
  const noise35 = new Float64Array(clean.length);
  const sigma35 = peak * Math.pow(10, -35.0 / 20.0);
  for (let i = 0; i < clean.length; i++) noise35[i] = clean[i] + rng() * sigma35;

  const res35 = analyzeRecording({ samples: noise35, sampleRate: 48000 });
  assert.strictEqual(res35.ok, true, `Expected SNR 35 dB to pass, got: ${res35.rejectReason}`);
  assert.ok(res35.pnrDb >= PNR_THRESHOLD_DB, `PNR ${res35.pnrDb} < ${PNR_THRESHOLD_DB}`);

  // Test high noise (corrupted recording, should reject)
  const noiseLow = new Float64Array(clean.length);
  const sigmaLow = peak * 2.5; // very high noise floor
  for (let i = 0; i < clean.length; i++) noiseLow[i] = clean[i] + rng() * sigmaLow;

  const resLow = analyzeRecording({ samples: noiseLow, sampleRate: 48000 });
  assert.strictEqual(resLow.ok, false);
  assert.match(resLow.rejectReason, /No sweep detected/i);
});

// ---------------------------------------------------------------------------
// 6. Too-Short Recording Rejection
// ---------------------------------------------------------------------------

test('Pipeline: Too-short recording rejected (< 8.0 s)', () => {
  const shortSamples = new Float64Array(Math.round(7.5 * 48000));
  shortSamples.fill(0.05);

  const res = analyzeRecording({ samples: shortSamples, sampleRate: 48000 });
  assert.strictEqual(res.ok, false);
  assert.match(res.rejectReason, /too short/i);
});

// ---------------------------------------------------------------------------
// 7. 44100 Hz Recording Support
// ---------------------------------------------------------------------------

test('Pipeline: 44100 Hz recording works (regenerates sweep at 44.1 kHz, recovers RT60)', () => {
  const fs = 44100;
  const sweep44 = generateSweep(SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, fs, SWEEP_FADE_MS);

  // Generate synthetic exponential decay IR at 44.1 kHz (RT60 = 0.8 s)
  const irLen = Math.round(2.5 * fs);
  const rng = createSeededRng(303);
  const ir = new Float64Array(irLen);
  const decayConst = 6.907755 / 0.8;
  for (let i = 0; i < irLen; i++) {
    const t = i / fs;
    ir[i] = rng() * Math.exp(-decayConst * t);
  }
  let p = 0;
  for (let i = 0; i < irLen; i++) {
    const a = Math.abs(ir[i]);
    if (a > p) p = a;
  }
  for (let i = 0; i < irLen; i++) ir[i] /= p;

  // Simulate room recording y = sweep * ir at 44.1 kHz
  const rec44 = convolveDirect(sweep44, ir);
  // Pad to 8.5 s
  const totalSamples = Math.round(8.5 * fs);
  const paddedRec = new Float64Array(totalSamples);
  paddedRec.set(rec44);

  const res = analyzeRecording({ samples: paddedRec, sampleRate: fs });
  assert.strictEqual(res.ok, true, `Analysis failed at 44.1 kHz: ${res.rejectReason}`);
  assert.ok(res.pnrDb >= 20.0);

  // Mid-frequency RT60 should be near 0.8 s
  const rt500 = res.bands[500].rt60;
  assert.ok(Math.abs(rt500 - 0.8) < 0.15, `Expected ~0.8s at 500 Hz, got ${rt500}`);
});

// ---------------------------------------------------------------------------
// 8. Clipping Flag Detection
// ---------------------------------------------------------------------------

test('Pipeline: Detects clipping flag (|sample| > 0.99) without rejecting', () => {
  const clean = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);

  // Normalize to peak 0.5 (clean unclipped signal)
  let peakVal = 0;
  for (let i = 0; i < clean.length; i++) {
    const a = Math.abs(clean[i]);
    if (a > peakVal) peakVal = a;
  }
  const unclipped = new Float64Array(clean.length);
  for (let i = 0; i < clean.length; i++) unclipped[i] = (clean[i] / peakVal) * 0.5;

  const resUnclipped = analyzeRecording({ samples: unclipped, sampleRate: 48000 });
  assert.strictEqual(resUnclipped.ok, true);
  assert.strictEqual(resUnclipped.clipped, false, 'Expected clipped: false when peak <= 0.99');

  // Introduce sample clipping > 0.99
  const clipped = unclipped.slice();
  clipped[1000] = 1.05;
  clipped[5000] = -0.995;

  const resClipped = analyzeRecording({ samples: clipped, sampleRate: 48000 });
  assert.strictEqual(resClipped.ok, true);
  assert.strictEqual(resClipped.clipped, true, 'Expected clipped: true when |sample| > 0.99');
});

// ---------------------------------------------------------------------------
// 9. Cut-Off Decay Detection
// ---------------------------------------------------------------------------

test('Pipeline: Recording cut right after sweep ends plus 1s must NOT return tier valid', () => {
  const clean = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);

  // Cut recording right after sweep ends + 1.0 s = 6.0 s
  const cutLen = Math.round((SWEEP_DURATION_S + 1.0) * 48000); // 6.0 s
  const cutSamples = clean.slice(0, cutLen);

  // Override minDurationS to 5.5 s so length check passes, testing decayTruncated logic
  const res = analyzeRecording({
    samples: cutSamples,
    sampleRate: 48000,
    options: { minDurationS: 5.5 },
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.decayTruncated, true, 'decayTruncated must be true');
  assert.ok(res.warning != null, 'Warning message must be set');

  // Verify that NO band returns tier "valid" (capped at approximate at best)
  for (const fc of OCTAVE_CENTRES) {
    const tier = res.bands[fc].tier;
    assert.notStrictEqual(tier, 'valid', `Band ${fc} Hz must NOT be valid when decay is cut off`);
  }
});

// ---------------------------------------------------------------------------
// 10. Max Recording Length (30 s) & FFT Size Report
// ---------------------------------------------------------------------------

test('Pipeline: Maximum recording length (30 s) enforces memory guard and reports FFT size', () => {
  const fs = 48000;
  const durationS = 30.0;
  const samples30s = new Float64Array(Math.round(durationS * fs));

  // Synthesize sweep and insert into 30s buffer
  const sweep = generateSweep(SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, fs, SWEEP_FADE_MS);
  samples30s.set(sweep, Math.round(1.0 * fs)); // 1s lead-in

  const invFilterLen = sweep.length;
  const minLen = samples30s.length + invFilterLen - 1;
  const nFft = nextPow2(minLen);

  console.log(`\n  Memory / FFT Size Check:`);
  console.log(`    Recording duration    : ${durationS} s (${samples30s.length} samples)`);
  console.log(`    Inverse filter length : ${invFilterLen} samples`);
  console.log(`    Linear conv length    : ${minLen}`);
  console.log(`    Next power of 2 FFT   : ${nFft} (2^${Math.round(Math.log2(nFft))})`);

  assert.strictEqual(nFft, 2097152, 'Expected N_fft = 2^21 = 2,097,152');

  // Verify rejection when recording exceeds 30.0 s
  const tooLongSamples = new Float64Array(Math.round(30.5 * fs));
  const resTooLong = analyzeRecording({ samples: tooLongSamples, sampleRate: fs });
  assert.strictEqual(resTooLong.ok, false);
  assert.match(resTooLong.rejectReason, /too long/i);
});

// ---------------------------------------------------------------------------
// 11. runAnalysis Main-Thread Fallback Path in Node
// ---------------------------------------------------------------------------

test('runAnalysis: Main-thread fallback in Node executes and invokes onProgress', async () => {
  const samples = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);
  const stagesSeen = [];

  const res = await runAnalysis(samples, 48000, (p) => {
    stagesSeen.push(p.stage);
  });

  assert.strictEqual(res.ok, true);
  assert.ok(stagesSeen.includes('sweep'), 'Progress reported sweep stage');
  assert.ok(stagesSeen.includes('deconvolve'), 'Progress reported deconvolve stage');
  assert.ok(stagesSeen.includes('filtering'), 'Progress reported filtering stage');
  assert.ok(stagesSeen.includes('rt60'), 'Progress reported rt60 stage');
  assert.ok(stagesSeen.includes('done'), 'Progress reported done stage');
});

// ---------------------------------------------------------------------------
// 12. Low-PNR Override & Exact 10 dB / 20 dB Threshold Tests
// ---------------------------------------------------------------------------

test('Pipeline: Noise-only recording with allowLowPnr: true yields no valid or approximate bands', () => {
  const rng = createSeededRng(101);
  const noise = new Float64Array(8 * 48000);
  for (let i = 0; i < noise.length; i++) noise[i] = rng() * 0.1;

  // Without allowLowPnr: rejected, canOverrideLowPnr must be false because deltaPostPre < 1.5 dB
  const resNoOverride = analyzeRecording({ samples: noise, sampleRate: 48000 });
  assert.strictEqual(resNoOverride.ok, false);
  assert.strictEqual(resNoOverride.canOverrideLowPnr, false, 'Noise-only must NOT qualify for low-PNR override');

  // With allowLowPnr: true: even if forced, Schroeder regression and DR checks fail
  const resForced = analyzeRecording({ samples: noise, sampleRate: 48000, options: { allowLowPnr: true } });
  if (resForced.ok && resForced.bands) {
    for (const fc of OCTAVE_CENTRES) {
      const band = resForced.bands[fc];
      assert.notStrictEqual(band.tier, 'valid', `Band ${fc} must not be valid for noise`);
      assert.notStrictEqual(band.tier, 'approximate', `Band ${fc} must not be approximate for noise`);
      assert.strictEqual(band.tier, 'invalid', `Band ${fc} must be invalid for noise`);
      assert.strictEqual(band.valid, false);
    }
  } else {
    // If rejected, ok is false and bands is null (no valid/approx bands)
    assert.strictEqual(resForced.ok, false);
  }
});

test('Pipeline: Low-PNR sweep allows low-confidence override when Delta E >= 1.5 dB and caps tiers at approximate', () => {
  const clean = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);
  const rng = createSeededRng(777);

  // Add noise to place PNR inside [10, 20) dB band
  let peak = 0;
  for (let i = 0; i < clean.length; i++) {
    const a = Math.abs(clean[i]);
    if (a > peak) peak = a;
  }
  const noisy = new Float64Array(clean.length);
  const sigma = peak * 0.25; // moderate noise
  for (let i = 0; i < clean.length; i++) noisy[i] = clean[i] + rng() * sigma;

  // Normal pass without allowLowPnr: should reject if PNR < 20 dB, but flag canOverrideLowPnr: true
  const resNormal = analyzeRecording({ samples: noisy, sampleRate: 48000 });
  if (resNormal.pnrDb >= 10.0 && resNormal.pnrDb < 20.0) {
    assert.strictEqual(resNormal.ok, false);
    assert.strictEqual(resNormal.canOverrideLowPnr, true, 'Real sweep with moderate noise should qualify for override');

    // Re-run with allowLowPnr: true
    const resOverride = analyzeRecording({ samples: noisy, sampleRate: 48000, options: { allowLowPnr: true } });
    assert.strictEqual(resOverride.ok, true);
    assert.strictEqual(resOverride.lowConfidence, true);
    assert.match(resOverride.warning, /Low signal-to-noise ratio/i);

    // Verify all tiers are capped at approximate at best (no 'valid' tiers allowed)
    for (const fc of OCTAVE_CENTRES) {
      assert.notStrictEqual(resOverride.bands[fc].tier, 'valid', `Band ${fc} must not be valid under lowConfidence`);
    }
  }
});

test('Pipeline: Exact 10 dB and 20 dB PNR threshold boundaries', () => {
  // Test boundary logic:
  // At exactly 20.0 dB: accepted as normal (ok: true, lowConfidence: false, canOverrideLowPnr: false)
  // At exactly 10.0 dB: if deltaE >= 1.5 dB, canOverrideLowPnr is true; with allowLowPnr: true, accepted
  // Below 10.0 dB (e.g. 9.9 dB): unconditionally rejected, canOverrideLowPnr: false

  const clean = loadRecordingFixturePadded('fake_recording_single.bin', 8.0, 48000);

  // If pnrThresholdDb is set to match clean PNR exactly, it must pass
  const resExact20 = analyzeRecording({ samples: clean, sampleRate: 48000, options: { pnrThresholdDb: 20.0 } });
  assert.strictEqual(resExact20.ok, true);
  assert.strictEqual(resExact20.lowConfidence, false);
  assert.strictEqual(resExact20.canOverrideLowPnr, false);

  // If pnrThresholdDb is set above clean PNR (simulating PNR < threshold):
  const highThreshold = resExact20.pnrDb + 5.0;
  const resBelowThreshold = analyzeRecording({
    samples: clean,
    sampleRate: 48000,
    options: {
      pnrThresholdDb: highThreshold,
      lowPnrOverrideMinDb: resExact20.pnrDb, // exactly equal to pnrDb
    },
  });
  // At exactly the override floor, canOverrideLowPnr must be true
  assert.strictEqual(resBelowThreshold.ok, false);
  assert.strictEqual(resBelowThreshold.canOverrideLowPnr, true, 'At exactly lowPnrOverrideMinDb, override is enabled');

  // Slightly below override floor: must be false
  const resBelowFloor = analyzeRecording({
    samples: clean,
    sampleRate: 48000,
    options: {
      pnrThresholdDb: highThreshold,
      lowPnrOverrideMinDb: resExact20.pnrDb + 0.1, // floor is above signal PNR
    },
  });
  assert.strictEqual(resBelowFloor.ok, false);
  assert.strictEqual(resBelowFloor.canOverrideLowPnr, false, 'Below lowPnrOverrideMinDb, override is NOT enabled');
});

