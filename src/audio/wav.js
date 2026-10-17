/**
 * src/audio/wav.js — Pure WAV audio parser and browser file loader.
 *
 * Implements:
 *   - Pure parseWav(arrayBuffer): zero DOM dependencies, works in Node and Web Worker.
 *   - Formats supported:
 *       • PCM 16-bit, 24-bit, 32-bit integer
 *       • IEEE 754 32-bit float
 *       • WAVE_FORMAT_EXTENSIBLE (0xFFFE) with PCM or float subformats
 *   - Multi-channel: extracts channel 0 without downmixing or resampling.
 *   - Chunk tolerance: skips LIST, INFO, and other metadata chunks; handles odd-byte padding.
 *   - Data chunk tolerance: handles chunk sizes of 0 or 0xFFFFFFFF by consuming remaining bytes.
 *   - Header validation before full decoding:
 *       • File size <= 50 MB
 *       • Duration <= 30.0 s
 *       • Rejects RIFX (big-endian) and RF64 with explicit error messages.
 *   - Browser loadAudioFile(file, audioContext):
 *       • WAV files: parsed directly via parseWav (never resampled).
 *       • Non-WAV (m4a/mp3): decoded via AudioContext.decodeAudioData with visible warning.
 */

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_DURATION_S = 30.0;                 // 30 s guard

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

// SubFormat GUIDs (first 4 bytes little-endian)
// KSDATAFORMAT_SUBTYPE_PCM: 00000001-0000-0010-8000-00aa00389b71
// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: 00000003-0000-0010-8000-00aa00389b71

/**
 * Pure WAV parser.
 *
 * @param {ArrayBuffer|Uint8Array} inputBuffer
 * @returns {{
 *   samples: Float32Array,
 *   sampleRate: number,
 *   numChannels: number,
 *   durationSec: number,
 *   isMultiChannel: boolean,
 *   format: string
 * }}
 */
export function parseWav(inputBuffer) {
  if (!inputBuffer) {
    throw new Error('parseWav: Input buffer is null or undefined');
  }

  const buffer = inputBuffer instanceof Uint8Array
    ? inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength)
    : inputBuffer;

  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(`WAV file exceeds 50 MB limit (${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB > 50 MB)`);
  }

  if (buffer.byteLength < 12) {
    throw new Error('Invalid WAV file: file is too small to contain a header');
  }

  const dataView = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Read first 4 bytes for magic identifier
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  if (magic === 'RIFX') {
    throw new Error('Big-endian WAV (RIFX) is not supported');
  }
  if (magic === 'RF64') {
    throw new Error('RF64 WAV files are not supported');
  }
  if (magic !== 'RIFF') {
    throw new Error(`Invalid WAV file: expected RIFF header but found "${magic}"`);
  }

  const waveId = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (waveId !== 'WAVE') {
    throw new Error(`Invalid WAV file: missing WAVE format identifier (found "${waveId}")`);
  }

  let offset = 12;
  let fmtParsed = false;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let isFloat = false;

  let dataOffset = -1;
  let dataSize = 0;

  // Scan chunks in RIFF container
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    let chunkSize = dataView.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('Invalid WAV file: fmt chunk is corrupt (< 16 bytes)');
      }

      audioFormat = dataView.getUint16(offset + 8, true);
      numChannels = dataView.getUint16(offset + 10, true);
      sampleRate = dataView.getUint32(offset + 12, true);
      byteRate = dataView.getUint32(offset + 16, true);
      blockAlign = dataView.getUint16(offset + 20, true);
      bitsPerSample = dataView.getUint16(offset + 22, true);

      if (numChannels <= 0) {
        throw new Error(`Invalid channel count: ${numChannels}`);
      }
      if (sampleRate <= 0) {
        throw new Error(`Invalid sample rate: ${sampleRate}`);
      }

      if (audioFormat === WAVE_FORMAT_PCM) {
        isFloat = false;
      } else if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
        isFloat = true;
      } else if (audioFormat === WAVE_FORMAT_EXTENSIBLE) {
        if (chunkSize < 40) {
          throw new Error('Invalid WAVE_FORMAT_EXTENSIBLE: fmt chunk is too small');
        }
        const subFormatLow = dataView.getUint32(offset + 32, true);
        if (subFormatLow === WAVE_FORMAT_PCM) {
          isFloat = false;
        } else if (subFormatLow === WAVE_FORMAT_IEEE_FLOAT) {
          isFloat = true;
        } else {
          throw new Error(`Unsupported WAVE_FORMAT_EXTENSIBLE subformat: 0x${subFormatLow.toString(16).padStart(4, '0')}`);
        }
      } else {
        throw new Error(`Unsupported WAV audio format code: 0x${audioFormat.toString(16).padStart(4, '0')}`);
      }

      fmtParsed = true;
    } else if (chunkId === 'data') {
      if (!fmtParsed) {
        throw new Error('Invalid WAV: data chunk appeared before fmt chunk');
      }

      dataOffset = offset + 8;

      // Pre-check duration from claimed chunk header before decoding
      const bytesPerSample = bitsPerSample / 8;
      const bytesPerFrame = numChannels * bytesPerSample;
      const claimedDataBytes = (chunkSize === 0 || chunkSize === 0xFFFFFFFF)
        ? (buffer.byteLength - dataOffset)
        : chunkSize;

      if (bytesPerFrame > 0 && sampleRate > 0) {
        const estDuration = claimedDataBytes / (bytesPerFrame * sampleRate);
        if (estDuration > MAX_DURATION_S + 0.05) {
          throw new Error(`Recording duration exceeds 30 s limit (${estDuration.toFixed(1)} s > ${MAX_DURATION_S} s)`);
        }
      }

      // Handle chunk size 0 or 0xFFFFFFFF or partial buffer by using remaining bytes
      if (chunkSize === 0 || chunkSize === 0xFFFFFFFF || dataOffset + chunkSize > buffer.byteLength) {
        dataSize = buffer.byteLength - dataOffset;
      } else {
        dataSize = chunkSize;
      }
      break; // Found data chunk, ready to decode
    }

    // Advance to next chunk, accounting for odd chunk padding byte
    const paddedChunkSize = chunkSize + (chunkSize % 2);
    offset += 8 + paddedChunkSize;
  }

  if (!fmtParsed) {
    throw new Error('Invalid WAV: missing fmt chunk');
  }
  if (dataOffset === -1) {
    throw new Error('Invalid WAV: missing data chunk');
  }

  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = numChannels * bytesPerSample;
  if (bytesPerFrame <= 0) {
    throw new Error('Invalid WAV frame size');
  }

  const totalFrames = Math.floor(dataSize / bytesPerFrame);
  const durationSec = totalFrames / sampleRate;

  if (durationSec > MAX_DURATION_S + 0.05) {
    throw new Error(`Recording duration exceeds 30 s limit (${durationSec.toFixed(1)} s > ${MAX_DURATION_S} s)`);
  }

  const samples = new Float32Array(totalFrames);

  // Decode channel 0 only
  if (isFloat) {
    if (bitsPerSample === 32) {
      for (let i = 0; i < totalFrames; i++) {
        const pos = dataOffset + i * bytesPerFrame;
        samples[i] = dataView.getFloat32(pos, true);
      }
    } else {
      throw new Error(`Unsupported float bit depth: ${bitsPerSample} bits`);
    }
  } else {
    if (bitsPerSample === 16) {
      for (let i = 0; i < totalFrames; i++) {
        const pos = dataOffset + i * bytesPerFrame;
        samples[i] = dataView.getInt16(pos, true) / 32768.0;
      }
    } else if (bitsPerSample === 24) {
      for (let i = 0; i < totalFrames; i++) {
        const pos = dataOffset + i * bytesPerFrame;
        const b0 = bytes[pos];
        const b1 = bytes[pos + 1];
        const b2 = bytes[pos + 2];
        // Sign-extend 24-bit signed integer
        const int24 = (b2 << 24) | (b1 << 16) | (b0 << 8);
        samples[i] = (int24 >> 8) / 8388608.0;
      }
    } else if (bitsPerSample === 32) {
      for (let i = 0; i < totalFrames; i++) {
        const pos = dataOffset + i * bytesPerFrame;
        samples[i] = dataView.getInt32(pos, true) / 2147483648.0;
      }
    } else {
      throw new Error(`Unsupported PCM bit depth: ${bitsPerSample} bits`);
    }
  }

  return {
    samples,
    sampleRate,
    numChannels,
    durationSec,
    isMultiChannel: numChannels > 1,
    format: 'wav',
  };
}

/**
 * Browser audio file loader. Parses WAV directly or decodes compressed audio via AudioContext.
 *
 * @param {File|Blob} file
 * @param {AudioContext} [audioContext]
 * @returns {Promise<{
 *   samples: Float32Array,
 *   sampleRate: number,
 *   numChannels: number,
 *   durationSec: number,
 *   isMultiChannel: boolean,
 *   format: string,
 *   warning: string|null
 * }>}
 */
export async function loadAudioFile(file, audioContext = null) {
  if (!file) {
    throw new Error('loadAudioFile: No file provided');
  }

  const fileName = (file.name || '').toLowerCase();
  const fileType = (file.type || '').toLowerCase();
  const isWav = fileName.endsWith('.wav') || fileType.includes('wav');

  const arrayBuffer = await file.arrayBuffer();

  if (isWav) {
    const parsed = parseWav(arrayBuffer);
    const warning = parsed.isMultiChannel
      ? 'Multi-channel audio detected: channel 0 used for analysis.'
      : null;
    return {
      ...parsed,
      warning,
    };
  }

  // Non-WAV: compressed format fallback via AudioContext
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
    throw new Error('Browser audio decoding is not supported in this environment');
  }

  const ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const durationSec = audioBuffer.duration;

  if (durationSec > MAX_DURATION_S + 0.05) {
    throw new Error(`Recording duration exceeds 30 s limit (${durationSec.toFixed(1)} s > ${MAX_DURATION_S} s)`);
  }

  // Extract channel 0
  const channel0 = audioBuffer.getChannelData(0);
  const samples = new Float32Array(channel0);

  const ext = fileName.split('.').pop() || 'compressed';
  const warning = `Compressed audio format detected (${ext.toUpperCase()}). Browser decoding and resampling to ${sampleRate} Hz may distort phase or frequency response.`;

  return {
    samples,
    sampleRate,
    numChannels,
    durationSec,
    isMultiChannel: numChannels > 1,
    format: 'compressed',
    warning,
  };
}
