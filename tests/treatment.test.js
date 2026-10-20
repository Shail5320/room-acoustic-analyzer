import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OCTAVE_BANDS,
  SPEECH_MUSIC_BANDS,
  STEP_VOLUME_UNCERTAINTY,
  MIN_HOTSPOT_POINTS,
  HOTSPOT_UNIFORM_MESSAGE,
  HOTSPOT_CAPTION,
  LOW_FREQ_CAVEAT,
  aggregateSessionBands,
  formatPrimaryRatio,
  calculateBandTreatment,
  computeTreatmentHeadline,
  computePercentile,
  evaluateHotspot,
} from '../src/analysis/treatment.js';

import { roomGeometry } from '../src/dsp/sabine.js';

const rootDir = process.cwd();
const expectedPath = path.join(rootDir, 'reference/treatment_expected.json');
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));

test('Phase 6 - Preset & Material JSON schema and source honesty', () => {
  const targetsPath = path.join(rootDir, 'src/data/targets.json');
  const materialsPath = path.join(rootDir, 'src/data/materials.json');

  assert.ok(fs.existsSync(targetsPath), 'targets.json must exist');
  assert.ok(fs.existsSync(materialsPath), 'materials.json must exist');

  const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf-8'));
  const materials = JSON.parse(fs.readFileSync(materialsPath, 'utf-8'));

  assert.ok(Array.isArray(targets.presets) && targets.presets.length >= 5, 'Should have at least 5 target presets');
  for (const p of targets.presets) {
    assert.ok(p.id && p.name && typeof p.targetRt60 === 'number', `Preset ${p.id} must have id, name, targetRt60`);
    assert.ok(p.source, `Preset ${p.id} must have a source field`);
    // Source must be either a verifiable citation or explicitly "rule of thumb". Never "likely".
    assert.doesNotMatch(p.source.toLowerCase(), /likely/, `Preset ${p.id} must not say "likely"`);
    const isRuleOfThumb = p.source.trim().toLowerCase() === 'rule of thumb';
    const isVerifiable = p.source.includes('EBU') || p.source.includes('ANSI') || p.source.includes('ISO');
    assert.ok(
      isRuleOfThumb || isVerifiable,
      `Preset ${p.id} source must be verified citation or "rule of thumb", got: "${p.source}"`
    );
  }

  assert.ok(Array.isArray(materials.materials) && materials.materials.length >= 4, 'Should have at least 4 materials');
  for (const m of materials.materials) {
    assert.equal(m.placeholder, true, `Material ${m.id} must have placeholder: true`);
    assert.equal(
      m.source,
      'placeholder, verify with manufacturer datasheet',
      `Material ${m.id} source must match placeholder disclaimer`
    );
    for (const b of OCTAVE_BANDS) {
      assert.ok(typeof m.alpha[b] === 'number' && m.alpha[b] >= 0 && m.alpha[b] <= 1, `Material ${m.id} must have valid alpha for ${b} Hz`);
    }
  }
});

test('Phase 6 - Session aggregation rules: tier filtering, fake exclusion, and data status', () => {
  const mockMeasurements = [
    {
      id: 1,
      status: 'measured',
      fake: false,
      source: 'wav',
      bands: {
        500: { rt60: 1.20, t30: 1.20, used: 'T30', tier: 'valid' },
        1000: { rt60: 0.90, t20: 0.90, used: 'T20', tier: 'approximate' },
        2000: { rt60: 0.80, t20: 0.80, used: 'T20', tier: 'invalid' }, // Invalid tier
      },
    },
    {
      id: 2,
      status: 'measured',
      fake: false,
      source: 'wav',
      bands: {
        500: { rt60: 1.10, t30: 1.10, used: 'T30', tier: 'valid' },
        1000: { rt60: 0.95, t30: 0.95, used: 'T30', tier: 'valid' },
        2000: { rt60: NaN, used: 'none', tier: 'invalid' },
      },
    },
    {
      id: 3,
      status: 'measured',
      fake: true,
      source: 'dev', // Simulated / Dev point
      bands: {
        500: { rt60: 2.00, t30: 2.00, used: 'T30', tier: 'valid' },
      },
    },
    {
      id: 4,
      status: 'pending', // Pending point, not yet measured
      bands: null,
    },
  ];

  // Default: Real data only (fake excluded)
  const realOnly = aggregateSessionBands(mockMeasurements, { includeSimulated: false });
  assert.equal(realOnly.dataStatus.realCount, 2);
  assert.equal(realOnly.dataStatus.simulatedCount, 1);
  assert.equal(realOnly.dataStatus.includedCount, 2);
  assert.equal(realOnly.bands[500].count, 2);
  assert.equal(realOnly.bands[500].validCount, 2);
  assert.equal(realOnly.bands[500].approximateCount, 0);
  assert.equal(realOnly.bands[500].mean, 1.15);
  assert.equal(realOnly.bands[500].min, 1.10);
  assert.equal(realOnly.bands[500].max, 1.20);
  assert.equal(realOnly.bands[500].spread, 0.10);

  // 1000 Hz: 1 valid, 1 approximate -> count 2, hasApproximate: true
  assert.equal(realOnly.bands[1000].count, 2);
  assert.equal(realOnly.bands[1000].validCount, 1);
  assert.equal(realOnly.bands[1000].approximateCount, 1);
  assert.equal(realOnly.bands[1000].hasApproximate, true);

  // 2000 Hz: both points invalid -> count 0, insufficient data
  assert.equal(realOnly.bands[2000].hasData, false);
  assert.equal(realOnly.bands[2000].count, 0);
  assert.equal(realOnly.bands[2000].reason, 'insufficient data');

  // Toggle: Include simulated data
  const withSim = aggregateSessionBands(mockMeasurements, { includeSimulated: true });
  assert.equal(withSim.dataStatus.includedCount, 3);
  assert.equal(withSim.bands[500].count, 3);
  assert.equal(withSim.bands[500].max, 2.00);

  // Check data status line format (N real points: M valid, K approximate)
  assert.match(realOnly.dataStatus.statusLine, /2 real points:\s*\d+\s*valid,\s*\d+\s*approximate/);
});

test('Phase 3a-2c - Low-confidence measurements are excluded by default and only included via explicit toggle', () => {
  const measurementsWithLowConf = [
    {
      id: 1,
      status: 'measured',
      lowConfidence: false,
      bands: {
        500: { tier: 'valid', rt60: 1.0, used: 'T30' },
      },
    },
    {
      id: 2,
      status: 'measured',
      lowConfidence: true,
      bands: {
        500: { tier: 'approximate', rt60: 1.5, used: 'T20' },
      },
    },
  ];

  // Default: lowConfidence: true is EXCLUDED
  const defaultAgg = aggregateSessionBands(measurementsWithLowConf);
  assert.equal(defaultAgg.dataStatus.lowConfidenceCount, 1);
  assert.equal(defaultAgg.dataStatus.hasLowConfidence, true);
  assert.equal(defaultAgg.dataStatus.includedCount, 1);
  assert.equal(defaultAgg.bands[500].count, 1);
  assert.equal(defaultAgg.bands[500].mean, 1.0);
  assert.match(defaultAgg.dataStatus.statusLine, /1 low-confidence excluded/);

  // Explicit opt-in: includeLowConfidence: true
  const includedAgg = aggregateSessionBands(measurementsWithLowConf, { includeLowConfidence: true });
  assert.equal(includedAgg.dataStatus.includedCount, 2);
  assert.equal(includedAgg.bands[500].count, 2);
  assert.equal(includedAgg.bands[500].mean, 1.25);
  assert.match(includedAgg.dataStatus.statusLine, /1 low-confidence included/);
});

test('Phase 6 - Primary ratio math and plain-language readings', () => {
  // Target met (<= 1.0)
  const met = formatPrimaryRatio(0.38, 0.40);
  assert.equal(met.targetMet, true);
  assert.equal(met.ratio, 0.95);
  assert.equal(met.plainLanguage, 'target met (no extra absorption needed)');

  // Target met exactly 1.0
  const exact = formatPrimaryRatio(0.40, 0.40);
  assert.equal(exact.targetMet, true);
  assert.equal(exact.plainLanguage, 'target met (no extra absorption needed)');

  // Target exceeded (> 1.0): required wording
  // “total absorption must be about X times what it is now (add about X-1 times the current amount)”
  const needed = formatPrimaryRatio(1.20, 0.40);
  assert.equal(needed.targetMet, false);
  assert.equal(needed.ratio, 3.00);
  assert.equal(needed.excessFactor, 2.00);
  assert.equal(
    needed.plainLanguage,
    'total absorption must be about 3.0 times what it is now (add about 2.0 times the current amount)'
  );

  // Approximate tier labeling
  const approx = formatPrimaryRatio(0.80, 0.40, true);
  assert.equal(approx.hasApproximate, true);
  assert.equal(approx.approximateLabel, 'approximate-tier input');
});

test('Phase 6 - Hand-checked worked example from PLAN.md vs Python ground truth', () => {
  const planExp = expected.plan_example;
  const geom = roomGeometry(5.0, 4.0, 3.0);

  assert.equal(geom.volume, planExp.geometry.volume);
  assert.equal(geom.surfaceArea, planExp.geometry.surface_area);
  const wallCeilingArea = 2.0 * (geom.length * geom.height + geom.width * geom.height) + (geom.length * geom.width);
  assert.equal(wallCeilingArea, planExp.geometry.wall_ceiling_area); // 74 m2

  const treatment = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    minRt60: 1.20,
    maxRt60: 1.20,
    targetRt60: 0.40,
    materialAlpha: 0.80,
    existingAlpha: 0.05,
    geometry: geom,
    isSteps: false,
  });

  // Verify Sabine values
  assert.equal(treatment.primary.ratio, 3.00);
  assert.equal(treatment.sabine.aNow, planExp.sabine.a_now); // 8.05
  assert.equal(treatment.sabine.aTarget, planExp.sabine.a_target); // 24.15
  assert.ok(Math.abs(treatment.sabine.deltaA - planExp.sabine.delta_a) < 0.01);
  assert.ok(
    Math.abs(treatment.sabine.sPanel - planExp.sabine.s_panel) < 0.01,
    `Sabine panel area must match Python reference ~21.47 m2, got ${treatment.sabine.sPanel}`
  );

  // Verify Eyring values side-by-side
  assert.ok(
    Math.abs(treatment.eyring.sPanel - planExp.eyring.s_panel) < 0.01,
    `Eyring panel area must match Python reference ~18.11 m2, got ${treatment.eyring.sPanel}`
  );
  assert.equal(treatment.eyring.isDeadRoom, false);
});

test('Phase 6 - Dead-room Eyring example with alpha_avg > 0.3', () => {
  const deadExp = expected.dead_room_example;
  const geom = roomGeometry(4.0, 3.0, 2.4);

  const treatment = calculateBandTreatment({
    band: 1000,
    meanRt60: 0.80,
    minRt60: 0.80,
    maxRt60: 0.80,
    targetRt60: 0.20,
    materialAlpha: 0.85,
    existingAlpha: 0.05,
    geometry: geom,
    isSteps: false,
  });

  assert.equal(treatment.primary.ratio, 4.00);
  assert.ok(Math.abs(treatment.sabine.sPanel - deadExp.sabine.s_panel) < 0.01);
  assert.ok(Math.abs(treatment.eyring.sPanel - deadExp.eyring.s_panel) < 0.01);
  assert.equal(treatment.eyring.isDeadRoom, true);
  assert.ok(treatment.eyring.alphaAvgTarget > 0.30);
});

test('Phase 6 - Mathematical guards: deltaA <= 0, alpha_mat <= alpha_exist, and area exceeded', () => {
  const geom = roomGeometry(5.0, 4.0, 3.0); // Wall+ceiling area = 74 m2

  // Guard 1: Measured RT60 at or below target (deltaA <= 0)
  // Must return "no extra absorption needed", never a negative area
  const metGuard = calculateBandTreatment({
    band: 500,
    meanRt60: 0.35,
    minRt60: 0.30,
    maxRt60: 0.38,
    targetRt60: 0.40,
    materialAlpha: 0.80,
    existingAlpha: 0.05,
    geometry: geom,
  });
  assert.equal(metGuard.guards.targetMet, true);
  assert.equal(metGuard.sabine.sPanel, 0.0);
  assert.equal(metGuard.sabine.deltaA, 0.0);
  assert.equal(metGuard.eyring.sPanel, 0.0);
  assert.equal(metGuard.range.sPanelMin, 0.0);
  assert.equal(metGuard.range.sPanelMax, 0.0);
  assert.match(metGuard.guards.message.toLowerCase(), /no extra absorption needed/);

  // Guard 2: Material alpha <= existing surface alpha
  const lowAlpha = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    targetRt60: 0.40,
    materialAlpha: 0.04,
    existingAlpha: 0.05,
    geometry: geom,
  });
  assert.equal(lowAlpha.guards.materialIneffective, true);
  assert.equal(lowAlpha.sabine.sPanel, Infinity);
  assert.match(lowAlpha.guards.message, /No amount of this panel can help/);

  // Material alpha EQUAL to existing surface alpha
  const equalAlpha = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    targetRt60: 0.40,
    materialAlpha: 0.05,
    existingAlpha: 0.05,
    geometry: geom,
  });
  assert.equal(equalAlpha.guards.materialIneffective, true);
  assert.equal(equalAlpha.sabine.sPanel, Infinity);

  // Guard 3: Required panel area exceeds available wall and ceiling area
  // Wall+ceiling is 74 m2. With a very low net alpha (0.15 - 0.05 = 0.10), required area is 161 m2
  const exceeded = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    targetRt60: 0.40,
    materialAlpha: 0.15, // net alpha = 0.10 -> sPanel = 16.1 / 0.1 = 161 m2 > 74 m2
    existingAlpha: 0.05,
    geometry: geom,
  });
  assert.equal(exceeded.guards.areaExceeded, true);
  assert.match(exceeded.guards.message, /Target is not reachable with this material/);
  assert.match(exceeded.guards.message, /exceeding available wall and ceiling area/);
});

test('Phase 6 - Range propagation: monotonic corners with step volume uncertainty (~30%) and measured spread', () => {
  const geom = roomGeometry(5.0, 4.0, 3.0); // V = 60 m3
  const stepExp = expected.corners.steps;

  // Step counts enable ~30% volume uncertainty (V_min = 42, V_max = 78)
  // Measured RT60 spread: min = 1.1s, mean = 1.2s, max = 1.3s
  const stepTreatment = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    minRt60: 1.10,
    maxRt60: 1.30,
    targetRt60: 0.40,
    materialAlpha: 0.80,
    existingAlpha: 0.05,
    geometry: geom,
    isSteps: true,
  });

  assert.equal(stepTreatment.range.isSteps, true);
  assert.equal(stepTreatment.range.volumeMin, stepExp.volume_min);
  assert.equal(stepTreatment.range.volumeMax, stepExp.volume_max);
  assert.ok(Math.abs(stepTreatment.range.sPanelNominal - stepExp.s_panel_nominal) < 0.01);
  assert.ok(Math.abs(stepTreatment.range.sPanelMin - stepExp.s_panel_min) < 0.01);
  assert.ok(Math.abs(stepTreatment.range.sPanelMax - stepExp.s_panel_max) < 0.01);

  // Monotonic property: Min corner must be strictly less than nominal, and nominal less than Max corner
  assert.ok(stepTreatment.range.sPanelMin < stepTreatment.range.sPanelNominal);
  assert.ok(stepTreatment.range.sPanelNominal < stepTreatment.range.sPanelMax);

  // Exact metres (no step volume uncertainty): range reflects only measured RT60 spread
  const exactExp = expected.corners.exact;
  const exactTreatment = calculateBandTreatment({
    band: 500,
    meanRt60: 1.20,
    minRt60: 1.10,
    maxRt60: 1.30,
    targetRt60: 0.40,
    materialAlpha: 0.80,
    existingAlpha: 0.05,
    geometry: geom,
    isSteps: false,
  });

  assert.equal(exactTreatment.range.isSteps, false);
  assert.equal(exactTreatment.range.volumeMin, 60.0);
  assert.equal(exactTreatment.range.volumeMax, 60.0);
  assert.ok(Math.abs(exactTreatment.range.sPanelMin - exactExp.s_panel_min) < 0.01);
  assert.ok(Math.abs(exactTreatment.range.sPanelMax - exactExp.s_panel_max) < 0.01);
});

test('Phase 6 - Headline calculation (250 Hz - 4 kHz) and 125 Hz room-mode caveat', () => {
  const geom = roomGeometry(5.0, 4.0, 3.0);
  const bandTreatments = {};

  for (const b of OCTAVE_BANDS) {
    bandTreatments[b] = calculateBandTreatment({
      band: b,
      meanRt60: 1.0,
      minRt60: 0.9,
      maxRt60: 1.1,
      targetRt60: 0.4,
      materialAlpha: 0.8,
      existingAlpha: 0.05,
      geometry: geom,
      isSteps: false,
    });
  }

  const headline = computeTreatmentHeadline(bandTreatments);
  assert.equal(headline.hasData, true);
  assert.equal(headline.activeBandCount, 5); // 250, 500, 1000, 2000, 4000
  assert.ok(Number.isFinite(headline.headlineAreaNominal));
  assert.ok(headline.lowFreqCaveat.includes('room modes'));
  assert.ok(headline.lowFreqCaveat.includes('125 Hz'));
  assert.ok(headline.lowFreqCaveat.includes('bass traps'));
});

test('Phase 6 - Hotspot highlight on heatmap: requires >= 6 points and spread > 10% mean', () => {
  // Case 1: Fewer than 6 usable points -> no hotspot, uniform message
  const fewPoints = [
    { value: 0.5 }, { value: 0.6 }, { value: 0.8 }, { value: 0.9 }, { value: 1.1 }
  ];
  const resFew = evaluateHotspot(fewPoints);
  assert.equal(resFew.hasHotspot, false);
  assert.equal(resFew.message, HOTSPOT_UNIFORM_MESSAGE);

  // Case 2: >= 6 points but uniform field (spread <= 10% of mean) -> no hotspot
  // Mean = 0.50, spread = 0.52 - 0.48 = 0.04 (8% of mean <= 10%)
  const uniformPoints = [
    { value: 0.48 }, { value: 0.49 }, { value: 0.50 },
    { value: 0.50 }, { value: 0.51 }, { value: 0.52 }
  ];
  const resUniform = evaluateHotspot(uniformPoints);
  assert.equal(resUniform.hasHotspot, false);
  assert.equal(resUniform.message, HOTSPOT_UNIFORM_MESSAGE);

  // Case 3: >= 6 points and spread > 10% of mean -> hotspot active with Q3 threshold & caption
  const hotspotPoints = [
    { value: 0.40 }, { value: 0.45 }, { value: 0.50 },
    { value: 0.60 }, { value: 0.85 }, { value: 1.20 }
  ];
  const resHotspot = evaluateHotspot(hotspotPoints);
  assert.equal(resHotspot.hasHotspot, true);
  assert.ok(Number.isFinite(resHotspot.q3Threshold));
  assert.equal(resHotspot.caption, HOTSPOT_CAPTION);

  // Verify Q3 percentile threshold calculation matches Python reference
  const pyHotspot = expected.hotspot;
  const jsQ3 = computePercentile(pyHotspot.values, 0.75);
  assert.ok(Math.abs(jsQ3 - pyHotspot.q3_threshold) < 1e-6);
});
