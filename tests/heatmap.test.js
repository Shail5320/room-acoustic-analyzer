import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_USABLE_HEATMAP_POINTS,
  RECOMMENDED_HEATMAP_POINTS,
  HEATMAP_UNRELIABLE_MESSAGE,
  HEATMAP_CAPTION,
  DEV_DATA_BANNER,
  VIRIDIS_STOPS,
  getLuminance,
  interpolateViridis,
  valueToColor,
  extractPointBandValue,
  getUsablePoints,
  getBandTierCounts,
  formatBandTierCounts,
  computeHeatmapRange,
  aspectCorrectedDist,
  interpolateIDW,
  computeHeatmapGrid,
} from '../src/ui/heatmap-math.js';

test('Heatmap Math - Exact reproduction at measured points (distance 0 returns exact value without division by zero)', () => {
  const points = [
    { x: 0.2, y: 0.3, value: 0.65 },
    { x: 0.8, y: 0.3, value: 0.95 },
    { x: 0.5, y: 0.7, value: 1.25 },
  ];
  const R = 4 / 3;

  for (const p of points) {
    const evaluated = interpolateIDW(p.x, p.y, points, R, 2);
    assert.equal(evaluated, p.value, `At point (${p.x}, ${p.y}), evaluated value must equal measured value exactly`);
  }

  // Very close distance (< 1e-6) also safely resolves to exact measured value without division by zero
  const tinyOffsetEval = interpolateIDW(0.2 + 1e-8, 0.3, points, R, 2);
  assert.equal(tinyOffsetEval, 0.65);
});

test('Heatmap Math - Spatial symmetry for symmetric layouts', () => {
  // 4 points placed symmetrically around room center (0.5, 0.5) with symmetric values
  const points = [
    { x: 0.2, y: 0.2, value: 0.8 },
    { x: 0.8, y: 0.2, value: 0.8 },
    { x: 0.2, y: 0.8, value: 1.2 },
    { x: 0.8, y: 0.8, value: 1.2 },
  ];
  const R = 4 / 3;

  // Center (0.5, 0.5) must be exact average: (0.8 + 1.2) / 2 = 1.0
  const centerVal = interpolateIDW(0.5, 0.5, points, R, 2);
  assert.ok(Math.abs(centerVal - 1.0) < 1e-12, `Center value must be 1.0, got ${centerVal}`);

  // Symmetric points along horizontal line y = 0.5
  const leftVal = interpolateIDW(0.3, 0.5, points, R, 2);
  const rightVal = interpolateIDW(0.7, 0.5, points, R, 2);
  assert.ok(
    Math.abs(leftVal - rightVal) < 1e-12,
    `Symmetric horizontal points must have equal values: left=${leftVal}, right=${rightVal}`
  );
});

test('Heatmap Math - Hand-computed IDW reference verification', () => {
  /**
   * Hand computation details:
   * P1 = (0.2, 0.5), v1 = 1.0
   * P2 = (0.5, 0.2), v2 = 2.0
   * Aspect ratio R = 4/3
   * Evaluation coordinate = (0.5, 0.5)
   *
   * Distance to P1:
   * dx1 = (0.5 - 0.2) * (4/3) = 0.3 * (4/3) = 0.4
   * dy1 = 0.5 - 0.5 = 0
   * d1^2 = 0.4^2 = 0.16
   * w1 = 1 / 0.16 = 6.25 = 25/4
   *
   * Distance to P2:
   * dx2 = (0.5 - 0.5) * (4/3) = 0
   * dy2 = 0.5 - 0.2 = 0.3
   * d2^2 = 0.3^2 = 0.09
   * w2 = 1 / 0.09 = 100/9
   *
   * sumWeight = 25/4 + 100/9 = (225 + 400) / 36 = 625 / 36
   * sumWeightedVal = 6.25 * 1.0 + (100/9) * 2.0 = 25/4 + 200/9 = (225 + 800) / 36 = 1025 / 36
   *
   * V = (1025 / 36) / (625 / 36) = 1025 / 625 = 41 / 25 = 1.64 EXACTLY.
   */
  const points = [
    { x: 0.2, y: 0.5, value: 1.0 },
    { x: 0.5, y: 0.2, value: 2.0 },
  ];
  const R = 4 / 3;
  const result = interpolateIDW(0.5, 0.5, points, R, 2);

  assert.ok(
    Math.abs(result - 1.64) < 1e-12,
    `Hand-calculated IDW at (0.5, 0.5) must equal 1.64 exactly, got ${result}`
  );
});

test('Heatmap Math - Aspect-ratio effect (4:3 vs 16:9 produces different distances and values)', () => {
  const p1 = { x: 0.2, y: 0.5, value: 1.0 };
  const p2 = { x: 0.5, y: 0.2, value: 2.0 };
  const points = [p1, p2];

  const evalX = 0.5;
  const evalY = 0.5;

  const distSquare = aspectCorrectedDist(p1.x, p1.y, evalX, evalY, 1.0);
  const dist43 = aspectCorrectedDist(p1.x, p1.y, evalX, evalY, 4 / 3);
  const dist169 = aspectCorrectedDist(p1.x, p1.y, evalX, evalY, 16 / 9);

  // Horizontal relative offset is 0.3.
  // With R = 1:   dx*R = 0.3000
  // With R = 4/3: dx*R = 0.4000
  // With R = 16/9:dx*R = 0.5333...
  assert.ok(Math.abs(distSquare - 0.3) < 1e-12);
  assert.ok(Math.abs(dist43 - 0.4) < 1e-12);
  assert.ok(Math.abs(dist169 - (0.3 * 16 / 9)) < 1e-12);

  // Evaluated values must differ under different aspect ratios
  const valSquare = interpolateIDW(evalX, evalY, points, 1.0, 2);
  const val43 = interpolateIDW(evalX, evalY, points, 4 / 3, 2);
  const val169 = interpolateIDW(evalX, evalY, points, 16 / 9, 2);

  assert.ok(Math.abs(valSquare - 1.5) < 1e-12, 'Symmetric distances at 1:1 ratio must yield 1.5');
  assert.ok(Math.abs(val43 - 1.64) < 1e-12, 'Aspect ratio 4:3 yields 1.64');
  // Hand-calc for 16:9: 593 / 337 ≈ 1.7596439
  assert.ok(Math.abs(val169 - (593 / 337)) < 1e-6);

  assert.notEqual(val43, val169, 'Aspect ratio must influence relative horizontal weight');
});

test('Heatmap Math - Invalid, pending, and fake handling with strict metric selection', () => {
  const measurements = [
    // 1: Valid T30
    {
      id: 1,
      x: 0.2,
      y: 0.2,
      status: 'measured',
      fake: false,
      bands: {
        500: { t20: 0.72, t30: 0.70, edt: 0.75, used: 'T30', tier: 'valid', rt60: 0.70 },
      },
    },
    // 2: Approximate T20 (T30 was rejected by tier)
    {
      id: 2,
      x: 0.8,
      y: 0.2,
      status: 'measured',
      fake: false,
      bands: {
        500: { t20: 0.85, t30: 0.99, edt: 0.80, used: 'T20', tier: 'approximate', rt60: 0.85 },
      },
    },
    // 3: Invalid band (tier is invalid) -> MUST BE EXCLUDED
    {
      id: 3,
      x: 0.5,
      y: 0.5,
      status: 'measured',
      fake: false,
      bands: {
        500: { t20: 0.60, t30: 0.62, edt: 0.61, used: 'none', tier: 'invalid', rt60: NaN },
      },
    },
    // 4: Pending point -> MUST BE EXCLUDED
    {
      id: 4,
      x: 0.3,
      y: 0.7,
      status: 'pending',
      fake: false,
    },
    // 5: Fake test measurement with valid band
    {
      id: 5,
      x: 0.7,
      y: 0.7,
      status: 'measured',
      fake: true,
      bands: {
        500: { t20: 1.10, t30: 1.12, edt: 1.15, used: 'T30', tier: 'valid', rt60: 1.12 },
      },
    },
  ];

  // Point 1: uses T30 value (0.70)
  const res1 = extractPointBandValue(measurements[0], 500);
  assert.equal(res1.usable, true);
  assert.equal(res1.value, 0.70);
  assert.equal(res1.metric, 'T30');
  assert.equal(res1.tier, 'valid');

  // Point 2: uses T20 value (0.85) - never falls back to rejected T30
  const res2 = extractPointBandValue(measurements[1], 500);
  assert.equal(res2.usable, true);
  assert.equal(res2.value, 0.85);
  assert.equal(res2.metric, 'T20');
  assert.equal(res2.tier, 'approximate');

  // Point 3: invalid tier rejected
  const res3 = extractPointBandValue(measurements[2], 500);
  assert.equal(res3.usable, false);

  // Point 4: pending point rejected
  const res4 = extractPointBandValue(measurements[3], 500);
  assert.equal(res4.usable, false);

  // Filter contributing points
  const usable = getUsablePoints(measurements, 500);
  assert.equal(usable.length, 3, 'Only points 1, 2, and 5 should contribute');
  assert.deepEqual(usable.map((p) => p.id), [1, 2, 5]);
  assert.equal(usable.some((p) => p.fake), true, 'Detects fake test measurement');

  // Tier counts per band
  const counts = getBandTierCounts(measurements, 500);
  assert.equal(counts.valid, 2);
  assert.equal(counts.approximate, 1);
  assert.equal(counts.invalid, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.usable, 3);
  assert.equal(formatBandTierCounts(counts), '2 valid, 1 approximate, 1 invalid');
});

test('Heatmap Math - Low-confidence measurements excluded by default and included with explicit option', () => {
  const points = [
    {
      id: 1,
      x: 0.2,
      y: 0.2,
      status: 'measured',
      lowConfidence: false,
      bands: { 500: { tier: 'valid', t30: 0.8, rt60: 0.8, used: 'T30' } },
    },
    {
      id: 2,
      x: 0.8,
      y: 0.2,
      status: 'measured',
      lowConfidence: true,
      bands: { 500: { tier: 'approximate', t20: 1.2, rt60: 1.2, used: 'T20' } },
    },
  ];

  // Default: excluded
  const usableDefault = getUsablePoints(points, 500);
  assert.equal(usableDefault.length, 1);
  assert.equal(usableDefault[0].id, 1);

  const countsDefault = getBandTierCounts(points, 500);
  assert.equal(countsDefault.valid, 1);
  assert.equal(countsDefault.approximate, 0);
  assert.equal(countsDefault.usable, 1);

  // Opted in: included
  const usableIncluded = getUsablePoints(points, 500, { includeLowConfidence: true });
  assert.equal(usableIncluded.length, 2);
  assert.deepEqual(usableIncluded.map((p) => p.id), [1, 2]);

  const countsIncluded = getBandTierCounts(points, 500, { includeLowConfidence: true });
  assert.equal(countsIncluded.valid, 1);
  assert.equal(countsIncluded.approximate, 1);
  assert.equal(countsIncluded.usable, 2);
});

test('Heatmap Math - Fewer-than-4 rule triggers honest messaging and unreliability flag', () => {
  // 3 usable points
  const threePoints = [
    { x: 0.2, y: 0.2, value: 0.7 },
    { x: 0.8, y: 0.2, value: 0.8 },
    { x: 0.5, y: 0.8, value: 0.9 },
  ];
  const grid3 = computeHeatmapGrid(threePoints, { cols: 10, rows: 10 });
  assert.equal(grid3.usableCount, 3);
  assert.equal(grid3.isReliable, false, 'Fewer than 4 points must mark heatmap as unreliable');

  // 4 usable points
  const fourPoints = [
    { x: 0.2, y: 0.2, value: 0.7 },
    { x: 0.8, y: 0.2, value: 0.8 },
    { x: 0.2, y: 0.8, value: 0.9 },
    { x: 0.8, y: 0.8, value: 1.0 },
  ];
  const grid4 = computeHeatmapGrid(fourPoints, { cols: 10, rows: 10 });
  assert.equal(grid4.usableCount, 4);
  assert.equal(grid4.isReliable, true, '>= 4 points marks heatmap as reliable');

  // Verify honesty message strings
  assert.match(HEATMAP_UNRELIABLE_MESSAGE, /Not enough data for a reliable heatmap/);
  assert.match(HEATMAP_UNRELIABLE_MESSAGE, /at least 9 measurement points/);
  assert.match(HEATMAP_CAPTION, /Interpolated between measurement points; not a measurement/);
  assert.match(DEV_DATA_BANNER, /DEV DATA/);
});

test('Heatmap Math - Colour ramp endpoints and monotonic luminance ordering', () => {
  // Endpoints clamp correctly
  const colNegative = interpolateViridis(-0.5);
  const colZero = interpolateViridis(0.0);
  assert.equal(colNegative.hex, colZero.hex, 'Negative parameter clamps to stop 0');
  assert.equal(colZero.hex, '#440154');

  const colOverflow = interpolateViridis(1.5);
  const colOne = interpolateViridis(1.0);
  assert.equal(colOverflow.hex, colOne.hex, 'Parameter > 1 clamps to stop 1.0');
  assert.equal(colOne.hex, '#fde725');

  // Verify monotonic non-decreasing luminance across stops
  for (let i = 0; i < VIRIDIS_STOPS.length - 1; i++) {
    const s1 = VIRIDIS_STOPS[i];
    const s2 = VIRIDIS_STOPS[i + 1];
    const lum1 = getLuminance(s1.r, s1.g, s1.b);
    const lum2 = getLuminance(s2.r, s2.g, s2.b);
    assert.ok(
      lum2 >= lum1,
      `Viridis stop ${i + 1} luminance (${lum2}) must be >= stop ${i} luminance (${lum1})`
    );
  }

  // Sample 21 evenly spaced points from t = 0 to 1 and verify strictly non-decreasing luminance
  let prevLum = -1;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const col = interpolateViridis(t);
    assert.ok(
      col.luminance >= prevLum - 1e-4,
      `Interpolated luminance at t=${t} (${col.luminance}) should be >= previous (${prevLum})`
    );
    prevLum = col.luminance;
  }
});

test('Heatmap Math - Edge cases: single point and all points having equal values (zero-width range)', () => {
  // Single point
  const single = [{ x: 0.5, y: 0.5, value: 0.85 }];
  const singleRange = computeHeatmapRange(single, 'auto');
  assert.ok(singleRange.max > singleRange.min, 'Single point range must have non-zero width');
  assert.ok(singleRange.min <= 0.85 && singleRange.max >= 0.85);

  const singleGrid = computeHeatmapGrid(single, { cols: 6, rows: 6 });
  for (let i = 0; i < singleGrid.values.length; i++) {
    assert.equal(singleGrid.values[i], 0.85, 'Single point grid must evaluate everywhere to that point value');
  }

  // Equal values across all points
  const equalPoints = [
    { x: 0.1, y: 0.1, value: 0.75 },
    { x: 0.9, y: 0.1, value: 0.75 },
    { x: 0.1, y: 0.9, value: 0.75 },
    { x: 0.9, y: 0.9, value: 0.75 },
  ];
  const equalRange = computeHeatmapRange(equalPoints, 'auto');
  assert.ok(equalRange.max > equalRange.min, 'Equal points range must pad safely without dividing by zero');
  assert.ok(equalRange.min < 0.75 && equalRange.max > 0.75);

  const mappedCol = valueToColor(0.75, equalRange.min, equalRange.max);
  assert.ok(Number.isFinite(mappedCol.r) && Number.isFinite(mappedCol.g) && Number.isFinite(mappedCol.b));

  const equalGrid = computeHeatmapGrid(equalPoints, { cols: 8, rows: 8 });
  for (let i = 0; i < equalGrid.values.length; i++) {
    assert.ok(
      Math.abs(equalGrid.values[i] - 0.75) < 1e-12,
      `Equal points grid value must equal 0.75, got ${equalGrid.values[i]}`
    );
  }

  // Fixed range mode
  const fixedRange = computeHeatmapRange(equalPoints, 'fixed');
  assert.equal(fixedRange.min, 0.0);
  assert.equal(fixedRange.max, 2.0);
  assert.equal(fixedRange.isFixed, true);
});
