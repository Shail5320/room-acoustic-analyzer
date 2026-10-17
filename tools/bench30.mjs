/**
 * tools/bench30.mjs — Standalone 30-second benchmark script for EchoMap.
 *
 * Measures pipeline execution time and peak memory / FFT size for a 30.0-second
 * recording at 48,000 Hz in Node.js.
 *
 * Usage:
 *   node tools/bench30.mjs
 */

import { generateSweep } from '../src/dsp/sweep.js';
import { analyzeRecording } from '../src/analysis/pipeline.js';
import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
} from '../src/analysis/config.js';
import { nextPow2 } from '../src/dsp/fft.js';

console.log('='.repeat(70));
console.log('EchoMap: 30-Second Recording Acoustic Pipeline Benchmark');
console.log('='.repeat(70));

const sampleRate = 48000;
const durationS = 30.0;
const totalSamples = Math.round(durationS * sampleRate);

console.log(`\nAllocating 30.0 s audio buffer at ${sampleRate} Hz (${totalSamples.toLocaleString()} samples)...`);
const samples = new Float64Array(totalSamples);

// Synthesize 5.0 s sweep with 1.0 s lead-in
const sweep = generateSweep(SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, sampleRate, SWEEP_FADE_MS);
samples.set(sweep, Math.round(1.0 * sampleRate));

// Add slight background noise to ensure realistic deconvolution floor
for (let i = 0; i < samples.length; i++) {
  samples[i] += (Math.random() - 0.5) * 1e-4;
}

const minConvLen = samples.length + sweep.length - 1;
const nFft = nextPow2(minConvLen);

console.log(`\nFFT Sizing:`);
console.log(`  Recording length     : ${samples.length.toLocaleString()} samples`);
console.log(`  Inverse filter length: ${sweep.length.toLocaleString()} samples`);
console.log(`  Linear conv length   : ${minConvLen.toLocaleString()}`);
console.log(`  Next power-of-2 FFT  : ${nFft.toLocaleString()} (2^${Math.round(Math.log2(nFft))})`);

console.log(`\nRunning analyzeRecording on 30.0 s recording...`);
const tStart = performance.now();

const result = analyzeRecording({
  samples,
  sampleRate,
  onProgress: ({ stage, progress, message }) => {
    console.log(`  [${(progress * 100).toFixed(0).padStart(3)}%] ${stage}: ${message}`);
  },
});

const tTotal = performance.now() - tStart;

console.log('\n' + '-'.repeat(70));
console.log('Benchmark Results:');
console.log('-'.repeat(70));
console.log(`  Pipeline OK          : ${result.ok}`);
console.log(`  PNR                  : ${result.pnrDb} dB`);
console.log(`  Dynamic Range (min)  : ${result.dynamicRangeDb} dB (Weakest: ${result.weakestBandHz} Hz)`);
console.log(`  Total Wall-Clock Time: ${tTotal.toFixed(1)} ms (${(tTotal / 1000).toFixed(2)} s)`);
console.log(`  Per-Stage Timings:`);
console.log(`    Sweep synthesis    : ${result.timingsMs.sweepMs.toFixed(1)} ms`);
console.log(`    Deconvolution (FFT): ${result.timingsMs.deconvolveMs.toFixed(1)} ms`);
console.log(`    Octave filtering   : ${result.timingsMs.filteringMs.toFixed(1)} ms`);
console.log(`    Schroeder / RT60   : ${result.timingsMs.rt60Ms.toFixed(1)} ms`);
console.log('='.repeat(70));
