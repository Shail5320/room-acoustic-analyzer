/**
 * src/ui/format.js — UI formatting helpers.
 *
 * Implements:
 *   - formatDecibels(db, decimals): Formats decibel values. Numbers strictly > 100 dB
 *     are rendered as ">100 dB". Pure ES module, zero DOM dependencies.
 *   - formatAudioErrorMessage(err): Translates raw audio/WAV parsing and pipeline errors
 *     into clear, actionable user messages.
 *   - formatTimeAgo(timestampMs, now): Formats elapsed time since last backup or event.
 */

/**
 * Format acoustic decibel values for UI display.
 * Values exceeding 100 dB are formatted as ">100 dB".
 *
 * @param {number|null|undefined} db
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatDecibels(db, decimals = 1) {
  if (db == null || Number.isNaN(db)) {
    return '—';
  }
  const num = Number(db);
  if (!Number.isFinite(num)) {
    return '—';
  }
  if (num > 100.0) {
    return '>100 dB';
  }
  return `${num.toFixed(decimals)} dB`;
}

/**
 * Translate raw audio, WAV decoding, and pipeline errors into plain-language user messages.
 *
 * @param {Error|string} err
 * @returns {{ title: string, message: string }}
 */
export function formatAudioErrorMessage(err) {
  const msg = (err && err.message ? err.message : String(err || '')).toLowerCase();

  if (msg.includes('50 mb') || msg.includes('exceeds 50')) {
    return {
      title: 'File Too Large',
      message: 'The audio file exceeds the 50 MB limit. Please trim the recording to just the sweep playback and decay tail.',
    };
  }

  if (msg.includes('30 s') || msg.includes('30.0 s') || msg.includes('duration exceeds')) {
    return {
      title: 'Recording Too Long',
      message: 'The recording exceeds the 30-second duration limit. For reliable deconvolution, keep the recording between 12 and 20 seconds.',
    };
  }

  if (msg.includes('rifx') || msg.includes('rf64')) {
    return {
      title: 'Unsupported WAV Format',
      message: 'Big-endian (RIFX) and RF64 formats are not supported. Please use standard 16-bit or 24-bit PCM WAV.',
    };
  }

  if (
    msg.includes('too small') ||
    msg.includes('expected riff') ||
    msg.includes('missing wave') ||
    msg.includes('invalid wav')
  ) {
    return {
      title: 'Corrupt or Invalid Audio',
      message: 'The file header is damaged or does not contain valid audio data. Please ensure the file was saved correctly.',
    };
  }

  if (msg.includes('empty') || msg.includes('silent')) {
    return {
      title: 'Silent Audio',
      message: 'The audio appears silent. Check that your microphone was unmuted and recording level was adequate.',
    };
  }

  if (msg.includes('sweep not detected') || msg.includes('pnr') || msg.includes('peak')) {
    return {
      title: 'Sweep Not Detected',
      message: 'The test sweep could not be clearly detected above background noise. Ensure playback volume is loud enough and background noise is minimized.',
    };
  }

  return {
    title: 'Analysis Failed',
    message: err && err.message ? err.message : 'Failed to process audio file. Please check that the file is an uncorrupted WAV, MP3, or M4A recording.',
  };
}

/**
 * Format relative elapsed time (e.g. "Just now", "5 min ago", "2 h ago", "Never").
 *
 * @param {number|null|undefined} timestampMs
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatTimeAgo(timestampMs, now = Date.now()) {
  if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return 'Never';
  }
  const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSec < 60) {
    return 'Just now';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours} h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} d ago`;
}

/**
 * Escape HTML special characters for safe template insertion.
 *
 * @param {string|number|null|undefined} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format acoustic analysis diagnostics for display in a collapsed Details section.
 * Lists PNR, deltaPostPre, ordering score and threshold, sample rate, duration, and which gate fired.
 *
 * @param {object|null|undefined} diagnostics
 * @returns {string} HTML string
 */
export function formatDiagnosticsHtml(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') {
    return '<p class="text-muted" style="margin: 4px 0;">No diagnostic data available</p>';
  }

  const pnrVal = diagnostics.pnrDb != null && Number.isFinite(diagnostics.pnrDb)
    ? `${diagnostics.pnrDb.toFixed(1)} dB (threshold: ≥ ${(diagnostics.pnrThresholdDb ?? 20).toFixed(1)} dB)`
    : '—';

  const deltaVal = diagnostics.deltaPostPreDb != null && Number.isFinite(diagnostics.deltaPostPreDb)
    ? `${diagnostics.deltaPostPreDb.toFixed(1)} dB (threshold: ≥ ${(diagnostics.deltaPostPreThresholdDb ?? 1.5).toFixed(1)} dB)`
    : '—';

  const scoreVal = diagnostics.orderingScore != null && Number.isFinite(diagnostics.orderingScore)
    ? `${diagnostics.orderingScore.toFixed(3)} (threshold: ≥ ${(diagnostics.orderingThreshold ?? 0.65).toFixed(3)})`
    : '—';

  const srVal = diagnostics.sampleRate ? `${diagnostics.sampleRate} Hz` : '—';
  const durVal = diagnostics.durationS != null && Number.isFinite(diagnostics.durationS)
    ? `${diagnostics.durationS.toFixed(2)} s`
    : '—';

  const gateVal = diagnostics.gateFired || 'None';

  return `
<table class="diagnostics-table" style="width:100%; border-collapse:collapse; font-size:0.85em; font-family:monospace; margin-top:4px;">
  <tbody>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8); width:35%;">Gate fired:</td><td style="padding:3px 6px; font-weight:600;">${escapeHtml(gateVal)}</td></tr>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8);">PNR:</td><td style="padding:3px 6px;">${escapeHtml(pnrVal)}</td></tr>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8);">deltaPostPre:</td><td style="padding:3px 6px;">${escapeHtml(deltaVal)}</td></tr>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8);">Ordering score:</td><td style="padding:3px 6px;">${escapeHtml(scoreVal)}</td></tr>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8);">Sample rate:</td><td style="padding:3px 6px;">${escapeHtml(srVal)}</td></tr>
    <tr><td style="padding:3px 6px; color:var(--text-muted, #94a3b8);">Duration:</td><td style="padding:3px 6px;">${escapeHtml(durVal)}</td></tr>
  </tbody>
</table>`.trim();
}
