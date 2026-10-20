# EchoMap — Room Acoustic Analyzer

> **Live Application:** [https://shail5320.github.io/room-acoustic-analyzer/](https://shail5320.github.io/room-acoustic-analyzer/)  
> **Course Project:** Linear Systems and Signal Processing (LSSP)  
> **License:** MIT

---

## What EchoMap Does

EchoMap is a client-side Progressive Web App (PWA) designed to analyze room acoustics and plan acoustic absorption treatments directly on mobile and desktop browsers without installing native software.

In plain language:
1. **Measures reverberation time (RT60):** It determines how many seconds it takes for sound reflections to decay by 60 dB across standard octave frequency bands (125 Hz to 4 kHz).
2. **Classifies confidence:** It assesses the signal quality of every decay curve into clear validity tiers (**Valid**, **Approximate**, or **Invalid**) based on background noise margins and decay linearity.
3. **Maps room variations:** It renders an aspect-corrected 2D heatmap over a room floor plan to reveal acoustic hotspots and reverberation distribution.
4. **Calculates acoustic treatment:** It computes the dimensionless absorption scaling ratio ($RT_{60,\text{measured}} / RT_{60,\text{target}}$) and, when room dimensions are entered, provides panel surface area recommendations in $\text{m}^2$ using Sabine and Eyring formulations side-by-side.

---

## Privacy & On-Device Security

EchoMap operates **100% on-device**:
- All audio decoding, Fast Fourier Transforms (FFT), 4th-order Butterworth bandpass filtering, Schroeder backward integrations, and Sabine calculations run locally inside the browser (via Web Worker or main-thread fallback).
- **Zero audio uploads:** Your recordings, audio files, floor plans, room dimensions, and measurement points are never uploaded to any remote server or cloud infrastructure.
- **Audited codebase:** A complete search of the codebase confirms zero occurrences of `XMLHttpRequest`, zero occurrences of `navigator.sendBeacon`, and zero external network `fetch()` requests (network requests are strictly confined to same-origin service worker caching of static assets and local JSON presets).

---

## How to Take a Measurement (Two-Device WAV Workflow)

Because mobile operating systems often enforce aggressive hardware noise suppression and auto-gain control during live in-browser microphone capture, EchoMap uses a robust **two-device WAV workflow**:

1. **Download the Test Sweep:** In the EchoMap *Analyze Recording* panel, tap **Download test sweep** to download the 5-second, 48 kHz 16-bit PCM synchronized exponential sine sweep (`sweep_50_8000Hz_5s_48kHz.wav`).
2. **Transfer to Playback Device:** Place this file on a second device (laptop, tablet, secondary phone, or media player connected to a loudspeaker). Position the speaker at a fixed spot in the room (e.g., monitor position or stage). Ensure all software equalizers, spatial audio effects, and loudness enhancements are **switched off**.
3. **Prepare the Recording Device:** On your measuring smartphone or laptop, open an audio recording app (e.g., standard voice recorder set to uncompressed WAV). Ensure noise cancellation, voice isolation, and automatic gain control (AGC) are **disabled**.
4. **Record the Room Response:**
   - Tap **Record** on your measuring phone first.
   - Wait 1–2 seconds in silence.
   - Press **Play** on the playback speaker to play the 5-second sweep.
   - Remain quiet for at least 3 seconds after the sweep ends so the room reverberation tail decays into silence (total recording duration: ~12 to 18 seconds).
   - Stop recording and save as WAV.
5. **Analyze and Attach:** In EchoMap, tap **Choose audio file** and select your recording. The DSP engine deconvolves the impulse response, isolates octave bands, and computes RT60. Tap **Attach to point** to link the measurement to a point on the room floor plan.

---

## How the Pipeline Works

The analysis pipeline processes the audio through six sequential stages:

```
[ Recorded Audio ]
        │
        ▼
1. In-Situ Sweep & Inverse Filter
        │
        ▼
2. Frequency-Domain Deconvolution (FFT ⊛ IFFT)
        │
        ▼
3. Direct Sound Alignment & PNR Detection
        │
        ▼
4. 4th-Order Butterworth Octave Bandpass (SOS)
        │
        ▼
5. Schroeder Backward Integration & Noise Truncation
        │
        ▼
6. Sabine & Eyring Treatment Sizing
```

### 1. In-Situ Sweep & Inverse Filter Generation
The engine synthesizes a mathematical exponential sine sweep spanning $f_1 = 50\text{ Hz}$ to $f_2 = 8000\text{ Hz}$ over $T = 5.0\text{ s}$ matching the exact sampling rate of the uploaded recording. A matched inverse filter $x_\text{inv}(t)$ with $20\text{ ms}$ half-Hann window tapers and a $+3\text{ dB/octave}$ compensating spectral envelope is computed, and its complex frequency spectrum is pre-calculated via radix-2 FFT.

### 2. Frequency-Domain Deconvolution
The linear convolution of the recorded room signal $y[n]$ with the inverse filter is evaluated in the frequency domain: $H(f) = Y(f) \cdot X_\text{inv}(f)$. The signals are zero-padded to the next power of two ($\ge N_y + N_\text{inv} - 1$, typically $N = 2^{20}$ or $2^{21}$), multiplied in complex 64-bit precision, and transformed back to the time domain via IFFT to extract the room impulse response (IR).

### 3. Peak Alignment, PNR, & Cut-Off Detection
The direct sound arrival peak index $n_\text{peak} = \arg\max_n |h[n]|$ is detected. The Peak-to-Noise Ratio (PNR) is computed as the power ratio in decibels between the direct sound peak and the pre-sweep ambient noise floor. Recordings with $\text{PNR} < 15\text{ dB}$ are rejected to prevent noise-dominated deconvolution artifacts. The IR is also verified to decay at least $6\text{ dB}$ into background noise before the recording terminates.

### 4. Butterworth Octave Bandpass Filtering
The extracted impulse response is split into 6 standard acoustic octave bands (centre frequencies: 125 Hz, 250 Hz, 500 Hz, 1000 Hz, 2000 Hz, and 4000 Hz). Filtering uses a 4th-order Butterworth bandpass filter designed via the bilinear transform with frequency pre-warping, implemented as a cascade of 2 Second-Order Sections (SOS biquads) in 64-bit floating point for numerical stability.

### 5. Schroeder Integration & Simplified Noise-Floor Truncation
For each octave band, the background noise variance $\sigma^2$ is estimated from the pre-sweep silence or the late $15\%$ tail. A 20 ms moving-average power envelope locates the point where the decay drops within $+3\text{ dB}$ ($2.0 \cdot \sigma^2$) of the noise floor. The energy decay curve (EDC) is integrated backward from this truncation index with noise energy compensation $\max(0, h[k]^2 - \sigma^2)$ and converted to decibels. Ordinary least-squares regression extracts EDT ($0$ to $-10\text{ dB}$), T20 ($-5$ to $-25\text{ dB}$), and T30 ($-5$ to $-35\text{ dB}$) with goodness-of-fit $R^2$. Results are classified into validity tiers: **Valid** (clean $10\text{ dB}$ margin and $R^2 \ge 0.95$), **Approximate** (fit range met and $R^2 \ge 0.95$), or **Invalid**.

### 6. Sabine & Eyring Acoustic Treatment Calculation
Measured reverberation times are compared against user-selected room targets ($RT_{60,\text{target}}$). The primary metric is the dimensionless absorption ratio $RT_{60,\text{measured}} / RT_{60,\text{target}}$. When optional room dimensions ($L \times W \times H$) are provided, room volume $V$ and boundary surface areas are computed to calculate the additional metric absorption $\Delta A$ required and the corresponding absorber panel area ($S_\text{panel}$) via Sabine's formula ($A = 0.161 \cdot V / RT_{60}$) and Eyring's formula side-by-side.

---

## Known Limitations

Like all acoustical software operating under practical physical constraints, EchoMap has important limitations:

1. **Sabine's Diffuse-Field Assumption:** Sabine and Eyring formulas assume a perfectly diffuse sound field with uniformly distributed absorption and random sound reflections. Typical rectangular furnished rooms deviate from this ideal, exhibiting flutter echoes, local corner build-ups, and non-uniform decay rates.
2. **Room Modes Below ~250 Hz:** In typical domestic rooms (volume $< 100\text{ m}^3$), frequencies below the Schroeder frequency ($\approx 200–250\text{ Hz}$) are governed by discrete standing waves (room modes), not statistical reverberation. Thin porous panels cannot effectively absorb frequencies in this modal regime; tuned membrane traps or bass traps are required.
3. **Phone Speaker & Microphone Frequency Limits (125 Hz Marginality):** Smartphone speakers roll off steeply below 200–250 Hz and cannot produce adequate acoustic energy at 125 Hz. Furthermore, narrow filter bandwidth at 125 Hz ($\Delta f \approx 88\text{ Hz}$) creates high stochastic scatter (typical $2\sigma$ scatter is $\pm 11\%$, and up to $\pm 18\%$ at $0.3\text{ s}$ where errors can approach $20\%$ even on valid fits). Measurements in the 125 Hz band are frequently classified as *Approximate* or *Invalid*. Controlled tests demonstrate that the positive bias at 125 Hz is primarily driven by sweep edge truncation ($f_1 = 50\text{ Hz}$ truncating the lower skirt of the 125 Hz octave band) rather than Butterworth filter ringing, which remains an unproven secondary hypothesis.
4. **Compressed Audio Distortion:** Uploading lossy compressed files (MP3, M4A, AAC) introduces psychoacoustic quantisation artifacts and phase smearing that can distort Schroeder decay curves. Uncompressed 16-bit or 24-bit PCM WAV is strongly recommended.
5. **Effective Low-PNR Override Band (14–20 dB) & Impulsive Noise Sensitivity:** While the pipeline's architectural floor allows override evaluation between 10.0 dB and 20.0 dB PNR, the effective override operating band is approximately **14 to 20 dB PNR** because the $\Delta E_{\text{post/pre}} \ge 1.5\text{ dB}$ energy margin gate fails below ~14 dB when ambient noise swamps the post-peak window. While 20 stationary Gaussian white-noise seeds showed zero false override triggers, non-stationary impulsive sounds (such as a handclap or loud burst) can exceed the 1.5 dB margin without a sweep present, generating deceptive high-frequency pseudo-decays (e.g. at 2 kHz and 4 kHz). Consequently, measurements with `lowConfidence: true` are excluded by default from the heatmap, session aggregation, hotspot placement hints, and treatment calculator, and require an explicit toggle with a visible `LOW CONFIDENCE` badge.
6. **Few-Point Heatmap Interpolation:** An inverse-distance weighted (IDW) heatmap computed from only 2 to 4 measurement points is a mathematical interpolation across space, not a physical simulation. A minimum of 9 points distributed across the space is recommended for meaningful mapping.
7. **Placeholder Material Coefficients:** Material absorption coefficients in preset tables are placeholder textbook values. Always verify laboratory test certificates (ISO 354 or ASTM C423) from the manufacturer before ordering materials.
8. **Simulated Data is Never Real:** The built-in *Simulate Room* engine uses mathematical Gaussian noise decays to test algorithm behavior. It does not model geometry, wall impedance, or diffraction.
9. **Live In-App Microphone Capture Status:** In-app `getUserMedia` recording with all browser DSP filters disabled is in progress; current recommended practice is the two-device external WAV file workflow.
10. **Absorption is NOT Sound Insulation:** Acoustic absorbers clarify speech and reduce echo *inside* the room. They do not soundproof the room or prevent sound transmission into adjacent apartments.

---

## How This Was Verified

Verification separates numerical implementation accuracy from statistical acoustic recovery. Only the following items were verified against independent ground truth:

### 1. Python Reference Answer Key
The DSP algorithms were first implemented in pure Python 3 using NumPy 2.4.6 and SciPy 1.16.2 (`reference/sweep.py`, `reference/deconvolve.py`, `reference/bands.py`, `reference/rt60.py`). Standard ground-truth vectors and filter coefficients were serialised to `reference/expected_outputs.json`.

### 2. Tier 1 Verification (Numerical Precision on Identical Fixtures)
The JavaScript implementation was executed on identical binary fixtures (`reference/fixtures/`) and compared against the Python reference:
- **FFT Round-Trip:** Max sample error $< 10^{-10}$ ([`tests/fft.test.js`](tests/fft.test.js)).
- **Sweep & Inverse Waveforms:** Max absolute sample difference $\le 10^{-6}$ ([`tests/sweep.test.js`](tests/sweep.test.js)).
- **Deconvolution Peak-to-Sidelobe:** Matches Python reference ($43.89\text{ dB}$) within $0.002\text{ dB}$ ([`tests/deconvolve.test.js`](tests/deconvolve.test.js)).
- **Butterworth Filter Coefficients:** Relative error $\le 10^{-8}$ against SciPy `butter(N=2, ..., output='sos')` ([`tests/bands.test.js`](tests/bands.test.js)).
- **Filter Magnitude Responses:** Deviation $\le 0.01\text{ dB}$ across 200+ log-spaced frequencies ([`tests/bands.test.js`](tests/bands.test.js)).
- **Recovered RT60 per Band:** Absolute difference $\le 0.001\text{ s}$ ($\le 0.1\%$) against `expected_outputs.json` ([`tests/rt60.test.js`](tests/rt60.test.js)).

### 3. Tier 2 Verification (Monte Carlo Statistical Recovery on Synthetic Data)
A 30-seed Monte Carlo study (`reference/monte_carlo.py`) established the empirical statistical variance ($\text{Mean bias} \pm 2\sigma$) of synthetic room decays under Butterworth filtering. End-to-end recovery tests ([`tests/rt60.test.js`](tests/rt60.test.js), [`tests/pipeline.test.js`](tests/pipeline.test.js), [`tests/selftest.test.js`](tests/selftest.test.js)) verify that JS recovers target reverberation times within these empirical $2\sigma$ bounds across all 6 octave bands.

---

## Not Yet Verified

The following aspects have **not** yet been validated:
1. **Validation on real-room recordings:** Testing and validation against physical impulse responses recorded in diverse real-world furnished rooms.
2. **Comparison against a calibrated meter or an established measurement tool:** Side-by-side benchmark comparison against a calibrated Class 1 / Class 2 sound level meter or established commercial measurement software (e.g., REW, ARTA, NTI XL2).
3. **Live in-app microphone capture:** Full validation of live in-browser `getUserMedia` audio capture across diverse mobile and desktop operating systems and hardware audio pipelines.
4. **The 125 Hz band on real phone hardware:** Transducer frequency response, speaker roll-off, and microphone noise floors at 125 Hz on consumer smartphone and tablet hardware.
5. **Calibration of the PNR threshold on real recordings:** Calibration and empirical tuning of the 15 dB Peak-to-Noise Ratio cutoff threshold on practical room recordings with real ambient noise.

> [!WARNING]
> EchoMap results are screening-grade estimates, not certified measurements. They are intended for room assessment, planning, and educational purposes, not for regulatory compliance, building code certification, or legal noise disputes.

---

## AI Assistance Note

This codebase was developed with the assistance of agentic AI coding tools (Claude / Gemini via Google Antigravity). All mathematical specifications, filter topologies, regression equations, and signal processing steps were designed from first principles and cross-checked against independent Python 3 / SciPy reference implementations and unit tests.

---

## References

1. **Farina, A. (2000).** "Simultaneous Measurement of Impulse Response and Distortion with a Swept-Sine Technique." *108th Audio Engineering Society Convention*, Paris, France, Preprint 5093.
2. **Schroeder, M. R. (1965).** "New Method of Measuring Reverberation Time." *The Journal of the Acoustical Society of America*, 37(3), 409–412.
3. **ISO 3382-1:2009.** "Acoustics — Measurement of room acoustic parameters — Part 1: Performance spaces." International Organization for Standardization, Geneva, Switzerland.
4. **ISO 3382-2:2008.** "Acoustics — Measurement of room acoustic parameters — Part 2: Reverberation time in ordinary rooms." International Organization for Standardization, Geneva, Switzerland.
5. **Sabine, W. C. (1922).** *Collected Papers on Acoustics*. Harvard University Press, Cambridge, MA.
6. **Eyring, C. F. (1930).** "Reverberation Time in 'Dead' Rooms." *The Journal of the Acoustical Society of America*, 1(2A), 217–241.

---

## Project Structure

```
.
├── index.html                  # Mobile-first semantic HTML5 app shell
├── style.css                   # Mobile-first CSS tokens, WCAG AA contrast, dark mode
├── sw.js                       # Service worker with versioned cache and network-first strategy
├── manifest.webmanifest        # PWA standalone manifest
├── package.json                # Test runner configuration (node:test)
├── icons/                      # 192x192 and 512x512 PWA icons
├── src/
│   ├── dsp/                    # Pure numerical DSP (zero dependencies, Float64Array)
│   │   ├── fft.js              # Radix-2 Cooley-Tukey FFT & IFFT
│   │   ├── sweep.js            # Exponential sine sweep & inverse filter
│   │   ├── deconvolve.js       # Fast convolution & peak extraction
│   │   ├── bands.js            # 4th-order Butterworth bandpass (2 SOS per band)
│   │   ├── rt60.js             # Schroeder integration, noise truncation, regression
│   │   └── sabine.js           # Sabine & Eyring formulas & absorption ratio
│   ├── audio/                  # Audio file I/O & sweep generation
│   │   ├── wav.js              # Pure client-side WAV parser & format validator
│   │   └── sweep-wav.js        # 48 kHz 16-bit PCM test sweep WAV generator
│   ├── analysis/               # Orchestration & worker DSP
│   │   ├── config.js           # Acoustic frequency & sampling constants
│   │   ├── pipeline.js         # Pure headless analysis pipeline
│   │   ├── worker.js           # Module Web Worker for non-blocking analysis
│   │   ├── run.js              # Worker orchestrator with main-thread fallback
│   │   ├── selftest.js         # Room simulation self-test generator
│   │   └── treatment.js        # Treatment calculator & hotspot placement engine
│   ├── store/                  # Session persistence & file export
│   │   ├── storage.js          # IndexedDB with MemoryStorageAdapter fallback
│   │   └── export.js           # RFC 4180 CSV & JSON exporters
│   ├── ui/                     # UI components & views
│   │   ├── coordinates.js      # Aspect-corrected coordinate transforms
│   │   ├── dimensions.js       # Metric / step count room geometry validator
│   │   ├── session-model.js    # Reactive session state model
│   │   ├── floorplan.js        # Interactive Canvas room & marker renderer
│   │   ├── heatmap-math.js     # Inverse Distance Weighted (IDW) interpolation
│   │   ├── heatmap.js          # Viridis heatmap renderer & legend
│   │   ├── contrast.js         # WCAG relative luminance & CSS token parser
│   │   ├── help.js             # In-app help cards & privacy guide
│   │   ├── format.js           # Plain-language error & decibel formatting
│   │   └── app.js              # Main application coordinator
│   └── data/
│       ├── targets.json        # Target RT60 acoustic presets with verified sources
│       └── materials.json      # Absorption materials with placeholder warnings
├── tests/                      # Automated unit test suite (run via node:test)
│   ├── fft.test.js
│   ├── sweep.test.js
│   ├── deconvolve.test.js
│   ├── bands.test.js
│   ├── rt60.test.js
│   ├── sabine.test.js
│   ├── wav.test.js
│   ├── pipeline.test.js
│   ├── selftest.test.js
│   ├── aspect-ratio.test.js
│   ├── dimensions.test.js
│   ├── floorplan.test.js
│   ├── heatmap.test.js
│   ├── storage.test.js
│   ├── export.test.js
│   ├── treatment.test.js
│   ├── contrast.test.js
│   ├── errors.test.js
│   └── pwa.test.js
├── reference/                  # Independent Python 3 reference implementation
│   ├── sweep.py
│   ├── synthetic_ir.py
│   ├── deconvolve.py
│   ├── bands.py
│   ├── rt60.py
│   ├── noise_analysis.py
│   ├── monte_carlo.py
│   ├── pipeline_reference.py
│   ├── treatment_reference.py
│   └── expected_outputs.json   # Ground truth test fixtures
└── docs/                       # Architectural documentation & learning notes
    ├── PLAN.md
    ├── PROGRESS.md
    └── learning/
```

---

## How to Run Tests

The test suite runs with Node.js built-in test runner (`node:test`) and requires zero npm installations or dependencies:

```bash
# Run all unit tests
npm test

# Run a specific test file
node --test tests/rt60.test.js
node --test tests/contrast.test.js
node --test tests/errors.test.js
```

---

## How to Run the Python Reference

To execute the Python reference verification scripts:

```bash
# 1. Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install pinned reference requirements
pip install -r reference/requirements.txt

# 3. Run individual reference analyses
python3 reference/sweep.py
python3 reference/synthetic_ir.py
python3 reference/deconvolve.py
python3 reference/bands.py
python3 reference/rt60.py
python3 reference/noise_analysis.py
python3 reference/monte_carlo.py
python3 reference/pipeline_reference.py
python3 reference/treatment_reference.py
```

---

## How to Deploy to GitHub Pages

EchoMap is designed for deployment as a static site directly from GitHub Pages:
1. Ensure the repository is pushed to GitHub on branch `main`.
2. Go to **Settings** > **Pages** in the GitHub repository.
3. Under **Build and deployment**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` / `/ (root)`
4. Click **Save**. The application will be live at:
   `https://<username>.github.io/<repository-name>/`
   All asset links, service worker registration scopes, and manifest entries use relative paths (`./`) to support hosting under repository subpaths without root domain assumptions.
