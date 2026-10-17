/**
 * src/ui/format.js — UI formatting helpers.
 *
 * Implements:
 *   - formatDecibels(db, decimals): Formats decibel values. Numbers strictly > 100 dB
 *     are rendered as ">100 dB". Pure ES module, zero DOM dependencies.
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
