/**
 * src/audio/sweep-wav.js — Reference acoustic test sweep generator and download helper.
 *
 * Implements:
 *   - buildSweepWavBuffer(): Pure 16-bit PCM WAV buffer generator at 48 kHz.
 *   - buildSweepWavBlob(): Browser Blob generator.
 *   - downloadSweepWav(): Direct browser download trigger for two-device acoustic capture.
 *   - TWO_DEVICE_HELP_TEXT: Plain-language instructions for accurate two-device acoustic testing.
 */

import {
  SWEEP_F1,
  SWEEP_F2,
  SWEEP_DURATION_S,
  SWEEP_FADE_MS,
} from '../analysis/config.js';

import { generateSweep } from '../dsp/sweep.js';

export const SWEEP_SAMPLE_RATE = 48000;
export const SWEEP_AMPLITUDE = 0.70;
export const SWEEP_LEAD_SILENCE_S = 1.0;
export const SWEEP_TAIL_SILENCE_S = 0.5;

export const TWO_DEVICE_HELP_TEXT = {
  title: 'Two-Device Measurement Workflow',
  instructions: [
    'Play the test sweep from a second device (phone, laptop, or speaker) at a fixed position and moderate volume.',
    'Turn OFF equalisers, bass boost, spatial audio, and loudness enhancement on the playback device.',
    'Turn OFF noise reduction, voice isolation, and auto-gain (AGC) on the recording device.',
    'Start recording first, then play the sweep. Record the full sweep plus at least 3 seconds of room decay (record at least 15 seconds total).',
    'Save as uncompressed WAV if possible. Compressed recordings (m4a, mp3) work but may be less accurate due to perceptual codecs.',
  ],
};

/**
 * Encode mono Float64Array / Float32Array samples into 16-bit PCM WAV ArrayBuffer.
 *
 * @param {Float64Array|Float32Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encode16BitWav(samples, sampleRate) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // RIFF Chunk
  view.setUint32(0, 0x52494646, false); // "RIFF" (Big-endian)
  view.setUint32(4, 36 + dataSize, true); // Little-endian chunk size
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt Subchunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);           // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);            // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true);            // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true);   // SampleRate
  view.setUint32(28, byteRate, true);     // ByteRate
  view.setUint16(32, blockAlign, true);   // BlockAlign
  view.setUint16(34, 16, true);           // BitsPerSample (16 bits)

  // data Subchunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);     // Subchunk2Size

  // Write 16-bit PCM samples with [-1.0, 1.0] clamping
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1.0, Math.min(1.0, samples[i]));
    const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32768.0)));
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Build the standardized acoustic measurement sweep WAV as an ArrayBuffer.
 *
 * @param {object} [options]
 * @param {number} [options.sampleRate=48000]
 * @param {number} [options.amplitude=0.70]
 * @param {number} [options.leadSilenceS=1.0]
 * @param {number} [options.tailSilenceS=0.5]
 * @returns {ArrayBuffer}
 */
export function buildSweepWavBuffer(options = {}) {
  const sampleRate = options.sampleRate || SWEEP_SAMPLE_RATE;
  const amplitude = options.amplitude ?? SWEEP_AMPLITUDE;
  const leadSilenceS = options.leadSilenceS ?? SWEEP_LEAD_SILENCE_S;
  const tailSilenceS = options.tailSilenceS ?? SWEEP_TAIL_SILENCE_S;

  const rawSweep = generateSweep(
    SWEEP_F1,
    SWEEP_F2,
    SWEEP_DURATION_S,
    sampleRate,
    SWEEP_FADE_MS
  );

  const leadSamples = Math.round(leadSilenceS * sampleRate);
  const tailSamples = Math.round(tailSilenceS * sampleRate);
  const totalSamples = leadSamples + rawSweep.length + tailSamples;

  const fullSignal = new Float32Array(totalSamples);
  for (let i = 0; i < rawSweep.length; i++) {
    fullSignal[leadSamples + i] = rawSweep[i] * amplitude;
  }

  return encode16BitWav(fullSignal, sampleRate);
}

/**
 * Generate sweep WAV as a browser Blob.
 *
 * @param {object} [options]
 * @returns {Blob}
 */
export function buildSweepWavBlob(options = {}) {
  const buffer = buildSweepWavBuffer(options);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Trigger file download of the standardized test sweep in the browser.
 *
 * @param {string} [filename='echomap_sweep_48k.wav']
 */
export function downloadSweepWav(filename = 'echomap_sweep_48k.wav') {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('downloadSweepWav is only available in browser environments');
  }

  const blob = buildSweepWavBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
