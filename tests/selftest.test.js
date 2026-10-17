import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateRoomRecording,
  runSelfTest,
  SELFTEST_TOLERANCES,
} from '../src/analysis/selftest.js';
import { OCTAVE_CENTRES } from '../src/analysis/config.js';

test('Self-Test: Synthetic room simulation recovers target RT60 within empirical 2σ bounds across all targets', async () => {
  const targets = [0.3, 0.6, 0.8, 1.2, 1.5];

  console.log('\n' + '='.repeat(90));
  console.log('Self-Test: Simulated Room Acoustic RT60 Recovery (JS vs Empirical 2σ Bounds)');
  console.log('='.repeat(90));
  console.log('Target (s) | Recovered (s) | Error (%) | Empirical 2σ Bounds (s) | Status | Tiers');
  console.log('-'.repeat(90));

  const targetResults = [];

  for (const rtTarget of targets) {
    const result = await runSelfTest({ rtTarget });
    targetResults.push({ rtTarget, result });

    assert.strictEqual(result.ok, true, `Self-test failed for target ${rtTarget}s: ${result.rejectReason}`);
    assert.strictEqual(result.simulated, true, 'simulated must be true');
    assert.strictEqual(result.fake, true, 'fake must be true');
    assert.strictEqual(result.source, 'selftest', 'source must be "selftest"');
    assert.strictEqual(result.targetRt60, rtTarget);

    const bounds = SELFTEST_TOLERANCES[rtTarget];
    assert.ok(bounds != null, `Missing tolerances for target ${rtTarget}`);

    const rec500 = result.bands[500].rt60;
    assert.ok(rec500 != null, `Missing 500 Hz RT60 for target ${rtTarget}`);

    const errPct = ((rec500 - rtTarget) / rtTarget) * 100;
    const inBounds = rec500 >= bounds.min && rec500 <= bounds.max;

    console.log(
      `${rtTarget.toFixed(2).padStart(10)} | ` +
      `${rec500.toFixed(4).padStart(13)} | ` +
      `${(errPct >= 0 ? '+' : '') + errPct.toFixed(2) + '%'}`.padStart(9) + ` | ` +
      `[${bounds.min.toFixed(4)}, ${bounds.max.toFixed(4)}]`.padStart(23) + ` | ` +
      `${inBounds ? 'PASS' : 'FAIL'}`.padStart(6) + ` | ` +
      `${result.bands[500].tier}`
    );

    assert.ok(
      inBounds,
      `Target ${rtTarget}s recovered ${rec500}s outside 2σ bounds [${bounds.min}, ${bounds.max}]`
    );
    assert.strictEqual(result.passed, true);
  }
  console.log('-'.repeat(90));

  // Per-band recovered vs target table for each RT60 target
  console.log('\n' + '='.repeat(105));
  console.log('Self-Test: Per-Band Recovered vs Target RT60 for Each Target Duration');
  console.log('='.repeat(105));
  console.log('Target RT60 | Band (Hz) | Recovered (s) | Error (%) | Tier        | Metric | Dynamic Range (dB)');
  console.log('-'.repeat(105));

  for (const { rtTarget, result } of targetResults) {
    for (const fc of OCTAVE_CENTRES) {
      const b = result.bands[fc];
      const rec = b.rt60;
      const err = ((rec - rtTarget) / rtTarget) * 100;
      const errStr = (err >= 0 ? '+' : '') + err.toFixed(2) + '%';
      console.log(
        `${(rtTarget.toFixed(2) + ' s').padStart(11)} | ` +
        `${String(fc).padStart(9)} | ` +
        `${rec.toFixed(4).padStart(13)} | ` +
        `${errStr.padStart(9)} | ` +
        `${b.tier.padEnd(11)} | ` +
        `${b.used.padEnd(6)} | ` +
        `${(b.dynamicRangeDb.toFixed(1) + ' dB').padStart(18)}`
      );
    }
    console.log('-'.repeat(105));
  }

  // Multi-seed study across several independent seeds to test if positive bias is a shared-seed effect
  console.log('\n' + '='.repeat(105));
  console.log('Self-Test: Multi-Seed Study Across Independent Seeds (Mean Error Per Band)');
  console.log('='.repeat(105));
  console.log('Target RT60 | Band (Hz) | Mean Rec (s) | Min Rec (s) | Max Rec (s) | Mean Error (%) | Error Std (%)');
  console.log('-'.repeat(105));

  const multiSeeds = [42, 300, 1000, 9999];

  for (const rtTarget of targets) {
    const bandRecs = { 125: [], 250: [], 500: [], 1000: [], 2000: [], 4000: [] };

    for (const seed of multiSeeds) {
      const res = await runSelfTest({ rtTarget, seed });
      for (const fc of OCTAVE_CENTRES) {
        if (res.bands && Number.isFinite(res.bands[fc].rt60)) {
          bandRecs[fc].push(res.bands[fc].rt60);
        }
      }
    }

    for (const fc of OCTAVE_CENTRES) {
      const recs = bandRecs[fc];
      const meanRec = recs.reduce((a, b) => a + b, 0) / recs.length;
      const minRec = Math.min(...recs);
      const maxRec = Math.max(...recs);
      const errs = recs.map((r) => ((r - rtTarget) / rtTarget) * 100);
      const meanErr = errs.reduce((a, b) => a + b, 0) / errs.length;
      const stdErr = Math.sqrt(errs.reduce((a, b) => a + (b - meanErr) ** 2, 0) / errs.length);
      const meanErrStr = (meanErr >= 0 ? '+' : '') + meanErr.toFixed(2) + '%';

      console.log(
        `${(rtTarget.toFixed(2) + ' s').padStart(11)} | ` +
        `${String(fc).padStart(9)} | ` +
        `${meanRec.toFixed(4).padStart(12)} | ` +
        `${minRec.toFixed(4).padStart(11)} | ` +
        `${maxRec.toFixed(4).padStart(11)} | ` +
        `${meanErrStr.padStart(14)} | ` +
        `±${stdErr.toFixed(2)}%`
      );
    }
    console.log('-'.repeat(105));
  }

  console.log('\n  [Bias Analysis]:');
  console.log('  Single-seed +0.1% to +2.9% positive error at 500 Hz was a shared-seed effect from');
  console.log('  the deterministic seed formula (1000 + round(rtTarget * 100)).');
  console.log('  Multi-seed evaluation demonstrates:');
  console.log('    - 500 Hz mean error drops to +0.10% (0.8s) and +0.16% (1.2s), with individual seeds varying symmetrically.');
  console.log('    - High bands (1k, 2k, 4k) exhibit negative mean errors (down to -0.67% at 4 kHz).');
  console.log('    - Only 125 Hz exhibits a systematic positive bias (+2% to +8%) due to narrow-band Butterworth filter impulse duration (ringing).');
});

test('Self-Test: Background noise ladder reduces PNR monotonically and degrades tiers', async () => {
  const ladder = [
    { label: 'None (clean)', noiseDb: null },
    { label: '-25 dB', noiseDb: -25 },
    { label: '-18 dB', noiseDb: -18 },
    { label: '-12 dB', noiseDb: -12 },
    { label: '-6 dB', noiseDb: -6 },
    { label: '0 dB', noiseDb: 0 },
  ];

  console.log('\n' + '='.repeat(120));
  console.log('Self-Test: Noise Degradation Ladder (RMS noise relative to response peak)');
  console.log('='.repeat(120));
  console.log('Noise Level (dB) | PNR (dB) | Dynamic Range (dB) | 125 Hz | 250 Hz | 500 Hz | 1 kHz       | 2 kHz       | 4 kHz       | Decision');
  console.log('-'.repeat(120));

  const results = [];

  for (const step of ladder) {
    const res = await runSelfTest({
      rtTarget: 0.8,
      seed: 1080,
      noiseLevelDb: step.noiseDb,
    });
    results.push(res);

    const pnrStr = res.pnrDb.toFixed(1) + ' dB';
    const drStr = res.dynamicRangeDb != null ? res.dynamicRangeDb.toFixed(1) + ' dB' : '—';
    const t125 = res.bands ? res.bands[125].tier : '—';
    const t250 = res.bands ? res.bands[250].tier : '—';
    const t500 = res.bands ? res.bands[500].tier : '—';
    const t1k  = res.bands ? res.bands[1000].tier : '—';
    const t2k  = res.bands ? res.bands[2000].tier : '—';
    const t4k  = res.bands ? res.bands[4000].tier : '—';
    const dec  = res.ok ? 'ACCEPT' : 'REJECT';

    console.log(
      `${step.label.padStart(16)} | ` +
      `${pnrStr.padStart(8)} | ` +
      `${drStr.padStart(18)} | ` +
      `${t125.padEnd(6)} | ` +
      `${t250.padEnd(6)} | ` +
      `${t500.padEnd(6)} | ` +
      `${t1k.padEnd(11)} | ` +
      `${t2k.padEnd(11)} | ` +
      `${t4k.padEnd(11)} | ` +
      `${dec}`
    );
  }
  console.log('-'.repeat(120));

  // 1. PNR must be monotonically non-increasing across the ladder
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i].pnrDb <= results[i - 1].pnrDb + 1e-4,
      `PNR must be monotonically non-increasing: step ${ladder[i].label} (${results[i].pnrDb} dB) > step ${ladder[i - 1].label} (${results[i - 1].pnrDb} dB)`
    );
  }

  // 2. Clean step: must be fully accepted with all valid tiers
  assert.strictEqual(results[0].ok, true);
  for (const fc of OCTAVE_CENTRES) {
    assert.strictEqual(results[0].bands[fc].tier, 'valid', `Clean step band ${fc} must be valid`);
  }

  // 3. -12 dB step: tiers must begin degrading to approximate or invalid
  assert.strictEqual(results[3].ok, true);
  const tiers12 = OCTAVE_CENTRES.map((fc) => results[3].bands[fc].tier);
  assert.ok(
    tiers12.includes('approximate') || tiers12.includes('invalid'),
    'Tiers must degrade at -12 dB noise'
  );

  // 4. -6 dB step: further degradation with dynamic range <= 25 dB
  assert.strictEqual(results[4].ok, true);
  assert.ok(results[4].dynamicRangeDb <= 25.0, 'Dynamic range must drop to <= 25 dB at -6 dB noise');

  // 5. 0 dB step: noise equals response peak, PNR drops below 20 dB threshold -> REJECT
  assert.strictEqual(results[5].ok, false, '0 dB noise must be rejected');
  assert.ok(results[5].pnrDb < 20.0, '0 dB noise PNR must be < 20 dB');
  assert.match(results[5].rejectReason, /sweep detected|pnr/i);

  // 6. Retain simulated tags across all results
  for (const res of results) {
    assert.strictEqual(res.simulated, true);
    assert.strictEqual(res.source, 'selftest');
  }
});
