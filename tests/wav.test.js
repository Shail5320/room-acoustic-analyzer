import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWav } from '../src/audio/wav.js';
import {
  buildSweepWavBuffer,
  encode16BitWav,
  SWEEP_SAMPLE_RATE,
  SWEEP_AMPLITUDE,
} from '../src/audio/sweep-wav.js';
import { generateSweep } from '../src/dsp/sweep.js';
import { SWEEP_F1, SWEEP_F2, SWEEP_DURATION_S, SWEEP_FADE_MS } from '../src/analysis/config.js';

/**
 * Helper to build custom test WAV buffers with arbitrary chunks, formats, and headers.
 */
function buildCustomWav({
  magic = 'RIFF',
  formatTag = 1,
  numChannels = 1,
  sampleRate = 48000,
  bitsPerSample = 16,
  samplesChannel0 = [0, 0.5, -0.5, 0.25],
  samplesChannel1 = null,
  extraChunks = [],
  overrideDataSize = null,
  isExtensible = false,
  subFormatGuidLow = 1,
}) {
  const numFrames = samplesChannel0.length;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const rawDataSize = numFrames * blockAlign;
  const dataSize = overrideDataSize != null ? overrideDataSize : rawDataSize;

  // Compute fmt chunk size
  const fmtSize = isExtensible ? 40 : 16;

  // Compute total extra chunks byte size
  let extraBytes = 0;
  for (const chunk of extraChunks) {
    extraBytes += 8 + chunk.data.length + (chunk.data.length % 2);
  }

  const totalFileSize = 12 + (8 + fmtSize + (fmtSize % 2)) + extraBytes + (8 + rawDataSize);
  const buffer = new ArrayBuffer(totalFileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 1. RIFF Header
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
  view.setUint32(4, totalFileSize - 8, true);
  bytes[8] = 'W'.charCodeAt(0);
  bytes[9] = 'A'.charCodeAt(0);
  bytes[10] = 'V'.charCodeAt(0);
  bytes[11] = 'E'.charCodeAt(0);

  let offset = 12;

  // Extra chunks before fmt if any
  for (const chunk of extraChunks.filter((c) => c.beforeFmt)) {
    for (let i = 0; i < 4; i++) bytes[offset + i] = chunk.id.charCodeAt(i);
    view.setUint32(offset + 4, chunk.data.length, true);
    bytes.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.length;
    if (chunk.data.length % 2 !== 0) {
      bytes[offset] = 0; // padding
      offset += 1;
    }
  }

  // 2. fmt chunk
  bytes[offset] = 'f'.charCodeAt(0);
  bytes[offset + 1] = 'm'.charCodeAt(0);
  bytes[offset + 2] = 't'.charCodeAt(0);
  bytes[offset + 3] = ' '.charCodeAt(0);
  view.setUint32(offset + 4, fmtSize, true);

  view.setUint16(offset + 8, isExtensible ? 0xfffe : formatTag, true);
  view.setUint16(offset + 10, numChannels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, byteRate, true);
  view.setUint16(offset + 20, blockAlign, true);
  view.setUint16(offset + 22, bitsPerSample, true);

  if (isExtensible) {
    view.setUint16(offset + 24, 22, true); // cbSize = 22
    view.setUint16(offset + 26, bitsPerSample, true); // validBitsPerSample
    view.setUint32(offset + 28, 0, true); // channelMask
    // SubFormat GUID (first 4 bytes little endian = subFormatGuidLow)
    view.setUint32(offset + 32, subFormatGuidLow, true);
    // Remaining 12 bytes of standard KSDATAFORMAT GUID
    const guidTail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    bytes.set(guidTail, offset + 36);
  }

  offset += 8 + fmtSize + (fmtSize % 2);

  // Extra chunks between fmt and data
  for (const chunk of extraChunks.filter((c) => !c.beforeFmt)) {
    for (let i = 0; i < 4; i++) bytes[offset + i] = chunk.id.charCodeAt(i);
    view.setUint32(offset + 4, chunk.data.length, true);
    bytes.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.length;
    if (chunk.data.length % 2 !== 0) {
      bytes[offset] = 0; // padding
      offset += 1;
    }
  }

  // 3. data chunk
  bytes[offset] = 'd'.charCodeAt(0);
  bytes[offset + 1] = 'a'.charCodeAt(0);
  bytes[offset + 2] = 't'.charCodeAt(0);
  bytes[offset + 3] = 'a'.charCodeAt(0);
  view.setUint32(offset + 4, dataSize, true);
  offset += 8;

  // Write samples
  const isFloatSample = isExtensible ? (subFormatGuidLow === 3) : (formatTag === 3);

  for (let f = 0; f < numFrames; f++) {
    const s0 = samplesChannel0[f];
    const s1 = samplesChannel1 ? samplesChannel1[f] : 0;

    if (bitsPerSample === 16) {
      view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(s0 * 32768))), true);
      offset += 2;
      if (numChannels === 2) {
        view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(s1 * 32768))), true);
        offset += 2;
      }
    } else if (bitsPerSample === 24) {
      const int24 = Math.max(-8388608, Math.min(8388607, Math.round(s0 * 8388608)));
      bytes[offset] = int24 & 0xff;
      bytes[offset + 1] = (int24 >> 8) & 0xff;
      bytes[offset + 2] = (int24 >> 16) & 0xff;
      offset += 3;
      if (numChannels === 2) {
        const int24_1 = Math.max(-8388608, Math.min(8388607, Math.round(s1 * 8388608)));
        bytes[offset] = int24_1 & 0xff;
        bytes[offset + 1] = (int24_1 >> 8) & 0xff;
        bytes[offset + 2] = (int24_1 >> 16) & 0xff;
        offset += 3;
      }
    } else if (bitsPerSample === 32 && isFloatSample) {
      view.setFloat32(offset, s0, true);
      offset += 4;
      if (numChannels === 2) {
        view.setFloat32(offset, s1, true);
        offset += 4;
      }
    } else if (bitsPerSample === 32) {
      view.setInt32(offset, Math.round(s0 * 2147483647), true);
      offset += 4;
      if (numChannels === 2) {
        view.setInt32(offset, Math.round(s1 * 2147483647), true);
        offset += 4;
      }
    }
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('WAV Parser: PCM 16-bit integer mono decodes accurately', () => {
  const original = [0.0, 0.75, -0.75, 0.25, -0.25];
  const buf = buildCustomWav({
    formatTag: 1,
    bitsPerSample: 16,
    samplesChannel0: original,
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.numChannels, 1);
  assert.equal(parsed.isMultiChannel, false);
  assert.equal(parsed.samples.length, original.length);

  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - original[i]) < 1e-4);
  }
});

test('WAV Parser: PCM 24-bit integer decodes accurately', () => {
  const original = [0.0, 0.999, -0.999, 0.123456, -0.654321];
  const buf = buildCustomWav({
    formatTag: 1,
    bitsPerSample: 24,
    samplesChannel0: original,
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.samples.length, original.length);

  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - original[i]) < 1e-6);
  }
});

test('WAV Parser: PCM 32-bit integer decodes accurately', () => {
  const original = [0.0, 0.987654, -0.987654, 0.5];
  const buf = buildCustomWav({
    formatTag: 1,
    bitsPerSample: 32,
    samplesChannel0: original,
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.samples.length, original.length);

  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - original[i]) < 1e-6);
  }
});

test('WAV Parser: IEEE 32-bit float decodes with zero quantization error', () => {
  const original = [0.0, 0.1234567, -0.7654321, 0.99999];
  const buf = buildCustomWav({
    formatTag: 3,
    bitsPerSample: 32,
    samplesChannel0: original,
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.samples.length, original.length);

  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - original[i]) < 1e-7);
  }
});

test('WAV Parser: Multi-channel (stereo) extracts channel 0 only without resampling', () => {
  const ch0 = [0.1, 0.2, 0.3, 0.4];
  const ch1 = [0.9, 0.8, 0.7, 0.6];
  const buf = buildCustomWav({
    numChannels: 2,
    bitsPerSample: 16,
    samplesChannel0: ch0,
    samplesChannel1: ch1,
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.numChannels, 2);
  assert.equal(parsed.isMultiChannel, true);
  assert.equal(parsed.samples.length, ch0.length);

  for (let i = 0; i < ch0.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - ch0[i]) < 1e-4);
  }
});

test('WAV Parser: Tolerant of extra metadata chunks (LIST, INFO) and odd-byte padding', () => {
  const oddMetadata = new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 0x54, 0x45, 0x53, 0x54, 0x31]); // 9 bytes (odd)
  const buf = buildCustomWav({
    samplesChannel0: [0.1, 0.2, 0.3],
    extraChunks: [
      { id: 'JUNK', data: new Uint8Array([1, 2, 3, 4]), beforeFmt: true },
      { id: 'LIST', data: oddMetadata, beforeFmt: false },
    ],
  });

  const parsed = parseWav(buf);
  assert.equal(parsed.samples.length, 3);
  assert.ok(Math.abs(parsed.samples[0] - 0.1) < 1e-4);
});

test('WAV Parser: Supports WAVE_FORMAT_EXTENSIBLE (0xFFFE) with PCM and Float subformats', () => {
  // PCM subformat (subFormatGuidLow = 1)
  const bufExtPcm = buildCustomWav({
    isExtensible: true,
    subFormatGuidLow: 1,
    bitsPerSample: 16,
    samplesChannel0: [0.5, -0.5],
  });
  const parsedPcm = parseWav(bufExtPcm);
  assert.equal(parsedPcm.samples.length, 2);
  assert.ok(Math.abs(parsedPcm.samples[0] - 0.5) < 1e-4);

  // Float subformat (subFormatGuidLow = 3)
  const bufExtFloat = buildCustomWav({
    isExtensible: true,
    subFormatGuidLow: 3,
    bitsPerSample: 32,
    samplesChannel0: [0.75, -0.25],
  });
  const parsedFloat = parseWav(bufExtFloat);
  assert.equal(parsedFloat.samples.length, 2);
  assert.ok(Math.abs(parsedFloat.samples[0] - 0.75) < 1e-6);
});

test('WAV Parser: Handles data chunk size 0 or 0xFFFFFFFF by reading remaining bytes', () => {
  // dataSize = 0
  const bufZero = buildCustomWav({
    overrideDataSize: 0,
    samplesChannel0: [0.1, 0.2, 0.3, 0.4],
  });
  const parsedZero = parseWav(bufZero);
  assert.equal(parsedZero.samples.length, 4);

  // dataSize = 0xFFFFFFFF
  const bufMax = buildCustomWav({
    overrideDataSize: 0xffffffff,
    samplesChannel0: [0.1, 0.2, 0.3, 0.4],
  });
  const parsedMax = parseWav(bufMax);
  assert.equal(parsedMax.samples.length, 4);
});

test('WAV Parser: Rejects RIFX (big-endian) and RF64 with clear messages', () => {
  const bufRifx = buildCustomWav({ magic: 'RIFX' });
  assert.throws(() => parseWav(bufRifx), /Big-endian WAV \(RIFX\) is not supported/i);

  const bufRf64 = buildCustomWav({ magic: 'RF64' });
  assert.throws(() => parseWav(bufRf64), /RF64 WAV files are not supported/i);

  const bufInvalid = buildCustomWav({ magic: 'FORM' });
  assert.throws(() => parseWav(bufInvalid), /Invalid WAV file/i);
});

test('WAV Parser: Checks header first and rejects files > 50 MB before decoding', () => {
  // Virtual mock exceeding 50 MB
  const fakeBigBuffer = {
    byteLength: 52 * 1024 * 1024,
  };
  assert.throws(() => parseWav(fakeBigBuffer), /WAV file exceeds 50 MB limit/i);
});

test('WAV Parser: Checks header and rejects duration > 30 s before decoding', () => {
  const sampleRate = 48000;
  // 31 seconds at 48000 Hz 16-bit mono = 31 * 48000 * 2 = 2,976,000 bytes
  const longFrames = 31 * sampleRate;
  const longDataSize = longFrames * 2;

  // Build a small buffer with a data chunk header claiming 31s
  const totalSize = 12 + 24 + 8 + longDataSize;
  const buf = new ArrayBuffer(12 + 24 + 8 + 100); // truncated actual buffer, but header claims 31s
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // RIFF
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, totalSize - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);

  // fmt
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 1 ch
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, longDataSize, true);

  assert.throws(() => parseWav(buf), /duration exceeds 30 s limit/i);
});

test('Sweep WAV: Generated test sweep round-trips through parser within quantization error', () => {
  const sweepBuffer = buildSweepWavBuffer();
  const parsed = parseWav(sweepBuffer);

  assert.equal(parsed.sampleRate, SWEEP_SAMPLE_RATE);
  assert.equal(parsed.numChannels, 1);
  assert.equal(parsed.isMultiChannel, false);

  // Compare parsed waveform with generated sweep
  const rawSweep = generateSweep(
    SWEEP_F1,
    SWEEP_F2,
    SWEEP_DURATION_S,
    SWEEP_SAMPLE_RATE,
    SWEEP_FADE_MS
  );

  const leadSamples = Math.round(1.0 * SWEEP_SAMPLE_RATE);
  // Verify 1 s leading silence
  for (let i = 0; i < leadSamples; i++) {
    assert.equal(parsed.samples[i], 0);
  }

  // Verify sweep section matches within 16-bit quantization error (1 / 32768 ≈ 3.05e-5)
  let maxDiff = 0;
  for (let i = 0; i < rawSweep.length; i++) {
    const expected = rawSweep[i] * SWEEP_AMPLITUDE;
    const actual = parsed.samples[leadSamples + i];
    const diff = Math.abs(actual - expected);
    if (diff > maxDiff) maxDiff = diff;
  }

  console.log(`\n  Sweep WAV Round-Trip Max Quantization Error: ${maxDiff.toExponential(4)} (Threshold: 3.1e-5)`);
  assert.ok(maxDiff < 3.1e-5, `Quantization error ${maxDiff} >= 3.1e-5`);
});

// ---------------------------------------------------------------------------
// UI Helper: formatDecibels
// ---------------------------------------------------------------------------

import { formatDecibels } from '../src/ui/format.js';

test('UI Helper: formatDecibels formats >100 dB as ">100 dB" and finite values with precision', () => {
  assert.equal(formatDecibels(123.4), '>100 dB');
  assert.equal(formatDecibels(100.1), '>100 dB');
  assert.equal(formatDecibels(100.0), '100.0 dB');
  assert.equal(formatDecibels(45.67), '45.7 dB');
  assert.equal(formatDecibels(0), '0.0 dB');
  assert.equal(formatDecibels(null), '—');
  assert.equal(formatDecibels(NaN), '—');
});

