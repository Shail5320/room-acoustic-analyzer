/**
 * tools/gate-battery.mjs — Robustness battery and large-offset verification for sweep-signature gate.
 *
 * Implements Section 1 large-offset cases (10s, 20s in 30s) and Section 2 robustness battery:
 *   a) Sweep with loud broadband thump (louder than sweep in 125-500 Hz) at start, middle, end
 *   b) Sweep through phone-speaker model (high-pass near 150-200 Hz @ 12 dB/oct, roll-off > 6 kHz) + brown rumble
 *   c) Sweep played twice back to back
 *   d) Cough-like burst during sweep
 *   e) Sweep plus 50 Hz hum at -30, -20, -10, 0 dB re sweep
 *
 * Reports:
 *   1. Current checkSweepSignature battery performance
 *   2. Prototype predicted-time template gate proposal & battery performance
 *
 * Usage:
 *   node tools/gate-battery.mjs
 */

import { generateSweep, generateInverseFilter } from '../src/dsp/sweep.js';
import { convolveDirect, deconvolve, findPeakAndPNR } from '../src/dsp/deconvolve.js';
import { sosFilt, designOctaveFilters } from '../src/dsp/bands.js';
import { checkSweepSignature } from '../src/analysis/pipeline.js';
import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
  SWEEP_SIG_MIN_SCORE,
  OCTAVE_CENTRES,
} from '../src/analysis/config.js';

// Deterministic PRNG
function createMulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function makeBrown(length, rng) {
  const noise = new Float64Array(length);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = boxMuller(rng);
    last = 0.995 * last + white * 0.1;
    noise[i] = last;
  }
  return noise;
}

// 2nd-order Butterworth Highpass filter design (12 dB/oct)
function designHighpass2(fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  const K2 = K * K;
  const sqrt2 = Math.SQRT2;
  const norm = 1.0 + sqrt2 * K + K2;
  const b0 = 1.0 / norm;
  const b1 = -2.0 / norm;
  const b2 = 1.0 / norm;
  const a1 = (2.0 * (K2 - 1.0)) / norm;
  const a2 = (1.0 - sqrt2 * K + K2) / norm;
  return [[b0, b1, b2, 1.0, a1, a2]];
}

// 1st-order Lowpass filter design (6 dB/oct gentle roll-off)
function designLowpass1(fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  const b0 = K / (1.0 + K);
  const b1 = K / (1.0 + K);
  const a1 = (K - 1.0) / (1.0 + K);
  return [[b0, b1, 0.0, 1.0, a1, 0.0]];
}

// Helper: Measure peak 50ms block RMS per octave band
function measureBandPeakBlockRms(signal, sampleRate) {
  const filters = designOctaveFilters(sampleRate, OCTAVE_CENTRES);
  const blockSamples = Math.round(50.0 * 1e-3 * sampleRate);
  const hopSamples = Math.round(25.0 * 1e-3 * sampleRate);
  const numHops = Math.max(1, Math.floor((signal.length - blockSamples) / hopSamples) + 1);
  const peakBlockMap = new Map();

  for (const fc of OCTAVE_CENTRES) {
    const sos = filters.get(fc);
    const filtered = sosFilt(sos, signal);
    let maxRms = 0;
    for (let h = 0; h < numHops; h++) {
      const start = h * hopSamples;
      let sumSq = 0;
      for (let i = 0; i < blockSamples; i++) {
        const val = filtered[start + i];
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / blockSamples);
      if (rms > maxRms) maxRms = rms;
    }
    peakBlockMap.set(fc, maxRms);
  }
  return peakBlockMap;
}

const sampleRate = 48000;
const currentGateResults = [];
const prototypeGateResults = [];

// Base sweep synthesis
const baseSweep = generateSweep(SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, sampleRate, SWEEP_FADE_MS);
const baseInv = generateInverseFilter(baseSweep, SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, sampleRate);

// Base room IR (RT60 = 0.8s)
const irLen = Math.round(2.5 * sampleRate);
const baseIr = new Float64Array(irLen);
const rngBaseIr = createMulberry32(101);
const decayRate = 6.907755 / 0.8;
for (let i = 0; i < irLen; i++) baseIr[i] = rngBaseIr() * Math.exp(-decayRate * (i / sampleRate));
let maxIr = 0;
for (let i = 0; i < irLen; i++) if (Math.abs(baseIr[i]) > maxIr) maxIr = Math.abs(baseIr[i]);
for (let i = 0; i < irLen; i++) baseIr[i] /= maxIr;

const baseRoomResp = convolveDirect(baseSweep, baseIr);

// Standard recording layout: 8.5 s total, sweep starts at t = 0.8 s
const stdDur = 8.5;
const stdTotal = Math.round(stdDur * sampleRate);
const sweepStartIdx = Math.round(0.8 * sampleRate);

function createStandardRoomRecording() {
  const buf = new Float64Array(stdTotal);
  buf.set(baseRoomResp.subarray(0, stdTotal - sweepStartIdx), sweepStartIdx);
  return buf;
}

// Baseline peak block RMS of the clean sweep recording
const cleanBandPeakRms = measureBandPeakBlockRms(createStandardRoomRecording(), sampleRate);

// ============================================================================
// PROTOTYPE: Predicted-Time Template Gate
// ============================================================================
/**
 * Predicted-time template gate:
 *   1. Obtains start time t_start from deconvolution direct-arrival peak.
 *   2. Predicts expected octave center arrival times: t_k = t_start + L * ln(f_k / f1).
 *   3. Compares band energy in a window around t_k with the band background baseline.
 *   4. Requires at least 4 of 6 bands to exhibit significant energy above background.
 */
function checkPredictedTimeTemplateGate(signal, sampleRate, options = {}) {
  if (!signal || signal.length === 0) {
    return { ok: false, matchingBands: 0, requiredBands: 4, bandMarginsDb: [], peakTimes: [], tStartS: 0 };
  }

  const f1 = options.f1 || SWEEP_F1;
  const f2 = options.f2 || SWEEP_F2;
  const T = options.T || SWEEP_DURATION_S;
  const centres = options.octaveCentres || OCTAVE_CENTRES;

  // 1. Deconvolve against inverse filter to find direct arrival peak
  const ir = deconvolve(signal, baseInv);
  const { peakIdx, pnrDb } = findPeakAndPNR(ir, sampleRate);

  // Sweep arrival in recording: peakIdx aligns with the end of the sweep playback
  // t_arrival_end = peakIdx / sampleRate. Sweep began at t_start = t_arrival_end - T.
  const tArrivalEnd = peakIdx / sampleRate;
  const tStartS = Math.max(0, tArrivalEnd - T);

  // 2. Predict octave center arrival times
  const L = T / Math.log(f2 / f1);
  const expectedTimes = centres.map((fc) => tStartS + L * Math.log(fc / f1));

  // 3. Compare band energy at expected times vs background
  const filters = designOctaveFilters(sampleRate, centres);
  const winHalfS = 0.25; // 250 ms tolerance window around predicted time
  const winHalfSamples = Math.round(winHalfS * sampleRate);

  let matchingBands = 0;
  const bandMarginsDb = [];
  const measuredPeakTimes = [];

  for (let k = 0; k < centres.length; k++) {
    const fc = centres[k];
    const tExp = expectedTimes[k];
    const expCenterSample = Math.round(tExp * sampleRate);

    const sos = filters.get(fc);
    const filtered = sosFilt(sos, signal);

    // Expected window RMS
    const wStart = Math.max(0, expCenterSample - winHalfSamples);
    const wEnd = Math.min(filtered.length, expCenterSample + winHalfSamples);
    let winSumSq = 0;
    let winPeak = 0;
    let winPeakIdx = wStart;
    for (let i = wStart; i < wEnd; i++) {
      const v = filtered[i];
      const a = Math.abs(v);
      winSumSq += v * v;
      if (a > winPeak) {
        winPeak = a;
        winPeakIdx = i;
      }
    }
    const winRms = Math.sqrt(winSumSq / Math.max(1, wEnd - wStart));
    measuredPeakTimes.push(winPeakIdx / sampleRate);

    // Background RMS: pre-sweep or outside expected window
    let bgSumSq = 0;
    let bgCount = 0;
    const sweepRangeStart = Math.round(Math.max(0, tStartS - 0.2) * sampleRate);
    const sweepRangeEnd = Math.round(Math.min(signal.length / sampleRate, tStartS + T + 0.5) * sampleRate);

    for (let i = 0; i < filtered.length; i += 4) {
      if (i < sweepRangeStart || i > sweepRangeEnd) {
        const v = filtered[i];
        bgSumSq += v * v;
        bgCount++;
      }
    }
    const bgRms = bgCount > 100 ? Math.sqrt(bgSumSq / bgCount) : 1e-6;

    const marginDb = 20.0 * Math.log10(Math.max(1e-12, winRms) / Math.max(1e-12, bgRms));
    bandMarginsDb.push(Math.round(marginDb * 10) / 10);

    // Band matches if energy at predicted time exceeds background by >= 3 dB
    // and PNR indicates reasonable signal
    if (marginDb >= 3.0 && pnrDb >= 10.0) {
      matchingBands++;
    }
  }

  const requiredBands = 4;
  const ok = matchingBands >= requiredBands;

  return {
    ok,
    matchingBands,
    requiredBands,
    pnrDb: Math.round(pnrDb * 10) / 10,
    tStartS: Math.round(tStartS * 100) / 100,
    expectedTimes: expectedTimes.map((t) => Math.round(t * 100) / 100),
    peakTimes: measuredPeakTimes,
    bandMarginsDb,
  };
}

// Build Test Battery Cases
const testBattery = [];

// Part 1: Large-Offset 30s cases
const total30s = Math.round(30.0 * sampleRate);
for (const offsetS of [0.5, 3.0, 10.0, 20.0]) {
  const buf = new Float64Array(total30s);
  const offsetSamples = Math.round(offsetS * sampleRate);
  buf.set(baseRoomResp.subarray(0, total30s - offsetSamples), offsetSamples);

  const rngNoise = createMulberry32(700 + Math.round(offsetS * 10));
  for (let i = 0; i < buf.length; i++) buf[i] += (rngNoise() - 0.5) * 1e-4;

  testBattery.push({
    category: 'Large-Offset (30s)',
    name: `Sweep offset ${offsetS.toFixed(1)} s inside 30.0 s`,
    seed: 700 + Math.round(offsetS * 10),
    durationS: 30.0,
    signal: buf,
    relLevelsDb: OCTAVE_CENTRES.map(() => '-inf'),
  });
}

// Part 2a: Broadband Thump (louder than sweep in 125, 250, 500 Hz)
const thumpPositions = [
  { name: 'Thump at START (t = 0.3 s, before sweep)', timeS: 0.3, seed: 801 },
  { name: 'Thump in MIDDLE (t = 3.0 s, during sweep)', timeS: 3.0, seed: 802 },
  { name: 'Thump at END (t = 6.5 s, decay tail)', timeS: 6.5, seed: 803 },
];

for (const tp of thumpPositions) {
  const signal = createStandardRoomRecording();
  const thumpDist = new Float64Array(stdTotal);
  const rngThump = createMulberry32(tp.seed);

  const thumpLen = Math.round(0.08 * sampleRate);
  const thumpStart = Math.round(tp.timeS * sampleRate);

  // Scaled so peak 50ms block energy in 125, 250, 500 Hz exceeds sweep peak block energy (+3 to +6 dB)
  for (let i = 0; i < thumpLen; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.020);
    const res = Math.sin(2.0 * Math.PI * 120.0 * t) * 3.5 +
                Math.sin(2.0 * Math.PI * 250.0 * t) * 3.0 +
                Math.sin(2.0 * Math.PI * 450.0 * t) * 2.5;
    const burst = boxMuller(rngThump) * 2.0;
    const val = (res + burst) * env;
    thumpDist[thumpStart + i] = val;
    signal[thumpStart + i] += val;
  }

  const thumpBandPeak = measureBandPeakBlockRms(thumpDist, sampleRate);
  const relLevels = OCTAVE_CENTRES.map((fc) => {
    const sw = cleanBandPeakRms.get(fc) || 1e-6;
    const th = thumpBandPeak.get(fc) || 1e-12;
    const db = 20.0 * Math.log10(th / sw);
    return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  });

  testBattery.push({
    category: '2a. Broadband Thump',
    name: tp.name,
    seed: tp.seed,
    durationS: stdDur,
    signal,
    relLevelsDb: relLevels,
  });
}

// Part 2b: Phone-speaker model + brown-noise rumble
{
  const seed = 810;
  const rngPhone = createMulberry32(seed);

  // HPF 200 Hz @ 12 dB/oct (cascaded 2-pole) gives > 20 dB drop in 125 Hz band
  const hpSos1 = designHighpass2(200, sampleRate);
  const hpSos2 = designHighpass2(200, sampleRate);
  const lpSos = designLowpass1(6000, sampleRate);
  let filteredSweep = sosFilt(hpSos1, baseSweep);
  filteredSweep = sosFilt(hpSos2, filteredSweep);
  filteredSweep = sosFilt(lpSos, filteredSweep);

  const phoneRoomResp = convolveDirect(filteredSweep, baseIr);
  const signal = new Float64Array(stdTotal);
  signal.set(phoneRoomResp.subarray(0, stdTotal - sweepStartIdx), sweepStartIdx);

  // Brown noise rumble
  const rawBrown = makeBrown(stdTotal, rngPhone);
  let maxSig = 0;
  for (let i = 0; i < signal.length; i++) if (Math.abs(signal[i]) > maxSig) maxSig = Math.abs(signal[i]);
  let bSumSq = 0;
  for (let i = 0; i < rawBrown.length; i++) bSumSq += rawBrown[i] * rawBrown[i];
  const bRms = Math.sqrt(bSumSq / rawBrown.length) || 1;
  const bScale = (maxSig * Math.pow(10, -32 / 20.0)) / bRms;
  for (let i = 0; i < stdTotal; i++) signal[i] += rawBrown[i] * bScale;

  const phoneBandPeak = measureBandPeakBlockRms(signal, sampleRate);
  const rms125 = phoneBandPeak.get(125);
  const maxOtherRms = Math.max(
    phoneBandPeak.get(250),
    phoneBandPeak.get(500),
    phoneBandPeak.get(1000),
    phoneBandPeak.get(2000),
    phoneBandPeak.get(4000)
  );
  const diff125Db = 20.0 * Math.log10(rms125 / maxOtherRms);

  const relLevels = OCTAVE_CENTRES.map((fc) => {
    const db = 20.0 * Math.log10(phoneBandPeak.get(fc) / maxOtherRms);
    return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  });

  testBattery.push({
    category: '2b. Phone Speaker',
    name: `Phone speaker model (125Hz diff: ${diff125Db.toFixed(1)} dB)`,
    seed,
    durationS: stdDur,
    signal,
    relLevelsDb: relLevels,
  });
}

// Part 2c: Back-to-Back Sweeps
{
  const seed = 820;
  const doubleDur = 14.0;
  const doubleTotal = Math.round(doubleDur * sampleRate);
  const doubleSignal = new Float64Array(doubleTotal);

  const s1Start = Math.round(0.5 * sampleRate);
  const s2Start = Math.round(5.8 * sampleRate);

  doubleSignal.set(baseRoomResp.subarray(0, doubleTotal - s1Start), s1Start);
  for (let i = 0; i < Math.min(baseRoomResp.length, doubleTotal - s2Start); i++) {
    doubleSignal[s2Start + i] += baseRoomResp[i];
  }

  const rngD = createMulberry32(seed);
  for (let i = 0; i < doubleTotal; i++) doubleSignal[i] += (rngD() - 0.5) * 1e-4;

  testBattery.push({
    category: '2c. Back-to-Back Sweeps',
    name: 'Same sweep played twice back-to-back',
    seed,
    durationS: doubleDur,
    signal: doubleSignal,
    relLevelsDb: OCTAVE_CENTRES.map(() => '0.0 dB'),
  });
}

// Part 2d: Cough Burst
{
  const seed = 830;
  const rngCough = createMulberry32(seed);
  const signal = createStandardRoomRecording();
  const coughDist = new Float64Array(stdTotal);

  const coughLen = Math.round(0.30 * sampleRate);
  const coughStart = Math.round(2.8 * sampleRate);

  for (let i = 0; i < coughLen; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * i) / coughLen) ** 2;
    const n = boxMuller(rngCough);
    const formant = Math.sin(2.0 * Math.PI * 450.0 * t) * 0.6 + Math.sin(2.0 * Math.PI * 1800.0 * t) * 0.4;
    const val = n * 0.35 * formant * env;
    coughDist[coughStart + i] = val;
    signal[coughStart + i] += val;
  }

  const coughBandPeak = measureBandPeakBlockRms(coughDist, sampleRate);
  const relLevels = OCTAVE_CENTRES.map((fc) => {
    const sw = cleanBandPeakRms.get(fc) || 1e-6;
    const c = coughBandPeak.get(fc) || 1e-12;
    const db = 20.0 * Math.log10(c / sw);
    return db > -60 ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '<-60 dB';
  });

  testBattery.push({
    category: '2d. Cough Burst',
    name: 'Cough-like shaped burst during sweep',
    seed,
    durationS: stdDur,
    signal,
    relLevelsDb: relLevels,
  });
}

// Part 2e: Sweep + 50 Hz Hum
for (const humDb of [-30, -20, -10, 0]) {
  const seed = 840 + Math.abs(humDb);
  const signal = createStandardRoomRecording();
  const humDist = new Float64Array(stdTotal);

  let swSumSq = 0;
  for (let i = 0; i < baseSweep.length; i++) swSumSq += baseSweep[i] * baseSweep[i];
  const swRms = Math.sqrt(swSumSq / baseSweep.length);

  const targetHumRms = swRms * Math.pow(10, humDb / 20.0);
  const humAmp = targetHumRms * Math.SQRT2;

  for (let i = 0; i < stdTotal; i++) {
    const t = i / sampleRate;
    const val = humAmp * Math.sin(2.0 * Math.PI * 50.0 * t);
    humDist[i] = val;
    signal[i] += val;
  }

  const humBandPeak = measureBandPeakBlockRms(humDist, sampleRate);
  const relLevels = OCTAVE_CENTRES.map((fc) => {
    const sw = cleanBandPeakRms.get(fc) || 1e-6;
    const h = humBandPeak.get(fc) || 1e-12;
    const db = 20.0 * Math.log10(h / sw);
    return db > -60 ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '<-60 dB';
  });

  testBattery.push({
    category: '2e. 50 Hz Hum',
    name: `Sweep + 50 Hz hum at ${humDb} dB re sweep`,
    seed,
    durationS: stdDur,
    signal,
    relLevelsDb: relLevels,
  });
}

// Negative Reference Cases
const total85 = Math.round(8.5 * sampleRate);
const rngNeg = createMulberry32(999);
const clapSignal = new Float64Array(total85);
const clapStart = Math.round(2.0 * sampleRate);
for (let i = 0; i < Math.round(0.5 * sampleRate); i++) {
  const t = i / sampleRate;
  clapSignal[clapStart + i] = boxMuller(rngNeg) * 0.8 * Math.exp(-t / 0.03);
}

testBattery.push({
  category: 'Negative Ref (Clap)',
  name: 'Clean loud clap (no sweep)',
  seed: 999,
  durationS: 8.5,
  signal: clapSignal,
  relLevelsDb: OCTAVE_CENTRES.map(() => '0.0 dB'),
  expectedVerdict: 'REJECTED',
});

// Run both gates
for (const tc of testBattery) {
  // Current Gate
  const sig = checkSweepSignature(tc.signal, sampleRate);
  const margin = sig.score - SWEEP_SIG_MIN_SCORE;
  const verdict = sig.ok ? 'ACCEPTED (PASS)' : 'REJECTED (FAIL)';
  currentGateResults.push({
    category: tc.category,
    name: tc.name,
    seed: tc.seed,
    durationS: tc.durationS,
    relLevelsDb: tc.relLevelsDb,
    peakTimes: sig.peakTimes,
    score: sig.score,
    margin,
    verdict,
    ok: sig.ok,
    expectedVerdict: tc.expectedVerdict || 'ACCEPTED',
  });

  // Prototype Gate
  const proto = checkPredictedTimeTemplateGate(tc.signal, sampleRate);
  const pMargin = proto.matchingBands - proto.requiredBands;
  const pVerdict = proto.ok ? 'ACCEPTED (PASS)' : 'REJECTED (FAIL)';
  prototypeGateResults.push({
    category: tc.category,
    name: tc.name,
    seed: tc.seed,
    durationS: tc.durationS,
    relLevelsDb: tc.relLevelsDb,
    peakTimes: proto.peakTimes,
    matchingBands: proto.matchingBands,
    requiredBands: proto.requiredBands,
    bandMarginsDb: proto.bandMarginsDb,
    pnrDb: proto.pnrDb,
    margin: pMargin,
    verdict: pVerdict,
    ok: proto.ok,
    expectedVerdict: tc.expectedVerdict || 'ACCEPTED',
  });
}

// ============================================================================
// REPORT 1: Current checkSweepSignature Battery Table
// ============================================================================
console.log('='.repeat(145));
console.log('EchoMap Phase 3a-2e: Current checkSweepSignature Battery Report');
console.log(`Rejection Threshold: Score >= ${SWEEP_SIG_MIN_SCORE.toFixed(3)}`);
console.log('='.repeat(145));
console.log(
  'Category / Test Case'.padEnd(38) + ' | ' +
  'Seed'.padStart(5) + ' | ' +
  'Dur'.padStart(5) + ' | ' +
  'Rel Level [125, 250, 500, 1k, 2k, 4k]'.padEnd(38) + ' | ' +
  'Peak Times [125..4k] (s)'.padEnd(30) + ' | ' +
  'Score'.padStart(6) + ' | ' +
  'Margin'.padStart(7) + ' | ' +
  'Verdict'
);
console.log('-'.repeat(145));

let rejectedCount = 0;
const rejectedCases = [];

for (const r of currentGateResults) {
  const seedStr = String(r.seed).padStart(5);
  const durStr = `${r.durationS.toFixed(1)}s`.padStart(5);
  const relStr = r.relLevelsDb.map((x) => x.replace(' dB', '')).join(', ').padEnd(38);
  const timesStr = (r.peakTimes || []).map((t) => Number(t).toFixed(2)).join(', ').padEnd(30);
  const scoreStr = r.score.toFixed(3).padStart(6);
  const marginStr = (r.margin >= 0 ? `+${r.margin.toFixed(3)}` : r.margin.toFixed(3)).padStart(7);

  console.log(
    `${r.name.padEnd(38)} | ` +
    `${seedStr} | ` +
    `${durStr} | ` +
    `${relStr} | ` +
    `${timesStr} | ` +
    `${scoreStr} | ` +
    `${marginStr} | ` +
    `${r.verdict}`
  );

  if (r.expectedVerdict === 'ACCEPTED' && !r.ok) {
    rejectedCount++;
    rejectedCases.push(r);
  }
}

console.log('-'.repeat(145));
console.log(`Audit Summary (Positive Cases): Total: ${currentGateResults.length - 1} | Accepted: ${currentGateResults.length - 1 - rejectedCount} | Rejected: ${rejectedCount}`);

if (rejectedCount > 0) {
  console.log(`\n⚠️ CONDITIONAL STOP TRIGGERED: ${rejectedCount} positive case(s) were REJECTED by current checkSweepSignature:`);
  for (const r of rejectedCases) {
    console.log(`   - [${r.category}] ${r.name}: Score = ${r.score.toFixed(3)} (Margin = ${r.margin.toFixed(3)})`);
    console.log(`     Peak Times: [${r.peakTimes.map((t) => t.toFixed(2)).join(', ')}] s`);
  }
}

// ============================================================================
// REPORT 2: Proposed Predicted-Time Template Gate Prototype Battery Table
// ============================================================================
console.log('\n' + '='.repeat(145));
console.log('EchoMap Phase 3a-2e: Prototype Predicted-Time Template Gate Battery Report');
console.log('Design: t_start from deconvolution peak, check band energy at expected t_k vs background (requires >= 4 of 6 bands)');
console.log('='.repeat(145));
console.log(
  'Category / Test Case'.padEnd(38) + ' | ' +
  'Seed'.padStart(5) + ' | ' +
  'Dur'.padStart(5) + ' | ' +
  'Band SNR Margins [125..4k] (dB)'.padEnd(38) + ' | ' +
  'Matched Bands'.padStart(14) + ' | ' +
  'PNR (dB)'.padStart(9) + ' | ' +
  'Verdict'
);
console.log('-'.repeat(145));

let protoRejects = 0;
for (const r of prototypeGateResults) {
  const seedStr = String(r.seed).padStart(5);
  const durStr = `${r.durationS.toFixed(1)}s`.padStart(5);
  const marginsStr = (r.bandMarginsDb || []).map((m) => `${m >= 0 ? '+' : ''}${m.toFixed(1)}`).join(', ').padEnd(38);
  const matchStr = `${r.matchingBands} / ${r.requiredBands}`.padStart(14);
  const pnrStr = `${r.pnrDb.toFixed(1)}`.padStart(9);

  console.log(
    `${r.name.padEnd(38)} | ` +
    `${seedStr} | ` +
    `${durStr} | ` +
    `${marginsStr} | ` +
    `${matchStr} | ` +
    `${pnrStr} | ` +
    `${r.verdict}`
  );

  if (r.expectedVerdict === 'ACCEPTED' && !r.ok) {
    protoRejects++;
  }
}
console.log('-'.repeat(145));
console.log(`Prototype Summary: Positive cases rejected: ${protoRejects} | Clean clap rejected: ${prototypeGateResults.find((r) => r.name.includes('clap')).ok ? 'NO (Failed)' : 'YES (Successfully blocked)'}\n`);
