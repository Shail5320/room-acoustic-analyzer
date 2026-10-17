/**
 * tests/sabine.test.js — Unit tests for acoustic absorption and treatment calculations.
 *
 * Tasks:
 *   2.15  Dimensionless absorption ratio, optional Sabine/Eyring calculations with
 *         hand-calculated reference values.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  absorptionRatio,
  perBandAbsorptionRatios,
  roomGeometry,
  roomGeometryFromSteps,
  sabineAbsorption,
  sabineTreatment,
  eyringAbsorption,
  eyringTreatment,
  calculateTreatment,
  SABINE_CONSTANT,
} from '../src/dsp/sabine.js';

// ---------------------------------------------------------------------------
// 1. Hand-Calculated Worked Example from PLAN.md and User Prompt
// ---------------------------------------------------------------------------
test('Sabine worked example from PLAN.md (1.2s -> 0.4s, 5x4x3m, alpha 0.05 -> 0.8)', () => {
  const rt60Measured = 1.2;
  const rt60Target = 0.4;
  const length = 5.0;
  const width = 4.0;
  const height = 3.0;
  const existingAlpha = 0.05;
  const materialAlpha = 0.80;

  // Geometry:
  // V = 5 * 4 * 3 = 60 m^3
  // S = 2 * (5*4 + 5*3 + 4*3) = 2 * (20 + 15 + 12) = 94 m^2
  const geom = roomGeometry(length, width, height);
  assert.strictEqual(geom.volume, 60.0);
  assert.strictEqual(geom.surfaceArea, 94.0);

  // 1. Dimensionless ratio:
  // ratio = 1.2 / 0.4 = 3.0
  const ratioRes = absorptionRatio(rt60Measured, rt60Target);
  assert.ok(Math.abs(ratioRes.ratio - 3.0) < 1e-12, `Expected ratio 3.0, got ${ratioRes.ratio}`);
  assert.strictEqual(ratioRes.targetMet, false);
  assert.ok(Math.abs(ratioRes.excessFactor - 2.0) < 1e-12);

  // 2. Sabine absorption:
  // A_now = 0.161 * 60 / 1.2 = 9.66 / 1.2 = 8.05 m^2
  const aNow = sabineAbsorption(geom.volume, rt60Measured);
  assert.ok(Math.abs(aNow - 8.05) < 1e-12, `Expected A_now 8.05, got ${aNow}`);

  // A_target = 0.161 * 60 / 0.4 = 9.66 / 0.4 = 24.15 m^2
  const aTarget = sabineAbsorption(geom.volume, rt60Target);
  assert.ok(Math.abs(aTarget - 24.15) < 1e-12, `Expected A_target 24.15, got ${aTarget}`);

  // Delta_A = 24.15 - 8.05 = 16.10 m^2
  const deltaA = aTarget - aNow;
  assert.ok(Math.abs(deltaA - 16.10) < 1e-12, `Expected Delta_A 16.10, got ${deltaA}`);

  // 3. Treatment panel area:
  // net_alpha = 0.80 - 0.05 = 0.75
  // S_panel = 16.10 / 0.75 = 21.46666... m^2 ≈ 21.5 m^2
  const treatment = sabineTreatment(
    geom.volume,
    rt60Measured,
    rt60Target,
    materialAlpha,
    existingAlpha,
  );
  assert.ok(Math.abs(treatment.ratio - 3.0) < 1e-12);
  assert.ok(Math.abs(treatment.aNow - 8.05) < 1e-12);
  assert.ok(Math.abs(treatment.aTarget - 24.15) < 1e-12);
  assert.ok(Math.abs(treatment.deltaA - 16.10) < 1e-12);
  const expectedPanel = 16.10 / 0.75;
  assert.ok(Math.abs(treatment.sPanel - expectedPanel) < 1e-12);
  assert.ok(Math.abs(treatment.sPanel - 21.4667) < 0.01, `Expected ~21.5 m^2, got ${treatment.sPanel.toFixed(2)}`);

  console.log('\n  Hand-Calculated Sabine Example:');
  console.log(`    Room Volume          : ${geom.volume.toFixed(1)} m³`);
  console.log(`    Room Surface Area    : ${geom.surfaceArea.toFixed(1)} m²`);
  console.log(`    Absorption Ratio     : ${treatment.ratio.toFixed(2)}`);
  console.log(`    A_now                : ${treatment.aNow.toFixed(2)} m² (Sabins)`);
  console.log(`    A_target             : ${treatment.aTarget.toFixed(2)} m² (Sabins)`);
  console.log(`    Delta_A needed       : ${treatment.deltaA.toFixed(2)} m²`);
  console.log(`    Required Panel Area  : ${treatment.sPanel.toFixed(2)} m² (about 21.5 m²)`);
});

// ---------------------------------------------------------------------------
// 2. Eyring Formula Hand-Calculation Cross-Check
// ---------------------------------------------------------------------------
test('Eyring formula calculation matches hand-calculated exponential values', () => {
  const V = 60.0;
  const S = 94.0;
  const rt60Measured = 1.2;
  const rt60Target = 0.4;
  const existingAlpha = 0.05;
  const materialAlpha = 0.80;

  // Hand derivation:
  // exponent_now = (0.161 * 60) / (94 * 1.2) = 9.66 / 112.8 ≈ 0.08563829787
  // alpha_avg_now = 1 - exp(-0.08563829787) ≈ 0.0820847
  // a_eyring_now = 94 * 0.0820847 ≈ 7.71596 m^2
  const eyringNow = eyringAbsorption(S, V, rt60Measured);
  const expAlphaNow = 1.0 - Math.exp(-(0.161 * 60.0) / (94.0 * 1.2));
  assert.ok(Math.abs(eyringNow.alphaAvg - expAlphaNow) < 1e-12);
  assert.ok(Math.abs(eyringNow.aEyring - S * expAlphaNow) < 1e-12);

  // exponent_target = (0.161 * 60) / (94 * 0.4) = 9.66 / 37.6 ≈ 0.25691489
  // alpha_avg_target = 1 - exp(-0.25691489) ≈ 0.226567
  // a_eyring_target = 94 * 0.226567 ≈ 21.2973 m^2
  const eyringTarget = eyringAbsorption(S, V, rt60Target);
  const expAlphaTarget = 1.0 - Math.exp(-(0.161 * 60.0) / (94.0 * 0.4));
  assert.ok(Math.abs(eyringTarget.alphaAvg - expAlphaTarget) < 1e-12);

  const eyringTreat = eyringTreatment(S, V, rt60Measured, rt60Target, materialAlpha, existingAlpha);
  const expDeltaA = S * expAlphaTarget - S * expAlphaNow;
  const expSPanel = expDeltaA / (materialAlpha - existingAlpha);

  assert.ok(Math.abs(eyringTreat.deltaA - expDeltaA) < 1e-12);
  assert.ok(Math.abs(eyringTreat.sPanel - expSPanel) < 1e-12);

  console.log('\n  Hand-Calculated Eyring Cross-Check:');
  console.log(`    Alpha_avg (now)      : ${eyringTreat.alphaAvgNow.toFixed(4)}`);
  console.log(`    Alpha_avg (target)   : ${eyringTreat.alphaAvgTarget.toFixed(4)}`);
  console.log(`    A_eyring (now)       : ${eyringTreat.aNow.toFixed(2)} m²`);
  console.log(`    A_eyring (target)    : ${eyringTreat.aTarget.toFixed(2)} m²`);
  console.log(`    Delta_A Eyring       : ${eyringTreat.deltaA.toFixed(2)} m²`);
  console.log(`    Panel Area Eyring    : ${eyringTreat.sPanel.toFixed(2)} m²`);
});

// ---------------------------------------------------------------------------
// 3. Primary Dimensionless Ratio (Gated vs Dimensionless Flow)
// ---------------------------------------------------------------------------
test('Dimensionless ratio works with ZERO dimensions provided', () => {
  // User does not provide dimensions — app must STILL output absorption ratio
  const calcNoDim = calculateTreatment({
    rt60Measured: 0.90,
    rt60Target: 0.45,
  });

  assert.strictEqual(calcNoDim.ratio, 2.0);
  assert.strictEqual(calcNoDim.targetMet, false);
  assert.strictEqual(calcNoDim.excessFactor, 1.0);
  assert.strictEqual(calcNoDim.sabine, undefined, 'Sabine must not be computed without volume');
  assert.strictEqual(calcNoDim.eyring, undefined, 'Eyring must not be computed without dimensions');
});

test('Target already met: ratio <= 1.0 requires 0 m^2 additional treatment', () => {
  const targetMetRes = calculateTreatment({
    rt60Measured: 0.35,
    rt60Target: 0.40,
    dimensions: { length: 5, width: 4, height: 3 },
    materialAlpha: 0.8,
  });

  assert.strictEqual(targetMetRes.ratio, 0.35 / 0.40);
  assert.strictEqual(targetMetRes.targetMet, true);
  assert.strictEqual(targetMetRes.excessFactor, 0.0);
  assert.strictEqual(targetMetRes.sabine.sPanel, 0.0, 'No panels needed when target is met');
});

// ---------------------------------------------------------------------------
// 4. Per-Band Octave Calculations
// ---------------------------------------------------------------------------
test('perBandAbsorptionRatios computes ratios across all 6 octave bands', () => {
  const measured = {
    125: 1.20,
    250: 1.00,
    500: 0.80,
    1000: 0.70,
    2000: 0.60,
    4000: 0.50,
  };
  const targets = {
    125: 0.40,
    250: 0.40,
    500: 0.40,
    1000: 0.40,
    2000: 0.40,
    4000: 0.40,
  };

  const perBand = perBandAbsorptionRatios(measured, targets);
  assert.ok(Math.abs(perBand['125'].ratio - 3.0) < 1e-12);
  assert.ok(Math.abs(perBand['250'].ratio - 2.5) < 1e-12);
  assert.ok(Math.abs(perBand['500'].ratio - 2.0) < 1e-12);
  assert.ok(Math.abs(perBand['1000'].ratio - 1.75) < 1e-12);
  assert.ok(Math.abs(perBand['2000'].ratio - 1.5) < 1e-12);
  assert.ok(Math.abs(perBand['4000'].ratio - 1.25) < 1e-12);

  for (const b of Object.values(perBand)) {
    assert.strictEqual(b.targetMet, false);
  }
});

// ---------------------------------------------------------------------------
// 5. Step Count Geometry Calculation
// ---------------------------------------------------------------------------
test('roomGeometryFromSteps converts pace counts using 0.7 m/step', () => {
  // 10 steps × 8 steps × 4 steps with default 0.7 m/step
  // L = 7.0 m, W = 5.6 m, H = 2.8 m
  // V = 7.0 * 5.6 * 2.8 = 109.76 m^3
  // S = 2 * (7.0*5.6 + 7.0*2.8 + 5.6*2.8) = 2 * (39.2 + 19.6 + 15.68) = 148.96 m^2
  const stepsGeom = roomGeometryFromSteps(10, 8, 4, 0.7);
  assert.strictEqual(stepsGeom.isStepEstimate, true);
  assert.ok(Math.abs(stepsGeom.length - 7.0) < 1e-12);
  assert.ok(Math.abs(stepsGeom.width - 5.6) < 1e-12);
  assert.ok(Math.abs(stepsGeom.height - 2.8) < 1e-12);
  assert.ok(Math.abs(stepsGeom.volume - 109.76) < 1e-12);
  assert.ok(Math.abs(stepsGeom.surfaceArea - 148.96) < 1e-12);
});

// ---------------------------------------------------------------------------
// 6. Degenerate and Invalid Inputs
// ---------------------------------------------------------------------------
test('Degenerate and non-positive inputs return NaN safely', () => {
  const nanRes = absorptionRatio(NaN, 0.4);
  assert.ok(Number.isNaN(nanRes.ratio));

  const zeroTarget = absorptionRatio(1.2, 0);
  assert.ok(Number.isNaN(zeroTarget.ratio));

  const negMeasured = absorptionRatio(-1.2, 0.4);
  assert.ok(Number.isNaN(negMeasured.ratio));

  const nanSab = sabineAbsorption(-10, 1.0);
  assert.ok(Number.isNaN(nanSab));

  assert.throws(() => roomGeometry(-5, 4, 3), /positive/);
});
