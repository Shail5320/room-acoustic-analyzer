/**
 * src/store/export.js — Pure export utilities for sessions (JSON and CSV).
 *
 * Implements:
 *   - toJSON(session): Formats full session state as formatted JSON string
 *   - toCSV(session): Flattens session to 1 row per measurement per octave band
 *       Columns (no dimensions):
 *         session, point_index, status, x_rel, y_rel, band_hz, t20, t30, edt, r2, used, tier, pnr_db, dynamic_range_db, clipped, fake, timestamp
 *       Columns (with dimensions):
 *         session, point_index, status, x_rel, y_rel, x_m, y_m, band_hz, t20, t30, edt, r2, used, tier, pnr_db, dynamic_range_db, clipped, fake, timestamp
 *   - Strict RFC 4180 CSV escaping (escapes commas, quotes, and newlines)
 *   - Pending points exported with empty data cells
 *   - Metric coordinates marked approximate (e.g. ~x.xxx) if derived from step counts
 *   - hasFakeMeasurements(session) detection for visible UI warning
 *   - Zero DOM dependencies for pure functions; downloadFile for browser export
 */

import { OCTAVE_BANDS } from '../ui/session-model.js';
import { relativeToMetric } from '../ui/dimensions.js';

/**
 * RFC 4180 CSV cell value escaper.
 * If field contains comma, quote, or newline, escape internal quotes to "" and wrap in quotes.
 *
 * @param {any} val
 * @returns {string}
 */
export function escapeCSVCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Check whether any measurement in the session contains simulated/DEV fake data.
 *
 * @param {object} session
 * @returns {boolean}
 */
export function hasFakeMeasurements(session) {
  if (!session || !Array.isArray(session.measurements)) return false;
  return session.measurements.some((m) => Boolean(m.fake));
}

/**
 * Export full session data to formatted JSON string.
 *
 * @param {object} session
 * @returns {string}
 */
export function toJSON(session) {
  if (!session) return '{}';
  const cleanSession = typeof session.toJSON === 'function' ? session.toJSON() : session;
  return JSON.stringify(cleanSession, null, 2);
}

/**
 * Export session data to flat CSV string (one row per measurement per octave band).
 *
 * @param {object} session
 * @returns {string}
 */
export function toCSV(session) {
  if (!session) return '';
  const rawSession = typeof session.toJSON === 'function' ? session.toJSON() : session;

  const sessionName = rawSession.name || 'Untitled Session';
  const hasDims = Boolean(
    rawSession.roomDimensions &&
    Number.isFinite(rawSession.roomDimensions.lengthM) &&
    Number.isFinite(rawSession.roomDimensions.widthM)
  );
  const isApproximate = hasDims && Boolean(rawSession.roomDimensions.isApproximate);

  // Column definitions
  const columns = hasDims
    ? [
        'session',
        'point_index',
        'status',
        'x_rel',
        'y_rel',
        'x_m',
        'y_m',
        'band_hz',
        't20',
        't30',
        'edt',
        'r2',
        'used',
        'tier',
        'pnr_db',
        'dynamic_range_db',
        'clipped',
        'fake',
        'timestamp',
      ]
    : [
        'session',
        'point_index',
        'status',
        'x_rel',
        'y_rel',
        'band_hz',
        't20',
        't30',
        'edt',
        'r2',
        'used',
        'tier',
        'pnr_db',
        'dynamic_range_db',
        'clipped',
        'fake',
        'timestamp',
      ];

  const lines = [columns.join(',')];

  const measurements = Array.isArray(rawSession.measurements) ? rawSession.measurements : [];

  for (const m of measurements) {
    const pointIndex = m.id;
    const status = m.status || 'pending';
    const xRel = Number(m.x.toFixed(4));
    const yRel = Number(m.y.toFixed(4));

    let xMStr = '';
    let yMStr = '';
    if (hasDims) {
      const metric = relativeToMetric(m.x, m.y, rawSession.roomDimensions);
      if (metric) {
        const xVal = metric.xM.toFixed(3);
        const yVal = metric.yM.toFixed(3);
        xMStr = isApproximate ? `~${xVal}` : xVal;
        yMStr = isApproximate ? `~${yVal}` : yVal;
      }
    }

    if (status === 'pending' || !m.bands) {
      // Pending point: export 1 row per band with empty measurement cells
      for (const band of OCTAVE_BANDS) {
        const row = [
          escapeCSVCell(sessionName),
          pointIndex,
          status,
          xRel,
          yRel,
        ];
        if (hasDims) {
          row.push(xMStr, yMStr);
        }
        // band_hz
        row.push(band);
        // empty measurement data cells: t20, t30, edt, r2, used, tier, pnr_db, dynamic_range_db, clipped, fake, timestamp
        row.push('', '', '', '', '', '', '', '', '', '', '');
        lines.push(row.join(','));
      }
    } else {
      // Measured point: export rows for each octave band
      for (const band of OCTAVE_BANDS) {
        const bandData = m.bands[band];
        const row = [
          escapeCSVCell(sessionName),
          pointIndex,
          status,
          xRel,
          yRel,
        ];
        if (hasDims) {
          row.push(xMStr, yMStr);
        }
        row.push(band);

        if (bandData) {
          row.push(
            Number.isFinite(bandData.t20) ? bandData.t20.toFixed(3) : '',
            Number.isFinite(bandData.t30) ? bandData.t30.toFixed(3) : '',
            Number.isFinite(bandData.edt) ? bandData.edt.toFixed(3) : '',
            Number.isFinite(bandData.r2) ? bandData.r2.toFixed(3) : '',
            escapeCSVCell(bandData.used || ''),
            escapeCSVCell(bandData.tier || '')
          );
        } else {
          row.push('', '', '', '', '', '');
        }

        row.push(
          Number.isFinite(m.pnrDb) ? m.pnrDb.toFixed(1) : '',
          Number.isFinite(m.dynamicRangeDb) ? m.dynamicRangeDb.toFixed(1) : '',
          m.clipped ? 'true' : 'false',
          m.fake ? 'true' : 'false',
          m.timestamp ? m.timestamp : ''
        );

        lines.push(row.join(','));
      }
    }
  }

  return lines.join('\r\n');
}

/**
 * Trigger file download via a Blob and temporary anchor element in browser.
 *
 * @param {string} content
 * @param {string} filename
 * @param {string} [mimeType='text/plain;charset=utf-8']
 */
export function downloadFile(content, filename, mimeType = 'text/plain;charset=utf-8') {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('downloadFile is only available in browser environments');
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
