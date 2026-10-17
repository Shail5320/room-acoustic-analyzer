/**
 * src/analysis/selftest.js — Synthetic room acoustic simulation and self-test verification.
 *
 * Implements:
 *   - Reproducible PRNG: seeded mulberry32 and Box-Muller Gaussian generator.
 *   - Room impulse response synthesizer: exponential decay corresponding to target RT60 (0.3s to 1.5s).
 *   - Convolution with reference sweep at 48 kHz.
 *   - runSelfTest(): feeds synthetic recording through runAnalysis worker/fallback pipeline.
 *   - Guaranteed tagging: all results carry simulated: true, fake: true, source: 'selftest'.
 *   - Derived empirical Mean ± 2σ bounds per RT60 target for regression testing.
 */

import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
  MIN_RECORDING_DURATION_S,
} from './config.js';

import { generateSweep } from '../dsp/sweep.js';
import { convolveDirect } from '../dsp/deconvolve.js';
import { runAnalysis } from './run.js';

/**
 * Empirical Mean ± 2σ bounds derived across 10 random seeds per RT60 target.
 */
export const SELFTEST_TOLERANCES = {
  0.3: { min: 0.2838, max: 0.3236, mean: 0.3037, twoSigma: 0.0199 },
  0.6: { min: 0.5801, max: 0.6452, mean: 0.6127, twoSigma: 0.0326 },
  0.8: { min: 0.7609, max: 0.8517, mean: 0.8063, twoSigma: 0.0454 },
  1.2: { min: 1.1802, max: 1.2658, mean: 1.2230, twoSigma: 0.0428 },
  1.5: { min: 1.4598, max: 1.5791, mean: 1.5194, twoSigma: 0.0597 },
};

/**
 * Seeded 32-bit PRNG (mulberry32).
 *
 * @param {number} seed
 * @returns {() => number} uniform random in [0, 1)
 */
export function createMulberry32(seed = 12345) {
  let s = Math.floor(seed) | 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal Gaussian generator via Box-Muller transform.
 *
 * @param {() => number} rng
 * @returns {number}
 */
export function boxMuller(rng) {
  const u1 = Math.max(1e-15, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Synthesize a simulated room recording for a given target RT60.
 *
 * @param {object} [options]
 * @param {number} [options.rtTarget=0.8]   — Target reverberation time in seconds [0.3, 1.5]
 * @param {number} [options.sampleRate=48000]
 * @param {number} [options.seed=42]
 * @param {boolean} [options.addNoise=false]
 * @param {number} [options.snrDb=50]
 * @returns {{
 *   samples: Float32Array,
 *   sampleRate: number,
 *   rtTarget: number,
 *   seed: number,
 *   simulated: boolean
 * }}
 */
export function simulateRoomRecording(options = {}) {
  const rtTarget = Math.max(0.3, Math.min(1.5, Number(options.rtTarget) || 0.8));
  const sampleRate = options.sampleRate || 48000;
  const seed = options.seed != null ? options.seed : (1000 + Math.round(rtTarget * 100));
  const addNoise = Boolean(options.addNoise);
  const snrDb = options.snrDb || 50;

  const rng = createMulberry32(seed);

  // 1. Synthesize reference exponential sine sweep
  const sweep = generateSweep(
    SWEEP_F1,
    SWEEP_F2,
    SWEEP_DURATION_S,
    sampleRate,
    SWEEP_FADE_MS
  );

  // 2. Synthesize room impulse response with target exponential decay
  // Decay constant: -60 dB = ln(10^-3) = -6.907755
  const irLen = Math.round(Math.max(2.5, rtTarget * 2.0) * sampleRate);
  const ir = new Float64Array(irLen);
  const decayConst = 6.907755278982137 / rtTarget;

  for (let i = 0; i < irLen; i++) {
    const t = i / sampleRate;
    ir[i] = boxMuller(rng) * Math.exp(-decayConst * t);
  }

  // Normalize IR peak
  let maxAbs = 0;
  for (let i = 0; i < irLen; i++) {
    const a = Math.abs(ir[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 0) {
    for (let i = 0; i < irLen; i++) ir[i] /= maxAbs;
  }

  // 3. Convolve sweep with synthetic room IR
  const recRaw = convolveDirect(sweep, ir);

  // 4. Pad with leading silence (1.0 s) and trailing silence to reach at least MIN_RECORDING_DURATION_S (8.5 s)
  const leadSamples = Math.round(1.0 * sampleRate);
  const minTotal = Math.round(Math.max(MIN_RECORDING_DURATION_S + 0.5, 8.5) * sampleRate);
  const totalSamples = Math.max(leadSamples + recRaw.length, minTotal);

  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < recRaw.length; i++) {
    samples[leadSamples + i] = recRaw[i];
  }

  // Optional background noise
  if (addNoise) {
    let recPeak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > recPeak) recPeak = a;
    }
    const noiseSigma = recPeak * Math.pow(10, -snrDb / 20.0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] += boxMuller(rng) * noiseSigma;
    }
  }

  return {
    samples,
    sampleRate,
    rtTarget,
    seed,
    simulated: true,
  };
}

/**
 * Execute room acoustic self-test end-to-end through the analysis pipeline.
 *
 * @param {object} [options]
 * @param {number} [options.rtTarget=0.8]
 * @param {number} [options.seed=42]
 * @param {boolean} [options.addNoise=false]
 * @param {number} [options.snrDb=50]
 * @param {Function} [options.onProgress]
 * @returns {Promise<object>} — Pipeline result augmented with self-test flags and validation
 */
export async function runSelfTest(options = {}) {
  const { samples, sampleRate, rtTarget, seed } = simulateRoomRecording(options);

  const result = await runAnalysis(samples, sampleRate, options.onProgress);

  const bounds = SELFTEST_TOLERANCES[rtTarget] || null;
  const recovered500 = result.ok && result.bands && result.bands[500]
    ? result.bands[500].rt60
    : null;

  const passed = Boolean(
    result.ok &&
    recovered500 != null &&
    bounds &&
    recovered500 >= bounds.min &&
    recovered500 <= bounds.max
  );

  return {
    ...result,
    simulated: true,
    fake: true,
    source: 'selftest',
    targetRt60: rtTarget,
    recoveredRt60: recovered500,
    tolerances: bounds,
    passed,
    seed,
  };
}
