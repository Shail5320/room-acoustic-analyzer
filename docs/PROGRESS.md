# EchoMap — Progress

> Auto-updated after each phase. See [docs/PLAN.md](PLAN.md) for full task details.

## Current Status

Phase 0b completed (Butterworth filters, Schroeder RT60, noise tests, ground truth `reference/expected_outputs.json`, and learning note `docs/learning/phase0.md`). Phase 2a is unblocked.

## Phase Tracker

| Phase | Description | Status | Completed |
|---|---|---|---|
| 0a | Python ref: sweep, synthetic IRs, deconvolution | Completed | 2026-10-16 |
| 0b | Python ref: filters, Schroeder RT60, expected_outputs | Completed | 2026-10-16 |
| 1 | App shell + PWA | Completed | 2026-10-16 |
| 2a | DSP core (FFT, sweep, deconvolution, filters) | Ready to start | — |
| 2b | DSP analysis (Schroeder, RT60, noise floor, Sabine) | Not started | — |
| 3a | Audio I/O + measurement flow | Not started | — |
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
