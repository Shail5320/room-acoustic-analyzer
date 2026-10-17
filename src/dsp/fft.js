/**
 * src/dsp/fft.js — Radix-2 Cooley–Tukey FFT and IFFT.
 *
 * Buffer layout: interleaved Float64Array [re0, im0, re1, im1, …]
 * so element k has real part at index 2k and imaginary at 2k+1.
 *
 * All functions operate in-place on the provided interleaved buffer.
 * Exported helpers also accept a plain number array / Float64Array of
 * real samples and return an interleaved Float64Array.
 *
 * N must be a power of two.
 */

// ---------------------------------------------------------------------------
// Bit-reversal permutation (in-place on interleaved buffer)
// ---------------------------------------------------------------------------
function bitReverse(buf, n) {
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) {
    let j = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      j = (j << 1) | (x & 1);
      x >>= 1;
    }
    if (j > i) {
      // swap complex element i ↔ j
      const ri = 2 * i, rj = 2 * j;
      let tmp = buf[ri];   buf[ri]   = buf[rj];   buf[rj]   = tmp;
          tmp = buf[ri+1]; buf[ri+1] = buf[rj+1]; buf[rj+1] = tmp;
    }
  }
}

// ---------------------------------------------------------------------------
// Core Cooley–Tukey DIT radix-2 butterfly (in-place, interleaved)
// sign = -1 → forward FFT, sign = +1 → inverse FFT (unnormalised)
// ---------------------------------------------------------------------------
function fftCore(buf, n, sign) {
  bitReverse(buf, n);

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = sign * 2.0 * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let tRe = 1.0, tIm = 0.0; // twiddle factor starts at W^0 = 1
      for (let j = 0; j < half; j++) {
        const uIdx = 2 * (i + j);
        const vIdx = 2 * (i + j + half);

        const uRe = buf[uIdx],   uIm = buf[uIdx+1];
        const vRe = buf[vIdx],   vIm = buf[vIdx+1];

        // v' = twiddle * v
        const tvRe = tRe * vRe - tIm * vIm;
        const tvIm = tRe * vIm + tIm * vRe;

        buf[uIdx]   = uRe + tvRe;
        buf[uIdx+1] = uIm + tvIm;
        buf[vIdx]   = uRe - tvRe;
        buf[vIdx+1] = uIm - tvIm;

        // advance twiddle: t *= w
        const newTRe = tRe * wRe - tIm * wIm;
        tIm = tRe * wIm + tIm * wRe;
        tRe = newTRe;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the forward FFT of a real signal.
 *
 * @param {Float64Array|number[]} real  — N real samples
 * @returns {Float64Array}              — interleaved [re0,im0,re1,im1,…] length 2N
 */
export function fft(real) {
  const n = real.length;
  // Fill interleaved buffer with real samples, imaginary = 0
  const buf = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) buf[2 * i] = real[i];
  fftCore(buf, n, -1);
  return buf;
}

/**
 * Compute the inverse FFT of an interleaved complex spectrum.
 * Returns the normalised (1/N) complex output as an interleaved Float64Array.
 *
 * @param {Float64Array} buf  — interleaved [re0,im0,…] length 2N
 * @returns {Float64Array}    — interleaved normalised output, length 2N
 */
export function ifft(buf) {
  const n = buf.length >> 1;
  // Work on a copy so the caller's buffer is unchanged
  const out = new Float64Array(buf);
  fftCore(out, n, +1);
  const inv = 1.0 / n;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Multiply two interleaved complex spectra element-wise (in-place into a).
 * Used by deconvolve and sweep to combine spectra without extra allocations.
 *
 * @param {Float64Array} a — modified in place
 * @param {Float64Array} b — read-only
 */
export function complexMultiply(a, b) {
  const n = a.length >> 1;
  for (let i = 0; i < n; i++) {
    const ri = 2 * i;
    const aRe = a[ri], aIm = a[ri+1];
    const bRe = b[ri], bIm = b[ri+1];
    a[ri]   = aRe * bRe - aIm * bIm;
    a[ri+1] = aRe * bIm + aIm * bRe;
  }
}

/**
 * Extract the real part of an interleaved complex buffer as a new Float64Array.
 *
 * @param {Float64Array} buf  — interleaved, length 2N
 * @returns {Float64Array}    — real part, length N
 */
export function realPart(buf) {
  const n = buf.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[2 * i];
  return out;
}

/**
 * Next power of two ≥ n.
 */
export function nextPow2(n) {
  if (n <= 1) return 1;
  return 1 << Math.ceil(Math.log2(n));
}

/**
 * Compute the forward FFT of a zero-padded real signal.
 *
 * @param {Float64Array|number[]} real  — signal (length ≤ nfft)
 * @param {number}                nfft  — must be a power of two
 * @returns {Float64Array}              — interleaved length 2*nfft
 */
export function fftPadded(real, nfft) {
  const buf = new Float64Array(2 * nfft); // zero-initialised
  const len = Math.min(real.length, nfft);
  for (let i = 0; i < len; i++) buf[2 * i] = real[i];
  fftCore(buf, nfft, -1);
  return buf;
}
