# PROJECT BRIEF: Room Acoustic Analyzer (installable web app / PWA)

You are helping two second-year CS students build a course project for a Linear Systems and Signal Processing class. Neither of us knows mobile or web development. Our goals, in priority order:

1. A genuinely working app that gives correct acoustic numbers.
2. We deeply understand the signal processing and the code. You are our mentor as much as our builder.
3. A clean, good-looking, phone-first UI.

Correctness and honesty matter more than speed. Take your time.

---

## 0. HOW YOU MUST WORK (non-negotiable rules)

1. **Plan first, code later.** Before writing any code, produce an implementation plan and task list covering all phases below, then STOP and wait for my approval.
2. **One phase at a time.** Finish a phase, run its tests, show me the real output, write the learning note, and STOP. Do not start the next phase until I say "go".
3. **Never invent things.** Do not make up browser APIs, library functions, package names, versions, filter coefficients, or material absorption values. If you are not sure something exists or works a certain way, say so and verify it (official docs such as MDN, or by running code). "I'm not sure" is a good answer.
4. **Never claim something works without running it.** Run the tests/scripts yourself and paste the actual output. If you cannot run something (for example, a test that needs a real phone microphone), say so clearly and tell me exactly how I should test it.
5. **Ask when in doubt.** If a requirement is ambiguous or a decision has real trade-offs, ask me with 2-3 options and your recommendation. Do not silently guess. Prefer a question over a wrong assumption.
6. **No scope creep.** Build only what this brief says. If you think something extra is worth adding, propose it and wait.
7. **Zero dependencies by default.** Vanilla HTML/CSS/JS with ES modules, no framework, no bundler, no build step. If you believe a library is truly needed, ask first, and pin an exact version.
8. **Be honest about limits.** If a result is unreliable (noisy measurement, small-room low-frequency behaviour, model assumptions), the app and your explanations must say so. Do not present estimates as exact.
9. **Small, reviewable steps.** Use git. Commit after each completed task with a clear message.
10. **Teach as you go.** After every phase, write `docs/learning/phaseN.md` containing: (a) the concept in plain language, (b) the formulas used, (c) which file/function implements each, (d) common beginner mistakes, (e) three questions to check our understanding. Explain the code you wrote in simple terms.

### Questions you must ask me BEFORE writing the plan
- Which phones will we test on (Android or iOS, model, browser)?
- Do we have a second device (old phone, laptop, Bluetooth speaker) to act as the fixed sound source?
- Is Node.js installed on my machine, and which version?
- Do we have a GitHub account/repo for hosting (GitHub Pages)?
- What kind of room is the target (home studio, vocal booth, control room) and rough dimensions?

---

## 1. WHAT THE APP DOES

The app measures how a room reverberates and tells us how much acoustic absorption to add.

Flow:
1. User enters room dimensions (length, width, height in metres) and draws/sets a simple floor plan.
2. A **fixed sound source** plays a test sweep.
3. The phone is moved to several positions in the room. At each position it records the sweep and computes the room's reverberation time (RT60) in several frequency bands.
4. The app builds a **heatmap** of RT60 over the floor plan, per frequency band.
5. The user picks a target RT60. The app estimates how much extra absorption is needed and what that means in square metres of a chosen material.

**Important terminology (put this in the app's help text too):** this app deals with **absorption / reverberation control** (making a room sound less echoey). It does NOT measure or design **sound insulation / soundproofing** (blocking sound from going through walls). These are different problems. Do not blur them.

---

## 2. DECISIONS ALREADY MADE

- Platform: **PWA** (installable web app), opened in the phone browser and added to the home screen. Not a native app.
- Language: vanilla JavaScript (ES modules), HTML, CSS.
- Position input: **manual**. The user taps their position on a floor-plan canvas before each measurement. No IMU or AR tracking.
- Room shape: rectangular only in v1.
- Storage: browser storage (IndexedDB or localStorage). No backend, no accounts.
- Hosting: static hosting (GitHub Pages or similar). Microphone access requires a secure context, so the deployed app must be HTTPS. Local development works on `localhost`, but opening a laptop's LAN IP over plain http on a phone will NOT allow microphone access. Tell me how to test on a real phone (for example, by deploying early).
- Two roles in one app:
  - **Source mode:** plays the sweep (run this on the second device placed at a fixed spot).
  - **Measure mode:** records and analyses (run this on the phone we carry around).
  - Also provide a single-device fallback where the same phone plays and records, clearly labelled as less representative since the source then moves with the phone. Ask me to confirm this design in your plan.

---

## 3. ARCHITECTURE AND FILE STRUCTURE

Keep all DSP code in pure, browser-independent ES modules so it can be unit-tested in Node. Browser-specific code (audio I/O, canvas, DOM) stays separate.

```
/index.html
/manifest.webmanifest
/sw.js                      service worker (cache app shell, versioned cache name)
/icons/                     192px and 512px PNG icons
/src/
  dsp/
    sweep.js                exponential sweep + inverse filter
    fft.js                  FFT / IFFT (own radix-2 implementation, or a vetted vendored lib)
    deconvolve.js           frequency-domain deconvolution -> impulse response
    bands.js                octave-band filtering
    rt60.js                 Schroeder integration, T20/T30/EDT, validity checks
    sabine.js               absorption and treatment math
  audio/
    mic.js                  getUserMedia + AudioWorklet capture
    recorder-worklet.js     AudioWorkletProcessor that collects raw samples
    player.js               plays the generated sweep
  ui/
    floorplan.js            canvas floor plan + tap-to-place
    heatmap.js              IDW interpolation + colour rendering
    screens.js              screen/state management
  data/
    materials.json          editable absorption table (see section 4.6)
    targets.json            editable RT60 target presets
  store/
    storage.js              save/load sessions
/tests/                     Node tests for src/dsp
/reference/                 Python reference scripts (numpy/scipy) used to validate the JS
/docs/learning/             phase notes
```

---

## 4. DSP SPECIFICATION

Use the actual `AudioContext.sampleRate` of the device. Do not assume 44100 or 48000. The sweep, recording and processing must all use the same rate.

### 4.1 Excitation: exponential sine sweep (Farina method)
For 0 <= t <= T, with f1 (start Hz), f2 (end Hz):

```
L = T / ln(f2 / f1)
K = 2*pi * f1 * L
x(t) = sin( K * (exp(t / L) - 1) )
```
- Defaults: f1 = 50 Hz (ask me before changing), f2 = 12000 Hz (phone speakers/mics are limited at the extremes; justify what you choose), T between 5 and 10 s.
- Apply short fade-in/out (a few ms to tens of ms) to avoid clicks.

**Inverse filter:** time-reverse the sweep and apply an amplitude envelope that falls at 6 dB per octave:
```
x_inv(t) = x(T - t) * exp(-t / L)
```
Verify numerically (in Python and JS) that convolving the sweep with its inverse filter gives a sharp peak. Do not skip this check.

### 4.2 Deconvolution -> impulse response
```
y = recorded signal
h = IFFT( FFT(y) * FFT(x_inv) )   (zero-pad to a power of two >= len(y) + len(x_inv) - 1)
```
- The linear impulse response appears at the largest peak. Harmonic distortion products appear BEFORE it in time, so start the IR a few milliseconds before the peak and ignore the earlier region.
- Because the peak is found automatically, we do not need to synchronise the source and the recorder. The sweep can start at any moment during recording. Record long enough to cover the whole sweep plus a decay tail (at least ~2 s after the sweep ends, longer for big/live rooms).
- Normalise the IR by its peak.

### 4.3 Microphone capture (critical)
- Request the stream with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, mono. Browsers may apply these by default and they destroy the measurement. After getting the stream, read back the track's actual settings (`getSettings()`) and show a warning in the UI if any of them are still on.
- Capture raw Float32 samples with an **AudioWorklet**. Do NOT use `MediaRecorder` (it produces compressed audio) and do NOT use the deprecated `ScriptProcessorNode`.
- Resume the `AudioContext` from a user tap (required on mobile browsers).
- Before each measurement: record ~2 s of silence, estimate the background noise level, and warn if it is too high. After recording: check for clipping (samples near +/-1.0) and reject or warn.
- Use the Screen Wake Lock API only if the browser supports it (feature-detect), so the screen does not sleep mid-measurement.

### 4.4 Octave-band analysis
- Centre frequencies: 125, 250, 500, 1000, 2000, 4000 Hz (band edges at fc / sqrt(2) and fc * sqrt(2)). 63 Hz and 8000 Hz optional and off by default (weak phone speaker/mic response there). Ask me before enabling.
- Default filter: 4th-order Butterworth band-pass per band. Validate your implementation against `scipy.signal` in Python. Explain (in the learning note) why a filter's own ringing can bias the result at low frequencies, and document the choice you make.

### 4.5 RT60 from the impulse response (Schroeder method)
```
EDC[n]   = sum_{k=n}^{N-1} h[k]^2            (reverse cumulative sum of squared IR)
EDC_dB[n] = 10 * log10( EDC[n] / EDC[0] )
```
- **T20:** least-squares line fit of EDC_dB between -5 dB and -25 dB; `T20 = -60 / slope`.
- **T30:** same between -5 dB and -35 dB; `T30 = -60 / slope`.
- **EDT** (optional): fit from 0 to -10 dB, `EDT = -60 / slope`.
- Also compute the fit's R^2 (or correlation) as a quality indicator.
- **Noise handling:** the background noise floor flattens the decay curve and makes RT60 look too long. Truncate the IR where the smoothed squared envelope reaches the noise floor, and compensate for the remaining noise energy. If you implement a simplified method, call it "simplified noise-floor truncation". Do NOT call it the Lundeby method unless you implemented it faithfully, and say what you did.
- **Validity rules:** report T30 only if the usable decay range covers at least 35 dB above the noise floor; otherwise fall back to T20 if at least 25 dB is available; otherwise mark the band **invalid**. Each reading stores which estimate was used.

Output per position:
```
{ x, y, timestamp, snrDb, clipped, bands: { "125": { t20, t30, edt, r2, used, valid }, ... } }
```

### 4.6 Absorption and treatment (Sabine)
Metric units: V = room volume in m^3, S = total surface area in m^2.
```
RT60 = 0.161 * V / A          A = total absorption in m^2 sabins = sum(S_i * alpha_i)
A_now    = 0.161 * V / RT60_measured
A_target = 0.161 * V / RT60_target
Delta_A  = A_target - A_now
```
- Use the average of the **valid** measured RT60 values per band.
- Area of a chosen material needed: `S_panel = Delta_A / (alpha_material - alpha_existing_surface)`, because the panel replaces whatever surface was there. Make `alpha_existing_surface` an editable input.
- Cross-check with the Eyring formula when the average absorption coefficient is high, and show both.
- `materials.json`: each entry has a name, alpha per band, and a `source` field. **Do not fabricate coefficients.** Fill it with clearly marked placeholder values (`"placeholder": true`) and tell me which real manufacturer datasheets/standard tables we should copy numbers from. The UI must show a "placeholder values, verify with datasheet" notice wherever these are used.
- `targets.json`: preset RT60 targets (for example small control room, vocal booth, live room) as editable rule-of-thumb values. Tell me honestly what source each preset comes from, and mark any you cannot source as "rule of thumb".
- State the model's limits in the UI: Sabine assumes a diffuse sound field. In small rooms, low-frequency behaviour is dominated by room modes, so results below roughly the 250 Hz band are less reliable and the model cannot design bass traps accurately.
- Placement hint: highlight the regions with the longest RT60 on the heatmap and suggest treating nearby surfaces. Label this clearly as a heuristic, not a calculation.

---

## 5. PHASES (stop at the end of every phase and wait for "go")

**Phase 0: Python reference (in `/reference`).**
Generate the sweep and inverse filter, build a synthetic impulse response with a known RT60 (exponentially decaying noise: `h(t) = n(t) * exp(-6.908 * t / RT60)` with `n(t)` white noise), convolve to make a fake recording, deconvolve, run Schroeder, and show the recovered RT60 per band.
Acceptance: recovered RT60 within about 5% of the true value on synthetic data. Save a few reference outputs (numbers) for later comparison with the JS.

**Phase 1: App shell + PWA.**
Responsive layout, manifest, service worker with a versioned cache name (explain the stale-cache pitfall), icons. Deploy to HTTPS and install on a real phone.
Acceptance: installs, opens full-screen, works offline after first load.

**Phase 2: Pure-JS DSP + tests (Node).**
Port sweep, FFT, deconvolution, band filtering, Schroeder/T20/T30, Sabine to `src/dsp`. Tests with Node's built-in test runner (`node:test`), no extra dependencies.
Acceptance: JS results match the Python reference within a stated tolerance; FFT/IFFT round-trip test passes; sweep-times-inverse-filter test gives a sharp peak; synthetic-IR RT60 recovered within about 5%.

**Phase 3: Audio I/O in the browser.**
Sweep playback, AudioWorklet capture with processing disabled, noise-floor check, clipping check, Source mode and Measure mode (and single-device fallback). Show a live level meter.
Acceptance: on a real phone, a measurement produces an impulse response plot and RT60 per band that look physically sensible (decay curves are roughly straight lines on the dB plot, low bands usually longer than high bands). Report honestly what you could and could not verify without a physical device.

**Phase 4: Floor plan + data capture.**
Room dimensions form, canvas floor plan with scale in metres, tap to place the source and each measurement position, list of saved points, save/load sessions, export to JSON and CSV.
Acceptance: positions map correctly from canvas pixels to metres (include a unit test for the transform).

**Phase 5: Heatmap.**
Inverse-distance-weighted interpolation (power 2) over a grid covering the room, colour scale with legend, band selector, markers for measurement points and the source, clear message if fewer than 4 valid points exist (recommend 9 or more).
Acceptance: interpolation reproduces measured values at the measured points; test with synthetic data.

**Phase 6: Treatment calculator.**
Section 4.6 implemented with a clear results screen and the honest limitations text.
Acceptance: hand-checked example worked out in the learning note.

**Phase 7: Polish and hardening.**
UI cleanup, error states (mic denied, no secure context, unsupported browser), accessibility basics, final README with setup, deployment steps, how to run tests, and a "known limitations" section.

---

## 6. UI / UX

- Phone-first, single column, large tap targets, light and dark mode.
- A clear measurement wizard: place phone -> mark position -> check noise -> start -> progress -> result.
- Show the decay curve (EDC in dB) for each measurement so we can visually judge quality.
- Every number shown has its unit. Invalid or low-confidence values are visibly flagged, never hidden.
- Short in-app help for each concept (RT60, absorption vs insulation, why we turn off echo cancellation).

---

## 7. PITFALLS CHECKLIST (verify each one explicitly)

- Echo cancellation / noise suppression / auto gain left on
- `AudioContext` not resumed after a user gesture
- Assuming a fixed sample rate
- Using `MediaRecorder` instead of raw samples
- Clipping in playback or recording
- FFT length not large enough, causing circular-convolution wrap-around
- Peak detection picking a reflection or noise instead of the direct sound
- Noise floor inflating RT60
- Using too narrow or too noisy a dB range for the line fit
- Treating Sabine results as exact in a small room
- Service worker serving a stale cached version after an update
- Microphone not working on plain http (needs HTTPS or localhost)
- Behaviour differences between browser tab and installed home-screen mode on the actual phones (test both and report; do not assume)

---

## 8. DEFINITION OF DONE

- All phase acceptance criteria met, with real test output shown.
- Installed and tested on at least one real phone, with a real measurement in a real room.
- README and `docs/learning/` notes complete.
- Limitations clearly documented.
- No fabricated numbers anywhere (materials, targets, thresholds all sourced or flagged).

---

## 9. YOUR FIRST RESPONSE

Do NOT write code yet. Reply with:
1. Your clarifying questions from section 0 and any others you have.
2. Anything in this brief that is unclear, risky, or technically wrong. Challenge it if you think it is wrong.
3. After I answer, your implementation plan and task list, then wait for my approval.
