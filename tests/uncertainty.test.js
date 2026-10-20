import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  interpolateUncertainty,
  RT60_TARGET_STEPS,
  DEFAULT_BY_TARGET,
} from '../src/analysis/uncertainty.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const uncertaintyJson = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'src/data/uncertainty.json'), 'utf8'));

test('Uncertainty - Exact match at target endpoints (0.3s, 0.6s, 0.8s, 1.2s, 1.5s)', () => {
  // Test 125 Hz
  const res03 = interpolateUncertainty(0.3, 125, uncertaintyJson);
  assert.strictEqual(res03.twoSigmaPct, 17.8);
  assert.strictEqual(res03.clamped, null);
  assert.strictEqual(res03.displayText, 'typical scatter ±17.8%');

  const res06 = interpolateUncertainty(0.6, 125, uncertaintyJson);
  assert.strictEqual(res06.twoSigmaPct, 9.5);
  assert.strictEqual(res06.clamped, null);

  const res08 = interpolateUncertainty(0.8, 125, uncertaintyJson);
  assert.strictEqual(res08.twoSigmaPct, 9.0);
  assert.strictEqual(res08.clamped, null);

  const res12 = interpolateUncertainty(1.2, 125, uncertaintyJson);
  assert.strictEqual(res12.twoSigmaPct, 7.9);
  assert.strictEqual(res12.clamped, null);

  const res15 = interpolateUncertainty(1.5, 125, uncertaintyJson);
  assert.strictEqual(res15.twoSigmaPct, 8.1);
  assert.strictEqual(res15.clamped, null);

  // Test 250 Hz at 0.3s -> 13.4%
  const res250_03 = interpolateUncertainty(0.3, 250, uncertaintyJson);
  assert.strictEqual(res250_03.twoSigmaPct, 13.4);

  // Test 4000 Hz at 1.5s -> 1.2%
  const res4k_15 = interpolateUncertainty(1.5, 4000, uncertaintyJson);
  assert.strictEqual(res4k_15.twoSigmaPct, 1.2);
});

test('Uncertainty - Linear interpolation between target points', () => {
  // Halfway between 0.3s (17.84%) and 0.6s (9.52%) at 125 Hz:
  // Expected: (17.84 + 9.52) / 2 = 13.68% -> 13.7%
  const resMid = interpolateUncertainty(0.45, 125, uncertaintyJson);
  assert.strictEqual(resMid.twoSigmaPct, 13.7);
  assert.strictEqual(resMid.clamped, null);
  assert.strictEqual(resMid.displayText, 'typical scatter ±13.7%');

  // Halfway between 0.8s (7.12%) and 1.2s (5.62%) at 250 Hz:
  // Expected: (7.12 + 5.62) / 2 = 6.37% -> 6.4%
  const resMid250 = interpolateUncertainty(1.0, 250, uncertaintyJson);
  assert.strictEqual(resMid250.twoSigmaPct, 6.4);
  assert.strictEqual(resMid250.clamped, null);
});

test('Uncertainty - Clamping outside [0.3s, 1.5s] with clear UI message', () => {
  // RT60 < 0.3s (e.g. 0.20s in a dead vocal booth)
  const resLow = interpolateUncertainty(0.20, 125, uncertaintyJson);
  assert.strictEqual(resLow.twoSigmaPct, 17.8);
  assert.strictEqual(resLow.clamped, 'low');
  assert.strictEqual(resLow.clampedTarget, 0.3);
  assert.strictEqual(resLow.displayText, 'typical scatter ±17.8%, clamped at 0.3s');

  // RT60 > 1.5s (e.g. 2.4s in a cathedral)
  const resHigh = interpolateUncertainty(2.4, 4000, uncertaintyJson);
  assert.strictEqual(resHigh.twoSigmaPct, 1.2);
  assert.strictEqual(resHigh.clamped, 'high');
  assert.strictEqual(resHigh.clampedTarget, 1.5);
  assert.strictEqual(resHigh.displayText, 'typical scatter ±1.2%, clamped at 1.5s');
});

test('Uncertainty - Works with default embedded fallback when data is omitted', () => {
  const resDefault = interpolateUncertainty(0.3, 125);
  assert.strictEqual(resDefault.twoSigmaPct, 17.8);
  assert.strictEqual(resDefault.displayText, 'typical scatter ±17.8%');
});
