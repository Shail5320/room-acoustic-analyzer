/**
 * src/dsp/bands.js — Octave-band Butterworth bandpass filter design & SOS filtering.
 *
 * Implements scipy.signal.butter(N=2, Wn=[lo,hi], btype='bandpass', fs=fs, output='sos')
 * exactly, using bilinear transform with analogue frequency pre-warping.
 *
 * Design overview for N=2 bandpass (4th-order total, 2 SOS biquads):
 *
 *   1. Compute analogue band edges via pre-warping:
 *        Ω_lo = 2·fs·tan(π·flo/fs)
 *        Ω_hi = 2·fs·tan(π·fhi/fs)
 *   2. Analogue Butterworth lowpass prototype (order N=2): poles at exp(jπ(2k+N+1)/(2N))
 *   3. Lowpass-to-bandpass transformation:
 *        s → (s² + Ω0²) / (BW·s)   where Ω0 = sqrt(Ωlo·Ωhi), BW = Ωhi−Ωlo
 *      This turns each N=2 lowpass pole into 2 bandpass poles (total: 4 poles).
 *   4. Bilinear transform:  s = 2·fs·(z−1)/(z+1)
 *   5. Group into 2 SOS biquads.
 *   6. Normalise gain so |H(Ω0)| = 1 (0 dB at centre).
 *
 * SOS format per section: [b0, b1, b2, 1, a1, a2]  (denominator[0] always 1)
 *
 * Centres: 125, 250, 500, 1000, 2000, 4000 Hz
 * Band edges: fc/√2 and fc·√2
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const CENTRE_FREQUENCIES = [125, 250, 500, 1000, 2000, 4000];
export const DEFAULT_FS = 48000;

// ---------------------------------------------------------------------------
// Complex arithmetic helpers (plain objects {re, im})
// ---------------------------------------------------------------------------

function cadd(a, b)  { return { re: a.re + b.re, im: a.im + b.im }; }
function csub(a, b)  { return { re: a.re - b.re, im: a.im - b.im }; }
function cmul(a, b)  { return { re: a.re*b.re - a.im*b.im, im: a.re*b.im + a.im*b.re }; }
function cdiv(a, b)  {
  const d = b.re*b.re + b.im*b.im;
  return { re: (a.re*b.re + a.im*b.im)/d, im: (a.im*b.re - a.re*b.im)/d };
}
function cscale(a, r){ return { re: a.re*r, im: a.im*r }; }
function csqrt(a)    {
  const r = Math.sqrt(Math.hypot(a.re, a.im));
  const t = Math.atan2(a.im, a.re) / 2;
  return { re: r*Math.cos(t), im: r*Math.sin(t) };
}
function C(re, im=0) { return { re, im }; }

// ---------------------------------------------------------------------------
// Butterworth analogue lowpass poles (order N)
// Poles of H_LP(s) = 1/∏(s - p_k), placed on the unit circle in the left half-plane.
// For N=2: p_k = exp(jπ(2k+N+1)/(2N)), k=0,1
// ---------------------------------------------------------------------------
function butterworthLPPoles(N) {
  const poles = [];
  for (let k = 0; k < N; k++) {
    const angle = Math.PI * (2*k + N + 1) / (2*N);
    poles.push({ re: Math.cos(angle), im: Math.sin(angle) });
  }
  return poles;
}

// ---------------------------------------------------------------------------
// LP-to-BP analogue transformation
// For each LP pole p, two BP poles result from solving:
//   (s² + Ω0²) / (BW·s) = p   →   s² - p·BW·s + Ω0² = 0
// ---------------------------------------------------------------------------
function lpToBP(lpPoles, Omega0, BW) {
  const bpPoles = [];
  for (const p of lpPoles) {
    // s² - p·BW·s + Ω0² = 0
    // s = (p·BW ± sqrt((p·BW)² - 4·Ω0²)) / 2
    const pBW = cscale(p, BW);             // p·BW
    const disc = csub(cmul(pBW, pBW), C(4*Omega0*Omega0)); // (p·BW)² - 4·Ω0²
    const sq   = csqrt(disc);
    bpPoles.push(cscale(cadd(pBW,  sq), 0.5));
    bpPoles.push(cscale(csub(pBW,  sq), 0.5));
  }
  return bpPoles;
}

// ---------------------------------------------------------------------------
// Bilinear transform: analogue pole s → digital pole z
//   z = (1 + s/(2fs)) / (1 - s/(2fs))
// ---------------------------------------------------------------------------
function bilinear(s, fs) {
  const half = cscale(s, 1/(2*fs));  // s/(2fs)
  return cdiv(cadd(C(1), half), csub(C(1), half));
}

// ---------------------------------------------------------------------------
// Polynomial from roots: ∏(z - z_k) → coefficients [1, c1, c2, …]
// We only need quadratic factors (2 roots per SOS).
// ---------------------------------------------------------------------------
function quadFromRoots(r1, r2) {
  // (z - r1)(z - r2) = z² - (r1+r2)z + r1·r2
  const sum = cadd(r1, r2);
  const prod = cmul(r1, r2);
  // Coefficients of z⁻¹ and z⁻²: denominator in z-domain in descending powers
  // H(z) = b / ((z-p1)(z-p2)) => denominator: z² - (p1+p2)z + p1p2
  //                               in z⁻¹ form: 1 - (p1+p2)z⁻¹ + p1p2·z⁻²
  return { a1: -sum.re, a2: prod.re }; // imaginary parts cancel for conj pairs
}

// ---------------------------------------------------------------------------
// Build one SOS biquad for a pair of conjugate digital poles with one zero pair.
// For the BP design, each SOS from the numerator structure is:
//   - Section from LP numerator s-plane:   numerator = s  → in BP: zeros at 0 and ∞
//     After bilinear + LP-to-BP: zeros at z=+1 and z=-1 (i.e. b=[1,0,-1] in z^-1)
//   - Section from LP numerator constant:  numerator = 1  → zeros at z=+1 (bandpass structure)
//     Actually for the Butterworth LP with unity numerator, all LP zeros are at infinity.
//     After LP→BP: BP numerator gains zeros at s=0 and s=∞, which become z=+1 and z=-1.
//
// In SciPy's implementation the bandpass filter has:
//   - Every SOS biquad numerator: [b0, b1, b2] where for LP zeros at ∞→BP zeros at 0,∞
//     the numerator is proportional to (z-1)(z+1) = z²-1 → [1, 0, -1] in z polynomial
//     → in z^-1 form: b0 = b2, b1 = 0, i.e., b = [k, 0, -k].
//
// We therefore build each SOS as:
//   numerator: [1, 0, -1] (z-domain, proportional to the bandpass zero structure)
//   denominator: [1, a1, a2] (from pair of digital poles)
//   then scale to unity gain at centre frequency Ω0.
// ---------------------------------------------------------------------------

/**
 * Design N=2 bandpass Butterworth SOS matching scipy.signal.butter().
 *
 * @param {number} flo  — lower band edge (Hz)
 * @param {number} fhi  — upper band edge (Hz)
 * @param {number} fs   — sample rate (Hz)
 * @returns {number[][]} — 2×6 array: each row [b0,b1,b2,1,a1,a2]
 */
function designBandpassSOS(flo, fhi, fs) {
  // 1. Pre-warp band edges
  const OmLo = 2*fs * Math.tan(Math.PI * flo / fs);
  const OmHi = 2*fs * Math.tan(Math.PI * fhi / fs);
  const Omega0 = Math.sqrt(OmLo * OmHi);
  const BW     = OmHi - OmLo;

  // 2. Analogue Butterworth LP poles (N=2)
  const lpPoles = butterworthLPPoles(2);

  // 3. LP → BP: 4 analogue poles
  //    digPoles[0,2] = conjugate pair A (LP-side: higher imaginary angle)
  //    digPoles[1,3] = conjugate pair B (HP-side: lower  imaginary angle)
  const bpPolsA = lpToBP(lpPoles, Omega0, BW);

  // 4. Bilinear transform → 4 digital poles
  const digPoles = bpPolsA.map(p => bilinear(p, fs));

  // Conjugate pairs: (0,2) and (1,3)
  const { a1: a1_A, a2: a2_A } = quadFromRoots(digPoles[0], digPoles[2]); // LP-side
  const { a1: a1_B, a2: a2_B } = quadFromRoots(digPoles[1], digPoles[3]); // HP-side

  // 5. Zero structure (SciPy bandpass SOS convention):
  //    Section 0: zeros at z = -1 (double) → numerator [1, 2, 1]*k
  //               paired with HP-side poles (pair B, a1_B ≈ -1.9893 for 125 Hz)
  //    Section 1: zeros at z = +1 (double) → numerator [1, -2, 1]
  //               paired with LP-side poles (pair A, a1_A ≈ -1.9937 for 125 Hz)
  //    Verified against expected_outputs.json for all 6 bands.

  // 6. Digital centre frequency (inverse bilinear of Omega0)
  const omega0d = 2 * Math.atan(Omega0 / (2*fs));

  function evalBiquad(b0, b1, b2, a1, a2, omega) {
    const cosw  = Math.cos(omega),  sinw  = Math.sin(omega);
    const cos2w = Math.cos(2*omega), sin2w = Math.sin(2*omega);
    const numRe = b0 + b1*cosw + b2*cos2w;
    const numIm =    - b1*sinw - b2*sin2w;
    const denRe =  1 + a1*cosw + a2*cos2w;
    const denIm =    - a1*sinw - a2*sin2w;
    return Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm);
  }

  // Unscaled gain of each section at omega0d
  const g0 = evalBiquad(1,  2, 1, a1_B, a2_B, omega0d); // sec 0: [1,2,1],  poles B
  const g1 = evalBiquad(1, -2, 1, a1_A, a2_A, omega0d); // sec 1: [1,-2,1], poles A
  const k  = 1.0 / (g0 * g1); // all gain correction in section 0

  // SOS rows: [b0, b1, b2, 1, a1, a2]
  const sos = [
    [k, 2*k, k, 1, a1_B, a2_B],
    [1,  -2, 1, 1, a1_A, a2_A],
  ];

  return sos;
}


// ---------------------------------------------------------------------------
// Public: design all octave filters
// ---------------------------------------------------------------------------

/**
 * Design Butterworth bandpass SOS for all octave-band centre frequencies.
 *
 * @param {number}   fs       — sample rate
 * @param {number[]} centres  — centre frequencies in Hz
 * @returns {Map<number, number[][]>}  — Map: fc → SOS (2×6 array)
 */
export function designOctaveFilters(fs = DEFAULT_FS, centres = CENTRE_FREQUENCIES) {
  const filters = new Map();
  for (const fc of centres) {
    const flo = fc / Math.SQRT2;
    const fhi = fc * Math.SQRT2;
    const sos = designBandpassSOS(flo, fhi, fs);
    filters.set(fc, sos);
  }
  return filters;
}

// ---------------------------------------------------------------------------
// SOS filtering (matches scipy.signal.sosfilt — causal, direct-form II)
// ---------------------------------------------------------------------------

/**
 * Apply an SOS filter cascade to a signal (causal, forward direction only).
 * Uses direct-form II transposed structure for numerical stability.
 *
 * @param {number[][]}   sos    — 2D array, each row [b0,b1,b2,1,a1,a2]
 * @param {Float64Array} signal
 * @returns {Float64Array}
 */
export function sosFilt(sos, signal) {
  const nSections = sos.length;
  const n = signal.length;

  // State: 2 delay elements per section (DF2 transposed)
  const z = new Float64Array(nSections * 2); // zero-initialised

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let x = signal[i];
    for (let s = 0; s < nSections; s++) {
      const [b0, b1, b2, /*a0*/, a1, a2] = sos[s];
      const z0 = z[s*2], z1 = z[s*2+1];
      const y = b0*x + z0;
      z[s*2]   = b1*x - a1*y + z1;
      z[s*2+1] = b2*x - a2*y;
      x = y;
    }
    out[i] = x;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Magnitude response evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the magnitude response (linear) of an SOS cascade at given frequencies.
 *
 * @param {number[][]}   sos    — 2D SOS array
 * @param {number[]}     freqs  — evaluation frequencies in Hz
 * @param {number}       fs
 * @returns {Float64Array}      — linear magnitude values (same length as freqs)
 */
export function sosFreqz(sos, freqs, fs = DEFAULT_FS) {
  const out = new Float64Array(freqs.length);
  for (let fi = 0; fi < freqs.length; fi++) {
    const omega = 2 * Math.PI * freqs[fi] / fs;
    const cosw  = Math.cos(omega), sinw  = Math.sin(omega);
    const cos2w = Math.cos(2*omega), sin2w = Math.sin(2*omega);

    let hRe = 1, hIm = 0;
    for (const [b0, b1, b2, , a1, a2] of sos) {
      const nRe = b0 + b1*cosw + b2*cos2w;
      const nIm =    - b1*sinw - b2*sin2w;
      const dRe =  1 + a1*cosw + a2*cos2w;
      const dIm =    - a1*sinw - a2*sin2w;
      // (hRe+j·hIm) * (nRe+j·nIm) / (dRe+j·dIm)
      const tRe = hRe*nRe - hIm*nIm;
      const tIm = hRe*nIm + hIm*nRe;
      const d2  = dRe*dRe + dIm*dIm;
      hRe = (tRe*dRe + tIm*dIm) / d2;
      hIm = (tIm*dRe - tRe*dIm) / d2;
    }
    out[fi] = Math.hypot(hRe, hIm);
  }
  return out;
}
