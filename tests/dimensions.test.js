import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAndValidateDimensions,
  deriveAspectRatio,
  relativeToMetric,
  DEFAULT_STEP_LENGTH,
} from '../src/ui/dimensions.js';
import { SessionModel } from '../src/ui/session-model.js';

test('Dimensions - Valid metres inputs calculate correct metric values', () => {
  const res = parseAndValidateDimensions({
    length: 5,
    width: 4,
    height: 3,
    unit: 'metres',
  });

  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.dimensions, {
    unit: 'metres',
    rawLength: 5,
    rawWidth: 4,
    rawHeight: 3,
    stepLength: DEFAULT_STEP_LENGTH,
    lengthM: 5,
    widthM: 4,
    heightM: 3,
    isApproximate: false,
  });
});

test('Dimensions - Step counts convert to metres and are tagged approximate', () => {
  const res = parseAndValidateDimensions({
    length: 10, // 10 steps * 0.7 = 7 m
    width: 8,  // 8 steps * 0.7 = 5.6 m
    height: 4, // 4 steps * 0.7 = 2.8 m
    unit: 'steps',
    stepLength: 0.7,
  });

  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.dimensions.isApproximate, true);
  assert.equal(res.dimensions.lengthM, 7);
  assert.equal(res.dimensions.widthM, 5.6);
  assert.equal(res.dimensions.heightM, 2.8);
  assert.equal(res.dimensions.rawLength, 10);
  assert.equal(res.dimensions.stepLength, 0.7);
});

test('Dimensions - Validation rejects non-positive or out-of-range bounds', () => {
  // Horizontal < 1 m
  const tooShort = parseAndValidateDimensions({ length: 0.5, width: 4, height: 3 });
  assert.equal(tooShort.valid, false);
  assert.ok(tooShort.errors.some((e) => e.includes('Length')));

  // Horizontal > 50 m
  const tooLong = parseAndValidateDimensions({ length: 55, width: 4, height: 3 });
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.some((e) => e.includes('Length')));

  // Height < 2 m
  const lowCeiling = parseAndValidateDimensions({ length: 5, width: 4, height: 1.5 });
  assert.equal(lowCeiling.valid, false);
  assert.ok(lowCeiling.errors.some((e) => e.includes('Height')));

  // Height > 10 m
  const cathedral = parseAndValidateDimensions({ length: 5, width: 4, height: 12 });
  assert.equal(cathedral.valid, false);
  assert.ok(cathedral.errors.some((e) => e.includes('Height')));

  // Negative / NaN inputs
  const invalidNum = parseAndValidateDimensions({ length: -5, width: 'abc', height: 3 });
  assert.equal(invalidNum.valid, false);
  assert.equal(invalidNum.errors.length, 2);

  // Invalid step length
  const badStep = parseAndValidateDimensions({
    length: 10,
    width: 8,
    height: 4,
    unit: 'steps',
    stepLength: 3.5,
  });
  assert.equal(badStep.valid, false);
  assert.ok(badStep.errors.some((e) => e.includes('Metres per step')));
});

test('Dimensions - deriveAspectRatio calculates aspect ratio and formatted string', () => {
  const derived = deriveAspectRatio(6.0, 4.0);
  assert.ok(derived);
  assert.equal(derived.ratio, 1.5);
  assert.equal(derived.ratioStr, '1.5:1');

  // Square
  const square = deriveAspectRatio(5.0, 5.0);
  assert.equal(square.ratio, 1.0);
  assert.equal(square.ratioStr, '1:1');

  // Degenerate inputs return null
  assert.equal(deriveAspectRatio(0, 4), null);
  assert.equal(deriveAspectRatio(-5, 4), null);
  assert.equal(deriveAspectRatio(5, NaN), null);
});

test('Dimensions - relativeToMetric converts [0, 1] coordinates to metres', () => {
  const dims = {
    lengthM: 6.0,
    widthM: 4.0,
    isApproximate: false,
  };

  const center = relativeToMetric(0.5, 0.5, dims);
  assert.deepEqual(center, {
    xM: 3.0,
    yM: 2.0,
    isApproximate: false,
  });

  const corner = relativeToMetric(1.0, 0.25, dims);
  assert.deepEqual(corner, {
    xM: 6.0,
    yM: 1.0,
    isApproximate: false,
  });

  // Clamps out of range [0, 1] coordinates
  const clamped = relativeToMetric(1.5, -0.2, dims);
  assert.deepEqual(clamped, {
    xM: 6.0,
    yM: 0.0,
    isApproximate: false,
  });

  // Steps tag is passed through
  const stepDims = { lengthM: 7.0, widthM: 5.6, isApproximate: true };
  const stepCoord = relativeToMetric(0.5, 0.5, stepDims);
  assert.equal(stepCoord.isApproximate, true);
  assert.equal(stepCoord.xM, 3.5);
  assert.equal(stepCoord.yM, 2.8);
});

test('Dimensions - Omitting room dimensions breaks nothing in SessionModel', () => {
  const model = new SessionModel();
  assert.equal(model.roomDimensions, null);

  model.setSource(0.4, 0.4);
  const pt = model.addPendingMeasurement(0.2, 0.8);
  assert.equal(pt.status, 'pending');

  const json = model.toJSON();
  assert.equal(json.roomDimensions, null);
  assert.equal(json.measurements.length, 1);

  // relativeToMetric safely returns null when dimensions are null/undefined
  assert.equal(relativeToMetric(0.2, 0.8, null), null);
  assert.equal(relativeToMetric(0.2, 0.8, undefined), null);
});
