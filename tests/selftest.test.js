import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateRoomRecording,
  runSelfTest,
  SELFTEST_TOLERANCES,
} from '../src/analysis/selftest.js';

test('Self-Test: Synthetic room simulation recovers target RT60 within empirical 2σ bounds across all targets', async () => {
  const targets = [0.3, 0.6, 0.8, 1.2, 1.5];

  console.log('\n' + '='.repeat(90));
  console.log('Self-Test: Simulated Room Acoustic RT60 Recovery (JS vs Empirical 2σ Bounds)');
  console.log('='.repeat(90));
  console.log('Target (s) | Recovered (s) | Error (%) | Empirical 2σ Bounds (s) | Status | Tiers');
  console.log('-'.repeat(90));

  for (const rtTarget of targets) {
    const result = await runSelfTest({ rtTarget });

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
});

test('Self-Test: Background noise option reduces SNR and retains simulated tags', async () => {
  const resultClean = await runSelfTest({ rtTarget: 0.8, seed: 123, addNoise: false });
  const resultNoisy = await runSelfTest({ rtTarget: 0.8, seed: 123, addNoise: true, snrDb: 35 });

  assert.strictEqual(resultClean.ok, true);
  assert.strictEqual(resultNoisy.ok, true);
  assert.strictEqual(resultNoisy.simulated, true);
  assert.strictEqual(resultNoisy.source, 'selftest');

  // Noisy PNR should be lower than clean PNR
  console.log(`\n  Self-Test Noise Comparison: Clean PNR = ${resultClean.pnrDb} dB vs Noisy PNR = ${resultNoisy.pnrDb} dB`);
  assert.ok(resultNoisy.pnrDb < resultClean.pnrDb);
  assert.ok(resultNoisy.pnrDb >= 20.0, 'Noisy self-test at 35 dB SNR should still pass 20 dB PNR');
});
