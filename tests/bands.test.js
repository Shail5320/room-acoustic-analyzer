/**
 * tests/bands.test.js — Tests for src/dsp/bands.js
 *
 * Tasks 2.8 / 2.9:
 *   2.8  SOS coefficients match expected_outputs.json to ≤ 1e-8 relative error
 *   2.9  Magnitude response at 200+ log-spaced frequencies: max deviation ≤ 0.01 dB
 *        Diagnostic responses from expected_outputs.json also compared.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { designOctaveFilters, sosFreqz, CENTRE_FREQUENCIES, DEFAULT_FS } from '../src/dsp/bands.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');
const EXP   = JSON.parse(readFileSync(resolve(ROOT, 'reference/expected_outputs.json'), 'utf8'));

const filters = designOctaveFilters(DEFAULT_FS, CENTRE_FREQUENCIES);

// ---------------------------------------------------------------------------
// Helper: log-spaced frequencies between a and b (n points)
// ---------------------------------------------------------------------------
function logspace(a, b, n) {
  const out = new Float64Array(n);
  const la = Math.log10(a), lb = Math.log10(b);
  for (let i = 0; i < n; i++) out[i] = Math.pow(10, la + (lb - la) * i / (n - 1));
  return out;
}

// ---------------------------------------------------------------------------
// Task 2.8 — SOS coefficient match vs expected_outputs.json (≤ 1e-8 rel error)
// ---------------------------------------------------------------------------
for (const fc of CENTRE_FREQUENCIES) {
  test(`SOS coefficients ${fc} Hz match Python to ≤ 1e-8 relative error`, () => {
    const jsSOS  = filters.get(fc);
    const refSOS = EXP.filters[String(fc)].sos;

    assert.strictEqual(jsSOS.length,    2, 'Expected 2 SOS sections');
    assert.strictEqual(jsSOS[0].length, 6, 'Each section must have 6 coefficients');

    let maxRelErr = 0;
    for (let s = 0; s < 2; s++) {
      for (let c = 0; c < 6; c++) {
        const js  = jsSOS[s][c];
        const ref = refSOS[s][c];
        // Relative error (guard division by zero with abs(ref) < 1e-15)
        const relErr = Math.abs(ref) > 1e-15
          ? Math.abs(js - ref) / Math.abs(ref)
          : Math.abs(js - ref);
        if (relErr > maxRelErr) maxRelErr = relErr;
      }
    }

    console.log(`  SOS ${fc} Hz: max relative coeff error = ${maxRelErr.toExponential(4)}`);
    assert.ok(maxRelErr <= 1e-8, `Coeff rel error ${maxRelErr.toExponential(4)} > 1e-8`);
  });
}

// ---------------------------------------------------------------------------
// Task 2.9 — Magnitude response: 200 log-spaced freqs, max deviation ≤ 0.01 dB
// ---------------------------------------------------------------------------
test('Filter magnitude responses: 200 log-spaced freqs, all bands ≤ 0.01 dB deviation', () => {
  const freqs = logspace(20, 20000, 200);
  let globalMaxDev = 0;

  for (const fc of CENTRE_FREQUENCIES) {
    const jsSOS  = filters.get(fc);
    const refSOS = EXP.filters[String(fc)].sos;

    // Evaluate JS magnitude response
    const jsMag  = sosFreqz(jsSOS,  Array.from(freqs), DEFAULT_FS);

    // Evaluate reference (Python) magnitude response using the same sosFreqz formula
    // (since we don't have NumPy here, we evaluate the reference SOS coefficients
    //  with our own sosFreqz to compare filter designs, not just coefficient copying)
    const refMag = sosFreqz(refSOS, Array.from(freqs), DEFAULT_FS);

    let maxDevDb = 0;
    for (let i = 0; i < freqs.length; i++) {
      const jsDb  = 20 * Math.log10(Math.max(jsMag[i],  1e-12));
      const refDb = 20 * Math.log10(Math.max(refMag[i], 1e-12));
      const dev   = Math.abs(jsDb - refDb);
      if (dev > maxDevDb) maxDevDb = dev;
    }
    if (maxDevDb > globalMaxDev) globalMaxDev = maxDevDb;

    console.log(`  ${fc} Hz: max magnitude deviation = ${maxDevDb.toFixed(6)} dB (limit 0.01 dB)`);
    assert.ok(maxDevDb <= 0.01,
      `${fc} Hz: magnitude deviation ${maxDevDb.toFixed(6)} dB > 0.01 dB`);
  }

  console.log(`\n  Global max magnitude deviation across all bands: ${globalMaxDev.toFixed(6)} dB\n`);
});

// ---------------------------------------------------------------------------
// Task 2.9 extra — Diagnostic responses from expected_outputs.json
// ---------------------------------------------------------------------------
test('Diagnostic magnitude responses match expected_outputs.json', () => {
  for (const fc of CENTRE_FREQUENCIES) {
    const jsSOS = filters.get(fc);
    const diag  = EXP.filters[String(fc)].diagnostic_responses;

    for (const { freq_hz, mag_db } of diag) {
      const mag = sosFreqz(jsSOS, [freq_hz], DEFAULT_FS)[0];
      const db  = 20 * Math.log10(Math.max(mag, 1e-12));
      const dev = Math.abs(db - mag_db);
      console.log(`  ${fc} Hz band at ${freq_hz} Hz: JS=${db.toFixed(4)} dB  ref=${mag_db.toFixed(4)} dB  |diff|=${dev.toFixed(4)} dB`);
      assert.ok(dev <= 0.01, `${fc} Hz diag at ${freq_hz} Hz: ${dev.toFixed(4)} dB > 0.01 dB`);
    }
  }
});

// ---------------------------------------------------------------------------
// Spot-check: centre frequency response ≈ 0 dB (passband gain = 1)
// ---------------------------------------------------------------------------
test('Centre frequency gain ≈ 0 dB for all bands', () => {
  for (const fc of CENTRE_FREQUENCIES) {
    const sos = filters.get(fc);
    const mag = sosFreqz(sos, [fc], DEFAULT_FS)[0];
    const db  = 20 * Math.log10(Math.max(mag, 1e-12));
    console.log(`  ${fc} Hz centre gain = ${db.toFixed(4)} dB`);
    assert.ok(Math.abs(db) <= 0.01, `${fc} Hz centre gain ${db.toFixed(4)} dB not ≈ 0`);
  }
});

// ---------------------------------------------------------------------------
// Spot-check: -3 dB at band edges
// ---------------------------------------------------------------------------
test('Band-edge (fc/√2 and fc·√2) gain ≈ -3.01 dB for all bands', () => {
  for (const fc of CENTRE_FREQUENCIES) {
    const sos = filters.get(fc);
    const flo = fc / Math.SQRT2;
    const fhi = fc * Math.SQRT2;
    const [magLo, magHi] = sosFreqz(sos, [flo, fhi], DEFAULT_FS);
    const dbLo = 20 * Math.log10(Math.max(magLo, 1e-12));
    const dbHi = 20 * Math.log10(Math.max(magHi, 1e-12));
    console.log(`  ${fc} Hz: f_lo=${flo.toFixed(1)} Hz → ${dbLo.toFixed(4)} dB | f_hi=${fhi.toFixed(1)} Hz → ${dbHi.toFixed(4)} dB`);
    assert.ok(Math.abs(dbLo + 3.0103) <= 0.01, `${fc} Hz lo edge: ${dbLo.toFixed(4)} dB`);
    assert.ok(Math.abs(dbHi + 3.0103) <= 0.01, `${fc} Hz hi edge: ${dbHi.toFixed(4)} dB`);
  }
});
