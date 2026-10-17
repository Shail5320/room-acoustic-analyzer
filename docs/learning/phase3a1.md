# Phase 3a-1: Pure Analysis Pipeline, In-Situ Sweep Generation & Web Worker Offloading

## 1. Concepts & Architecture

### 1.1 The Complete Acoustic Analysis Pipeline

The purpose of Phase 3a-1 is to compose all DSP building blocks developed in Phase 2 into a single, pure, headless pipeline (`analyzeRecording`) that accepts raw audio samples from any source (microphone capture, worklet buffer, or test fixture) and produces verified acoustic room metrics.

```
                  Raw Audio Recording (Float32 / Float64)
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 1: Input Validation & Safety Guards              │
       │  - Sample rate >= 22050 Hz                             │
       │  - Duration 8.0 s to 30.0 s (Memory Guard)             │
       │  - Silence check (max |sample| <= 1e-6)                │
       │  - Clipping detection (|sample| > 0.99)                │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 2: In-Situ Sweep & Inverse Filter Generation     │
       │  - Generate analytical sweep at recording's sampleRate │
       │  - Generate Farina inverse filter (never resample!)    │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 3: Frequency-Domain Deconvolution                │
       │  - Zero-pad to next power of 2 >= len(y) + len(inv) - 1│
       │  - h_full = IFFT( FFT(y) · InvSpectrum )               │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 4: Peak Detection & PNR Validation               │
       │  - Locate direct sound peak arrival                    │
       │  - Peak-to-Noise Ratio (PNR >= 20 dB vs pre-peak)      │
       │  - Reject if sweep not detected                        │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 5: Cut-Off Decay Check                           │
       │  - Check tail envelope at end of recording             │
       │  - Must fall within ~6 dB of pre-peak noise floor      │
       │  - If cut prematurely: decayTruncated = true,          │
       │    warning set, tiers capped at "approximate"          │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 6: IR Extraction                                 │
       │  - Extract 2.5 s tail starting pre-peak                │
       │  - Peak normalization                                  │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 7: Octave Filtering & Schroeder RT60             │
       │  - 4th-order Butterworth filters (125, 250, 500,       │
       │    1000, 2000, 4000 Hz)                                │
       │  - Simplified noise-floor truncation (+3 dB envelope)  │
       │  - EDT, T20, T30 linear regression & R² check          │
       │  - 3-tier validity classification                      │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 8: Dynamic Range Derivation                      │
       │  - dynamicRangeDb = min(DR_125, ..., DR_4000)          │
       │  - weakestBandHz = argmin(DR_fc)                       │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ Stage 9: Lightweight UI Plot Decimation                │
       │  - irPlot: 600 points Float32Array                     │
       │  - edcPlot: 300 points Float32Array per octave band    │
       └────────────────────────────────────────────────────────┘
```

---

### 1.2 Why the Sweep is Regenerated at the Recording's Sample Rate

A common pitfall in web audio software is assuming a fixed sample rate (such as 44.1 kHz or 48.0 kHz) and attempting to resample the microphone input when the hardware operates at a different rate:

1. **Hardware Heterogeneity:**
   Android devices, USB microphones, and Bluetooth headsets expose varying native hardware rates:
   - Built-in Android microphones typically run at **48000 Hz**.
   - USB class-compliant interfaces and older phones often prefer **44100 Hz**.
   - Higher-end external DACs/codecs may run at **96000 Hz**.

2. **The Pitfall of Resampling the Recording:**
   Resampling a recorded audio stream requires digital sample rate conversion (polyphase sinc interpolation or multirate filtering). This introduces:
   - **Phase distortion:** Non-linear phase shifts distort early reflection arrival times and transient peak alignment.
   - **Passband ripple & stopband imaging:** Filter ringing corrupts low-frequency decay tails.
   - **CPU overhead:** Real-time polyphase resampling in JavaScript wastes valuable CPU cycles on mobile phones.

3. **The Clean Solution — In-Situ Sweep Synthesis:**
   Instead of modifying the recording, we generate the analytical exponential sine sweep and Farina inverse filter directly at the recording's exact sample rate $f_s$:
   $$\phi(t) = K \left( e^{t/L} - 1 \right), \quad x(t) = \sin(\phi(t)), \quad t = \frac{n}{f_s}$$
   Because the sweep formula is purely mathematical, generating 5 seconds of sweep at 44.1 kHz or 48 kHz takes only ~40 ms of CPU time, produces **zero interpolation error**, and maintains bit-exact linear convolution properties.

---

### 1.3 Why the Analysis Runs in a Module Web Worker

1. **Heavy Computational Burden of FFT Deconvolution:**
   A full room recording of 13 to 30 seconds requires deconvolution with a 5-second inverse filter.
   $$\text{Linear convolution length} = N_\text{rec} + N_\text{inv} - 1$$
   - At 13 seconds (624,000 samples) + 5 seconds (240,000 samples): $\min\text{Len} = 863,999 \rightarrow N_\text{FFT} = 2^{20} = 1,048,576$.
   - At 30 seconds (1,440,000 samples) + 5 seconds (240,000 samples): $\min\text{Len} = 1,679,999 \rightarrow N_\text{FFT} = 2^{21} = 2,097,152$.

2. **Main Thread Starvation:**
   A Cooley–Tukey radix-2 FFT at $N = 2^{20}$ takes ~500–900 ms in V8. During this time, if executed on the main thread:
   - The browser event loop is completely blocked.
   - Touch interactions, canvas rendering, level meters, and progress spinners freeze.
   - On low-power mobile devices, long main-thread execution triggers "Application Not Responding" (ANR) warnings or frame drops.

3. **Worker Architecture with Zero-Copy Transfer:**
   By encapsulating the pipeline in `src/analysis/worker.js`:
   - The raw audio buffer is transferred using transferable objects (`postMessage({ samples }, [samples.buffer])`), avoiding memory duplication.
   - The worker executes all FFTs, bandpass filters, and Schroeder regressions asynchronously, emitting granular stage progress messages (`'validating'`, `'sweep'`, `'deconvolve'`, `'filtering'`, `'rt60'`).
   - If Web Worker creation fails or is unsupported (such as headless Node environments), `runAnalysis` in `src/analysis/run.js` falls back to main-thread execution with a console warning.

---

### 1.4 Experimental Verification: The 125 Hz Octave Band vs Sweep Lower Cutoff

When evaluating the single-RT60 synthetic fixture (`synthetic_ir_single`), the raw true IR yielded an RT60 of **0.7314 s** in the 125 Hz band. However, when deconvolved through the full sweep pipeline (`fake_recording_single`), the recovered RT60 was **0.7452 s** (a difference of $+0.0138$ s).

#### The Hypothesis
The 125 Hz octave band has lower and upper bandpass cutoff frequencies given by:
$$f_\text{lower} = \frac{125}{\sqrt{2}} \approx 88.39\text{ Hz}, \quad f_\text{upper} = 125 \cdot \sqrt{2} \approx 176.78\text{ Hz}$$
Because our standard excitation sweep starts at $f_1 = 50\text{ Hz}$ with a 20 ms half-Hann fade, the filter's lower transition skirt (from 88.4 Hz down into the stopband) overlaps the sweep's lower cutoff and fade region.

#### The Experiment
To test whether this difference was an artifact of the 50 Hz sweep cutoff, we generated sweeps with identical duration ($T=5.0$ s) and upper frequency ($f_2=8000$ Hz) while lowering $f_1$ down to 20 Hz and 10 Hz:

| Sweep Start Frequency ($f_1$) | 125 Hz Octave Band Recovered RT60 | Absolute Error vs Raw Synthetic IR (0.7314 s) |
|---|---|---|
| **Raw Unconvolved Synthetic IR** | **0.731397 s** | — |
| **$f_1 = 50\text{ Hz}$ (Standard)** | **0.745240 s** | $+0.013843\text{ s}$ ($+1.89\%$) |
| **$f_1 = 20\text{ Hz}$** | **0.731581 s** | $+0.000184\text{ s}$ ($+0.025\%$) |
| **$f_1 = 10\text{ Hz}$** | **0.731438 s** | $+0.000041\text{ s}$ ($+0.005\%$) |

#### Conclusion
Extending the sweep down to 20 Hz reduces the error by two orders of magnitude (to 0.00018 s), and extending to 10 Hz virtually eliminates it (0.00004 s). This confirms that:
1. The difference at 125 Hz in `fake_recording_single` is **not** a flaw in deconvolution or Schroeder integration.
2. It is the physical consequence of excitation band-limiting: an acoustic signal cannot recover frequency content that was never transmitted by the loudspeaker.
3. In `reference/expected_outputs.json`, the `"pipeline"` section preserves this verified ground truth, against which our JavaScript implementation matches to $\le 10^{-6}$ s.

---

### 1.5 Cut-Off Decay Detection & Dynamic Range Derivation

#### Cut-Off Decay Check
If a user taps "Stop" or the recording ends prematurely before room reflections have died down into ambient noise:
- The tail of the recording still contains loud reverberant sound.
- Deconvolving a cut signal creates an artificial step drop-off in the recovered impulse response, inflating or falsifying RT60 estimates.

The pipeline inspects the final 50 ms window of the recording:
$$\Delta\text{dB} = 20 \log_{10}\left( \frac{\text{RMS}_\text{end}}{\text{RMS}_\text{pre-peak noise}} \right)$$
If $\Delta\text{dB} > 6.0\text{ dB}$, the decay was cut off before reaching ambient noise:
- `decayTruncated` is set to `true`.
- A user warning is attached: `"Reverberation decay appears cut off before reaching the noise floor"`.
- All affected octave bands are **capped at `"approximate"` at best** (or remain `"invalid"` if fit criteria fail).

#### Conservative Dynamic Range Derivation
The measurement point's overall dynamic range is derived as the **conservative minimum** across all 6 evaluated octave bands:
$$\text{dynamicRangeDb} = \min_{fc \in [125, \dots, 4000]} (\text{band}[fc].\text{dynamicRangeDb})$$
$$\text{weakestBandHz} = \arg\min_{fc \in [125, \dots, 4000]} (\text{band}[fc].\text{dynamicRangeDb})$$
This ensures the reported measurement confidence reflects the weakest link in the frequency chain.

---

## 2. Check Questions

### Q1: Why must the analysis pipeline never resample a 44.1 kHz recording to 48 kHz, and what is done instead?
**Answer:**
Resampling introduces time-domain smearing, phase distortion, and passband ripple from interpolation filters, which artificially smooths or elongates early reflections and biases Schroeder decay regression. Instead, the pipeline generates the analytical exponential sine sweep and Farina inverse filter at the recording's exact sample rate (44.1 kHz). Because the sweep equation $x(t) = \sin(K(e^{t/L}-1))$ is closed-form, it can be evaluated directly at any sample rate with zero resampling error and negligible CPU overhead (~40 ms).

### Q2: Why is the per-point `dynamicRangeDb` derived as the minimum over all 6 octave bands rather than the average or median?
**Answer:**
In room acoustics, measurement quality is constrained by the worst-performing band. Low frequencies (125 Hz) typically exhibit higher ambient room noise and lower transducer efficiency, yielding smaller decay depth. An average or median would obscure the fact that low-frequency estimates might only have 20–25 dB of usable range. Using the conservative minimum ($\min_{fc} DR_{fc}$) provides an honest, safety-first figure of merit and explicitly alerts the user to the `weakestBandHz`.

### Q3: What physical acoustic mechanism caused the 125 Hz band RT60 to differ between the raw synthetic IR fixture (0.7314 s) and the deconvolved fake recording (0.7452 s)?
**Answer:**
The 125 Hz octave band filter spans from $f_\text{lower} \approx 88.4$ Hz down into its transition stopband. The excitation sweep starts at $f_1 = 50$ Hz with a 20 ms half-Hann fade. When the raw broadband IR is convolved with the sweep, energy below 50 Hz is attenuated. The 125 Hz Butterworth filter's lower skirt receives less sub-50 Hz energy in the deconvolved signal than in the raw synthetic IR. Lowering the sweep start frequency to 20 Hz reduces this discrepancy from $+0.0138$ s to $+0.00018$ s, proving that the shift is an excitation band-limiting effect rather than an algorithmic error.
