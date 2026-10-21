# Phase 3a-2: Audio I/O, Robust WAV Parsing, Sweep Generation & Simulated Self-Testing

## 1. Concepts & Architecture

### 1.1 Robust Client-Side WAV Parsing (RIFF Container Architecture)

The Resource Interchange File Format (RIFF) is a chunk-based container structure commonly used for `.wav` audio. Each chunk consists of:
1. A 4-byte ASCII FourCC identifier (e.g. `RIFF`, `fmt `, `data`, `LIST`).
2. A 32-bit little-endian integer specifying the chunk data size $N$ (excluding the 8-byte header).
3. The $N$-byte data payload.
4. **Mandatory 2-byte alignment:** In the RIFF specification, if $N$ is odd, a 1-byte padding byte (`0x00`) must be appended so that the subsequent chunk begins on an even byte offset. Parsers that fail to account for odd-byte padding lose chunk synchronization and corrupt downstream audio reads.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Chunk ID: "RIFF" (4 bytes)                                             │
│ Chunk Size: File size - 8 bytes (4 bytes, Little-Endian)               │
│ Format: "WAVE" (4 bytes)                                               │
├────────────────────────────────────────────────────────────────────────┤
│ Sub-chunk ID: "fmt " (4 bytes)                                         │
│ Sub-chunk Size: 16 (PCM), 18, or 40 (EXTENSIBLE) (4 bytes)             │
│   - AudioFormat (2 bytes): 0x0001 (PCM), 0x0003 (Float), 0xFFFE (Ext) │
│   - NumChannels (2 bytes): 1 (Mono), 2 (Stereo), etc.                  │
│   - SampleRate (4 bytes): e.g. 48000, 44100                            │
│   - ByteRate (4 bytes): SampleRate * NumChannels * BitsPerSample / 8   │
│   - BlockAlign (2 bytes): NumChannels * BitsPerSample / 8              │
│   - BitsPerSample (2 bytes): 16, 24, 32                                │
├────────────────────────────────────────────────────────────────────────┤
│ Sub-chunk ID: "LIST" / "INFO" / "bext" (Optional metadata chunks)      │
│ Sub-chunk Size: M bytes (skipped cleanly; handles odd padding)         │
├────────────────────────────────────────────────────────────────────────┤
│ Sub-chunk ID: "data" (4 bytes)                                         │
│ Sub-chunk Size: K bytes (or 0 / 0xFFFFFFFF for streaming files)        │
│   - Audio sample payload (converted directly to Float32Array [-1.0, 1.0│
└────────────────────────────────────────────────────────────────────────┘
```

#### Key Implementation Details in `src/audio/wav.js`:
- **Pre-Decode Safety Guards:** Before allocating arrays or parsing multi-megabyte payloads, EchoMap inspects the header:
  - File size check: Rejects files $> 50$ MB.
  - Duration check: Computes duration $T = \text{dataBytes} / \text{byteRate}$ from chunk headers and rejects files $> 30$ s. This prevents memory exhaustion and UI lockup on constrained mobile devices.
- **Incompatible Variants Handled Gracefully:**
  - `RIFX` (big-endian RIFF common on legacy PowerPC / Motorola architectures) is rejected with an actionable error.
  - `RF64` (64-bit extension for files $> 4$ GB) is rejected with a clear message.
- **Supported Formats:**
  - **16-bit PCM Integer:** Stored as two's complement 16-bit LE integers $[-32768, 32767]$. Scaled by dividing by $32768.0$.
  - **24-bit PCM Integer:** Stored as 3-byte signed LE integers $[-8388608, 8388607]$. Reconstructed via sign-extension: `(b0 | (b1 << 8) | (b2 << 16)) << 8 >> 8` and scaled by $8388608.0$.
  - **32-bit PCM Integer:** Scaled by dividing by $2147483648.0$.
  - **32-bit IEEE 754 Float:** Direct binary representation in $[-1.0, 1.0]$ with zero quantization error.
  - **`WAVE_FORMAT_EXTENSIBLE` (tag `0xFFFE`):** Inspects the 16-byte SubFormat GUID (`KSDATAFORMAT_SUBTYPE_PCM` or `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT`).
- **Data Chunk Edge Cases:** Supports streaming WAV files where `chunkSize` is set to `0` or `0xFFFFFFFF` by consuming the remaining file buffer.
- **Multi-Channel Recordings:** If the audio has $> 1$ channel (e.g. stereo from phone voice memos), channel 0 (left) is extracted directly without mixing or downmixing. Downmixing stereo channels causes comb filtering due to microphone phase differences; extracting channel 0 preserves pristine phase linearity.

---

### 1.2 Why We Never Resample Recordings

EchoMap adheres strictly to the rule: **Never resample the physical recording.**

```
Traditional Approach (Flawed):
Recording (44.1 kHz) ──► Polyphase Sinc Resampler ──► 48.0 kHz ──► Deconvolution
                               │
                               └── Phase distortion, filter ringing & smearing

EchoMap Approach (Strict Fidelity):
Recording (44.1 kHz) ──────────────────────────────────────────► Deconvolution (44.1 kHz)
                                                                       ▲
Analytical Math: f1, f2, T ──► Analytical Sweep Generator ─────────────┘
                               at exact f_s = 44.1 kHz (Exact Phase)
```

1. **Phase Linearity & Transient Smearing:**
   Digital sample rate conversion (polyphase sinc interpolation) requires steep low-pass antialiasing filtering. Even linear-phase FIR resamplers introduce pre-ringing and group delays that smear early reflections (the direct sound peak and reflections arriving within the first 50 ms). Minimum-phase IIR resamplers introduce non-linear phase shifts that distort the waveform.
2. **Schroeder Decay Sensitivity:**
   The Schroeder backward integration curve $I(t) = \int_t^\infty h^2(\tau) \, d\tau$ accumulates energy backwards from the noise floor. Minor filter ringing or passband ripples caused by sample-rate conversion add artificial energy tails that falsely prolong the decay curve, distorting $T_{20}$, $T_{30}$, and EDT.
3. **Closed-Form Reference Sweep:**
   The logarithmic sine sweep $s(t) = \sin(\phi(t))$ and its Farina inverse filter $f(t)$ are closed-form continuous mathematical functions. Evaluating them directly at any arbitrary sampling rate $f_s \ge 22050$ Hz requires evaluating $\phi(n / f_s)$, which has zero phase distortion and machine-precision numerical accuracy ($< 10^{-12}$).
4. **Browser Fallback for Compressed Audio (`.mp3`, `.m4a`):**
   When users upload compressed formats, the browser's `AudioContext.decodeAudioData` must be used. However, Web Audio decoders automatically resample audio to the current `AudioContext.sampleRate` and apply lossy psychoacoustic compression (MDCT quantization). EchoMap visibly flags this in the UI as `"Compressed audio (decoded)"` to maintain total scientific honesty.

---

### 1.3 Sweep Playback Workflow (Two-Device Physical Method)

Measuring room acoustics accurately using mobile phones requires decoupling the playback source from the recording receiver.

#### Why Two Devices?
On a single smartphone, running simultaneous full-duplex audio (playing the sweep while recording the microphone input) encounters severe hardware and software limitations:
- **Acoustic Echo Cancellation (AEC) & Auto-Gain Control (AGC):** Mobile OS audio frameworks (iOS AudioUnit and Android AAudio) automatically engage hardware noise suppression and AGC during duplex calls, destroying acoustic decay tails.
- **Hardware Clock Coupling & Electrical Crosstalk:** Internal DAC-to-ADC crosstalk on mobile motherboards injects electrical signals directly into the mic preamplifier, producing false direct-sound spikes.
- **Physical Proximity:** The phone speaker and microphone are separated by only a few centimeters, making it impossible to evaluate room reflections without blasting the microphone capsule into non-linear saturation.

#### The Calibrated Two-Device Procedure:
1. **Download Calibrated Sweep:** Tap **Download test sweep** to obtain `echomap_sweep_48k_16bit.wav` (5.0 s exponential sweep, 50 Hz to 8000 Hz, 48 kHz 16-bit PCM, peak amplitude 0.70 with 1.0 s lead-in silence).
2. **Playback Device Setup:** Place a dedicated playback device (laptop, tablet, or secondary phone connected to a neutral monitor speaker) at a fixed location in the room.
   - Turn **OFF** equalizers, bass boost, Dolby Atmos, spatial audio, and volume levelers.
3. **Recording Device Setup:** Hold the primary phone at the intended measurement position.
   - Turn **OFF** voice isolation, ambient noise cancellation, and auto-gain.
4. **Capture Sequence:**
   - Start recording on the measurement phone first.
   - Play the test sweep once from the playback speaker at a comfortable, clear volume.
   - Allow at least 3 to 5 seconds of complete silence after the sweep ends so the reverberant tail fully decays below the room noise floor (record at least 15 seconds total).
5. **Import & Analyze:** Upload the resulting WAV file into EchoMap.

---

### 1.4 Simulated vs. Real Data: Scientific Honesty & Validation

EchoMap provides a built-in room acoustics simulator (`src/analysis/selftest.js`) that synthesizes physical room impulse responses using an exponentially decaying stochastic noise model:

$$h(t) = w(t) \cdot e^{-\frac{6.9078}{T_{60}} t}$$

where $w(t) \sim \mathcal{N}(0, 1)$ is Gaussian white noise generated using the Box-Muller transform driven by a seeded Mulberry32 PRNG. The synthetic IR is convolved with the analytical sweep, padded with lead-in and trailing silence, and passed through the complete analysis pipeline.

#### Transparent Labeling:
To guarantee that simulated data can never be confused with real physical measurements:
1. **Strict Model Properties:** Every simulated measurement is permanently tagged with `fake: true`, `simulated: true`, and `source: 'selftest'`.
2. **Prominent UI Banners:** The analysis results screen displays a bright orange `SIMULATED` badge.
3. **Heatmap & Floor Plan Protection:** The floor plan list marks points with `[SIMULATED]`, and the heatmap displays a persistent warning banner:
   `⚠️ SIMULATED / DEV DATA — contains simulated test measurements`.
4. **Export Integrity:** The CSV export includes explicit `fake` and `source` columns (`selftest`), and a warning dialog alerts the user before saving or exporting test data.

#### Empirical $2\sigma$ Tolerance Bounds:
Rather than guessing arbitrary tolerance percentages, EchoMap derived statistical acceptance criteria by running 30-seed Monte Carlo simulations in Phase 0 across multiple room decay rates:

| Target $T_{60}$ | Empirical Mean | Standard Deviation $\sigma$ | Acceptable $2\sigma$ Range |
|---|---|---|---|
| **0.30 s** | 0.3037 s | 0.0099 s | **[0.2838, 0.3236] s** |
| **0.60 s** | 0.6127 s | 0.0163 s | **[0.5801, 0.6452] s** |
| **0.80 s** | 0.8063 s | 0.0227 s | **[0.7609, 0.8517] s** |
| **1.20 s** | 1.2230 s | 0.0214 s | **[1.1802, 1.2658] s** |
| **1.50 s** | 1.5195 s | 0.0298 s | **[1.4598, 1.5791] s** |

This guarantees that self-tests rigorously verify pipeline execution without producing false test failures due to stochastic diffusion noise.

---

## 2. Check Questions & Answers

### Question 1: Why is odd-byte chunk padding mandatory in the RIFF WAV format, and what happens to a naive reader that ignores it?

**Answer:**
The RIFF format was designed for 16-bit word-aligned computer architectures (such as the Intel x86 8086 processor family). Memory bus accesses to word-aligned (even) memory addresses required only a single memory bus cycle, whereas unaligned memory accesses required two bus cycles and caused significant performance penalties.

Therefore, the RIFF specification stipulates that every chunk must begin on an even byte boundary. If a chunk's data payload size $N$ is an odd number (for example, a `LIST` chunk containing a 27-byte metadata string), a 1-byte padding byte (`0x00`) must be written immediately after the payload. However, the 4-byte chunk size field in the header records only the actual payload size $N$ (27), **not** $N + 1$.

A naive WAV parser that advances its read offset by exactly `8 + chunkSize` bytes will end up pointing to the padding byte instead of the next chunk's 4-character FourCC identifier. The parser will attempt to read the next chunk ID starting at an odd offset (e.g. reading `\0d` `a` `t` `a` instead of `data`), fail to find the expected sub-chunk header, and crash or report an unrecognized format error. Robust parsers must advance by `8 + chunkSize + (chunkSize & 1)` bytes.

---

### Question 2: Why does EchoMap scale 16-bit PCM integer samples by $32768.0$ rather than $32767.0$, and what is the mathematical consequence of using $32767.0$?

**Answer:**
A signed 16-bit two's complement integer has an asymmetric range of $[-32768, 32767]$:
- Negative minimum: $-32768 = -2^{15}$
- Positive maximum: $+32767 = +2^{15} - 1$
- Total distinct levels: $2^{16} = 65536$

If audio samples are scaled by dividing by $32767.0$:
1. A full-scale negative integer $-32768$ maps to $-32768 / 32767 = -1.0000305$, which exceeds the normalized physical amplitude bound $[-1.0, 1.0]$. This triggers clipping detectors and causes numerical instability in filter stages.
2. If asymmetric scaling is attempted (dividing negative numbers by 32768 and positive numbers by 32767), it introduces an asymmetric transfer curve (a non-linear slope discontinuity around zero). This slope error manifests as harmonic distortion ($> 3.1 \times 10^{-5}$ error), which compromises low-level decay integration.

Dividing by $2^{15} = 32768.0$ uniformly preserves perfect linearity across the entire dynamic range. In the encoder, samples in $[-1.0, 1.0]$ are multiplied by $32768.0$ and clamped to $[-32768, 32767]$. The maximum possible quantization round-trip error is strictly:

$$\epsilon_{\max} = \frac{0.5}{32768} \approx 1.526 \times 10^{-5}$$

which comfortably passes EchoMap's strict quantization tolerance ($3.1 \times 10^{-5}$).

---

### Question 3: Under what acoustic conditions does a recording yield a PNR between 10.0 dB and 20.0 dB, what is the effective override operating band, and why must rejection override remain strictly guarded?

**Answer:**
Peak-to-Noise Ratio (PNR) measures the difference between the direct sound arrival peak and the root-mean-square (RMS) energy of ambient noise measured prior to the sweep arrival:

$$\text{PNR} = 20 \log_{10} \left( \frac{|h_{\text{peak}}|}{\text{RMS}(h_{\text{noise}})} \right)$$

In EchoMap, recordings with $\text{PNR} < 20.0$ dB are normally rejected because noise-floor contamination can bias Schroeder backward integration. However, in noisy real-world environments (such as an open public space or a classroom near ventilation ducts), a genuine sweep may be detected with a marginal PNR between 10.0 dB and 20.0 dB.

#### The Effective Override Band (~14 to 20 dB PNR):
While the architecture nominally permits override evaluation when $\text{PNR} \ge 10.0\text{ dB}$, **the effective override operating band is approximately 14 to 20 dB PNR**. Below ~14 dB PNR, ambient noise energy swamps the 200 ms post-peak direct arrival window, causing the post-to-pre energy ratio $\Delta E_{\text{post/pre}}$ to drop below the required 1.5 dB threshold. Thus, genuine sweeps with $\text{PNR} < 14\text{ dB}$ will rarely qualify for override.

#### The Post-Peak Energy Margin Check ($\Delta E_{\text{post/pre}} \ge 1.5\text{ dB}$):
$$\Delta E_{\text{post/pre}} = 20 \log_{10} \left( \frac{\text{RMS}(h_{\text{post\_peak\_200ms}})}{\text{RMS}(h_{\text{noise}})} \right) \ge 1.5 \text{ dB}$$

- **True Acoustic Room Sweeps:** The 200 ms interval immediately following direct sound arrival contains strong early room reflections (specular reflections from boundaries). Thus, $\Delta E_{\text{post/pre}}$ is high (typically $3.0 \text{ to } 12.0$ dB).
- **Stationary White Noise Testing:** Tested across 20 independent stationary white-noise seeds, the maximum $\Delta E_{\text{post/pre}}$ observed was $0.33\text{ dB}$ (mean $\approx 0.0\text{ dB}$), maintaining a $>1.1\text{ dB}$ safety margin below the 1.5 dB threshold. Stationary Gaussian white noise did not accidentally trigger the override in any tested seed.
- **Non-Stationary Impulsive Noise Protection (Sweep-Signature Gate):** Testing with non-stationary audio initially revealed an important physical edge case: a single clap-like decaying burst (with no sweep present) produces $\text{PNR} \approx 19.8\text{ dB}$ and $\Delta E_{\text{post/pre}} \approx 9.1\text{ dB}$, which would previously have triggered the override offer. When deconvolved against the inverse sweep filter, the sudden impulse reconstructs the inverse filter itself (a time-reversed, decaying chirp) that yields misleadingly high $R^2$ values in high bands (e.g. 2 kHz = 1.24 s with $R^2 = 0.993$; 4 kHz = 1.71 s with $R^2 = 0.991$).
  To completely eliminate this vulnerability, the automated **Sweep-Signature Gate** (`checkSweepSignature`) was added to verify the strict chronological band progression ($125 \to 4000\text{ Hz}$). All non-sweep impulsive sounds (clean claps, noisy claps, sudden bursts, 50 Hz hum) score well below the $0.650$ threshold (scoring $0.000$ to $0.407$) and are rejected on both the normal and override paths. `canOverrideLowPnr` is forced to `false`, and passing `allowLowPnr: true` refuses internally. Across 20 positive sweep configurations (offsets 0.5s–20s in a 30s recording, RT60 targets 0.3s–1.5s, white and brown noise ladders), the ordering score remains robustly above threshold ($0.748$ to $0.948$), maintaining a clear separation gap ($\Delta S \ge 0.341$) from negative non-sweep sounds.

#### Aggregation and Exclusion Policy:
Because low-confidence measurements can introduce false or imprecise decays, EchoMap strictly enforces:
1. **Default Exclusion:** Measurements flagged `lowConfidence: true` are completely excluded by default from the RT60 heatmap, session aggregation, hotspot placement hints, and Sabine/Eyring treatment calculations.
2. **Explicit Opt-In Only:** Users must explicitly check an opt-in toggle to include low-confidence data, which immediately activates a persistent, high-visibility `LOW CONFIDENCE` badge across cards and banners.

---

### Question 4: Does the 125 Hz positive bias survive multi-seed evaluation, and is it caused by Butterworth filter ringing?

**Answer:**
1. **Bias Survival with 30 Seeds:** In a 30-seed Monte Carlo study per RT60 target (150 total simulations), the positive bias at 125 Hz **survives with statistical significance**:
   - Target 0.3 s: Mean Error = $+4.11\%$, SEM = $1.63\%$, $95\%\text{ CI} = [+0.85\%, +7.37\%]$ ($t = 2.52, p = 0.017$).
   - Target 0.6 s: Mean Error = $+3.65\%$, SEM = $0.87\%$, $95\%\text{ CI} = [+1.91\%, +5.39\%]$ ($t = 4.20, p < 0.001$).
   - Target 0.8 s: Mean Error = $+2.37\%$, SEM = $0.82\%$, $95\%\text{ CI} = [+0.73\%, +4.02\%]$.
   - At longer targets (1.2 s and 1.5 s), the 95% confidence interval spans zero, showing that the bias attenuates as RT60 increases.
2. **Cause: Sweep Edge Truncation vs. Butterworth Ringing:**
   - Recovering a known exponential decay (0.3 s) directly through the 125 Hz Butterworth bandpass filter without sweep deconvolution yields a mean error of only $+0.22\%$, ruling out internal Butterworth filter impulse ringing as the primary driver.
   - Deconvolving a sweep starting at $f_1 = 50\text{ Hz}$ yields $+8.52\%$ error, whereas starting the sweep at $f_1 = 20\text{ Hz}$ reduces the error to $+1.11\%$.
   - **Conclusion:** The positive bias at 125 Hz is real and physically driven by **sweep start-frequency truncation** ($f_1 = 50\text{ Hz}$ truncates the lower filter skirt of the 125 Hz octave band, which extends down toward 44–60 Hz). Filter ringing was experimentally ruled out as negligible (+0.22%). In future iterations, playing the test sweep from an external sound source capable of reproducing down to 20–30 Hz would alleviate this lower-skirt truncation.

---

### Question 5: Why can't EchoMap analyse handclaps or balloon pops, and how does the sweep-signature gate protect against impulse sounds?

**Answer:**
1. **The Impulse Deconvolution Illusion:**
   EchoMap relies on Farina's synchronous exponential sine sweep technique. When a room impulse response $h(t)$ is excited by sweep $s(t)$, the recorded microphone signal is $y(t) = s(t) * h(t) + n(t)$. Convolving $y(t)$ with the analytical inverse filter $f(t)$ collapses the sweep into a Dirac-like impulse $\delta(t)$, recovering $h(t) = f(t) * y(t)$.

   However, if a user claps their hands or pops a balloon instead of playing the sweep, the acoustic input is approximately an impulse: $y(t) \approx \delta(t)$. Convolving this with the inverse filter yields:
   $$y(t) * f(t) \approx \delta(t) * f(t) = f(t)$$
   The deconvolution output is **the inverse filter itself** — an amplitude-decaying chirp sweeping backwards from high frequencies to low frequencies. When filtered into octave bands, the tail of this chirp produces energy decay curves that look deceivingly like real room decays (e.g., $R^2 > 0.99$ at 2 kHz and 4 kHz), creating false RT60 readings.
2. **The Sweep-Signature Gate:**
   To prevent claps, balloon pops, and non-sweep ambient transients from being analyzed, EchoMap implements a chronological octave-band progression gate (`checkSweepSignature` in `src/analysis/pipeline.js`):
   - In an exponential sine sweep $f(t) = f_1 \cdot e^{t / L}$ (where $L = T / \ln(f_2 / f_1) \approx 0.985$ s for $T = 5$ s, $50 \to 8000$ Hz), the sweep passes through each octave band center frequency in strict chronological order ($125 \to 250 \to 500 \to 1000 \to 2000 \to 4000$ Hz).
   - The time between successive octave center frequencies is constant:
     $$\Delta t = L \cdot \ln(2) \approx 0.683\text{ s}$$
   - The total sweep duration across these 6 band centers is approximately $5 \times 0.683\text{ s} \approx 3.41$ s.
   - A handclap or impulse distributes acoustic energy into all octave bands simultaneously ($\Delta t \approx 0$ s).
   - Ambient stationary noise or hum produces random, uncorrelated peak arrival times across bands.
3. **Decision Logic & Rejection:**
   The gate measures 50 ms RMS block envelopes (25 ms hop) across all 6 octave bands of the raw recording:
   - Evaluates whether band peak times are monotonically increasing ($t_{125} < t_{250} < \dots < t_{4000}$).
   - Scores inter-band intervals against the expected $\approx 0.68$ s spacing (tolerance window $[0.35, 1.15]$ s accounting for room reverberation delays).
   - Rejects recordings with score $< 0.65$ or span $< 2.2$ s, returning the clear user guidance:
     *"This doesn't look like the EchoMap test sweep (a clap or another sound was recorded instead). Play the downloaded sweep."*
   - Applied universally on both the normal analysis path and the low-PNR override path. Override is internally refused if the sweep signature is absent.
4. **Empirical Verification Matrix & Separation Gap (Phase 3a-2e Audit):**
   - **Positive Sweep Cases (20 configurations):** Clean fixtures (single and multi-band), 44.1 kHz synthetic, offsets 0.5s, 3s, 10s, and 20s inside a 30s recording, room targets from 0.3s to 1.5s, and white/brown noise ladders (clean to 0 dB re peak). All 20 configurations pass with scores from $0.748$ to $0.948$. The smallest positive margin is **+0.098** (0 dB Brown noise: score 0.748).
   - **Negative Cases (7 configurations):** Clean clap, noisy clap, noise + burst, 50 Hz hum + noise, pure white noise, pure brown noise, pure silence. All 7 cases are rejected with scores from $0.000$ to $0.407$. The smallest negative margin below threshold is **-0.243** (pure white noise: score 0.407).
   - **Separation Gap:** A wide gap of **0.341 score units** separates the highest negative non-sweep sound ($0.407$) from the lowest valid sweep sound ($0.748$), proving the $0.650$ threshold is well-centered and robust.
5. **Debug Diagnostics in UI:**
   To enable immediate debugging of field recordings, both accepted results and rejected cards render a collapsed `<details>` section displaying: PNR (dB), $\Delta E_{\text{post/pre}}$ (dB), ordering score and threshold, sample rate (Hz), duration (s), and which specific gate fired.

---

## 4. References

1. **Farina, A. (2000).** "Simultaneous measurement of impulse response and distortion with a swept-sine technique." *108th Audio Engineering Society Convention*, Paris, France.
2. **Schroeder, M. R. (1965).** "New Method of Measuring Reverberation Time." *The Journal of the Acoustical Society of America*, 37(3), 409–412.
3. **ISO 3382-1:2009.** "Acoustics — Measurement of room acoustic parameters — Part 1: Performance spaces." International Organization for Standardization, Geneva, Switzerland.
4. **ISO 3382-2:2008.** "Acoustics — Measurement of room acoustic parameters — Part 2: Reverberation time in ordinary rooms." International Organization for Standardization, Geneva, Switzerland.
5. **Sabine, W. C. (1922).** *Collected Papers on Acoustics*. Harvard University Press, Cambridge, MA.
6. **Eyring, C. F. (1930).** "Reverberation Time in 'Dead' Rooms." *The Journal of the Acoustical Society of America*, 1(2), 217–241.
