# EchoMap — Progress

> Auto-updated after each phase. See [docs/PLAN.md](PLAN.md) for full task details.

## Current Status

Phase 2b completed (Pure ES modules in `src/dsp/`: `rt60.js` implementing the 8-step simplified noise-floor truncation, Schroeder backward integration, T20/T30/EDT linear regression, and 3-tier validity classification; `sabine.js` implementing dimensionless absorption ratio, room geometry, optional Sabine treatment panel sizing, and Eyring cross-checks. All 47 tests across the entire test suite pass with zero failures under `node:test` against Tier-1 tolerances [difference ≤ 0.000034 s vs expected_outputs.json] and Tier-2 Monte Carlo empirical bounds; `docs/learning/phase2.md` written). Ready for Phase 3a.

## Phase Tracker

| Phase | Description | Status | Completed |
|---|---|---|---|
| 0a | Python ref: sweep, synthetic IRs, deconvolution | Completed | 2026-10-16 |
| 0b | Python ref: filters, Schroeder RT60, expected_outputs | Completed | 2026-10-16 |
| 0c | Python ref: noise DR, 30-seed Monte Carlo, tolerances | Completed | 2026-10-16 |
| 0d | Python ref: validity tiers, truncation spec, target audit | Completed | 2026-10-16 |
| 1 | App shell + PWA | Completed | 2026-10-16 |
| 2a | DSP core (FFT, sweep, deconvolution, filters) | Completed | 2026-10-17 |
| 2b | DSP analysis (Schroeder, RT60, noise floor, Sabine) | Completed | 2026-10-17 |
| 3a | Audio I/O + measurement flow | Ready to start | — |
| 3b | Web Worker, single-device, results, deploy | Not started | — |
| 4 | Floor plan + data capture | Not started | — |
| 5 | Heatmap | Not started | — |
| 6 | Treatment calculator | Not started | — |
| 7 | Polish + hardening | Not started | — |

## Decisions Log

| Date | Decision |
|---|---|
| 2026-10-16 | Plan approved. Phase 0 owned by students. App named "EchoMap". |
| 2026-10-16 | Sweep: f1=50 Hz, f2=8000 Hz, T=5 s (config constants). |
| 2026-10-16 | Floor plan: relative coords (0–1), aspect ratio control (default 4:3). |
| 2026-10-16 | Primary output: dimensionless absorption ratio. Dimensions optional. |
| 2026-10-16 | Butterworth: N=2 design order → 4th-order bandpass → 2 SOS sections. |
| 2026-10-16 | Single-device fallback confirmed (build after two-device). |
| 2026-10-16 | Deploy: GitHub Pages from main branch, root. All paths relative. |
| 2026-10-16 | Phase 1 completed: app shell, PWA manifest, service worker with versioned cache echomap-v1, and icons. |
| 2026-10-16 | Phase 0 reinstated and assigned to assistant; split into Phase 0a and 0b. |
| 2026-10-16 | Phase 0a completed: sweep, inverse filter, synthetic IRs (single & multi-band), and frequency-domain deconvolution reference scripts and plots. |
| 2026-10-16 | Phase 0b completed: octave Butterworth filters, Schroeder EDC, T20/T30/EDT extraction, validity rules, noise-floor truncation test, ground truth expected_outputs.json, and phase0.md learning notes. |
| 2026-10-16 | Phase 0c completed: noise dynamic range (DR) evaluated at 45, 35, 25, 15 dB; un-truncated Schroeder corruption identified and rejected via depth and R² >= 0.95 checks; 30-seed Monte Carlo proved 125 Hz deviation is stochastic scatter while multi-band high-frequency error is filter leakage bias; two-tier Phase 2 acceptance criteria established in PLAN.md. |
| 2026-10-16 | Phase 0d completed: named threshold constants and 3 validity tiers ("valid", "approximate", "invalid") defined in `rt60.py`; DR 45/35/25/15 table updated with audit showing single approximate row (DR 35 dB truncated, error -11.14%) well within 15%; simplified noise-floor truncation algorithm fully specified as numbered steps in `docs/learning/phase0.md` and Phase 2b of `docs/PLAN.md`; multi-RT60 targets documented with synthesis overlap +6% shift and empirical Monte Carlo Tier-2 tolerances (filter order N=2 preserved); only RT60 and noise sections regenerated in `expected_outputs.json` with zero fixture regeneration. |
| 2026-10-17 | Phase 2a completed: implemented pure ES modules in `src/dsp/` (`fft.js`, `sweep.js`, `deconvolve.js`, `bands.js`) with zero external runtime dependencies; fixed 12-decimal truncation in `expected_outputs.json` filter serialization to retain full IEEE 754 precision; verified all 6 octave bands meet ≤ 1e-8 relative coefficient tolerance and ≤ 0.01 dB magnitude response; implemented silence, noise-only, and SNR sweep PNR rejection tests in `tests/deconvolve.test.js`; all 27 tests passing. |
| 2026-10-17 | Phase 2b completed: implemented pure ES modules `src/dsp/rt60.js` (8-step simplified noise-floor truncation, Schroeder backward integration, T20/T30/EDT linear regression, R², 3-tier validity classification) and `src/dsp/sabine.js` (dimensionless absorption ratio, room geometry, optional Sabine panel treatment sizing, Eyring cross-check); verified Tier 1 (per-band RT60 matches expected_outputs.json to ≤ 0.000034 s), Tier 2 (within Monte Carlo 2σ empirical bounds), and DR 45/35/25/15 noise table matching Python reference tiers and values; all 47 tests passing under `node:test`; `docs/learning/phase2.md` written. |
