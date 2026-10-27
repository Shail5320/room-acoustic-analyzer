# Phase 3a-3a: live microphone capture (Measure mode)

## Rules
- Do NOT touch src/dsp or existing reference files. Do not change the analysis pipeline (src/analysis); if you find a real bug there, report it and wait.
- No new dependencies, no network calls, no localStorage or IndexedDB of audio. Recordings live in memory only and are never saved unless the user taps the download button.
- Verify every Web API on MDN before using it and list the pages you checked. Do not invent constraint names or options; if a feature (e.g. voiceIsolation) is not documented for Android Chrome, do not use it.
- Short task list first, wait for my OK. Run the full suite, show the whole output, commit, then stop after this part.

## 1. Pure logic, testable in Node (src/audio/capture-core.js and wav-encode.js)
- buildConstraints(): audio constraints with echoCancellation, noiseSuppression and autoGainControl false, channelCount 1.
- evaluateSettings(settings): from track.getSettings() produce warnings; processing flags true OR unknown (undefined) both warn; report sampleRate and channelCount.
- ChunkAssembler: collects Float32 chunks tagged with the worklet frame counter, detects gaps and overlaps (dropouts count, missing frames), caps total length at the max duration, supports early stop, returns one Float32Array.
- findDigitalSilenceRuns(samples, minRunMs): runs of exact zeros longer than the threshold mid-recording are reported as a warning (possible noise gating, processing or dropout), not a rejection.
- levelDbfs, peak and clipped-sample count helpers. Provisional thresholds in config.js (named constants, not magic numbers).
- planRecordingDuration: default 20 s, minimum 8 s, maximum 30 s.
- CaptureStateMachine: idle, requestingPermission, ready, checkingNoise, recording, stopping, analysing, done, error(reason), with legal transitions only.
- mapCaptureError(err): NotAllowedError, NotFoundError, NotReadableError, OverconstrainedError, SecurityError, insecure context, no mediaDevices, each with a plain-language message and what to do.
- wav-encode.js: Float32Array to a WAV Blob (16-bit PCM and 32-bit float options); must round-trip through the existing parseWav.

## 2. Browser glue (src/audio/recorder-worklet.js and mic.js)
- AudioWorkletProcessor posts blocks of about 4096 frames with the frame counter, using transferable buffers. Load it with a relative URL so it works under the repo subpath, and add it to the service worker precache.
- Create or resume the AudioContext inside the user gesture. Do NOT force a sample rate; use ctx.sampleRate for the samples (the pipeline regenerates the reference sweep at the recording's rate). Note any difference between track settings and ctx.sampleRate.
- Graph: mic source, worklet, then a muted GainNode to destination only if needed to keep the graph pulled. The mic must never be routed audibly to the speakers.
- Handle track.onended, ctx.state changes (suspended, interrupted), and page visibilitychange during recording: abort with a clear message. Acquire the Screen Wake Lock (feature-detected) during capture and release it afterwards.
- stop() releases tracks, the worklet and the context completely so the mic indicator turns off.

## 3. UI (Measure step): "Record with this phone"
- Step 1 "Check input": shows sample rate, channels, echo cancellation, noise suppression and auto gain flags with the warnings, and a 2 s noise-floor check (dBFS) with a plain-language verdict.
- Step 2 "Record": start, live level meter (peak hold, red on clipping), elapsed time and instruction text: "Now play the sweep on the source device. Don't touch the phone." Auto-stop at the planned duration; "Stop early" allowed above the minimum.
- Then run the EXISTING runAnalysis, results screen and attach-to-point. Measurement source is 'mic'; store captureInfo (sampleRate, duration, dropouts, processing flags, silence-run warnings). Do not store device labels.
- Details section additions: blocks received, dropouts, min and peak level, clipped samples, settings flags, digital-silence warnings.
- Hard reject when dropouts > 0 ("The recording glitched: N audio blocks were lost. Close other apps and try again").
- "Download this recording (WAV)" button after capture, user-initiated only. Help text states audio never leaves the device.
- All error states from mapCaptureError shown in the panel; nothing may leave the microphone on after an error.

## 4. Tests (Node)
Constraints, evaluateSettings (true, false, undefined), assembler (continuity, gap, overlap, cap, early stop), silence runs, level and clipping helpers, planner, state-machine legal and illegal transitions, error mapping, WAV round trip (16-bit within quantisation error, float exact), and a simulated capture: feed reference/fixtures recordings through the assembler in chunks, run the existing analysis, and require results identical (1e-9) to analysing the whole array directly.

## 5. Housekeeping and docs
- Service worker precache and cache version bump; update PWA tests.
- README: microphone workflow, privacy statement, known limits (no AGC control on some phones, no dropout detection for zero-filled underruns beyond the silence-run heuristic).
- docs/learning/phase3a3a.md: Web Audio basics (AudioContext, worklet, getUserMedia constraints), why processing must be off, why we never resample, wake lock and visibility, 3 check questions, plus a manual hand-test checklist for Android Chrome (tab and installed): permission allow, deny and blocked, settings flags shown, backgrounding mid-recording aborts, screen lock, headset connected, recording the downloaded sweep played from a second device, and comparison with the same take analysed through the WAV workflow. Say what to screenshot when reporting a problem.
- Update docs/PROGRESS.md.
