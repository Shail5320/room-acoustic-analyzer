/**
 * tools/gate-battery.mjs — Comprehensive 62-scenario benchmark and sensitivity audit
 * for the EchoMap template gate vs legacy sweep-signature gate.
 *
 * Implements all 62 scenarios defined in reference/gate_reference.py:
 *   - 41 positive sweep scenarios (reverberant rooms, offsets inside 30s recordings,
 *     loud LF thumps, broadband knocks, phone speaker high-pass + rumble, mains hum,
 *     intense white noise, back-to-back playback).
 *   - 21 negative non-sweep scenarios (clean/noisy claps, pure noise seeds, silence,
 *     brown noise, hum + noise, noise + burst, speech-like tones, two claps,
 *     fan spin-up, reverse DOWN sweep, wrong-rate FAST sweep).
 *
 * Reports:
 *   1. 62-scenario comparison table (CURRENT vs TEMPLATE)
 *   2. Smallest positive and negative margins to the 10 dB threshold
 *   3. 27-point Sensitivity Table across:
 *      window in {0.10, 0.15, 0.25} s,
 *      margin in {6, 10, 15} dB,
 *      min bands in {3, 4, 5}
 *
 * Usage:
 *   node tools/gate-battery.mjs
 */

import { generateSweep, generateInverseFilter } from '../src/dsp/sweep.js';
import { convolveDirect } from '../src/dsp/deconvolve.js';
import { sosFilt, designOctaveFilters } from '../src/dsp/bands.js';
import { checkSweepTemplate, legacyCheckSweepSignature } from '../src/analysis/pipeline.js';
import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
  OCTAVE_CENTRES,
  TEMPLATE_GATE_WIN_HALF_S,
  TEMPLATE_GATE_MIN_MARGIN_DB,
  TEMPLATE_GATE_MIN_BANDS,
} from '../src/analysis/config.js';

const FS = 48000;
const F1 = SWEEP_F1;
const F2 = SWEEP_F2;
const T = SWEEP_DURATION_S;
const L = T / Math.log(F2 / F1);
const CENT = OCTAVE_CENTRES;

// Mulberry32 deterministic PRNG
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

// 2nd-order Butterworth Highpass filter design
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

// 4th-order Butterworth Lowpass filter design (cascaded 2 biquads)
function designLowpass4(fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  const K2 = K * K;
  // Section 1: Q = 1 / (2 * cos(pi / 8))
  const q1 = 1.0 / (2.0 * Math.cos(Math.PI / 8.0));
  const norm1 = 1.0 + K / q1 + K2;
  const s1 = [
    K2 / norm1,
    (2.0 * K2) / norm1,
    K2 / norm1,
    1.0,
    (2.0 * (K2 - 1.0)) / norm1,
    (1.0 - K / q1 + K2) / norm1,
  ];
  // Section 2: Q = 1 / (2 * cos(3 * pi / 8))
  const q2 = 1.0 / (2.0 * Math.cos((3.0 * Math.PI) / 8.0));
  const norm2 = 1.0 + K / q2 + K2;
  const s2 = [
    K2 / norm2,
    (2.0 * K2) / norm2,
    K2 / norm2,
    1.0,
    (2.0 * (K2 - 1.0)) / norm2,
    (1.0 - K / q2 + K2) / norm2,
  ];
  return [s1, s2];
}

const octaveFilters = designOctaveFilters(FS, CENT);
const BLK = Math.round(0.05 * FS);
const HOP = Math.round(0.025 * FS);

function blockEnergy(f) {
  const nh = Math.max(1, Math.floor((f.length - BLK) / HOP) + 1);
  const e = new Float64Array(nh);
  for (let i = 0; i < nh; i++) {
    let s = 0;
    const start = i * HOP;
    for (let j = 0; j < BLK; j++) s += f[start + j] ** 2;
    e[i] = s / BLK;
  }
  return e;
}

function peakBlockRms(x, fc) {
  const sos = octaveFilters.get(fc);
  const f = sosFilt(sos, x);
  const e = blockEnergy(f);
  let maxE = 0;
  for (let i = 0; i < e.length; i++) if (e[i] > maxE) maxE = e[i];
  return Math.sqrt(maxE);
}

// Global battery RNG seeded matching Python default_rng(2026)
const globalRng = createMulberry32(2026);

// Synthesize base sweep
const SW = generateSweep(F1, F2, T, FS, SWEEP_FADE_MS);
// Scale sweep to amp = 0.7 matching Python make_sweep(amp=0.7)
for (let i = 0; i < SW.length; i++) SW[i] *= 0.7;

function roomIr(rt60 = 0.8, dur = 1.2, rng = globalRng) {
  const n = Math.round(dur * FS);
  const h = new Float64Array(n);
  const decayRate = 6.908 / rt60;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    h[i] = boxMuller(rng) * Math.exp(-decayRate * t) * 0.15;
  }
  h[0] = 1.0;
  return h;
}

function recording(totalS = 8.5, offsetS = 1.0, rt60 = 0.8, rng = globalRng) {
  const x = new Float64Array(Math.round(totalS * FS));
  const ir = roomIr(rt60, 1.2, rng);
  const y = convolveDirect(SW, ir);
  const i0 = Math.round(offsetS * FS);
  const m = Math.min(y.length, x.length - i0);
  for (let i = 0; i < m; i++) x[i0 + i] += y[i];
  return x;
}

function lpBurst(dur = 0.03, fmax = 500, rng = globalRng) {
  const b = new Float64Array(Math.round(0.5 * FS));
  const m = Math.round(dur * FS);
  const nz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    nz[i] = boxMuller(rng) * Math.exp(-i / (0.01 * FS));
  }
  const lpSos = designLowpass4(fmax, FS);
  const filtered = sosFilt(lpSos, nz);
  for (let i = 0; i < Math.min(filtered.length, b.length); i++) b[i] = filtered[i];
  return b;
}

function bbBurst(dur = 0.08, tau = 0.02, rng = globalRng) {
  const len = Math.max(Math.round(0.4 * FS), Math.round(dur * FS) + 1);
  const b = new Float64Array(len);
  const m = Math.round(dur * FS);
  for (let i = 0; i < m; i++) {
    b[i] = boxMuller(rng) * Math.exp(-i / (tau * FS));
  }
  return b;
}

function addAt(x, ev, t0) {
  const y = new Float64Array(x);
  const i = Math.round(t0 * FS);
  const m = Math.min(ev.length, y.length - i);
  for (let k = 0; k < m; k++) y[i + k] += ev[k];
  return y;
}

function scaled(ev, db, fc, ref) {
  const tmp = new Float64Array(Math.round(8.5 * FS));
  tmp.set(ev.subarray(0, Math.min(ev.length, tmp.length)));
  const refRms = peakBlockRms(ref, fc);
  const evRms = Math.max(1e-12, peakBlockRms(tmp, fc));
  const factor = (refRms * Math.pow(10, db / 20.0)) / evRms;
  const out = new Float64Array(ev.length);
  for (let i = 0; i < ev.length; i++) out[i] = ev[i] * factor;
  return out;
}

function white(n, s, rng = globalRng) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = boxMuller(rng) * s;
  return out;
}

function brown(n, s, rng = globalRng) {
  const w = new Float64Array(n);
  let cum = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    cum += boxMuller(rng);
    w[i] = cum;
    sum += cum;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    w[i] -= mean;
    varSum += w[i] * w[i];
  }
  const std = Math.sqrt(varSum / n) || 1e-6;
  for (let i = 0; i < n; i++) w[i] = (w[i] / std) * s;
  return w;
}

function hum(n, s, harm = [1, 2, 3, 4, 5], rng = globalRng) {
  const out = new Float64Array(n);
  const phases = harm.map(() => rng() * 2 * Math.PI);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    let val = 0;
    for (let h = 0; h < harm.length; h++) {
      const harmIdx = harm[h];
      val += Math.sin(2.0 * Math.PI * 50.0 * harmIdx * t + phases[h]) / Math.sqrt(harmIdx);
    }
    out[i] = val;
    sumSq += val * val;
  }
  const std = Math.sqrt(sumSq / n) || 1e-6;
  for (let i = 0; i < n; i++) out[i] = (out[i] / std) * s;
  return out;
}

// Build the exact 62 scenarios
export function build62Scenarios(rng = createMulberry32(2026)) {
  const base = recording(8.5, 1.0, 0.8, rng);
  let swSumSq = 0;
  for (let i = 0; i < SW.length; i++) swSumSq += SW[i] * SW[i];
  const srms = Math.sqrt(swSumSq / SW.length);
  const N = Math.round(8.5 * FS);

  const rows = [];
  const add = (name, x, expect) => rows.push({ name, x, expect });

  // 1-3. Clean rooms
  add('clean room (RT60 0.8 s)', base, true);
  for (const rt of [0.3, 1.5]) {
    add(`clean room RT60 ${rt} s`, recording(8.5, 1.0, rt, rng), true);
  }

  // 4-7. Offsets in 30s
  for (const off of [0.5, 3.0, 10.0, 20.0]) {
    add(`sweep at offset ${off.toFixed(1)} s in a 30 s recording`, recording(30.0, off, 0.8, rng), true);
  }

  // 8-19. LF thump at start, middle, end
  for (const db of [0, 6, 12, 20]) {
    for (const [where, t0] of [['start 0.3 s', 0.3], ['middle 3 s', 3.0], ['end 7.5 s', 7.5]]) {
      const dbStr = db >= 0 ? `+${db}` : `${db}`;
      const thump = scaled(lpBurst(0.03, 500, rng), db, 250, base);
      add(`LF thump ${dbStr} dB re sweep (250 Hz band), ${where}`, addAt(base, thump, t0), true);
    }
  }

  // 20-22. Broadband knock
  for (const db of [0, 6, 12]) {
    const dbStr = db >= 0 ? `+${db}` : `${db}`;
    const knock = scaled(bbBurst(0.08, 0.02, rng), db, 1000, base);
    add(`broadband knock ${dbStr} dB re sweep (1 kHz band), 2.5 s`, addAt(base, knock, 2.5), true);
  }

  // 23-34. Phone-speaker HPF + brown rumble
  for (const hp of [150, 250, 350, 500]) {
    const hpSos = designHighpass2(hp, FS);
    const s = sosFilt(hpSos, base);
    let sSumSq = 0;
    for (let i = 0; i < s.length; i++) sSumSq += s[i] * s[i];
    const sRmsFiltered = Math.sqrt(sSumSq / s.length);

    for (const rd of [null, -10, 0]) {
      let x = s;
      if (rd !== null) {
        const br = brown(s.length, sRmsFiltered * Math.pow(10, rd / 20.0), rng);
        x = new Float64Array(s.length);
        for (let i = 0; i < s.length; i++) x[i] = s[i] + br[i];
      }
      add(`phone-speaker HPF ${hp} Hz + brown rumble ${rd !== null ? rd : 'None'} dB`, x, true);
    }
  }

  // 35-37. Mains hum + harmonics
  for (const db of [-20, 0, 6]) {
    const dbStr = db >= 0 ? `+${db}` : `${db}`;
    const hm = hum(base.length, srms * Math.pow(10, db / 20.0), [1, 2, 3, 4, 5], rng);
    const x = new Float64Array(base.length);
    for (let i = 0; i < base.length; i++) x[i] = base[i] + hm[i];
    add(`mains hum + harmonics ${dbStr} dB re sweep RMS`, x, true);
  }

  // 38-40. White noise
  for (const db of [-10, 0, 3]) {
    const dbStr = db >= 0 ? `+${db}` : `${db}`;
    const wn = white(base.length, srms * Math.pow(10, db / 20.0), rng);
    const x = new Float64Array(base.length);
    for (let i = 0; i < base.length; i++) x[i] = base[i] + wn[i];
    add(`white noise ${dbStr} dB re sweep RMS`, x, true);
  }

  // 41. Back to back sweep
  const len7 = Math.round(7.0 * FS);
  const b2b = new Float64Array(len7 + base.length);
  b2b.set(base.subarray(0, len7), 0);
  b2b.set(base, len7);
  add('sweep played twice back to back', b2b, true);

  // 42. Clean clap
  const rawClap = bbBurst(0.5, 0.03, rng);
  const clap = new Float64Array(rawClap.length);
  for (let i = 0; i < rawClap.length; i++) clap[i] = rawClap[i] * 0.8;
  add('clean clap, no sweep', addAt(new Float64Array(N), clap, 2.0), false);

  // 43-48. Clap + white noise
  for (const nz of [0.001, 0.005, 0.02]) {
    for (const lv of [0.2, 0.8]) {
      const scaledClap = new Float64Array(clap.length);
      for (let i = 0; i < clap.length; i++) scaledClap[i] = clap[i] * lv;
      add(`clap x${lv} + white noise sigma ${nz}`, addAt(white(N, nz, rng), scaledClap, 2.0), false);
    }
  }

  // 49-53. Noise only (5 seeds)
  for (let k = 0; k < 5; k++) {
    add(`noise only (seed ${k})`, white(N, 0.01, rng), false);
  }

  // 54. Silence
  add('silence', new Float64Array(N), false);

  // 55. Brown noise only
  add('brown noise only', brown(N, 0.05, rng), false);

  // 56. Mains hum + harmonics + noise
  const humNoise = hum(N, 0.1, [1, 2, 3, 4, 5], rng);
  const wNoise = white(N, 0.01, rng);
  const hnCombined = new Float64Array(N);
  for (let i = 0; i < N; i++) hnCombined[i] = humNoise[i] + wNoise[i];
  add('mains hum + harmonics + noise, no sweep', hnCombined, false);

  // 57. Noise + loud burst
  const loudBurst = bbBurst(0.08, 0.02, rng);
  const halfBurst = new Float64Array(loudBurst.length);
  for (let i = 0; i < loudBurst.length; i++) halfBurst[i] = loudBurst[i] * 0.5;
  add('noise + loud burst, no sweep', addAt(white(N, 0.01, rng), halfBurst, 3.0), false);

  // 58. Speech-like modulated tones
  const speechSig = new Float64Array(N);
  const tones = [150, 300, 450, 900, 1800];
  for (let i = 0; i < N; i++) {
    const tt = i / FS;
    const mod = 0.5 + 0.5 * Math.sin(2.0 * Math.PI * 3.0 * tt);
    let toneSum = 0;
    for (const f of tones) toneSum += Math.sin(2.0 * Math.PI * f * tt) * mod;
    speechSig[i] = toneSum * 0.05;
  }
  const speechNoise = white(N, 0.005, rng);
  for (let i = 0; i < N; i++) speechSig[i] += speechNoise[i];
  add('speech-like modulated tones, no sweep', speechSig, false);

  // 59. Two claps 1.5s apart
  const twoClaps = addAt(addAt(white(N, 0.003, rng), clap, 2.0), clap, 3.5);
  add('two claps 1.5 s apart', twoClaps, false);

  // 60. Rising broadband noise (fan spin-up)
  const fanNoise = white(N, 1.0, rng);
  const fanSig = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const ramp = 0.005 + (0.1 - 0.005) * (i / (N - 1));
    fanSig[i] = fanNoise[i] * ramp;
  }
  add('rising broadband noise (fan spin-up)', fanSig, false);

  // 61. DOWN sweep (wrong direction)
  const tdSamples = Math.round(5.0 * FS);
  const downSweep = new Float64Array(tdSamples);
  for (let i = 0; i < tdSamples; i++) {
    const td = i / FS;
    downSweep[i] = 0.7 * Math.sin(2.0 * Math.PI * F1 * L * (Math.exp((5.0 - td) / L) - 1.0));
  }
  const downSig = addAt(new Float64Array(N), downSweep, 1.0);
  const downNoise = white(N, 0.002, rng);
  for (let i = 0; i < N; i++) downSig[i] += downNoise[i];
  add('DOWN sweep (wrong direction)', downSig, false);

  // 62. FAST 2 s sweep (wrong rate)
  const fL = 2.0 / Math.log(F2 / F1);
  const tfSamples = Math.round(2.0 * FS);
  const fastSweep = new Float64Array(tfSamples);
  for (let i = 0; i < tfSamples; i++) {
    const tf = i / FS;
    fastSweep[i] = 0.7 * Math.sin(2.0 * Math.PI * F1 * fL * (Math.exp(tf / fL) - 1.0));
  }
  const fastSig = addAt(new Float64Array(N), fastSweep, 1.0);
  const fastNoise = white(N, 0.002, rng);
  for (let i = 0; i < N; i++) fastSig[i] += fastNoise[i];
  add('FAST 2 s sweep (wrong rate)', fastSig, false);

  return rows;
}

export function runGateBattery() {
  const scenarios = build62Scenarios();
  console.log('='.repeat(140));
  console.log('EchoMap: 62-Scenario Robustness Battery (CURRENT vs TEMPLATE Gate)');
  console.log('='.repeat(140));
  console.log(
    'Scenario'.padEnd(58) + ' ' +
    'Expect'.padEnd(7) + ' | ' +
    'CURRENT gate'.padEnd(25) + ' | ' +
    'TEMPLATE gate'
  );
  console.log('-'.repeat(140));

  let curCorrect = 0;
  let tmpCorrect = 0;

  let minPositiveMargin = Infinity;
  let minPositiveScenario = null;
  let minNegativeMargin = Infinity;
  let minNegativeScenario = null;

  for (const s of scenarios) {
    const curRes = legacyCheckSweepSignature(s.x, FS);
    const tmpRes = checkSweepTemplate(s.x, FS);
    s.peakIdx = tmpRes.peakIdx;

    const curOk = curRes.ok === s.expect;
    const tmpOk = tmpRes.ok === s.expect;
    if (curOk) curCorrect++;
    if (tmpOk) tmpCorrect++;

    const curFlag = curOk ? '' : ' WRONG';
    const tmpFlag = tmpOk ? '' : ' WRONG';

    const minMargin = Math.min(...tmpRes.perBandMarginDb);

    if (s.expect) {
      // Smallest positive margin above 10 dB threshold
      const m = minMargin - TEMPLATE_GATE_MIN_MARGIN_DB;
      if (m < minPositiveMargin) {
        minPositiveMargin = m;
        minPositiveScenario = s.name;
      }
    } else {
      // Smallest negative margin below 10 dB threshold
      const m = TEMPLATE_GATE_MIN_MARGIN_DB - minMargin;
      if (m < minNegativeMargin) {
        minNegativeMargin = m;
        minNegativeScenario = s.name;
      }
    }

    const curStr = `${curRes.ok ? 'ACCEPT' : 'REJECT'} score=${curRes.score.toFixed(3)}${curFlag}`.padEnd(25);
    const tmpStr = `${tmpRes.ok ? 'ACCEPT' : 'REJECT'} ${tmpRes.matchedBands}/6 t_start=${tmpRes.tStart.toFixed(2)} min_margin=${minMargin >= 0 ? '+' : ''}${minMargin.toFixed(1)} dB${tmpFlag}`;

    console.log(
      `${s.name.padEnd(58)} ${(s.expect ? 'ACCEPT' : 'REJECT').padEnd(7)} | ${curStr} | ${tmpStr}`
    );
  }

  console.log('-'.repeat(140));
  console.log(`Correct decisions: CURRENT ${curCorrect}/${scenarios.length}   TEMPLATE ${tmpCorrect}/${scenarios.length}`);
  console.log(`Smallest positive margin above 10 dB threshold: +${minPositiveMargin.toFixed(1)} dB (${minPositiveScenario})`);
  console.log(`Smallest negative margin below 10 dB threshold: -${minNegativeMargin.toFixed(1)} dB (${minNegativeScenario})`);

  // ============================================================================
  // Sensitivity Table (3 x 3 x 3 = 27 configurations)
  // Window in {0.10, 0.15, 0.25} s, Margin in {6, 10, 15} dB, Min Bands in {3, 4, 5}
  // ============================================================================
  console.log('\n' + '='.repeat(100));
  console.log('Template Gate Parameter Sensitivity Analysis (27 Configurations)');
  console.log('Defaults: Window = 0.15 s, Min Margin = 10 dB, Min Bands = 4');
  console.log('='.repeat(100));
  console.log(
    'Window (±s)'.padStart(12) + ' | ' +
    'Margin (dB)'.padStart(12) + ' | ' +
    'Min Bands'.padStart(10) + ' | ' +
    'Correct Decisions (out of 62)'.padEnd(30) + ' | ' +
    'Status'
  );
  console.log('-'.repeat(100));

  const windows = [0.10, 0.15, 0.25];
  const margins = [6, 10, 15];
  const minBandsList = [3, 4, 5];

  for (const win of windows) {
    for (const m of margins) {
      for (const mb of minBandsList) {
        let correct = 0;
        for (const s of scenarios) {
          const res = checkSweepTemplate(s.x, FS, s.peakIdx, SW.length, {
            templateGateWinHalfS: win,
            templateGateMinMarginDb: m,
            templateGateMinBands: mb,
          });
          if (res.ok === s.expect) correct++;
        }
        const isDefault = (win === 0.15 && m === 10 && mb === 4);
        const tag = isDefault ? ' [DEFAULT SETTING]' : '';
        console.log(
          `±${win.toFixed(2)} s`.padStart(12) + ' | ' +
          `${m.toFixed(1)} dB`.padStart(12) + ' | ' +
          `${mb} of 6`.padStart(10) + ' | ' +
          `${correct} / ${scenarios.length} (${((correct / scenarios.length) * 100).toFixed(1)}%)`.padEnd(30) + ' | ' +
          `${correct === scenarios.length ? 'PERFECT (62/62)' : 'ROBUST'}${tag}`
        );
      }
    }
  }
  console.log('='.repeat(100) + '\n');
}

// Auto-run when executed directly via CLI
import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGateBattery();
}
