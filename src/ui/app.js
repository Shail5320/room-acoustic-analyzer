/**
 * src/ui/app.js — Application UI orchestrator for Phase 4a Floor Plan.
 *
 * Connects SessionModel, FloorPlanView, and DOM controls:
 *   - Aspect ratio selection (4:3 default, stored in session)
 *   - Mode switching (Place/Move Measurement vs Move Source)
 *   - Octave band selection for RT60 inspection (125 Hz - 4000 Hz)
 *   - Dev-only test measurement button: fills pending points or adds measured fake points
 *   - Reactive scrollable measurement list
 */

import { SessionModel, OCTAVE_BANDS } from './session-model.js';
import { FloorPlanView } from './floorplan.js';
import { ASPECT_RATIO_PRESETS } from './coordinates.js';

export function initApp() {
  const canvas = document.getElementById('floorplan-canvas');
  if (!canvas) return;

  const model = new SessionModel({ aspectRatio: '4:3' });
  const view = new FloorPlanView(canvas, model, { mode: 'measure' });

  // DOM Elements
  const modeMeasureBtn = document.getElementById('btn-mode-measure');
  const modeSourceBtn = document.getElementById('btn-mode-source');
  const aspectRatioSelect = document.getElementById('select-aspect-ratio');
  const devAddFakeBtn = document.getElementById('btn-dev-fake');
  const bandSelectorContainer = document.getElementById('band-selector');
  const measurementListEl = document.getElementById('measurement-list');
  const emptyListNotice = document.getElementById('empty-list-notice');
  const pointCountBadge = document.getElementById('point-count-badge');
  const clearAllBtn = document.getElementById('btn-clear-points');

  // Populate Aspect Ratio select options
  if (aspectRatioSelect) {
    aspectRatioSelect.innerHTML = '';
    for (const preset of ASPECT_RATIO_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.value;
      opt.textContent = preset.label;
      if (preset.value === '4:3') opt.selected = true;
      aspectRatioSelect.appendChild(opt);
    }

    aspectRatioSelect.addEventListener('change', (e) => {
      model.setAspectRatio(e.target.value);
    });
  }

  // Mode Switchers
  function updateModeButtons(activeMode) {
    if (modeMeasureBtn && modeSourceBtn) {
      if (activeMode === 'measure') {
        modeMeasureBtn.classList.add('active');
        modeMeasureBtn.setAttribute('aria-pressed', 'true');
        modeSourceBtn.classList.remove('active');
        modeSourceBtn.setAttribute('aria-pressed', 'false');
      } else {
        modeSourceBtn.classList.add('active');
        modeSourceBtn.setAttribute('aria-pressed', 'true');
        modeMeasureBtn.classList.remove('active');
        modeMeasureBtn.setAttribute('aria-pressed', 'false');
      }
    }
  }

  if (modeMeasureBtn) {
    modeMeasureBtn.addEventListener('click', () => {
      view.setMode('measure');
      updateModeButtons('measure');
    });
  }

  if (modeSourceBtn) {
    modeSourceBtn.addEventListener('click', () => {
      view.setMode('source');
      updateModeButtons('source');
    });
  }

  // Octave Band Selector Buttons
  if (bandSelectorContainer) {
    bandSelectorContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-band]');
      if (!btn) return;
      const band = Number(btn.getAttribute('data-band'));
      model.setActiveBand(band);
    });
  }

  function updateBandSelectorUI(activeBand) {
    if (!bandSelectorContainer) return;
    const buttons = bandSelectorContainer.querySelectorAll('button[data-band]');
    buttons.forEach((btn) => {
      const b = Number(btn.getAttribute('data-band'));
      if (b === activeBand) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
      }
    });
  }

  // Dev-Only "Add test measurement" button
  if (devAddFakeBtn) {
    devAddFakeBtn.addEventListener('click', () => {
      // Fills pending point or adds a new measured point with fake data
      const pt = model.addOrFillDevMeasurement();
      if (pt) {
        // Scroll the list item into view
        setTimeout(() => {
          const itemEl = document.querySelector(`[data-point-id="${pt.id}"]`);
          if (itemEl) itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    });
  }

  // Clear all measurement points
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      if (model.measurements.length === 0) return;
      if (window.confirm('Clear all measurement points?')) {
        model.clearMeasurements();
      }
    });
  }

  // Render Measurement List
  function renderMeasurementList() {
    if (!measurementListEl) return;

    const count = model.measurements.length;
    if (pointCountBadge) {
      pointCountBadge.textContent = `${count} ${count === 1 ? 'point' : 'points'}`;
    }

    if (count === 0) {
      if (emptyListNotice) emptyListNotice.style.display = 'block';
      measurementListEl.innerHTML = '';
      return;
    }

    if (emptyListNotice) emptyListNotice.style.display = 'none';
    measurementListEl.innerHTML = '';

    const activeBand = model.activeBand;

    for (const m of model.measurements) {
      const item = document.createElement('li');
      item.className = 'measurement-card';
      item.setAttribute('data-point-id', String(m.id));
      if (m.id === model.selectedPointId) {
        item.classList.add('selected');
      }

      const isPending = m.status === 'pending';
      const bandData = !isPending && m.bands ? m.bands[activeBand] : null;

      let tierBadgeHtml = '';
      let rt60Text = '—';
      let tierClass = 'tier-pending';

      if (isPending) {
        tierBadgeHtml = '<span class="badge tier-pending">Pending</span>';
      } else if (bandData) {
        tierClass = `tier-${bandData.tier}`;
        const tierLabel = bandData.tier.charAt(0).toUpperCase() + bandData.tier.slice(1);
        tierBadgeHtml = `<span class="badge ${tierClass}">${tierLabel}</span>`;
        if (Number.isFinite(bandData.rt60)) {
          rt60Text = `${bandData.rt60.toFixed(3)} s (${bandData.used})`;
        } else {
          rt60Text = 'Invalid';
        }
      }

      const devBadgeHtml = m.fake ? '<span class="badge badge-dev">DEV</span>' : '';

      item.innerHTML = `
        <div class="card-main">
          <div class="card-header">
            <span class="point-number">Point ${m.id}</span>
            <div class="badge-group">
              ${devBadgeHtml}
              ${tierBadgeHtml}
            </div>
          </div>
          <div class="card-details">
            <span class="coord-label">Pos: (${m.x.toFixed(2)}, ${m.y.toFixed(2)})</span>
            <span class="rt60-label">RT60 (${activeBand} Hz): <strong>${rt60Text}</strong></span>
          </div>
        </div>
        <button class="btn-delete-point" data-delete-id="${m.id}" title="Remove Point ${m.id}" aria-label="Delete point ${m.id}">
          ✕
        </button>
      `;

      // Click card to select
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-point')) return;
        model.selectPoint(m.id);
      });

      // Delete button
      const delBtn = item.querySelector('.btn-delete-point');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          model.removeMeasurement(m.id);
        });
      }

      measurementListEl.appendChild(item);
    }
  }

  // Subscribe to Model Updates
  model.subscribe(({ type }) => {
    if (type === 'activeBand') {
      updateBandSelectorUI(model.activeBand);
      renderMeasurementList();
    } else {
      renderMeasurementList();
    }
  });

  // Initial render
  updateBandSelectorUI(model.activeBand);
  updateModeButtons('measure');
  renderMeasurementList();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
