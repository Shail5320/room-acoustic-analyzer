import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDecibels,
  formatAudioErrorMessage,
  formatTimeAgo,
  formatDiagnosticsHtml,
} from '../src/ui/format.js';
import { StorageService, MemoryStorageAdapter } from '../src/store/storage.js';

test('Error Formatting - Formats audio validation and pipeline errors into clear user copy', () => {
  // File size limit
  const errSize = formatAudioErrorMessage(new Error('WAV file exceeds 50 MB limit (62.4 MB > 50 MB)'));
  assert.equal(errSize.title, 'File Too Large');
  assert.match(errSize.message, /50 MB limit/);

  // Duration limit
  const errDuration = formatAudioErrorMessage(new Error('Recording duration exceeds 30 s limit (34.2 s > 30 s)'));
  assert.equal(errDuration.title, 'Recording Too Long');
  assert.match(errDuration.message, /30-second duration/);

  // Unsupported RIFX / RF64
  const errRifx = formatAudioErrorMessage(new Error('Big-endian WAV (RIFX) is not supported'));
  assert.equal(errRifx.title, 'Unsupported WAV Format');

  const errRf64 = formatAudioErrorMessage(new Error('RF64 WAV files are not supported'));
  assert.equal(errRf64.title, 'Unsupported WAV Format');

  // Corrupted / missing header
  const errCorrupt = formatAudioErrorMessage(new Error('Invalid WAV file: expected RIFF header but found "ABCD"'));
  assert.equal(errCorrupt.title, 'Corrupt or Invalid Audio');

  // Silent / empty
  const errSilent = formatAudioErrorMessage(new Error('Recording is silent or empty'));
  assert.equal(errSilent.title, 'Silent Audio');

  // Low PNR / sweep not found
  const errPnr = formatAudioErrorMessage(new Error('Sweep not detected above noise (PNR < 15 dB)'));
  assert.equal(errPnr.title, 'Sweep Not Detected');

  // General fallback
  const errGeneric = formatAudioErrorMessage(new Error('Unexpected decoding exception'));
  assert.equal(errGeneric.title, 'Analysis Failed');
  assert.equal(errGeneric.message, 'Unexpected decoding exception');
});

test('Time Formatting - formatTimeAgo handles elapsed relative times', () => {
  const now = 1000000000000;

  assert.equal(formatTimeAgo(null, now), 'Never');
  assert.equal(formatTimeAgo(0, now), 'Never');
  assert.equal(formatTimeAgo(undefined, now), 'Never');

  // 15 seconds ago -> Just now
  assert.equal(formatTimeAgo(now - 15 * 1000, now), 'Just now');

  // 5 minutes ago
  assert.equal(formatTimeAgo(now - 5 * 60 * 1000, now), '5 min ago');

  // 3 hours ago
  assert.equal(formatTimeAgo(now - 3 * 3600 * 1000, now), '3 h ago');

  // 2 days ago
  assert.equal(formatTimeAgo(now - 2 * 86400 * 1000, now), '2 d ago');
});

test('Storage - Quota exceeded error triggers graceful fallback to memory adapter with warning', async () => {
  // Mock adapter that throws QuotaExceededError
  const failingAdapter = {
    async saveSession() {
      const err = new Error('The quota has been exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    },
    async listSessions() {
      return [];
    },
    async getSession() {
      return null;
    },
    async deleteSession() {
      return true;
    },
  };

  const storage = new StorageService(failingAdapter);
  assert.equal(storage.getWarningMessage(), null);

  const saved = await storage.save({
    id: 'test_session',
    name: 'Quota Test Session',
    aspectRatio: '4:3',
  });

  assert.ok(saved, 'Must return saved session from memory adapter fallback');
  assert.equal(saved.id, 'test_session');
  assert.equal(saved.name, 'Quota Test Session');

  // Verify warning message advises user of quota limit and JSON backup
  const warning = storage.getWarningMessage();
  assert.ok(warning, 'Warning message must be set');
  assert.match(warning, /quota exceeded/i);
  assert.match(warning, /memory/i);
  assert.match(warning, /JSON backup/i);

  // Subsequent gets and saves should work via memory adapter
  const retrieved = await storage.get('test_session');
  assert.equal(retrieved.id, 'test_session');
});

test('Diagnostics Formatting - formatDiagnosticsHtml outputs collapsed details content', () => {
  // 1. Accepted recording diagnostics
  const validHtml = formatDiagnosticsHtml({
    pnrDb: 28.5,
    pnrThresholdDb: 20.0,
    deltaPostPreDb: 6.2,
    deltaPostPreThresholdDb: 1.5,
    tStart: 1.00,
    matchedBands: 6,
    perBandMarginDb: [54.5, 43.7, 37.9, 38.8, 46.5, 51.9],
    sampleRate: 48000,
    durationS: 8.50,
    gateFired: 'None (All gates passed)',
  });

  assert.match(validHtml, /Gate fired:.*None \(All gates passed\)/);
  assert.match(validHtml, /PNR:.*28\.5 dB \(threshold: ≥ 20\.0 dB\)/);
  assert.match(validHtml, /deltaPostPre:.*6\.2 dB \(threshold: ≥ 1\.5 dB\)/);
  assert.match(validHtml, /Sweep start \(tStart\):.*1\.00 s/);
  assert.match(validHtml, /Matched bands:.*6 of 6 bands/);
  assert.match(validHtml, /Per-band margins:.*125Hz: \+54\.5 dB/);
  assert.match(validHtml, /Sample rate:.*48000 Hz/);
  assert.match(validHtml, /Duration:.*8\.50 s/);

  // 2. Rejected recording diagnostics (e.g. clap)
  const rejectedHtml = formatDiagnosticsHtml({
    pnrDb: 19.8,
    pnrThresholdDb: 20.0,
    deltaPostPreDb: 9.1,
    deltaPostPreThresholdDb: 1.5,
    tStart: -2.83,
    matchedBands: 0,
    perBandMarginDb: [-99.0, -99.0, -99.0, -99.0, -99.0, -99.0],
    sampleRate: 48000,
    durationS: 8.50,
    gateFired: 'Template gate',
  });

  assert.match(rejectedHtml, /Gate fired:.*Template gate/);
  assert.match(rejectedHtml, /PNR:.*19\.8 dB/);
  assert.match(rejectedHtml, /deltaPostPre:.*9\.1 dB/);
  assert.match(rejectedHtml, /Matched bands:.*0 of 6 bands/);

  // 3. Fallback on missing data
  assert.match(formatDiagnosticsHtml(null), /No diagnostic data available/);
});
