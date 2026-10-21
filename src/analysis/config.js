/**
 * src/analysis/config.js — Shared configuration and rejection thresholds.
 *
 * Defines sweep parameters, validation limits, and acoustic analysis thresholds
 * used across measurement capture, Web Worker execution, and DSP analysis.
 */

// ---------------------------------------------------------------------------
// Sweep Configuration (used by playback and analysis)
// ---------------------------------------------------------------------------
export const SWEEP_F1 = 50.0;        // Start frequency (Hz)
export const SWEEP_F2 = 8000.0;      // End frequency (Hz)
export const SWEEP_DURATION_S = 5.0; // Duration T (s)
export const SWEEP_FADE_MS = 20.0;   // Half-Hann fade in/out length (ms)

// ---------------------------------------------------------------------------
// Rejection and Validation Thresholds
// ---------------------------------------------------------------------------
export const PNR_THRESHOLD_DB = 20.0;         // Minimum peak-to-noise ratio (dB)
export const LOW_PNR_OVERRIDE_MIN_DB = 10.0;  // Floor for conditional PNR override (dB)
export const LOW_PNR_POST_PRE_MARGIN_DB = 1.5; // Minimum post-peak (200ms) vs pre-peak energy margin (dB)
export const MIN_SAMPLE_RATE = 22050;         // Minimum recording sample rate (Hz)
export const MIN_RECORDING_DURATION_S = 8.0;  // T + 3 s tail = 8.0 s
export const MAX_RECORDING_DURATION_S = 30.0; // Memory guard (30.0 s)
export const CLIPPING_THRESHOLD = 0.99;       // Absolute sample threshold for clipping
export const SILENCE_THRESHOLD = 1e-6;        // Max absolute sample value below which signal is silent
export const DECAY_TAIL_MARGIN_DB = 6.0;      // Tail envelope threshold above pre-peak noise floor (dB)

// ---------------------------------------------------------------------------
// Sweep Template Gate Validation (Predicted-Time Gate)
// ---------------------------------------------------------------------------
export const TEMPLATE_GATE_WIN_HALF_S = 0.15;     // Half-window tolerance around predicted time t_k (s)
export const TEMPLATE_GATE_MIN_MARGIN_DB = 10.0;  // Required energy margin above background per band (dB)
export const TEMPLATE_GATE_MIN_BANDS = 4;         // Minimum matched bands out of 6
export const TEMPLATE_GATE_BLOCK_MS = 50.0;       // Band background integration block length (ms)
export const TEMPLATE_GATE_HOP_MS = 25.0;         // Band background integration hop length (ms)
export const CLAP_MAX_SPREAD_S = 0.15;            // Maximum spread across all 6 band peak times to identify a clap (s)

export const formatTemplateGateRejectMessage = (matchedBands) =>
  `Couldn't confirm the EchoMap test sweep (found ${matchedBands} of 6 expected frequency bands at the expected times). Check the sweep played in full and that recording started before it.`;

// ---------------------------------------------------------------------------
// Legacy Sweep Signature Validation (Octave Band Progression Gate - battery only)
// ---------------------------------------------------------------------------
export const SWEEP_SIG_MIN_SCORE = 0.65;          // Minimum continuous progression score [0, 1]
export const SWEEP_SIG_MIN_MONOTONIC_STEPS = 4;   // Minimum number of positive intervals (out of 5)
export const SWEEP_SIG_MIN_SPAN_S = 2.2;          // Minimum total octave span t_4000 - t_125 (s)
export const SWEEP_SIG_MAX_SPAN_S = 4.8;          // Maximum total octave span t_4000 - t_125 (s)
export const SWEEP_SIG_BLOCK_MS = 50.0;           // Band energy integration window length (ms)
export const SWEEP_SIG_HOP_MS = 25.0;             // Band energy integration hop length (ms)
export const SWEEP_REJECT_NOT_SWEEP =
  "This doesn't look like the EchoMap test sweep (a clap or another sound was recorded instead). Play the downloaded sweep.";
export const SWEEP_REJECT_NO_SWEEP =
  'No sweep detected — make sure the source played during recording';

// ---------------------------------------------------------------------------
// IR Extraction & Octave Band Configuration
// ---------------------------------------------------------------------------
export const OCTAVE_CENTRES = [125, 250, 500, 1000, 2000, 4000];
export const IR_DURATION_S = 2.5;             // Standard impulse response extraction length (s)
export const PRE_PEAK_MS = 5.0;               // Protected direct-sound lead-in before peak (ms)
export const IR_PLOT_POINTS = 600;            // Number of points for downsampled IR plot
export const EDC_PLOT_POINTS = 300;           // Number of points for downsampled EDC curves per band

export const PIPELINE_CONFIG = {
  f1: SWEEP_F1,
  f2: SWEEP_F2,
  T: SWEEP_DURATION_S,
  fadeMs: SWEEP_FADE_MS,
  pnrThresholdDb: PNR_THRESHOLD_DB,
  lowPnrOverrideMinDb: LOW_PNR_OVERRIDE_MIN_DB,
  lowPnrPostPreMarginDb: LOW_PNR_POST_PRE_MARGIN_DB,
  templateGateWinHalfS: TEMPLATE_GATE_WIN_HALF_S,
  templateGateMinMarginDb: TEMPLATE_GATE_MIN_MARGIN_DB,
  templateGateMinBands: TEMPLATE_GATE_MIN_BANDS,
  templateGateBlockMs: TEMPLATE_GATE_BLOCK_MS,
  templateGateHopMs: TEMPLATE_GATE_HOP_MS,
  clapMaxSpreadS: CLAP_MAX_SPREAD_S,
  sweepSigMinScore: SWEEP_SIG_MIN_SCORE,
  sweepSigMinSteps: SWEEP_SIG_MIN_MONOTONIC_STEPS,
  sweepSigMinSpanS: SWEEP_SIG_MIN_SPAN_S,
  sweepSigMaxSpanS: SWEEP_SIG_MAX_SPAN_S,
  minSampleRate: MIN_SAMPLE_RATE,
  minDurationS: MIN_RECORDING_DURATION_S,
  maxDurationS: MAX_RECORDING_DURATION_S,
  clippingThreshold: CLIPPING_THRESHOLD,
  silenceThreshold: SILENCE_THRESHOLD,
  decayTailMarginDb: DECAY_TAIL_MARGIN_DB,
  octaveCentres: OCTAVE_CENTRES,
  irDurationS: IR_DURATION_S,
  prePeakMs: PRE_PEAK_MS,
  irPlotPoints: IR_PLOT_POINTS,
  edcPlotPoints: EDC_PLOT_POINTS,
};
