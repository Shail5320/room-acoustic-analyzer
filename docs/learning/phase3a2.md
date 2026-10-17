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

### Question 3: Under what acoustic conditions does a recording yield a PNR between 10.0 dB and 20.0 dB, and why does EchoMap require a post-peak energy verification before allowing the user to override rejection?

**Answer:**
Peak-to-Noise Ratio (PNR) measures the difference between the direct sound arrival peak and the root-mean-square (RMS) energy of ambient noise measured prior to the sweep arrival:

$$\text{PNR} = 20 \log_{10} \left( \frac{|h_{\text{peak}}|}{\text{RMS}(h_{\text{noise}})} \right)$$

In EchoMap, recordings with $\text{PNR} < 20.0$ dB are normally rejected because noise-floor contamination can bias Schroeder backward integration. However, in noisy real-world environments (such as an open public space or a classroom near ventilation ducts), a genuine sweep may be detected with a marginal PNR between 10.0 dB and 20.0 dB.

Crucially, **pure random noise** (a recording of ambient room noise containing no sweep at all) when deconvolved with an inverse sweep produces pseudo-random correlation artifacts that naturally yield a false PNR of approximately $14 \text{ to } 16$ dB. If EchoMap allowed a blind override for any signal with $\text{PNR} \ge 10.0$ dB, users recording pure silence or HVAC noise could override the rejection and generate completely fake RT60 values.

To solve this, EchoMap requires a second physical condition: **the post-peak energy margin check**:
$$\Delta E_{\text{post/pre}} = 20 \log_{10} \left( \frac{\text{RMS}(h_{\text{post\_peak\_200ms}})}{\text{RMS}(h_{\text{noise}})} \right) \ge 1.5 \text{ dB}$$

- In a **true acoustic room**, the 200 ms interval immediately following direct sound arrival contains strong early room reflections (specular reflections from floor, walls, and ceiling). Thus, $\Delta E_{\text{post/pre}}$ is high (typically $3.0 \text{ to } 12.0$ dB).
- In **pure noise**, the detected "peak" is merely a random statistical outlier, and the subsequent 200 ms window immediately drops back to the stationary noise floor ($\Delta E_{\text{post/pre}} \approx 0.0 \text{ dB} < 1.5 \text{ dB}$).

Therefore, pure noise cannot be overridden, while genuine low-SNR acoustic sweeps can be overridden with a visible `"Low Confidence"` flag and validity tiers capped at `"approximate"`.
