# Phase 3a-2e: gate evidence, robustness battery, diagnostics, docs

## Rules
- Do NOT touch src/dsp or reference/.
- Do NOT change any threshold, constant or decision logic (checkSweepSignature, PNR, deltaPostPre) in this task. Report only.
- All existing tests must pass UNMODIFIED. Add new tests only.
- Short task list first, wait for my OK. If anything is ambiguous, ask me.
- Run the full suite, show the whole output, commit, then stop.

## 1. Positive-side evidence for the sweep-signature gate
Print a table (ordering score, margin to the rejection threshold, per-band peak times, verdict) for:
- both clean fixtures and the 44.1 kHz fixture
- the same sweep placed at offsets of 0.5 s, 3 s, 10 s and 20 s inside a 30 s recording
- rooms with RT60 0.3, 0.8 and 1.5 s
- every step of the white and brown noise ladders
- the negative cases: clap, noisy clap, noise plus burst, hum plus noise, noise only, silence
Add tests asserting positives are accepted and negatives rejected. Report the smallest margin on each side.

## 2. Robustness battery (report only)
Print the same table for:
a) the sweep with a loud broadband thump (louder than the sweep in the 125 to 500 Hz bands) at the start, in the middle and at the end
b) the sweep through a phone-speaker model (high-pass near 150 to 200 Hz at 12 dB/oct, gentle roll-off above 6 kHz) plus brown-noise rumble, with the 125 Hz band at least 20 dB below the others
c) the same sweep played twice back to back
d) a cough-like burst during the sweep
e) sweep plus 50 Hz hum at -30, -20, -10 and 0 dB relative to the sweep
If any positive case is rejected: STOP after reporting. Propose a predicted-time template gate (start time from the deconvolution peak; compare band energy at the expected times with the background; require at least 4 of 6 bands), show the same battery results for the prototype, and WAIT for my approval before wiring it in.

## 3. Diagnostics in the UI
On both accepted and rejected recordings, show a collapsed "Details" section: PNR, deltaPostPre, ordering score and threshold, per-band peak times, sample rate, duration, and which gate fired. A rejection must not claim a clap was recorded unless the evidence supports it (use neutral wording when the cause is unclear). Bump the service worker cache version and update the PWA tests if any app file changes.

## 4. Stale text and docs
The printed "Non-Stationary Noise Findings" paragraph still describes the old behaviour (clap offers the override and returns numbers) while the table says all three cases are rejected. Update the text to match, and update the README and docs/learning/phase3a2.md (the clap case was previously accepted by the PNR logic and is now blocked by the signature gate).
