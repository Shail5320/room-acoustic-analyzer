/**
 * src/ui/app.js — Application UI orchestrator for Phase 4 Floor Plan, Dimensions & Storage.
 *
 * Connects SessionModel, FloorPlanView, StorageService, Export and DOM controls:
 *   - Aspect ratio selection (4:3 default, synchronized with dimensions)
 *   - Room dimensions panel (metres vs step counts, validation, auto-aspect sync & decouple warnings)
 *   - Storage in IndexedDB with auto-save debounce and in-memory fallback
 *   - Session lifecycle: Save, Auto-save, List, Load, Rename, Delete, Start New
 *   - Export to JSON and CSV with RFC 4180 escaping and fake-data warning
 *   - Dev-only test measurement button (fills pending points or adds measured fake points)
 *   - Reactive scrollable measurement list
 */

import { SessionModel, OCTAVE_BANDS } from './session-model.js';
import { FloorPlanView } from './floorplan.js';
import {
  ASPECT_RATIO_PRESETS,
  DEFAULT_ASPECT_RATIO,
  parseAspectRatio,
  formatAspectRatio,
} from './coordinates.js';
import {
  parseAndValidateDimensions,
  deriveAspectRatio,
  DEFAULT_STEP_LENGTH,
} from './dimensions.js';
import { StorageService } from '../store/storage.js';
import {
  toJSON,
  toCSV,
  hasFakeMeasurements,
  downloadFile,
} from '../store/export.js';
import {
  getBandTierCounts,
  formatBandTierCounts,
  computeHeatmapRange,
  getUsablePoints,
  extractPointBandValue,
  MIN_USABLE_HEATMAP_POINTS,
  HEATMAP_UNRELIABLE_MESSAGE,
} from './heatmap-math.js';
import { renderHeatmapLegendCanvas } from './heatmap.js';

export async function initApp() {
  const canvas = document.getElementById('floorplan-canvas');
  if (!canvas) return;

  const storage = new StorageService();
  const model = new SessionModel({ aspectRatio: '4:3' });
  const view = new FloorPlanView(canvas, model, { mode: 'measure' });

  // DOM Elements - Session Toolbar
  const sessionNameInput = document.getElementById('input-session-name');
  const sessionStatusEl = document.getElementById('status-session');
  const storageWarningEl = document.getElementById('storage-warning');
  const fakeWarningBanner = document.getElementById('fake-warning-banner');
  const btnSessionSave = document.getElementById('btn-session-save');
  const btnSessionNew = document.getElementById('btn-session-new');
  const btnSessionList = document.getElementById('btn-session-list');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportJson = document.getElementById('btn-export-json');

  // DOM Elements - Dimensions Panel
  const dimensionsPanel = document.getElementById('dimensions-panel');
  const dimensionsStatusBadge = document.getElementById('dimensions-status-badge');
  const btnUnitMetres = document.getElementById('btn-unit-metres');
  const btnUnitSteps = document.getElementById('btn-unit-steps');
  const stepsApproxNote = document.getElementById('steps-approx-note');
  const inputDimLength = document.getElementById('input-dim-length');
  const inputDimWidth = document.getElementById('input-dim-width');
  const inputDimHeight = document.getElementById('input-dim-height');
  const fieldDimStepLen = document.getElementById('field-dim-step-len');
  const inputDimStepLen = document.getElementById('input-dim-step-len');
  const labelDimLength = document.getElementById('label-dim-length');
  const labelDimWidth = document.getElementById('label-dim-width');
  const labelDimHeight = document.getElementById('label-dim-height');
  const dimAspectSyncNotice = document.getElementById('dim-aspect-sync-notice');
  const dimErrorMsg = document.getElementById('dim-error-msg');
  const btnApplyDimensions = document.getElementById('btn-apply-dimensions');
  const btnClearDimensions = document.getElementById('btn-clear-dimensions');

  // DOM Elements - Floor Plan & Heatmap Workspace
  const modeMeasureBtn = document.getElementById('btn-mode-measure');
  const modeSourceBtn = document.getElementById('btn-mode-source');
  const modeHeatmapBtn = document.getElementById('btn-mode-heatmap');
  const aspectRatioSelect = document.getElementById('select-aspect-ratio');
  const devAddFakeBtn = document.getElementById('btn-dev-fake');
  const bandSelectorContainer = document.getElementById('band-selector');
  const bandTierSummaryEl = document.getElementById('band-tier-summary');
  const measurementListEl = document.getElementById('measurement-list');
  const emptyListNotice = document.getElementById('empty-list-notice');
  const pointCountBadge = document.getElementById('point-count-badge');
  const clearAllBtn = document.getElementById('btn-clear-points');

  // DOM Elements - Heatmap Panel & Legend
  const heatmapCard = document.getElementById('heatmap-card');
  const heatmapDevBanner = document.getElementById('heatmap-dev-banner');
  const heatmapUnreliableBanner = document.getElementById('heatmap-unreliable-banner');
  const markerDetailCard = document.getElementById('marker-detail-card');
  const markerDetailTitle = document.getElementById('marker-detail-title');
  const markerDetailBody = document.getElementById('marker-detail-body');
  const btnCloseMarkerDetail = document.getElementById('btn-close-marker-detail');
  const btnRangeAuto = document.getElementById('btn-range-auto');
  const btnRangeFixed = document.getElementById('btn-range-fixed');
  const heatmapLegendCanvas = document.getElementById('heatmap-legend-canvas');

  // DOM Elements - Sessions Modal
  const modalSessions = document.getElementById('modal-sessions');
  const savedSessionsList = document.getElementById('saved-sessions-list');
  const savedSessionsEmpty = document.getElementById('saved-sessions-empty');
  const btnCloseSessionsModal = document.getElementById('btn-close-sessions-modal');
  const btnModalDismiss = document.getElementById('btn-modal-dismiss');

  let currentUnit = 'metres'; // 'metres' | 'steps'
  let isAspectLockedToDimensions = false;
  let currentMode = 'measure'; // 'measure' | 'source' | 'heatmap'
  let heatmapRangeMode = 'auto'; // 'auto' | 'fixed'

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------
  function setSessionStatus(text) {
    if (sessionStatusEl) sessionStatusEl.textContent = text;
  }

  function sanitizeFilename(name) {
    return (name || 'session').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  }

  function updateFakeWarningUI() {
    const isFake = hasFakeMeasurements(model);
    if (fakeWarningBanner) {
      fakeWarningBanner.hidden = !isFake;
    }
  }

  // -------------------------------------------------------------
  // Storage & Auto-save Logic
  // -------------------------------------------------------------
  let autoSaveTimeout = null;
  function scheduleAutoSave() {
    setSessionStatus('Saving...');
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(async () => {
      try {
        const saved = await storage.save(model.toJSON());
        if (!model.id) model.id = saved.id;
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setSessionStatus(`Auto-saved at ${timeStr}`);
      } catch (err) {
        console.error('Storage auto-save error:', err);
        setSessionStatus('Save error');
      }
    }, 400);
  }

  async function manualSave() {
    clearTimeout(autoSaveTimeout);
    try {
      const saved = await storage.save(model.toJSON());
      if (!model.id) model.id = saved.id;
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setSessionStatus(`Saved at ${timeStr}`);
    } catch (err) {
      console.error('Manual save error:', err);
      alert('Failed to save session: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // Aspect Ratio Dropdown Management
  // -------------------------------------------------------------
  function populateAspectRatioSelect(selectedRatio = DEFAULT_ASPECT_RATIO) {
    if (!aspectRatioSelect) return;
    aspectRatioSelect.innerHTML = '';

    const numRatio = parseAspectRatio(selectedRatio);
    let matched = false;
    for (const preset of ASPECT_RATIO_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.value;
      opt.textContent = preset.label;
      if (preset.value === selectedRatio || Math.abs(preset.ratio - numRatio) < 1e-4) {
        opt.selected = true;
        matched = true;
      }
      aspectRatioSelect.appendChild(opt);
    }

    if (!matched && numRatio) {
      const customOpt = document.createElement('option');
      customOpt.value = numRatio;
      const displayStr = formatAspectRatio(numRatio);
      customOpt.textContent = model.roomDimensions
        ? `${displayStr} (From Dimensions)`
        : `${displayStr}`;
      customOpt.selected = true;
      aspectRatioSelect.appendChild(customOpt);
    }
  }

  if (aspectRatioSelect) {
    aspectRatioSelect.addEventListener('change', (e) => {
      const newRatio = e.target.value;

      if (model.roomDimensions) {
        const confirmed = window.confirm(
          'Room aspect ratio is currently derived from room dimensions.\n\nChanging aspect ratio manually will decouple it from the dimensions and clear room dimensions. Proceed?'
        );
        if (confirmed) {
          model.clearRoomDimensions();
          syncDimensionsUIFromModel();
          model.setAspectRatio(newRatio);
        } else {
          // Revert selection
          aspectRatioSelect.value = model.aspectRatio;
          return;
        }
      } else {
        model.setAspectRatio(newRatio);
      }
    });
  }

  // -------------------------------------------------------------
  // Room Dimensions UI & Logic
  // -------------------------------------------------------------
  function setUnit(unit) {
    currentUnit = unit;
    if (unit === 'steps') {
      btnUnitSteps.classList.add('active');
      btnUnitSteps.setAttribute('aria-pressed', 'true');
      btnUnitMetres.classList.remove('active');
      btnUnitMetres.setAttribute('aria-pressed', 'false');
      if (fieldDimStepLen) fieldDimStepLen.hidden = false;
      if (stepsApproxNote) stepsApproxNote.hidden = false;
      if (labelDimLength) labelDimLength.textContent = 'Length (steps)';
      if (labelDimWidth) labelDimWidth.textContent = 'Width (steps)';
      if (labelDimHeight) labelDimHeight.textContent = 'Height (steps)';
    } else {
      btnUnitMetres.classList.add('active');
      btnUnitMetres.setAttribute('aria-pressed', 'true');
      btnUnitSteps.classList.remove('active');
      btnUnitSteps.setAttribute('aria-pressed', 'false');
      if (fieldDimStepLen) fieldDimStepLen.hidden = true;
      if (stepsApproxNote) stepsApproxNote.hidden = true;
      if (labelDimLength) labelDimLength.textContent = 'Length (m)';
      if (labelDimWidth) labelDimWidth.textContent = 'Width (m)';
      if (labelDimHeight) labelDimHeight.textContent = 'Height (m)';
    }
  }

  if (btnUnitMetres) btnUnitMetres.addEventListener('click', () => setUnit('metres'));
  if (btnUnitSteps) btnUnitSteps.addEventListener('click', () => setUnit('steps'));

  function syncDimensionsUIFromModel() {
    const dims = model.roomDimensions;
    if (!dims) {
      if (dimensionsStatusBadge) {
        dimensionsStatusBadge.textContent = 'Not set';
        dimensionsStatusBadge.classList.remove('active');
      }
      if (dimAspectSyncNotice) dimAspectSyncNotice.hidden = true;
      if (dimErrorMsg) dimErrorMsg.hidden = true;
      if (inputDimLength) inputDimLength.value = '';
      if (inputDimWidth) inputDimWidth.value = '';
      if (inputDimHeight) inputDimHeight.value = '';
      if (inputDimStepLen) inputDimStepLen.value = String(DEFAULT_STEP_LENGTH);
      setUnit('metres');
      isAspectLockedToDimensions = false;
      return;
    }

    setUnit(dims.unit || 'metres');
    if (inputDimLength) inputDimLength.value = dims.rawLength ?? dims.lengthM;
    if (inputDimWidth) inputDimWidth.value = dims.rawWidth ?? dims.widthM;
    if (inputDimHeight) inputDimHeight.value = dims.rawHeight ?? dims.heightM;
    if (inputDimStepLen && dims.stepLength) inputDimStepLen.value = String(dims.stepLength);

    if (dimensionsStatusBadge) {
      const approxTag = dims.isApproximate ? ' (~approx)' : '';
      dimensionsStatusBadge.textContent = `${dims.lengthM}m × ${dims.widthM}m × ${dims.heightM}m${approxTag}`;
      dimensionsStatusBadge.classList.add('active');
    }

    const derived = deriveAspectRatio(dims.lengthM, dims.widthM);
    if (derived && dimAspectSyncNotice) {
      dimAspectSyncNotice.hidden = false;
      const approxStr = dims.isApproximate ? ' (approximate from steps)' : '';
      dimAspectSyncNotice.textContent = `Floor-plan aspect ratio is set to ${derived.ratioStr} from room dimensions${approxStr}.`;
    }

    isAspectLockedToDimensions = true;
  }

  if (btnApplyDimensions) {
    btnApplyDimensions.addEventListener('click', () => {
      if (dimErrorMsg) dimErrorMsg.hidden = true;

      const rawL = inputDimLength ? inputDimLength.value : '';
      const rawW = inputDimWidth ? inputDimWidth.value : '';
      const rawH = inputDimHeight ? inputDimHeight.value : '';
      const stepLen = inputDimStepLen ? inputDimStepLen.value : DEFAULT_STEP_LENGTH;

      const parsed = parseAndValidateDimensions({
        length: rawL,
        width: rawW,
        height: rawH,
        unit: currentUnit,
        stepLength: stepLen,
      });

      if (!parsed.valid) {
        if (dimErrorMsg) {
          dimErrorMsg.hidden = false;
          dimErrorMsg.textContent = parsed.errors.join('. ');
        }
        return;
      }

      model.setRoomDimensions(parsed.dimensions);

      // Derive aspect ratio and update model & select
      const derived = deriveAspectRatio(parsed.dimensions.lengthM, parsed.dimensions.widthM);
      if (derived) {
        model.setAspectRatio(derived.ratio);
        populateAspectRatioSelect(derived.ratio);
      }

      syncDimensionsUIFromModel();
    });
  }

  if (btnClearDimensions) {
    btnClearDimensions.addEventListener('click', () => {
      model.clearRoomDimensions();
      syncDimensionsUIFromModel();
    });
  }

  // -------------------------------------------------------------
  // Mode Switchers
  // -------------------------------------------------------------
  function updateModeButtons(activeMode) {
    currentMode = activeMode;
    const items = [
      { btn: modeMeasureBtn, mode: 'measure' },
      { btn: modeSourceBtn, mode: 'source' },
      { btn: modeHeatmapBtn, mode: 'heatmap' },
    ];
    for (const item of items) {
      if (!item.btn) continue;
      const isActive = item.mode === activeMode;
      item.btn.classList.toggle('active', isActive);
      item.btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }

    if (heatmapCard) {
      heatmapCard.hidden = activeMode !== 'heatmap';
    }

    view.setMode(activeMode);
    if (activeMode === 'heatmap') {
      updateHeatmapUI();
    }
  }

  if (modeMeasureBtn) {
    modeMeasureBtn.addEventListener('click', () => updateModeButtons('measure'));
  }

  if (modeSourceBtn) {
    modeSourceBtn.addEventListener('click', () => updateModeButtons('source'));
  }

  if (modeHeatmapBtn) {
    modeHeatmapBtn.addEventListener('click', () => updateModeButtons('heatmap'));
  }

  // -------------------------------------------------------------
  // Heatmap Range Controls & Inspector
  // -------------------------------------------------------------
  if (btnRangeAuto) {
    btnRangeAuto.addEventListener('click', () => {
      heatmapRangeMode = 'auto';
      btnRangeAuto.classList.add('active');
      btnRangeAuto.setAttribute('aria-pressed', 'true');
      if (btnRangeFixed) {
        btnRangeFixed.classList.remove('active');
        btnRangeFixed.setAttribute('aria-pressed', 'false');
      }
      view.setHeatmapRangeMode('auto');
      updateHeatmapUI();
    });
  }

  if (btnRangeFixed) {
    btnRangeFixed.addEventListener('click', () => {
      heatmapRangeMode = 'fixed';
      btnRangeFixed.classList.add('active');
      btnRangeFixed.setAttribute('aria-pressed', 'true');
      if (btnRangeAuto) {
        btnRangeAuto.classList.remove('active');
        btnRangeAuto.setAttribute('aria-pressed', 'false');
      }
      view.setHeatmapRangeMode('fixed');
      updateHeatmapUI();
    });
  }

  if (btnCloseMarkerDetail) {
    btnCloseMarkerDetail.addEventListener('click', () => {
      model.selectPoint(null);
    });
  }

  function updateHeatmapUI() {
    const activeBand = model.activeBand;
    const usablePoints = getUsablePoints(model.measurements, activeBand);
    const range = computeHeatmapRange(usablePoints, heatmapRangeMode);
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    // Render legend color bar
    if (heatmapLegendCanvas) {
      renderHeatmapLegendCanvas(heatmapLegendCanvas, range, isDark);
    }

    // Honest messaging: < 4 points shows warning
    const isReliable = usablePoints.length >= MIN_USABLE_HEATMAP_POINTS;
    if (heatmapUnreliableBanner) {
      heatmapUnreliableBanner.hidden = isReliable || usablePoints.length === 0;
    }

    // DEV DATA banner
    const hasFake = usablePoints.some((p) => p.fake === true);
    if (heatmapDevBanner) {
      heatmapDevBanner.hidden = !hasFake;
    }

    // Marker detail inspector
    if (markerDetailCard && markerDetailBody && markerDetailTitle) {
      if (model.selectedPointId !== null) {
        const m = model.getMeasurement(model.selectedPointId);
        if (m) {
          const bandInfo = extractPointBandValue(m, activeBand);
          const isPending = m.status === 'pending';
          markerDetailTitle.textContent = `Point #${m.id} Details (${activeBand} Hz)`;

          let valDisplay = '—';
          if (!isPending && bandInfo.usable) {
            valDisplay = `${bandInfo.value.toFixed(3)} s`;
          } else if (!isPending) {
            valDisplay = 'Invalid';
          }

          let tierBadge = `<span class="badge tier-${bandInfo.tier}">${bandInfo.tier}</span>`;
          if (isPending) {
            tierBadge = `<span class="badge tier-pending">Pending</span>`;
          }

          markerDetailBody.innerHTML = `
            <div class="marker-detail-item">
              <span class="marker-detail-label">Position (rel)</span>
              <span class="marker-detail-val">x: ${m.x.toFixed(3)}, y: ${m.y.toFixed(3)}</span>
            </div>
            <div class="marker-detail-item">
              <span class="marker-detail-label">RT60 Value</span>
              <span class="marker-detail-val">${valDisplay}</span>
            </div>
            <div class="marker-detail-item">
              <span class="marker-detail-label">Validity Tier</span>
              <span class="marker-detail-val">${tierBadge}</span>
            </div>
            <div class="marker-detail-item">
              <span class="marker-detail-label">Metric Used</span>
              <span class="marker-detail-val">${bandInfo.metric || 'none'}</span>
            </div>
            ${m.fake ? '<div class="marker-detail-item"><span class="marker-detail-label">Source</span><span class="marker-detail-val" style="color: #ea580c; font-weight:700;">Simulated [DEV]</span></div>' : ''}
          `;
          markerDetailCard.hidden = false;
        } else {
          markerDetailCard.hidden = true;
        }
      } else {
        markerDetailCard.hidden = true;
      }
    }
  }

  // -------------------------------------------------------------
  // Octave Band Selector Buttons
  // -------------------------------------------------------------
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
      const counts = getBandTierCounts(model.measurements, b);
      btn.title = `${b} Hz: ${formatBandTierCounts(counts)}`;
      if (b === activeBand) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
      }
    });

    if (bandTierSummaryEl) {
      const currentCounts = getBandTierCounts(model.measurements, activeBand);
      bandTierSummaryEl.textContent = `${activeBand} Hz: ${formatBandTierCounts(currentCounts)}`;
    }
  }

  // -------------------------------------------------------------
  // Dev-Only "Add test measurement" button
  // -------------------------------------------------------------
  if (devAddFakeBtn) {
    devAddFakeBtn.addEventListener('click', () => {
      const pt = model.addOrFillDevMeasurement();
      if (pt) {
        setTimeout(() => {
          const itemEl = document.querySelector(`[data-point-id="${pt.id}"]`);
          if (itemEl) itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    });
  }

  // -------------------------------------------------------------
  // Clear all measurement points
  // -------------------------------------------------------------
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      if (model.measurements.length === 0) return;
      if (window.confirm('Clear all measurement points?')) {
        model.clearMeasurements();
      }
    });
  }

  // -------------------------------------------------------------
  // Render Measurement List
  // -------------------------------------------------------------
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
    const dims = model.roomDimensions;

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

      // Metric position label if dimensions exist
      let posText = `Pos: (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`;
      if (dims && Number.isFinite(dims.lengthM) && Number.isFinite(dims.widthM)) {
        const xM = (m.x * dims.lengthM).toFixed(2);
        const yM = (m.y * dims.widthM).toFixed(2);
        const approxTilde = dims.isApproximate ? '~' : '';
        posText = `Pos: ${approxTilde}${xM}m, ${approxTilde}${yM}m (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`;
      }

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
            <span class="coord-label">${posText}</span>
            <span class="rt60-label">RT60 (${activeBand} Hz): <strong>${rt60Text}</strong></span>
          </div>
        </div>
        <button class="btn-delete-point" data-delete-id="${m.id}" title="Remove Point ${m.id}" aria-label="Delete point ${m.id}">
          ✕
        </button>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-point')) return;
        model.selectPoint(m.id);
      });

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

  // -------------------------------------------------------------
  // Sessions Modal Operations
  // -------------------------------------------------------------
  async function renderSessionsModal() {
    if (!savedSessionsList) return;
    savedSessionsList.innerHTML = '';

    try {
      const list = await storage.list();
      if (!list || list.length === 0) {
        if (savedSessionsEmpty) savedSessionsEmpty.hidden = false;
        return;
      }
      if (savedSessionsEmpty) savedSessionsEmpty.hidden = true;

      for (const s of list) {
        const li = document.createElement('li');
        li.className = 'session-item';

        const updatedDate = s.updated ? new Date(s.updated).toLocaleDateString() : '';
        const updatedTime = s.updated ? new Date(s.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const isCurrent = model.id === s.id;

        li.innerHTML = `
          <div class="session-item-info">
            <div class="session-item-name">${s.name || 'Untitled Session'}${isCurrent ? ' (Current)' : ''}</div>
            <div class="session-item-meta">
              <span>Points: ${s.pointCount}</span>
              <span>Ratio: ${formatAspectRatio(s.aspectRatio)}</span>
              <span>${s.hasDimensions ? '📐 Dims' : 'No Dims'}</span>
              <span>Updated: ${updatedDate} ${updatedTime}</span>
            </div>
          </div>
          <div class="session-item-actions">
            <button class="btn btn-secondary btn-sm btn-session-rename" data-id="${s.id}" type="button">Rename</button>
            <button class="btn btn-primary btn-sm btn-session-load" data-id="${s.id}" type="button">Load</button>
            <button class="btn btn-outline btn-sm btn-session-delete" data-id="${s.id}" type="button">Delete</button>
          </div>
        `;

        // Load button
        const loadBtn = li.querySelector('.btn-session-load');
        loadBtn.addEventListener('click', async () => {
          const sessionData = await storage.get(s.id);
          if (sessionData) {
            model.loadSession(sessionData);
            if (sessionNameInput) sessionNameInput.value = model.name;
            populateAspectRatioSelect(model.aspectRatio);
            syncDimensionsUIFromModel();
            updateFakeWarningUI();
            setSessionStatus('Loaded session');
            closeSessionsModal();
          }
        });

        // Rename button
        const renameBtn = li.querySelector('.btn-session-rename');
        renameBtn.addEventListener('click', async () => {
          const newName = window.prompt('Rename session:', s.name);
          if (newName && newName.trim()) {
            await storage.rename(s.id, newName.trim());
            if (model.id === s.id) {
              model.setName(newName.trim());
              if (sessionNameInput) sessionNameInput.value = newName.trim();
            }
            renderSessionsModal();
          }
        });

        // Delete button
        const delBtn = li.querySelector('.btn-session-delete');
        delBtn.addEventListener('click', async () => {
          const confirmed = window.confirm(`Delete session "${s.name}"? This cannot be undone.`);
          if (confirmed) {
            await storage.delete(s.id);
            if (model.id === s.id) {
              // Start a blank session
              const blank = storage.createBlankSession('Untitled Session');
              model.loadSession(blank);
              if (sessionNameInput) sessionNameInput.value = model.name;
              populateAspectRatioSelect(model.aspectRatio);
              syncDimensionsUIFromModel();
              updateFakeWarningUI();
            }
            renderSessionsModal();
          }
        });

        savedSessionsList.appendChild(li);
      }
    } catch (err) {
      console.error('Failed to list sessions:', err);
    }
  }

  function openSessionsModal() {
    if (modalSessions) {
      modalSessions.hidden = false;
      renderSessionsModal();
    }
  }

  function closeSessionsModal() {
    if (modalSessions) {
      modalSessions.hidden = true;
    }
  }

  if (btnSessionList) btnSessionList.addEventListener('click', openSessionsModal);
  if (btnCloseSessionsModal) btnCloseSessionsModal.addEventListener('click', closeSessionsModal);
  if (btnModalDismiss) btnModalDismiss.addEventListener('click', closeSessionsModal);

  // -------------------------------------------------------------
  // Session Name Input & Actions
  // -------------------------------------------------------------
  if (sessionNameInput) {
    sessionNameInput.addEventListener('input', (e) => {
      model.setName(e.target.value);
    });
  }

  if (btnSessionSave) {
    btnSessionSave.addEventListener('click', manualSave);
  }

  if (btnSessionNew) {
    btnSessionNew.addEventListener('click', async () => {
      if (model.measurements.length > 0) {
        const proceed = window.confirm('Start a new session? Unsaved changes will be replaced.');
        if (!proceed) return;
      }
      const blank = storage.createBlankSession('Untitled Session');
      model.loadSession(blank);
      if (sessionNameInput) sessionNameInput.value = model.name;
      populateAspectRatioSelect(model.aspectRatio);
      syncDimensionsUIFromModel();
      updateFakeWarningUI();
      await storage.save(model.toJSON());
      setSessionStatus('New session started');
    });
  }

  // -------------------------------------------------------------
  // Export Handlers
  // -------------------------------------------------------------
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      if (hasFakeMeasurements(model)) {
        const proceed = window.confirm(
          '⚠️ Warning: This session contains simulated DEV test measurements (fake: true).\n\nThe exported CSV will include simulated test data. Do you want to proceed?'
        );
        if (!proceed) return;
      }
      const csvContent = toCSV(model.toJSON());
      const filename = `${sanitizeFilename(model.name)}.csv`;
      downloadFile(csvContent, filename, 'text/csv;charset=utf-8');
    });
  }

  if (btnExportJson) {
    btnExportJson.addEventListener('click', () => {
      if (hasFakeMeasurements(model)) {
        const proceed = window.confirm(
          '⚠️ Warning: This session contains simulated DEV test measurements (fake: true).\n\nThe exported JSON will include simulated test data. Do you want to proceed?'
        );
        if (!proceed) return;
      }
      const jsonContent = toJSON(model.toJSON());
      const filename = `${sanitizeFilename(model.name)}.json`;
      downloadFile(jsonContent, filename, 'application/json;charset=utf-8');
    });
  }

  // -------------------------------------------------------------
  // Subscribe to Model Updates
  // -------------------------------------------------------------
  model.subscribe(({ type }) => {
    if (type === 'activeBand') {
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
    } else if (type === 'point_selected') {
      updateHeatmapUI();
      renderMeasurementList();
    } else if (type === 'session_loaded') {
      updateFakeWarningUI();
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
    } else {
      updateFakeWarningUI();
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
      scheduleAutoSave();
    }
  });

  window.addEventListener('resize', () => {
    if (currentMode === 'heatmap') {
      updateHeatmapUI();
    }
  });

  // -------------------------------------------------------------
  // Storage Initialization & Initial Session Restoration
  // -------------------------------------------------------------
  try {
    const warning = storage.getWarningMessage();
    if (warning && storageWarningEl) {
      storageWarningEl.hidden = false;
      storageWarningEl.textContent = warning;
    }

    const sessions = await storage.list();
    if (sessions && sessions.length > 0) {
      const latest = await storage.get(sessions[0].id);
      if (latest) {
        model.loadSession(latest);
        if (sessionNameInput) sessionNameInput.value = model.name;
        populateAspectRatioSelect(model.aspectRatio);
        syncDimensionsUIFromModel();
      }
    } else {
      // First run: save blank session
      populateAspectRatioSelect('4:3');
      const saved = await storage.save(model.toJSON());
      model.id = saved.id;
    }
  } catch (err) {
    console.error('Storage initialization failed:', err);
    populateAspectRatioSelect('4:3');
  }

  // Initial UI Render
  updateBandSelectorUI(model.activeBand);
  updateModeButtons('measure');
  renderMeasurementList();
  updateFakeWarningUI();
  updateHeatmapUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
