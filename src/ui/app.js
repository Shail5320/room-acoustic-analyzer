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
import { loadAudioFile } from '../audio/wav.js';
import { downloadSweepWav } from '../audio/sweep-wav.js';
import { runSelfTest } from '../analysis/selftest.js';
import { interpolateUncertainty } from '../analysis/uncertainty.js';
import { formatDecibels, formatAudioErrorMessage, formatTimeAgo, formatDiagnosticsHtml } from './format.js';
import { HELP_TOPICS } from './help.js';
import {
  aggregateSessionBands,
  calculateBandTreatment,
  computeTreatmentHeadline,
  evaluateHotspot,
  LOW_FREQ_CAVEAT,
  HOTSPOT_UNIFORM_MESSAGE,
  HOTSPOT_CAPTION,
  SPEECH_MUSIC_BANDS,
} from '../analysis/treatment.js';
import { roomGeometry } from '../dsp/sabine.js';

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
  const btnToggleCanvasTable = document.getElementById('btn-toggle-canvas-table');
  const floorplanCanvasContainer = document.getElementById('floorplan-canvas-container');
  const floorplanTableContainer = document.getElementById('floorplan-table-container');
  const floorplanTableTbody = document.getElementById('floorplan-table-tbody');
  const bandSelectorContainer = document.getElementById('band-selector');
  const bandTierSummaryEl = document.getElementById('band-tier-summary');
  const measurementListEl = document.getElementById('measurement-list');
  const emptyListNotice = document.getElementById('empty-list-notice');
  const pointCountBadge = document.getElementById('point-count-badge');
  const clearAllBtn = document.getElementById('btn-clear-points');

  // DOM Elements - Backup Prompt
  const btnQuickBackup = document.getElementById('btn-quick-backup');
  const backupLastTimeEl = document.getElementById('backup-last-time');

  // DOM Elements - Heatmap Panel & Legend
  const heatmapCard = document.getElementById('heatmap-card');
  const heatmapDevBanner = document.getElementById('heatmap-dev-banner');
  const heatmapLowConfidenceBanner = document.getElementById('heatmap-low-confidence-banner');
  const heatmapUnreliableBanner = document.getElementById('heatmap-unreliable-banner');
  const checkHeatmapIncludeLowConfidence = document.getElementById('check-heatmap-include-low-confidence');
  const markerDetailCard = document.getElementById('marker-detail-card');
  const markerDetailTitle = document.getElementById('marker-detail-title');
  const markerDetailBody = document.getElementById('marker-detail-body');
  const btnCloseMarkerDetail = document.getElementById('btn-close-marker-detail');
  const btnRangeAuto = document.getElementById('btn-range-auto');
  const btnRangeFixed = document.getElementById('btn-range-fixed');
  const heatmapLegendCanvas = document.getElementById('heatmap-legend-canvas');

  // DOM Elements - Modals & Guides
  const modalSessions = document.getElementById('modal-sessions');
  const savedSessionsList = document.getElementById('saved-sessions-list');
  const savedSessionsEmpty = document.getElementById('saved-sessions-empty');
  const btnCloseSessionsModal = document.getElementById('btn-close-sessions-modal');
  const btnModalDismiss = document.getElementById('btn-modal-dismiss');
  const btnOpenHelp = document.getElementById('btn-open-help');
  const modalHelp = document.getElementById('modal-help');
  const btnCloseHelpModal = document.getElementById('btn-close-help-modal');
  const btnModalHelpDismiss = document.getElementById('btn-modal-help-dismiss');
  const modalHelpBody = document.getElementById('modal-help-body');

  // DOM Elements - Phase 3a Analysis & Simulation Card
  const btnDownloadSweep = document.getElementById('btn-download-sweep');
  const inputAudioFile = document.getElementById('input-audio-file');
  const selectedFileNameEl = document.getElementById('selected-file-name');
  const sliderSelftestRt60 = document.getElementById('slider-selftest-rt60');
  const selftestRtVal = document.getElementById('selftest-rt-val');
  const sliderSelftestNoise = document.getElementById('slider-selftest-noise');
  const selftestNoiseVal = document.getElementById('selftest-noise-val');
  const btnRunSelftest = document.getElementById('btn-run-selftest');
  const analyzeProgressContainer = document.getElementById('analyze-progress-container');
  const analyzeProgressBar = document.getElementById('analyze-progress-bar');
  const analyzeProgressMessage = document.getElementById('analyze-progress-message');
  const analyzeExecutionMode = document.getElementById('analyze-execution-mode');
  const analysisLiveAnnouncer = document.getElementById('analysis-live-announcer');
  const analyzeRejectCard = document.getElementById('analyze-reject-card');
  const analyzeRejectReason = document.getElementById('analyze-reject-reason');
  const analyzeRejectAdvice = document.getElementById('analyze-reject-advice');
  const rejectDetailsContent = document.getElementById('reject-details-content');
  const analyzeOverrideRow = document.getElementById('analyze-override-row');
  const btnOverrideLowPnr = document.getElementById('btn-override-low-pnr');
  const analyzeResultsContainer = document.getElementById('analyze-results-container');
  const resultsDetailsContent = document.getElementById('results-details-content');
  const badgeSimulated = document.getElementById('badge-simulated');
  const badgeClipped = document.getElementById('badge-clipped');
  const badgeTruncated = document.getElementById('badge-truncated');
  const badgeLowConfidence = document.getElementById('badge-low-confidence');
  const analyzeAudioInfo = document.getElementById('analyze-audio-info');
  const valPnr = document.getElementById('val-pnr');
  const valDr = document.getElementById('val-dr');
  const canvasIrPlot = document.getElementById('canvas-ir-plot');
  const canvasEdcPlot = document.getElementById('canvas-edc-plot');
  const analyzeBandsTbody = document.getElementById('analyze-bands-tbody');
  const selectAttachPoint = document.getElementById('select-attach-point');
  const btnAttachToPoint = document.getElementById('btn-attach-to-point');
  const attachSuccessMsg = document.getElementById('attach-success-msg');

  // DOM Elements - Phase 6 Treatment Calculator
  const treatmentDataStatusEl = document.getElementById('treatment-data-status');
  const checkIncludeSimulated = document.getElementById('check-include-simulated');
  const treatmentSimulatedBanner = document.getElementById('treatment-simulated-banner');
  const checkIncludeLowConfidence = document.getElementById('check-include-low-confidence');
  const treatmentLowConfidenceBanner = document.getElementById('treatment-low-confidence-banner');
  const selectTargetPreset = document.getElementById('select-target-preset');
  const btnTargetModePreset = document.getElementById('btn-target-mode-preset');
  const btnTargetModeManual = document.getElementById('btn-target-mode-manual');
  const targetPresetSourceText = document.getElementById('target-preset-source-text');
  const targetManualContainer = document.getElementById('target-manual-container');
  const checkPerBandTargets = document.getElementById('check-per-band-targets');
  const singleTargetRow = document.getElementById('single-target-row');
  const inputManualTargetAll = document.getElementById('input-manual-target-all');
  const perBandTargetsGrid = document.getElementById('per-band-targets-grid');
  const selectMaterial = document.getElementById('select-material');
  const inputExistingAlpha = document.getElementById('input-existing-alpha');
  const materialNoticeBanner = document.getElementById('material-notice-banner');
  const customMaterialContainer = document.getElementById('custom-material-container');
  const inputCustomMatSource = document.getElementById('input-custom-mat-source');
  const alertTargetMet = document.getElementById('alert-target-met');
  const alertAlphaIneffective = document.getElementById('alert-alpha-ineffective');
  const alertAreaExceeded = document.getElementById('alert-area-exceeded');
  const treatmentPrimaryTbody = document.getElementById('treatment-primary-tbody');
  const treatmentPhysicalSection = document.getElementById('treatment-physical-section');
  const treatmentPhysicalTbody = document.getElementById('treatment-physical-tbody');
  const treatmentNoDimPrompt = document.getElementById('treatment-no-dim-prompt');
  const treatmentHeadlineBox = document.getElementById('treatment-headline-box');
  const treatmentHeadlineVal = document.getElementById('treatment-headline-val');
  const treatmentHeadlineRange = document.getElementById('treatment-headline-range');
  const treatmentHeadlineUncertainty = document.getElementById('treatment-headline-uncertainty');
  const textLowFreqCaveat = document.getElementById('text-low-freq-caveat');
  const btnToggleHotspot = document.getElementById('btn-toggle-hotspot');
  const heatmapHotspotCaption = document.getElementById('heatmap-hotspot-caption');

  let currentUnit = 'metres'; // 'metres' | 'steps'
  let isAspectLockedToDimensions = false;
  let currentMode = 'measure'; // 'measure' | 'source' | 'heatmap'
  let heatmapRangeMode = 'auto'; // 'auto' | 'fixed'
  let placementHintActive = false;

  // Analysis State
  let currentAnalysisResult = null;
  let currentAudioContext = null;
  let lastLoadedAudio = null;

  // Uncertainty & Scatter by Octave Band (Derived from 30-seed Monte Carlo Study)
  const DEFAULT_UNCERTAINTY_PCT = {
    125: 11,
    250: 8,
    500: 6,
    1000: 4,
    2000: 3,
    4000: 2,
  };
  let typicalUncertaintyPct = { ...DEFAULT_UNCERTAINTY_PCT };
  let uncertaintyData = null;

  // Phase 6 Treatment State
  let includeSimulatedTreatment = false;
  let includeLowConfidenceTreatment = false;
  let includeLowConfidenceHeatmap = false;
  let targetMode = 'preset'; // 'preset' | 'manual'
  let selectedPresetId = 'small_control_room';
  let manualTargetAll = 0.40;
  let manualPerBandTargets = { 125: 0.40, 250: 0.35, 500: 0.35, 1000: 0.35, 2000: 0.35, 4000: 0.35 };
  let isCustomPerBandTarget = false;
  let selectedMaterialId = 'fiberglass_50mm';
  let existingAlpha = 0.05;
  let customMaterial = {
    id: 'custom',
    name: 'Custom Material (User-Entered)',
    placeholder: false,
    source: 'User-entered custom material',
    alpha: { 125: 0.20, 250: 0.50, 500: 0.80, 1000: 0.85, 2000: 0.85, 4000: 0.80 },
  };

  const FALLBACK_TARGET_PRESETS = [
    {
      id: 'small_control_room',
      name: 'Small Control Room / Mixing Studio',
      targetRt60: 0.35,
      perBandTargets: { 125: 0.40, 250: 0.35, 500: 0.35, 1000: 0.35, 2000: 0.35, 4000: 0.35 },
      description: 'Critical listening and stereo mixing environment for small production control rooms.',
      source: 'EBU Tech 3276 (Listening conditions for sound programme in broadcasting, 2nd ed., 1998)',
    },
    {
      id: 'vocal_booth',
      name: 'Vocal / Voiceover Booth',
      targetRt60: 0.25,
      perBandTargets: { 125: 0.30, 250: 0.25, 500: 0.25, 1000: 0.25, 2000: 0.25, 4000: 0.25 },
      description: 'Controlled dead environment for dry speech and vocal tracking with minimal room reflections.',
      source: 'rule of thumb',
    },
    {
      id: 'live_room',
      name: 'Live Room / Tracking Room',
      targetRt60: 0.70,
      perBandTargets: { 125: 0.80, 250: 0.75, 500: 0.70, 1000: 0.70, 2000: 0.65, 4000: 0.60 },
      description: 'Natural, controlled acoustic ambience for acoustic instruments, ensembles, and drums.',
      source: 'rule of thumb',
    },
    {
      id: 'podcast_studio',
      name: 'Podcast / Broadcast Voice Studio',
      targetRt60: 0.30,
      perBandTargets: { 125: 0.35, 250: 0.30, 500: 0.30, 1000: 0.30, 2000: 0.30, 4000: 0.28 },
      description: 'Controlled speech clarity optimized for podcasting and multi-microphone interviews.',
      source: 'rule of thumb',
    },
    {
      id: 'classroom',
      name: 'Classroom / Core Learning Space (< 283 m³)',
      targetRt60: 0.60,
      perBandTargets: { 125: 0.60, 250: 0.60, 500: 0.60, 1000: 0.60, 2000: 0.60, 4000: 0.60 },
      description: 'Standard unoccupied educational learning space maximizing speech intelligibility.',
      source: 'ANSI/ASA S12.60-2010 (Acoustical Performance Criteria, Design Requirements, and Guidelines for Schools, Part 1, Section 5.2.3.1)',
    },
    {
      id: 'home_theater',
      name: 'Home Theater / Multi-Channel Listening',
      targetRt60: 0.40,
      perBandTargets: { 125: 0.45, 250: 0.40, 500: 0.40, 1000: 0.40, 2000: 0.38, 4000: 0.35 },
      description: 'Immersive surround sound listening room balancing dialogue clarity and sound effects.',
      source: 'rule of thumb',
    },
  ];

  const FALLBACK_MATERIALS = [
    {
      id: 'fiberglass_50mm',
      name: 'Rigid Fiberglass Panel (50 mm / 2″, 48 kg/m³)',
      placeholder: true,
      source: 'placeholder, verify with manufacturer datasheet',
      thicknessMm: 50,
      alpha: { 125: 0.25, 250: 0.65, 500: 0.95, 1000: 0.98, 2000: 0.95, 4000: 0.90 },
    },
    {
      id: 'acoustic_foam_50mm',
      name: 'Open-Cell Acoustic Foam Wedge (50 mm / 2″)',
      placeholder: true,
      source: 'placeholder, verify with manufacturer datasheet',
      thicknessMm: 50,
      alpha: { 125: 0.15, 250: 0.35, 500: 0.70, 1000: 0.90, 2000: 0.92, 4000: 0.88 },
    },
    {
      id: 'fiberglass_100mm',
      name: 'Deep Broadband Absorber (100 mm / 4″)',
      placeholder: true,
      source: 'placeholder, verify with manufacturer datasheet',
      thicknessMm: 100,
      alpha: { 125: 0.50, 250: 0.85, 500: 0.98, 1000: 0.99, 2000: 0.95, 4000: 0.92 },
    },
    {
      id: 'heavy_drapery',
      name: 'Heavy Acoustic Curtain (Velour 500 g/m², 100% fullness)',
      placeholder: true,
      source: 'placeholder, verify with manufacturer datasheet',
      thicknessMm: 20,
      alpha: { 125: 0.10, 250: 0.30, 500: 0.50, 1000: 0.70, 2000: 0.75, 4000: 0.70 },
    },
    {
      id: 'wood_slat_panel',
      name: 'Slotted Timber / Wood Slat Panel (over mineral wool)',
      placeholder: true,
      source: 'placeholder, verify with manufacturer datasheet',
      thicknessMm: 60,
      alpha: { 125: 0.30, 250: 0.70, 500: 0.85, 1000: 0.75, 2000: 0.55, 4000: 0.40 },
    },
  ];

  let targetPresets = FALLBACK_TARGET_PRESETS;
  let materialsList = FALLBACK_MATERIALS;

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
    if (typeof updateStepStatuses === 'function') {
      updateStepStatuses();
    }
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

  if (btnToggleHotspot) {
    btnToggleHotspot.addEventListener('click', () => {
      placementHintActive = !placementHintActive;
      btnToggleHotspot.classList.toggle('active', placementHintActive);
      btnToggleHotspot.setAttribute('aria-pressed', String(placementHintActive));
      view.setPlacementHint(placementHintActive);
      updateHeatmapUI();
    });
  }

  if (checkHeatmapIncludeLowConfidence) {
    checkHeatmapIncludeLowConfidence.addEventListener('change', () => {
      includeLowConfidenceHeatmap = checkHeatmapIncludeLowConfidence.checked;
      view.setHeatmapIncludeLowConfidence(includeLowConfidenceHeatmap);
      updateHeatmapUI();
      updateBandSelectorUI(model.activeBand);
      render();
    });
  }

  if (btnCloseMarkerDetail) {
    btnCloseMarkerDetail.addEventListener('click', () => {
      model.selectPoint(null);
    });
  }

  function updateHeatmapUI() {
    const activeBand = model.activeBand;
    const usablePoints = getUsablePoints(model.measurements, activeBand, {
      includeLowConfidence: includeLowConfidenceHeatmap,
    });
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

    // DEV / SIMULATED DATA banner
    const hasFake = usablePoints.some((p) => p.fake === true || p.simulated === true || p.source === 'selftest' || p.source === 'dev');
    if (heatmapDevBanner) {
      heatmapDevBanner.hidden = !hasFake;
    }

    // LOW CONFIDENCE DATA banner
    const hasLowConf = usablePoints.some((p) => p.lowConfidence === true);
    if (heatmapLowConfidenceBanner) {
      heatmapLowConfidenceBanner.hidden = !(includeLowConfidenceHeatmap && hasLowConf);
    }

    // Hotspot Placement Hint Caption
    if (heatmapHotspotCaption) {
      if (placementHintActive) {
        heatmapHotspotCaption.hidden = false;
        const hotspotRes = evaluateHotspot(usablePoints);
        if (hotspotRes.hasHotspot) {
          heatmapHotspotCaption.textContent = `🎯 Longest reverberation region (${activeBand} Hz): ${hotspotRes.caption}`;
        } else {
          heatmapHotspotCaption.textContent = `ℹ️ ${hotspotRes.message}`;
        }
      } else {
        heatmapHotspotCaption.hidden = true;
      }
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
            ${m.lowConfidence ? `<div class="marker-detail-item"><span class="marker-detail-label">Confidence</span><span class="marker-detail-val"><span class="badge badge-warning">LOW CONFIDENCE</span></span></div>` : ''}
            ${m.fake || m.simulated ? `<div class="marker-detail-item"><span class="marker-detail-label">Source</span><span class="marker-detail-val" style="color: #ea580c; font-weight:700;">${m.source === 'selftest' ? 'SIMULATED' : 'Simulated [DEV]'}</span></div>` : (m.source ? `<div class="marker-detail-item"><span class="marker-detail-label">Source</span><span class="marker-detail-val">${m.source}${m.originalSampleRate ? ' (' + m.originalSampleRate + ' Hz)' : ''}</span></div>` : '')}
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
      const counts = getBandTierCounts(model.measurements, b, {
        includeLowConfidence: includeLowConfidenceHeatmap,
      });
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
      const currentCounts = getBandTierCounts(model.measurements, activeBand, {
        includeLowConfidence: includeLowConfidenceHeatmap,
      });
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

      let badgeHtml = '';
      if (m.fake || m.simulated) {
        badgeHtml = `<span class="badge ${m.source === 'selftest' ? 'badge-simulated' : 'badge-dev'}">${m.source === 'selftest' ? 'SIMULATED' : 'DEV'}</span>`;
      } else if (m.lowConfidence) {
        badgeHtml = '<span class="badge badge-warning">Low Conf</span>';
      }

      // Metric position label if dimensions exist
      let posText = `Pos: (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`;
      if (dims && Number.isFinite(dims.lengthM) && Number.isFinite(dims.widthM)) {
        const xM = (m.x * dims.lengthM).toFixed(2);
        const yM = (m.y * dims.widthM).toFixed(2);
        const approxTilde = dims.isApproximate ? '~' : '';
        posText = `Pos: ${approxTilde}${xM}m, ${approxTilde}${yM}m (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`;
      }

      let sourceTag = '';
      if (m.status !== 'pending' && m.source) {
        sourceTag = `<span class="coord-label">Source: ${m.source}${m.originalSampleRate ? ' (' + m.originalSampleRate + ' Hz)' : ''}${m.fileName ? ' · ' + m.fileName : ''}</span>`;
      }

      item.innerHTML = `
        <div class="card-main">
          <div class="card-header">
            <span class="point-number">Point ${m.id}</span>
            <div class="badge-group">
              ${badgeHtml}
              ${tierBadgeHtml}
            </div>
          </div>
          <div class="card-details">
            <span class="coord-label">${posText}</span>
            ${sourceTag}
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

    if (isTableView) {
      renderFloorPlanTable();
    }
    if (typeof updateStepStatuses === 'function') {
      updateStepStatuses();
    }
  }

  // -------------------------------------------------------------
  // Floor Plan Accessible Data Table Alternative
  // -------------------------------------------------------------
  let isTableView = false;

  function renderFloorPlanTable() {
    if (!floorplanTableTbody) return;
    floorplanTableTbody.innerHTML = '';

    const points = model.measurements || [];
    if (points.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 10;
      td.className = 'empty-table-cell';
      td.style.padding = '16px';
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-secondary)';
      td.textContent = 'No measurement points placed yet. Tap inside the room on the canvas or use [DEV] to add test points.';
      tr.appendChild(td);
      floorplanTableTbody.appendChild(tr);
      return;
    }

    points.forEach((pt, index) => {
      const tr = document.createElement('tr');
      const isMeasured = pt.status === 'measured';
      const isDev = Boolean(pt.fake);

      // Point #
      const tdNum = document.createElement('td');
      tdNum.innerHTML = `<strong>Pt ${index + 1}</strong>`;
      tr.appendChild(tdNum);

      // Coordinates
      const tdCoords = document.createElement('td');
      tdCoords.textContent = `(${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`;
      tr.appendChild(tdCoords);

      // Status
      const tdStatus = document.createElement('td');
      tdStatus.innerHTML = `<span class="badge ${isMeasured ? 'badge-valid' : 'badge-approx'}">${pt.status}</span>`;
      tr.appendChild(tdStatus);

      // Type
      const tdType = document.createElement('td');
      tdType.textContent = isDev ? 'Simulated [DEV]' : (isMeasured ? 'Real (WAV)' : 'Pending');
      tr.appendChild(tdType);

      // Octave bands (125 to 4000)
      for (const fc of OCTAVE_BANDS) {
        const tdBand = document.createElement('td');
        if (isMeasured && pt.bands && pt.bands[fc]) {
          const b = pt.bands[fc];
          const val = Number.isFinite(b.rt60) ? b.rt60.toFixed(2) + ' s' : '—';
          const tier = b.tier || 'invalid';
          const tierClass = tier === 'valid' ? 'symbol-valid' : tier === 'approximate' ? 'symbol-approx' : 'symbol-invalid';
          tdBand.innerHTML = `<span>${val}</span> <span class="legend-symbol ${tierClass}" title="Tier: ${tier}"></span>`;
        } else {
          tdBand.textContent = '—';
        }
        tr.appendChild(tdBand);
      }

      floorplanTableTbody.appendChild(tr);
    });
  }

  if (btnToggleCanvasTable && floorplanCanvasContainer && floorplanTableContainer) {
    btnToggleCanvasTable.addEventListener('click', () => {
      isTableView = !isTableView;
      btnToggleCanvasTable.setAttribute('aria-expanded', String(isTableView));
      if (isTableView) {
        floorplanCanvasContainer.hidden = true;
        floorplanTableContainer.hidden = false;
        btnToggleCanvasTable.textContent = 'Show canvas';
        renderFloorPlanTable();
      } else {
        floorplanTableContainer.hidden = true;
        floorplanCanvasContainer.hidden = false;
        btnToggleCanvasTable.textContent = 'Show as table';
        view.render();
      }
    });
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
  // Acoustic Guide & In-App Help Modal
  // -------------------------------------------------------------
  function initHelpModal() {
    if (!modalHelpBody || modalHelpBody.children.length > 0) return;
    modalHelpBody.innerHTML = '';
    for (const topic of HELP_TOPICS) {
      const details = document.createElement('details');
      details.className = 'help-card-item';
      if (topic.id === 'rt60' || topic.id === 'two-device-workflow') {
        details.open = true;
      }
      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${topic.title}</span><span class="help-card-summary-desc">${topic.summary}</span>`;
      details.appendChild(summary);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'help-card-details';
      contentDiv.innerHTML = topic.content;
      details.appendChild(contentDiv);

      modalHelpBody.appendChild(details);
    }
  }

  function openHelpModal() {
    initHelpModal();
    if (modalHelp) modalHelp.hidden = false;
  }

  function closeHelpModal() {
    if (modalHelp) modalHelp.hidden = true;
  }

  if (btnOpenHelp) btnOpenHelp.addEventListener('click', openHelpModal);
  if (btnCloseHelpModal) btnCloseHelpModal.addEventListener('click', closeHelpModal);
  if (btnModalHelpDismiss) btnModalHelpDismiss.addEventListener('click', closeHelpModal);

  if (modalHelp) {
    modalHelp.addEventListener('click', (e) => {
      if (e.target === modalHelp) closeHelpModal();
    });
  }
  if (modalSessions) {
    modalSessions.addEventListener('click', (e) => {
      if (e.target === modalSessions) closeSessionsModal();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeHelpModal();
      closeSessionsModal();
    }
  });

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
      try {
        localStorage.setItem('echomap_last_backup_time', String(Date.now()));
        updateBackupPrompt();
      } catch (_) {}
    });
  }

  // -------------------------------------------------------------
  // Backup Prompt (Warns users about browser storage eviction)
  // -------------------------------------------------------------
  function updateBackupPrompt() {
    if (!backupLastTimeEl) return;
    try {
      const stored = localStorage.getItem('echomap_last_backup_time');
      const timeMs = stored ? Number(stored) : null;
      backupLastTimeEl.textContent = `Last export: ${formatTimeAgo(timeMs)}`;
    } catch (_) {
      backupLastTimeEl.textContent = 'Last export: Available via JSON';
    }
  }

  if (btnQuickBackup && btnExportJson) {
    btnQuickBackup.addEventListener('click', () => {
      btnExportJson.click();
    });
  }

  updateBackupPrompt();
  setInterval(updateBackupPrompt, 60000);

  // -------------------------------------------------------------
  // Phase 3a: Audio Recording Analysis & Simulation View
  // -------------------------------------------------------------

  function prepareCanvas(cvs) {
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    const w = Math.round(rect.width) || 400;
    const h = Math.round(rect.height) || 140;
    if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
    }
    const ctx = cvs.getContext('2d');
    ctx.resetTransform?.();
    ctx.scale(dpr, dpr);
    return { ctx, width: w, height: h };
  }

  function drawIrPlot(cvs, irPlot) {
    if (!cvs) return;
    const { ctx, width, height } = prepareCanvas(cvs);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!irPlot || !irPlot.values || irPlot.values.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No impulse response data', width / 2, height / 2);
      return;
    }

    const vals = irPlot.values;
    let maxAbs = 0;
    for (let i = 0; i < vals.length; i++) {
      const a = Math.abs(vals[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs === 0) maxAbs = 1;

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const n = vals.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const y = height / 2 - (vals[i] / maxAbs) * (height * 0.45);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const BAND_COLORS = {
    125: '#f43f5e',
    250: '#f97316',
    500: '#eab308',
    1000: '#22c55e',
    2000: '#06b6d4',
    4000: '#a855f7',
  };

  function drawEdcPlot(cvs, edcPlot) {
    if (!cvs) return;
    const { ctx, width, height } = prepareCanvas(cvs);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    const padL = 34;
    const padR = 10;
    const padT = 12;
    const padB = 22;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);

    ctx.font = '10px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const dbs = [0, -20, -40, -60];
    for (const db of dbs) {
      const y = padT + (-db / 60) * plotH;
      ctx.strokeStyle = db === 0 ? 'rgba(148, 163, 184, 0.4)' : 'rgba(148, 163, 184, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}dB`, padL - 4, y);
    }

    if (!edcPlot) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No decay data', width / 2, height / 2);
      return;
    }

    let maxT = 0;
    for (const band of OCTAVE_BANDS) {
      const curve = edcPlot[band];
      if (curve && curve.t && curve.t.length > 0) {
        const lastT = curve.t[curve.t.length - 1];
        if (lastT > maxT) maxT = lastT;
      }
    }
    if (maxT <= 0) maxT = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('0s', padL, padT + plotH + 4);
    ctx.fillText(`${maxT.toFixed(1)}s`, padL + plotW, padT + plotH + 4);

    for (const band of OCTAVE_BANDS) {
      const curve = edcPlot[band];
      if (!curve || !curve.t || !curve.edcDb || curve.t.length === 0) continue;

      const color = BAND_COLORS[band] || '#38bdf8';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();

      const n = curve.t.length;
      for (let i = 0; i < n; i++) {
        const tVal = curve.t[i];
        const dbVal = Math.max(-60, Math.min(0, curve.edcDb[i]));
        const x = padL + (tVal / maxT) * plotW;
        const y = padT + (-dbVal / 60) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function getRejectionAdvice(reason) {
    const r = (reason || '').toLowerCase();
    if (r.includes('too short')) {
      return 'Recording must contain the complete 5-second sweep plus at least 3 seconds of natural decay (record at least 15 s recommended). Please record a longer take.';
    }
    if (r.includes('sample rate')) {
      return 'The audio sample rate is too low. EchoMap requires at least 22,050 Hz to analyze acoustic octave bands accurately.';
    }
    if (r.includes('empty') || r.includes('silent')) {
      return 'The audio appears silent or empty. Check that your microphone was unmuted and recording level was adequate.';
    }
    if (r.includes('sweep not detected') || r.includes('pnr')) {
      return 'The test sweep could not be detected above background noise. Ensure playback volume is adequate, place the speaker at a fixed position, and turn off background noise sources.';
    }
    return 'Please verify that the audio file was recorded cleanly with the test sweep playing, and try again.';
  }

  let lastAnnouncedStage = null;

  function setAnalyzeProgress(stageOrObj, progress, message) {
    let stage = stageOrObj;
    let p = progress;
    let msg = message;
    if (typeof stageOrObj === 'object' && stageOrObj !== null) {
      stage = stageOrObj.stage;
      p = stageOrObj.progress;
      msg = stageOrObj.message;
    }
    if (analyzeProgressContainer) analyzeProgressContainer.hidden = false;
    if (analyzeProgressBar) {
      const pct = Math.round((Number(p) || 0) * 100);
      analyzeProgressBar.style.width = `${pct}%`;
      const progressbarRole = document.getElementById('analyze-progressbar-role');
      if (progressbarRole) {
        progressbarRole.setAttribute('aria-valuenow', String(pct));
      }
    }
    if (analyzeProgressMessage) {
      analyzeProgressMessage.textContent = msg || `Processing: ${stage || ''}`;
    }

    // Announce stage changes ONLY to screen readers (avoids spamming every progress tick)
    if (stage && stage !== lastAnnouncedStage && analysisLiveAnnouncer) {
      lastAnnouncedStage = stage;
      analysisLiveAnnouncer.textContent = `Analysis stage: ${stage}. ${msg || ''}`;
    }
  }

  function populateAttachPointSelect() {
    if (!selectAttachPoint) return;
    const previousVal = selectAttachPoint.value;
    selectAttachPoint.innerHTML = '';

    const newOpt = document.createElement('option');
    newOpt.value = 'new';
    newOpt.textContent = '+ Add as new measurement point';
    selectAttachPoint.appendChild(newOpt);

    let hasSelected = false;
    for (const m of model.measurements) {
      const opt = document.createElement('option');
      opt.value = String(m.id);
      const statusTag = m.status === 'pending' ? '[Pending]' : `[Measured: ${m.source || 'wav'}]`;
      opt.textContent = `Point #${m.id} (${m.x.toFixed(2)}, ${m.y.toFixed(2)}) ${statusTag}`;

      if (previousVal && String(m.id) === previousVal) {
        opt.selected = true;
        hasSelected = true;
      } else if (!hasSelected && (m.id === model.selectedPointId || m.status === 'pending')) {
        opt.selected = true;
        hasSelected = true;
      }
      selectAttachPoint.appendChild(opt);
    }
    if (!hasSelected) {
      newOpt.selected = true;
    }
  }

  function displayAnalysisResults(result, audioMeta = {}) {
    currentAnalysisResult = result;
    if (analyzeProgressContainer) analyzeProgressContainer.hidden = true;

    if (!result.ok) {
      if (analyzeRejectCard) analyzeRejectCard.hidden = false;
      if (analyzeRejectReason) analyzeRejectReason.textContent = result.rejectReason || 'Analysis failed';
      if (analyzeRejectAdvice) analyzeRejectAdvice.textContent = getRejectionAdvice(result.rejectReason);
      if (analyzeOverrideRow) {
        analyzeOverrideRow.hidden = !result.canOverrideLowPnr;
      }
      if (rejectDetailsContent) {
        const diagData = result.diagnostics || {
          pnrDb: result.pnrDb,
          pnrThresholdDb: 20.0,
          deltaPostPreDb: result.deltaPostPreDb,
          deltaPostPreThresholdDb: 1.5,
          orderingScore: result.sweepSignature ? result.sweepSignature.score : null,
          orderingThreshold: 0.65,
          sampleRate: audioMeta.sampleRate || result.sampleRate,
          durationS: audioMeta.durationS || (audioMeta.samples ? audioMeta.samples.length / (audioMeta.sampleRate || 48000) : result.durationS),
          gateFired: result.gateFired || result.rejectReason || 'Rejection gate',
        };
        rejectDetailsContent.innerHTML = formatDiagnosticsHtml(diagData);
      }
      if (analyzeResultsContainer) analyzeResultsContainer.hidden = true;
      if (analysisLiveAnnouncer) {
        analysisLiveAnnouncer.textContent = `Analysis rejected: ${result.rejectReason || 'Check audio recording.'}`;
      }
      return;
    }

    if (analyzeRejectCard) analyzeRejectCard.hidden = true;
    if (analyzeResultsContainer) analyzeResultsContainer.hidden = false;
    if (resultsDetailsContent) {
      const diagData = result.diagnostics || {
        pnrDb: result.pnrDb,
        pnrThresholdDb: 20.0,
        deltaPostPreDb: result.deltaPostPreDb,
        deltaPostPreThresholdDb: 1.5,
        orderingScore: result.sweepSignature ? result.sweepSignature.score : null,
        orderingThreshold: 0.65,
        sampleRate: audioMeta.sampleRate || result.sampleRate,
        durationS: audioMeta.durationS || (audioMeta.samples ? audioMeta.samples.length / (audioMeta.sampleRate || 48000) : result.durationS),
        gateFired: result.gateFired || 'None (All gates passed)',
      };
      resultsDetailsContent.innerHTML = formatDiagnosticsHtml(diagData);
    }
    if (analysisLiveAnnouncer) {
      analysisLiveAnnouncer.textContent = `Analysis complete: PNR ${formatDecibels(result.pnrDb, 1)}, usable decay depth ${formatDecibels(result.dynamicRangeDb, 1)}.`;
    }

    // Badges
    if (badgeSimulated) badgeSimulated.hidden = !result.simulated;
    if (badgeClipped) badgeClipped.hidden = !result.clipped;
    if (badgeTruncated) badgeTruncated.hidden = !result.decayTruncated;
    if (badgeLowConfidence) badgeLowConfidence.hidden = !result.lowConfidence;

    // Execution mode
    if (analyzeExecutionMode) {
      if (result.executionMode === 'worker') {
        analyzeExecutionMode.textContent = 'analysed in: worker';
        analyzeExecutionMode.title = 'DSP computation executed in dedicated Web Worker.';
      } else {
        analyzeExecutionMode.textContent = 'analysed in: main thread (worker fallback)';
        analyzeExecutionMode.title = 'Web Worker unavailable; executed on main thread.';
      }
    }

    // Audio metadata info text
    if (analyzeAudioInfo) {
      const sr = audioMeta.sampleRate || result.sampleRate;
      const dur = audioMeta.durationS || (audioMeta.samples ? audioMeta.samples.length / sr : null);
      const parts = [];
      if (sr) parts.push(`${sr} Hz`);
      if (dur) parts.push(`${dur.toFixed(1)} s`);
      if (audioMeta.isMultiChannel) parts.push('Ch 0 (mono extracted)');
      if (audioMeta.isCompressed) parts.push('Compressed audio');
      if (result.simulated && result.targetRt60) {
        const nStr = result.noiseLevelDb != null ? ` (Noise: ${result.noiseLevelDb} dB re peak)` : ' (Clean)';
        parts.push(`Target RT60: ${result.targetRt60.toFixed(2)} s${nStr}`);
      }
      analyzeAudioInfo.textContent = parts.join(' · ');
    }

    // KPIs: Sweep detection (PNR) & Usable decay depth (DR)
    if (valPnr) valPnr.textContent = formatDecibels(result.pnrDb, 1);
    if (valDr) {
      const drStr = formatDecibels(result.dynamicRangeDb, 1);
      valDr.textContent = result.weakestBandHz ? `${drStr} (${result.weakestBandHz} Hz)` : drStr;
    }

    // Render Canvas Plots
    drawIrPlot(canvasIrPlot, result.irPlot);
    drawEdcPlot(canvasEdcPlot, result.edcPlot);

    // Populate Octave Bands Results Table
    if (analyzeBandsTbody) {
      analyzeBandsTbody.innerHTML = '';
      for (const fc of OCTAVE_BANDS) {
        const b = result.bands ? result.bands[fc] : null;
        const tr = document.createElement('tr');
        if (!b) {
          tr.innerHTML = `<td><strong>${fc} Hz</strong></td><td colspan="7">—</td>`;
        } else {
          const tierBadge = `<span class="badge tier-${b.tier}">${b.tier}</span>`;
          const t20Str = Number.isFinite(b.t20) ? b.t20.toFixed(3) : '—';
          const t30Str = Number.isFinite(b.t30) ? b.t30.toFixed(3) : '—';
          const edtStr = Number.isFinite(b.edt) ? b.edt.toFixed(3) : '—';
          const r2Str = Number.isFinite(b.r2) ? b.r2.toFixed(3) : '—';
          const usedStr = b.used || 'none';
          const uncInfo = b.rt60 != null
            ? interpolateUncertainty(b.rt60, fc, uncertaintyData)
            : null;
          const uncText = uncInfo ? `(${uncInfo.displayText})` : `(typical scatter ±${typicalUncertaintyPct[fc] || 5}%)`;
          const rt60Str = b.rt60 != null
            ? `<strong>${b.rt60.toFixed(3)} s</strong> <small class="text-muted">${uncText}</small>`
            : '—';
          tr.innerHTML = `
            <td><strong>${fc} Hz</strong></td>
            <td>${rt60Str}</td>
            <td>${t20Str}</td>
            <td>${t30Str}</td>
            <td>${edtStr}</td>
            <td>${r2Str}</td>
            <td>${usedStr}</td>
            <td>${tierBadge}</td>
          `;
        }
        analyzeBandsTbody.appendChild(tr);
      }
    }

    populateAttachPointSelect();
  }

  // 1. Download Test Sweep
  if (btnDownloadSweep) {
    btnDownloadSweep.addEventListener('click', () => {
      downloadSweepWav();
    });
  }

  // 2. Room Simulation Self-Test Controls
  if (sliderSelftestRt60 && selftestRtVal) {
    sliderSelftestRt60.addEventListener('input', (e) => {
      selftestRtVal.textContent = `${Number(e.target.value).toFixed(1)} s`;
    });
  }

  if (sliderSelftestNoise && selftestNoiseVal) {
    sliderSelftestNoise.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      if (val <= -40) {
        selftestNoiseVal.textContent = 'Clean';
      } else {
        selftestNoiseVal.textContent = `${val} dB`;
      }
    });
  }

  if (btnRunSelftest) {
    btnRunSelftest.addEventListener('click', async () => {
      const rtTarget = sliderSelftestRt60 ? Number(sliderSelftestRt60.value) : 0.8;
      const noiseRaw = sliderSelftestNoise ? Number(sliderSelftestNoise.value) : -40;
      const noiseLevelDb = noiseRaw > -40 ? noiseRaw : null;
      if (analyzeRejectCard) analyzeRejectCard.hidden = true;
      if (analyzeResultsContainer) analyzeResultsContainer.hidden = true;
      const noiseLabel = noiseLevelDb != null ? `, noise = ${noiseLevelDb} dB re peak` : '';
      setAnalyzeProgress('simulation', 0.05, `Simulating room impulse response (target RT60 = ${rtTarget.toFixed(1)} s${noiseLabel})...`);

      try {
        const result = await runSelfTest({
          rtTarget,
          noiseLevelDb,
          onProgress: (info) => setAnalyzeProgress(info),
        });

        lastLoadedAudio = {
          samples: null,
          sampleRate: 48000,
          fileName: `simulated_room_rt${rtTarget.toFixed(1)}s${noiseLevelDb != null ? '_n' + noiseLevelDb + 'dB' : ''}.wav`,
          isMultiChannel: false,
          isCompressed: false,
        };

        displayAnalysisResults(result, {
          sampleRate: 48000,
          durationS: 9.0,
          fileName: `simulated_room_rt${rtTarget.toFixed(1)}s${noiseLevelDb != null ? '_n' + noiseLevelDb + 'dB' : ''}.wav`,
          isMultiChannel: false,
          isCompressed: false,
        });
      } catch (err) {
        console.error('[SelfTestError]', err);
        if (analyzeProgressContainer) analyzeProgressContainer.hidden = true;
        if (analyzeRejectCard) {
          analyzeRejectCard.hidden = false;
          if (analyzeRejectReason) analyzeRejectReason.textContent = err.message || 'Simulation failed';
          if (analyzeRejectAdvice) analyzeRejectAdvice.textContent = 'Check browser console for error details.';
          if (analyzeOverrideRow) analyzeOverrideRow.hidden = true;
        }
      }
    });
  }

  // 3. Audio File Picker & Analysis
  if (inputAudioFile) {
    inputAudioFile.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (selectedFileNameEl) selectedFileNameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
      if (analyzeRejectCard) analyzeRejectCard.hidden = true;
      if (analyzeResultsContainer) analyzeResultsContainer.hidden = true;
      setAnalyzeProgress('loading', 0.05, 'Reading audio file...');

      try {
        if (!currentAudioContext && typeof AudioContext !== 'undefined') {
          currentAudioContext = new AudioContext();
        }

        const loaded = await loadAudioFile(file, currentAudioContext);
        lastLoadedAudio = {
          samples: loaded.samples,
          sampleRate: loaded.sampleRate,
          fileName: file.name,
          isMultiChannel: loaded.isMultiChannel,
          isCompressed: loaded.isCompressed,
        };

        if (loaded.warning) {
          console.warn('[AudioLoader]', loaded.warning);
        }

        setAnalyzeProgress('analysis', 0.1, 'Running acoustic deconvolution...');

        const result = await runAnalysis(
          loaded.samples,
          loaded.sampleRate,
          (info) => setAnalyzeProgress(info)
        );

        displayAnalysisResults(result, {
          sampleRate: loaded.sampleRate,
          samples: loaded.samples,
          fileName: file.name,
          isMultiChannel: loaded.isMultiChannel,
          isCompressed: loaded.isCompressed,
        });
      } catch (err) {
        console.error('[AudioAnalysisError]', err);
        if (analyzeProgressContainer) analyzeProgressContainer.hidden = true;
        const errInfo = formatAudioErrorMessage(err);
        if (analyzeRejectCard) {
          analyzeRejectCard.hidden = false;
          if (analyzeRejectReason) analyzeRejectReason.textContent = errInfo.title;
          if (analyzeRejectAdvice) analyzeRejectAdvice.textContent = errInfo.message;
          if (analyzeOverrideRow) analyzeOverrideRow.hidden = true;
        }
        if (analysisLiveAnnouncer) {
          analysisLiveAnnouncer.textContent = `Analysis error: ${errInfo.title}. ${errInfo.message}`;
        }
      }
    });
  }

  // 4. Low PNR Override Handler
  if (btnOverrideLowPnr) {
    btnOverrideLowPnr.addEventListener('click', async () => {
      if (!lastLoadedAudio || !lastLoadedAudio.samples) return;
      setAnalyzeProgress('analysis', 0.1, 'Re-analyzing with low-confidence override...');
      try {
        const result = await runAnalysis(
          lastLoadedAudio.samples,
          lastLoadedAudio.sampleRate,
          (info) => setAnalyzeProgress(info),
          { allowLowPnr: true }
        );

        displayAnalysisResults(result, {
          sampleRate: lastLoadedAudio.sampleRate,
          samples: lastLoadedAudio.samples,
          fileName: lastLoadedAudio.fileName,
          isMultiChannel: lastLoadedAudio.isMultiChannel,
          isCompressed: lastLoadedAudio.isCompressed,
        });
      } catch (err) {
        console.error('[OverrideError]', err);
      }
    });
  }

  // 5. Attach Result to Floor Plan Point
  if (btnAttachToPoint) {
    btnAttachToPoint.addEventListener('click', () => {
      if (!currentAnalysisResult || !currentAnalysisResult.ok) {
        alert('No valid analysis result to attach.');
        return;
      }

      const pointChoice = selectAttachPoint ? selectAttachPoint.value : 'new';
      const pointId = pointChoice === 'new' ? null : Number(pointChoice);

      const measurementData = {
        ...currentAnalysisResult,
        fake: Boolean(currentAnalysisResult.fake || currentAnalysisResult.simulated),
        source: currentAnalysisResult.source || (currentAnalysisResult.simulated ? 'selftest' : 'wav'),
        fileName: lastLoadedAudio ? lastLoadedAudio.fileName : (currentAnalysisResult.simulated ? 'simulated_room.wav' : null),
        originalSampleRate: lastLoadedAudio ? lastLoadedAudio.sampleRate : (currentAnalysisResult.sampleRate || 48000),
        timestamp: Date.now(),
      };

      let pt;
      if (pointChoice === 'new') {
        pt = model.addMeasuredMeasurement(0.5, 0.5, measurementData);
      } else {
        pt = model.attachMeasurement(pointId, measurementData);
      }

      if (attachSuccessMsg) {
        attachSuccessMsg.hidden = false;
        attachSuccessMsg.textContent = `✓ Attached to Point #${pt.id}!`;
        setTimeout(() => {
          if (attachSuccessMsg) attachSuccessMsg.hidden = true;
        }, 3000);
      }

      populateAttachPointSelect();
    });
  }

  // -------------------------------------------------------------
  // Phase 6: Treatment Calculator UI & Controller
  // -------------------------------------------------------------

  function populateTargetPresetsUI() {
    if (!selectTargetPreset) return;
    selectTargetPreset.innerHTML = '';
    targetPresets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (~${p.targetRt60} s)`;
      if (p.id === selectedPresetId) opt.selected = true;
      selectTargetPreset.appendChild(opt);
    });
    updateTargetPresetSourceUI();
  }

  function updateTargetPresetSourceUI() {
    const p = targetPresets.find((item) => item.id === selectedPresetId) || targetPresets[0];
    if (targetPresetSourceText && p) {
      targetPresetSourceText.textContent = p.source;
    }
  }

  function populateMaterialsUI() {
    if (!selectMaterial) return;
    selectMaterial.innerHTML = '';
    materialsList.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} [placeholder]`;
      if (m.id === selectedMaterialId) opt.selected = true;
      selectMaterial.appendChild(opt);
    });

    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = '✨ Custom material (user-entered α)';
    if (selectedMaterialId === 'custom') customOpt.selected = true;
    selectMaterial.appendChild(customOpt);
  }

  // Target preset select event
  if (selectTargetPreset) {
    selectTargetPreset.addEventListener('change', () => {
      selectedPresetId = selectTargetPreset.value;
      updateTargetPresetSourceUI();
      updateTreatmentUI();
      if (typeof updateStepStatuses === 'function') {
        updateStepStatuses();
      }
    });
  }

  // Target mode toggle: preset vs manual
  if (btnTargetModePreset) {
    btnTargetModePreset.addEventListener('click', () => {
      targetMode = 'preset';
      btnTargetModePreset.classList.add('active');
      btnTargetModePreset.setAttribute('aria-pressed', 'true');
      if (btnTargetModeManual) {
        btnTargetModeManual.classList.remove('active');
        btnTargetModeManual.setAttribute('aria-pressed', 'false');
      }
      if (targetManualContainer) targetManualContainer.hidden = true;
      if (selectTargetPreset) selectTargetPreset.disabled = false;
      updateTreatmentUI();
    });
  }

  if (btnTargetModeManual) {
    btnTargetModeManual.addEventListener('click', () => {
      targetMode = 'manual';
      btnTargetModeManual.classList.add('active');
      btnTargetModeManual.setAttribute('aria-pressed', 'true');
      if (btnTargetModePreset) {
        btnTargetModePreset.classList.remove('active');
        btnTargetModePreset.setAttribute('aria-pressed', 'false');
      }
      if (targetManualContainer) targetManualContainer.hidden = false;
      if (selectTargetPreset) selectTargetPreset.disabled = true;
      updateTreatmentUI();
    });
  }

  // Custom per-band target checkbox
  if (checkPerBandTargets) {
    checkPerBandTargets.addEventListener('change', () => {
      isCustomPerBandTarget = checkPerBandTargets.checked;
      if (singleTargetRow) singleTargetRow.hidden = isCustomPerBandTarget;
      if (perBandTargetsGrid) perBandTargetsGrid.hidden = !isCustomPerBandTarget;
      updateTreatmentUI();
    });
  }

  // Manual single target input
  if (inputManualTargetAll) {
    inputManualTargetAll.addEventListener('input', () => {
      const val = parseFloat(inputManualTargetAll.value);
      if (Number.isFinite(val) && val > 0) {
        manualTargetAll = val;
        updateTreatmentUI();
      }
    });
  }

  // Manual per-band inputs
  OCTAVE_BANDS.forEach((band) => {
    const el = document.getElementById(`input-target-${band}`);
    if (el) {
      el.addEventListener('input', () => {
        const val = parseFloat(el.value);
        if (Number.isFinite(val) && val > 0) {
          manualPerBandTargets[band] = val;
          updateTreatmentUI();
        }
      });
    }
  });

  // Material select
  if (selectMaterial) {
    selectMaterial.addEventListener('change', () => {
      selectedMaterialId = selectMaterial.value;
      const isCustom = selectedMaterialId === 'custom';
      if (customMaterialContainer) customMaterialContainer.hidden = !isCustom;
      if (materialNoticeBanner) materialNoticeBanner.hidden = isCustom;
      updateTreatmentUI();
    });
  }

  // Custom material band inputs
  OCTAVE_BANDS.forEach((band) => {
    const el = document.getElementById(`input-mat-${band}`);
    if (el) {
      el.addEventListener('input', () => {
        const val = parseFloat(el.value);
        if (Number.isFinite(val) && val >= 0 && val <= 1) {
          customMaterial.alpha[band] = val;
          updateTreatmentUI();
        }
      });
    }
  });

  if (inputCustomMatSource) {
    inputCustomMatSource.addEventListener('input', () => {
      customMaterial.source = inputCustomMatSource.value.trim() || 'User-entered custom material';
    });
  }

  // Existing boundary alpha
  if (inputExistingAlpha) {
    inputExistingAlpha.addEventListener('input', () => {
      const val = parseFloat(inputExistingAlpha.value);
      if (Number.isFinite(val) && val >= 0 && val < 1) {
        existingAlpha = val;
        updateTreatmentUI();
      }
    });
  }

  // Include simulated data toggle
  if (checkIncludeSimulated) {
    checkIncludeSimulated.addEventListener('change', () => {
      includeSimulatedTreatment = checkIncludeSimulated.checked;
      updateTreatmentUI();
    });
  }

  // Include low-confidence data toggle
  if (checkIncludeLowConfidence) {
    checkIncludeLowConfidence.addEventListener('change', () => {
      includeLowConfidenceTreatment = checkIncludeLowConfidence.checked;
      if (treatmentLowConfidenceBanner) {
        treatmentLowConfidenceBanner.hidden = !includeLowConfidenceTreatment;
      }
      updateTreatmentUI();
    });
  }

  function updateTreatmentUI() {
    const agg = aggregateSessionBands(model.measurements, {
      includeSimulated: includeSimulatedTreatment,
      includeLowConfidence: includeLowConfidenceTreatment,
    });
    if (treatmentDataStatusEl) {
      treatmentDataStatusEl.textContent = agg.dataStatus.statusLine;
    }
    if (treatmentSimulatedBanner) {
      treatmentSimulatedBanner.hidden = !includeSimulatedTreatment;
    }
    if (treatmentLowConfidenceBanner) {
      treatmentLowConfidenceBanner.hidden = !includeLowConfidenceTreatment;
    }

    // Determine current material
    let currentMaterial = null;
    if (selectedMaterialId === 'custom') {
      currentMaterial = customMaterial;
      if (materialNoticeBanner) materialNoticeBanner.hidden = true;
    } else {
      currentMaterial = materialsList.find((m) => m.id === selectedMaterialId) || materialsList[0];
      if (materialNoticeBanner) materialNoticeBanner.hidden = false;
    }

    // Prepare room geometry if available
    let geom = null;
    let isSteps = false;
    if (
      model.roomDimensions &&
      Number.isFinite(model.roomDimensions.lengthM) &&
      Number.isFinite(model.roomDimensions.widthM) &&
      Number.isFinite(model.roomDimensions.heightM) &&
      model.roomDimensions.lengthM > 0 &&
      model.roomDimensions.widthM > 0 &&
      model.roomDimensions.heightM > 0
    ) {
      geom = roomGeometry(model.roomDimensions.lengthM, model.roomDimensions.widthM, model.roomDimensions.heightM);
      isSteps = model.roomDimensions.unit === 'steps' || Boolean(model.roomDimensions.isApproximate);
    }

    const bandResults = {};
    let allTargetsMet = true;
    let anyUsableBand = false;
    let materialIneffectiveMsg = null;
    let areaExceededMsg = null;

    for (const band of OCTAVE_BANDS) {
      const bData = agg.bands[band];
      let targetRt = manualTargetAll;
      if (targetMode === 'preset') {
        const preset = targetPresets.find((p) => p.id === selectedPresetId);
        if (preset) {
          targetRt = preset.perBandTargets && preset.perBandTargets[band] ? preset.perBandTargets[band] : preset.targetRt60;
        }
      } else if (isCustomPerBandTarget) {
        targetRt = manualPerBandTargets[band] || 0.40;
      }

      const matAlpha = currentMaterial ? (currentMaterial.alpha[band] ?? 0.80) : 0.80;

      const treat = calculateBandTreatment({
        band,
        meanRt60: bData.hasData ? bData.mean : NaN,
        minRt60: bData.hasData ? bData.min : NaN,
        maxRt60: bData.hasData ? bData.max : NaN,
        targetRt60: targetRt,
        materialAlpha: matAlpha,
        existingAlpha,
        geometry: geom,
        isSteps,
        hasApproximate: bData.hasApproximate,
      });

      bandResults[band] = treat;

      if (bData.hasData) {
        anyUsableBand = true;
        if (!treat.primary.targetMet) {
          allTargetsMet = false;
        }
        if (treat.guards.materialIneffective && !materialIneffectiveMsg) {
          materialIneffectiveMsg = treat.guards.message;
        }
        if (treat.guards.areaExceeded && !areaExceededMsg) {
          areaExceededMsg = treat.guards.message;
        }
      }
    }

    // Render Primary Table
    if (treatmentPrimaryTbody) {
      treatmentPrimaryTbody.innerHTML = '';
      for (const band of OCTAVE_BANDS) {
        const treat = bandResults[band];
        const bData = agg.bands[band];
        const tr = document.createElement('tr');

        let measuredDisplay = '<span class="text-muted">Insufficient data</span>';
        let ratioDisplay = '—';
        let plainDisplay = '<span class="text-muted">No recommendation</span>';

        if (bData.hasData) {
          const uncInfo = interpolateUncertainty(bData.mean, band, uncertaintyData);
          const uncText = uncInfo ? `(${uncInfo.displayText})` : `(typical scatter ±${typicalUncertaintyPct[band] || 5}%)`;
          const spreadStr = bData.spread > 0 ? ` [${bData.min.toFixed(2)}–${bData.max.toFixed(2)}]` : '';
          measuredDisplay = `<strong>${bData.mean.toFixed(2)} s</strong>${spreadStr} <small class="text-muted" style="font-size:0.85em;">${uncText}</small>`;
          if (bData.hasApproximate) {
            measuredDisplay += ` <span class="badge badge-approx" title="Band contains approximate-tier measurement">≈ approx</span>`;
          }

          ratioDisplay = `<strong>${treat.primary.ratio.toFixed(2)}</strong>`;
          if (treat.primary.targetMet) {
            plainDisplay = `<span style="color:#10b981; font-weight:600;">✓ ${treat.primary.plainLanguage}</span>`;
          } else {
            plainDisplay = `<span style="color:#d97706; font-weight:600;">${treat.primary.plainLanguage}</span>`;
          }
        }

        tr.innerHTML = `
          <td><strong>${band} Hz</strong></td>
          <td>${measuredDisplay}</td>
          <td>${treat.targetRt60.toFixed(2)} s</td>
          <td>${ratioDisplay}</td>
          <td>${plainDisplay}</td>
        `;
        treatmentPrimaryTbody.appendChild(tr);
      }
    }

    // Physical Section & Headline
    if (geom) {
      if (treatmentPhysicalSection) treatmentPhysicalSection.hidden = false;
      if (treatmentNoDimPrompt) treatmentNoDimPrompt.hidden = true;

      const headline = computeTreatmentHeadline(bandResults);
      if (treatmentHeadlineBox) {
        if (headline.hasData && Number.isFinite(headline.headlineAreaNominal)) {
          treatmentHeadlineBox.hidden = false;
          treatmentHeadlineVal.textContent = headline.headlineAreaNominal === 0 ? '0 m² (target met)' : `~${headline.headlineAreaNominal.toFixed(1)} m²`;
          treatmentHeadlineRange.textContent = headline.headlineAreaNominal === 0 ? 'Target met across speech & music bands' : `Expected Range: ${headline.headlineAreaMin.toFixed(1)} – ${headline.headlineAreaMax.toFixed(1)} m²`;
          treatmentHeadlineUncertainty.textContent = isSteps
            ? 'Propagating measured RT60 spread and ~30% volume uncertainty from step-count paces'
            : 'Propagating measured RT60 spread across room measurement points';
        } else {
          treatmentHeadlineBox.hidden = true;
        }
      }

      if (treatmentPhysicalTbody) {
        treatmentPhysicalTbody.innerHTML = '';
        for (const band of OCTAVE_BANDS) {
          const treat = bandResults[band];
          const bData = agg.bands[band];
          const tr = document.createElement('tr');

          if (!bData.hasData || !treat.sabine) {
            tr.innerHTML = `
              <td><strong>${band} Hz</strong></td>
              <td colspan="5" class="text-muted">Insufficient data for this band</td>
            `;
          } else {
            let sabineAreaStr = `${treat.sabine.sPanel.toFixed(1)} m²`;
            if (treat.range && (treat.range.sPanelMin !== treat.sabine.sPanel || treat.range.sPanelMax !== treat.sabine.sPanel)) {
              sabineAreaStr = `<strong>${treat.sabine.sPanel.toFixed(1)} m²</strong><br/><small class="text-muted">range: ${treat.range.sPanelMin.toFixed(1)}–${treat.range.sPanelMax.toFixed(1)} m²</small>`;
            }

            let eyringAreaStr = `${treat.eyring.sPanel.toFixed(1)} m²`;
            if (treat.eyring.isDeadRoom) {
              eyringAreaStr += ` <span class="badge badge-info" title="Mean absorption α_avg > 0.3; Eyring formula is physically more accurate">ᾱ > 0.3</span>`;
            }

            tr.innerHTML = `
              <td><strong>${band} Hz</strong></td>
              <td>${treat.sabine.aNow.toFixed(1)}</td>
              <td>${treat.sabine.aTarget.toFixed(1)}</td>
              <td>${treat.sabine.deltaA.toFixed(1)}</td>
              <td>${sabineAreaStr}</td>
              <td>${eyringAreaStr}</td>
            `;
          }
          treatmentPhysicalTbody.appendChild(tr);
        }
      }

      if (textLowFreqCaveat) {
        textLowFreqCaveat.textContent = LOW_FREQ_CAVEAT;
      }

      // Guard Alerts
      if (alertAlphaIneffective) {
        alertAlphaIneffective.hidden = !materialIneffectiveMsg;
        if (materialIneffectiveMsg) alertAlphaIneffective.textContent = `⚠️ ${materialIneffectiveMsg}`;
      }

      if (alertAreaExceeded) {
        alertAreaExceeded.hidden = !areaExceededMsg;
        if (areaExceededMsg) alertAreaExceeded.textContent = `⚠️ ${areaExceededMsg}`;
      }

      if (alertTargetMet) {
        alertTargetMet.hidden = !(anyUsableBand && allTargetsMet && !materialIneffectiveMsg);
      }
    } else {
      if (treatmentPhysicalSection) treatmentPhysicalSection.hidden = true;
      if (treatmentNoDimPrompt) treatmentNoDimPrompt.hidden = false;
      if (alertAlphaIneffective) alertAlphaIneffective.hidden = true;
      if (alertAreaExceeded) alertAreaExceeded.hidden = true;
      if (alertTargetMet) alertTargetMet.hidden = true;
    }
  }

  // Load external JSON presets with fallbacks
  async function loadDataFiles() {
    try {
      const [tRes, mRes, uRes] = await Promise.all([
        fetch('./src/data/targets.json'),
        fetch('./src/data/materials.json'),
        fetch('./src/data/uncertainty.json'),
      ]);
      if (tRes && tRes.ok) {
        const tData = await tRes.json();
        if (tData.presets && tData.presets.length > 0) {
          targetPresets = tData.presets;
        }
      }
      if (mRes && mRes.ok) {
        const mData = await mRes.json();
        if (mData.materials && mData.materials.length > 0) {
          materialsList = mData.materials;
        }
      }
      if (uRes && uRes.ok) {
        const uData = await uRes.json();
        uncertaintyData = uData;
        if (uData.typicalTwoSigmaPct) {
          typicalUncertaintyPct = { ...DEFAULT_UNCERTAINTY_PCT, ...uData.typicalTwoSigmaPct };
        }
      }
    } catch (e) {
      console.warn('Using built-in treatment presets:', e);
    }
    populateTargetPresetsUI();
    populateMaterialsUI();
    updateTreatmentUI();
  }

  // -------------------------------------------------------------
  // Subscribe to Model Updates
  // -------------------------------------------------------------
  model.subscribe(({ type }) => {
    if (type === 'activeBand') {
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
      updateTreatmentUI();
    } else if (type === 'point_selected') {
      updateHeatmapUI();
      renderMeasurementList();
      populateAttachPointSelect();
    } else if (type === 'session_loaded') {
      updateFakeWarningUI();
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
      populateAttachPointSelect();
      updateTreatmentUI();
    } else {
      updateFakeWarningUI();
      updateBandSelectorUI(model.activeBand);
      updateHeatmapUI();
      renderMeasurementList();
      populateAttachPointSelect();
      updateTreatmentUI();
      scheduleAutoSave();
    }
  });

  window.addEventListener('resize', () => {
    if (currentMode === 'heatmap') {
      updateHeatmapUI();
    }
    if (currentAnalysisResult && currentAnalysisResult.ok) {
      drawIrPlot(canvasIrPlot, currentAnalysisResult.irPlot);
      drawEdcPlot(canvasEdcPlot, currentAnalysisResult.edcPlot);
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
  populateAttachPointSelect();
  drawIrPlot(canvasIrPlot, null);
  drawEdcPlot(canvasEdcPlot, null);
  updateFakeWarningUI();
  updateHeatmapUI();
  loadDataFiles();

  // -------------------------------------------------------------
  // Guided Flow Navigation (1 Room, 2 Measure, 3 Map, 4 Treat, Show All)
  // Navigation only: no changes to DSP, analysis, or storage logic.
  // -------------------------------------------------------------
  const stepStatus1 = document.getElementById('step-status-1');
  const stepStatus2 = document.getElementById('step-status-2');
  const stepStatus3 = document.getElementById('step-status-3');
  const stepStatus4 = document.getElementById('step-status-4');
  const stepButtons = document.querySelectorAll('.step-nav-btn');

  function updateStepStatuses() {
    // Step 1: Room (Never requires dimensions)
    if (stepStatus1) {
      const dims = model.roomDimensions;
      if (dims && Number.isFinite(dims.lengthM) && Number.isFinite(dims.widthM)) {
        stepStatus1.textContent = `${dims.lengthM.toFixed(1)}×${dims.widthM.toFixed(1)}m`;
      } else {
        stepStatus1.textContent = 'dimensions: optional';
      }
    }

    // Step 2: Measure
    if (stepStatus2) {
      const pts = model.measurements || [];
      const measured = pts.filter((p) => p.status === 'measured').length;
      if (pts.length === 0) {
        stepStatus2.textContent = 'Ready to measure';
      } else {
        stepStatus2.textContent = `${measured} of ${pts.length} measured`;
      }
    }

    // Step 3: Map
    if (stepStatus3) {
      const pts = model.measurements || [];
      const usable = getUsablePoints(pts, model.activeBand).length;
      if (usable >= 4) {
        stepStatus3.textContent = `Heatmap (${usable} pts)`;
      } else if (pts.length > 0) {
        stepStatus3.textContent = `${pts.length} ${pts.length === 1 ? 'pt' : 'pts'} mapped`;
      } else {
        stepStatus3.textContent = 'Floor plan';
      }
    }

    // Step 4: Treat
    if (stepStatus4) {
      const selectPreset = document.getElementById('select-target-preset');
      const presetName = selectPreset && selectPreset.selectedOptions && selectPreset.selectedOptions[0]
        ? selectPreset.selectedOptions[0].textContent.split('(')[0].trim()
        : 'Targets & panels';
      stepStatus4.textContent = presetName || 'Targets & panels';
    }
  }

  let currentStep = 'all';
  try {
    const savedStep = localStorage.getItem('echomap_guided_step');
    if (savedStep && ['1', '2', '3', '4', 'all'].includes(savedStep)) {
      currentStep = savedStep;
    }
  } catch (_) {}

  function setGuidedStep(step) {
    currentStep = step;
    try {
      localStorage.setItem('echomap_guided_step', step);
    } catch (_) {}

    stepButtons.forEach((btn) => {
      const isTarget = btn.getAttribute('data-step') === step;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', String(isTarget));
    });

    const sessionCard = document.querySelector('.session-card');
    const dimensionsPanel = document.getElementById('dimensions-panel');
    const floorplanCard = document.querySelector('.floorplan-card');
    const analyzeCard = document.getElementById('analyze-card');
    const heatmapCard = document.getElementById('heatmap-card');
    const treatmentCard = document.getElementById('treatment-card');
    const bandSelectorCard = document.querySelector('.band-selector-card');
    const measurementsCard = document.querySelector('.measurements-card');
    const quickStatusCard = document.querySelector('.quick-status');

    if (step === 'all') {
      if (sessionCard) sessionCard.hidden = false;
      if (dimensionsPanel) dimensionsPanel.hidden = false;
      if (floorplanCard) floorplanCard.hidden = false;
      if (analyzeCard) analyzeCard.hidden = false;
      if (treatmentCard) treatmentCard.hidden = false;
      if (bandSelectorCard) bandSelectorCard.hidden = false;
      if (measurementsCard) measurementsCard.hidden = false;
      if (quickStatusCard) quickStatusCard.hidden = false;
      if (heatmapCard) heatmapCard.hidden = currentMode !== 'heatmap';
    } else if (step === '1') {
      if (sessionCard) sessionCard.hidden = false;
      if (dimensionsPanel) dimensionsPanel.hidden = false;
      if (floorplanCard) floorplanCard.hidden = false;
      if (quickStatusCard) quickStatusCard.hidden = false;
      if (analyzeCard) analyzeCard.hidden = true;
      if (heatmapCard) heatmapCard.hidden = true;
      if (treatmentCard) treatmentCard.hidden = true;
      if (bandSelectorCard) bandSelectorCard.hidden = true;
      if (measurementsCard) measurementsCard.hidden = true;
    } else if (step === '2') {
      if (analyzeCard) analyzeCard.hidden = false;
      if (sessionCard) sessionCard.hidden = false;
      if (quickStatusCard) quickStatusCard.hidden = false;
      if (dimensionsPanel) dimensionsPanel.hidden = true;
      if (floorplanCard) floorplanCard.hidden = true;
      if (heatmapCard) heatmapCard.hidden = true;
      if (treatmentCard) treatmentCard.hidden = true;
      if (bandSelectorCard) bandSelectorCard.hidden = true;
      if (measurementsCard) measurementsCard.hidden = true;
    } else if (step === '3') {
      if (floorplanCard) floorplanCard.hidden = false;
      if (bandSelectorCard) bandSelectorCard.hidden = false;
      if (measurementsCard) measurementsCard.hidden = false;
      if (quickStatusCard) quickStatusCard.hidden = false;
      if (heatmapCard) heatmapCard.hidden = currentMode !== 'heatmap';
      if (sessionCard) sessionCard.hidden = true;
      if (dimensionsPanel) dimensionsPanel.hidden = true;
      if (analyzeCard) analyzeCard.hidden = true;
      if (treatmentCard) treatmentCard.hidden = true;
    } else if (step === '4') {
      if (treatmentCard) treatmentCard.hidden = false;
      if (bandSelectorCard) bandSelectorCard.hidden = false;
      if (dimensionsPanel) dimensionsPanel.hidden = false;
      if (quickStatusCard) quickStatusCard.hidden = false;
      if (sessionCard) sessionCard.hidden = true;
      if (floorplanCard) floorplanCard.hidden = true;
      if (analyzeCard) analyzeCard.hidden = true;
      if (heatmapCard) heatmapCard.hidden = true;
      if (measurementsCard) measurementsCard.hidden = true;
    }

    if (view && (step === '1' || step === '3' || step === 'all')) {
      view.resizeCanvas();
      view.render();
    }
  }

  stepButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = btn.getAttribute('data-step');
      if (step) setGuidedStep(step);
    });
  });

  setGuidedStep(currentStep);
  updateStepStatuses();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
