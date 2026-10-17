/**
 * src/ui/session-model.js — Pure measurement and session state model.
 *
 * Implements:
 *   - Movable source position (x, y) in [0, 1]
 *   - Numbered measurement list (sequential IDs) with status: 'pending' | 'measured'
 *   - DSP-compatible measurement data structure:
 *       x, y, timestamp, pnrDb, dynamicRangeDb, clipped
 *       bands: { [freq]: { t20, t30, edt, r2, used, tier, rt60 } }
 *   - Dev fake measurement generator (fake: true, includes valid, approximate, and invalid tiers)
 *   - Aspect ratio storage in session
 *   - Pure ES module: zero DOM dependencies, fully testable in node:test
 */

import { DEFAULT_ASPECT_RATIO_STR, parseAspectRatio } from './coordinates.js';

export const OCTAVE_BANDS = [125, 250, 500, 1000, 2000, 4000];

/**
 * Generate fake measurement data mirroring the DSP rt60 analysis output.
 * Guaranteed to have `fake: true` and includes 'valid', 'approximate', and 'invalid' tiers.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [index=1]
 * @returns {object}
 */
export function generateFakeMeasurementData(x = 0.5, y = 0.5, index = 1) {
  // Add subtle deterministic variation based on point index and position
  const baseRt = 0.70 + ((index * 7) % 15) * 0.02 + (x * 0.1) - (y * 0.05);

  const bands = {
    125: {
      t20: Math.round((baseRt + 0.22) * 1000) / 1000,
      t30: Math.round((baseRt + 0.24) * 1000) / 1000,
      edt: Math.round((baseRt + 0.28) * 1000) / 1000,
      r2: 0.984,
      used: 'T30',
      tier: 'valid',
      rt60: Math.round((baseRt + 0.24) * 1000) / 1000,
    },
    250: {
      t20: Math.round((baseRt + 0.12) * 1000) / 1000,
      t30: Math.round((baseRt + 0.14) * 1000) / 1000,
      edt: Math.round((baseRt + 0.16) * 1000) / 1000,
      r2: 0.978,
      used: 'T30',
      tier: 'valid',
      rt60: Math.round((baseRt + 0.14) * 1000) / 1000,
    },
    500: {
      t20: Math.round((baseRt + 0.04) * 1000) / 1000,
      t30: Math.round(baseRt * 1000) / 1000,
      edt: Math.round((baseRt + 0.02) * 1000) / 1000,
      r2: 0.991,
      used: 'T30',
      tier: 'valid',
      rt60: Math.round(baseRt * 1000) / 1000,
    },
    1000: {
      t20: Math.round((baseRt - 0.05) * 1000) / 1000,
      t30: Math.round((baseRt - 0.04) * 1000) / 1000,
      edt: Math.round((baseRt - 0.02) * 1000) / 1000,
      r2: 0.962,
      used: 'T20',
      tier: 'approximate', // Guaranteed approximate tier band
      rt60: Math.round((baseRt - 0.05) * 1000) / 1000,
    },
    2000: {
      t20: Math.round((baseRt - 0.10) * 1000) / 1000,
      t30: Math.round((baseRt - 0.11) * 1000) / 1000,
      edt: Math.round((baseRt - 0.08) * 1000) / 1000,
      r2: 0.979,
      used: 'T30',
      tier: 'valid',
      rt60: Math.round((baseRt - 0.11) * 1000) / 1000,
    },
    4000: {
      t20: NaN,
      t30: NaN,
      edt: NaN,
      r2: 0.88,
      used: 'none',
      tier: 'invalid', // Guaranteed invalid tier band
      rt60: NaN,
    },
  };

  return {
    timestamp: Date.now(),
    pnrDb: Math.round((42.5 + ((index * 3) % 8)) * 10) / 10,
    dynamicRangeDb: Math.round((46.0 + ((index * 2) % 6)) * 10) / 10,
    clipped: false,
    fake: true,
    bands,
  };
}

export class SessionModel {
  /**
   * @param {object} [initialState]
   * @param {string} [initialState.aspectRatio='4:3']
   * @param {{ x: number, y: number }|null} [initialState.source=null]
   * @param {Array<object>} [initialState.measurements=[]]
   * @param {number} [initialState.activeBand=500]
   */
  constructor(initialState = {}) {
    this.aspectRatio = initialState.aspectRatio || DEFAULT_ASPECT_RATIO_STR;
    this.source = initialState.source
      ? {
          x: Math.max(0, Math.min(1, initialState.source.x)),
          y: Math.max(0, Math.min(1, initialState.source.y)),
        }
      : null;
    this.measurements = Array.isArray(initialState.measurements) ? [...initialState.measurements] : [];
    this.activeBand = initialState.activeBand || 500;
    this.selectedPointId = null;
    this._listeners = new Set();

    // Determine highest existing ID to avoid ID collisions
    this._nextId = this.measurements.reduce((max, m) => Math.max(max, m.id || 0), 0) + 1;
  }

  /**
   * Register a state change subscriber.
   * @param {Function} listener
   * @returns {Function} unsubscribe function
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify(changeType, detail) {
    for (const listener of this._listeners) {
      try {
        listener({ type: changeType, detail, model: this });
      } catch (err) {
        console.error('SessionModel listener error:', err);
      }
    }
  }

  get parsedAspectRatio() {
    return parseAspectRatio(this.aspectRatio);
  }

  setAspectRatio(ratioStr) {
    this.aspectRatio = String(ratioStr);
    this._notify('aspectRatio', { aspectRatio: this.aspectRatio });
  }

  setActiveBand(band) {
    const num = Number(band);
    if (OCTAVE_BANDS.includes(num)) {
      this.activeBand = num;
      this._notify('activeBand', { activeBand: this.activeBand });
    }
  }

  setSource(x, y) {
    const clampedX = Math.max(0, Math.min(1, x));
    const clampedY = Math.max(0, Math.min(1, y));
    this.source = { x: clampedX, y: clampedY };
    this._notify('source', { source: this.source });
    return this.source;
  }

  clearSource() {
    this.source = null;
    this._notify('source', { source: null });
  }

  /**
   * Add a new measurement point in 'pending' status (position only, no acoustic data).
   *
   * @param {number} x — relative [0, 1]
   * @param {number} y — relative [0, 1]
   * @returns {object} created measurement point
   */
  addPendingMeasurement(x, y) {
    const point = {
      id: this._nextId++,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      status: 'pending',
      timestamp: null,
      pnrDb: null,
      dynamicRangeDb: null,
      clipped: false,
      fake: false,
      bands: null,
    };
    this.measurements.push(point);
    this.selectedPointId = point.id;
    this._notify('measurement_added', { point });
    return point;
  }

  /**
   * Add a new measurement point with full measured data.
   *
   * @param {number} x — relative [0, 1]
   * @param {number} y — relative [0, 1]
   * @param {object} data
   * @returns {object} created measurement point
   */
  addMeasuredMeasurement(x, y, data = {}) {
    const point = {
      id: this._nextId++,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      status: 'measured',
      timestamp: data.timestamp ?? Date.now(),
      pnrDb: data.pnrDb ?? null,
      dynamicRangeDb: data.dynamicRangeDb ?? null,
      clipped: data.clipped ?? false,
      fake: data.fake ?? false,
      bands: data.bands || null,
    };
    this.measurements.push(point);
    this.selectedPointId = point.id;
    this._notify('measurement_added', { point });
    return point;
  }

  /**
   * Fill an existing pending point with fake measurement data, or create a new measured point.
   * Fulfills Requirement 2 & 4.
   *
   * @param {number} [targetId] — point id to fill; if omitted, checks selected or last pending point
   * @param {number} [fallbackX=0.5] — relative x if new point needed
   * @param {number} [fallbackY=0.5] — relative y if new point needed
   * @returns {object} updated or created measurement point
   */
  addOrFillDevMeasurement(targetId = null, fallbackX = 0.5, fallbackY = 0.5) {
    let point = null;

    if (targetId != null) {
      point = this.getMeasurement(targetId);
    } else if (this.selectedPointId != null) {
      const selected = this.getMeasurement(this.selectedPointId);
      if (selected && selected.status === 'pending') {
        point = selected;
      }
    }

    // If no candidate yet, look for the most recent pending point
    if (!point) {
      for (let i = this.measurements.length - 1; i >= 0; i--) {
        if (this.measurements[i].status === 'pending') {
          point = this.measurements[i];
          break;
        }
      }
    }

    if (point && point.status === 'pending') {
      const fakeData = generateFakeMeasurementData(point.x, point.y, point.id);
      point.status = 'measured';
      point.timestamp = fakeData.timestamp;
      point.pnrDb = fakeData.pnrDb;
      point.dynamicRangeDb = fakeData.dynamicRangeDb;
      point.clipped = fakeData.clipped;
      point.fake = true;
      point.bands = fakeData.bands;
      this.selectedPointId = point.id;
      this._notify('measurement_updated', { point });
      return point;
    }

    // Otherwise, create a new measured point with fake data
    const id = this._nextId;
    const fakeData = generateFakeMeasurementData(fallbackX, fallbackY, id);
    return this.addMeasuredMeasurement(fallbackX, fallbackY, fakeData);
  }

  getMeasurement(id) {
    return this.measurements.find((m) => m.id === id) || null;
  }

  updateMeasurementPosition(id, x, y) {
    const point = this.getMeasurement(id);
    if (!point) return null;
    point.x = Math.max(0, Math.min(1, x));
    point.y = Math.max(0, Math.min(1, y));
    this._notify('measurement_moved', { point });
    return point;
  }

  removeMeasurement(id) {
    const idx = this.measurements.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    const [removed] = this.measurements.splice(idx, 1);
    if (this.selectedPointId === id) {
      this.selectedPointId = null;
    }
    this._notify('measurement_removed', { point: removed });
    return true;
  }

  clearMeasurements() {
    this.measurements = [];
    this.selectedPointId = null;
    this._notify('measurements_cleared', {});
  }

  selectPoint(id) {
    this.selectedPointId = id;
    this._notify('point_selected', { selectedPointId: id });
  }

  /**
   * Export the complete session state.
   */
  toJSON() {
    return {
      aspectRatio: this.aspectRatio,
      source: this.source ? { ...this.source } : null,
      measurements: this.measurements.map((m) => ({
        ...m,
        bands: m.bands ? JSON.parse(JSON.stringify(m.bands)) : null,
      })),
      activeBand: this.activeBand,
    };
  }
}
