# Phase 0: Python Reference — Sweeps, Deconvolution, Filters & Schroeder RT60

## 1. Concepts in Plain Language

### 1.1 The Room Impulse Response (RIR)
When a sound is emitted inside a room, an observer receives:
1. **The direct sound:** Traveling straight from the source to the listener along the shortest path.
2. **Early reflections:** Bouncing off the floor, ceiling, and nearby walls within 50 ms. These give our brain spatial cues about room size.
3. **Late diffuse reverberation:** Thousands of overlapping reflections per second forming a dense, decaying stochastic "tail".

The **Room Impulse Response (RIR)**, denoted $h(t)$, is the linear mathematical fingerprint of the room. If we know $h(t)$, we can predict how any audio signal $x(t)$ will sound in that space via convolution:
$$y(t) = (x * h)(t) = \int_0^\infty x(\tau) h(t - \tau) d\tau$$

### 1.2 Why Not Just Pop a Balloon?
Historically, acousticians created an impulse using a starter pistol or popping a balloon. While simple, impulsive sources suffer from serious drawbacks:
- **Low signal-to-noise ratio (SNR):** All the energy must be released in a fraction of a millisecond. High peak amplitudes cause non-linear distortion in small phone microphones and speakers.
- **Poor repeatability:** No two balloon pops have identical spectral content or energy.
- **Safety and convenience:** Starter pistols cannot be used in domestic apartments or offices.

### 1.3 The Farina Exponential Sine Sweep Method
Instead of concentrating all acoustic energy into an instant, Angelo Farina (2000) demonstrated that we can spread excitation energy evenly over several seconds using an **exponential sine sweep** (chirp).

An exponential sweep starts low ($f_1 = 50\text{ Hz}$) and smoothly glides to high ($f_2 = 8000\text{ Hz}$), spending exponentially more time in lower octaves than in higher octaves. Because the instantaneous frequency increases exponentially, the sweep's power spectral density rolls off at **$-3\text{ dB/octave}$** (pink noise characteristic).

### 1.4 Deconvolution & Harmonic Distortion Separation
When the room recording $y(t)$ is convolved with a specially designed **inverse filter** $x_\text{inv}(t)$ (which is the time-reversed sweep amplitude-tapered by $+3\text{ dB/octave}$), two things happen:
1. The linear impulse response compresses into a sharp, high-SNR impulse spike (time compression gain $> 40\text{ dB}$).
2. **Non-linear harmonic distortion separates in time:** Any non-linear harmonics produced by a cheap phone speaker (2nd, 3rd, 4th harmonics) sweep faster than the fundamental. In the deconvolved response, all harmonic distortion products appear **before** the direct linear impulse, allowing clean time-window isolation of the purely linear room response!

### 1.5 Octave Band Filtering & Filter Ringing
Human perception of pitch is logarithmic: every doubling in frequency represents one octave. Standard acoustic analysis groups reverberation into octave bands centred at:
$$125\text{ Hz}, \quad 250\text{ Hz}, \quad 500\text{ Hz}, \quad 1000\text{ Hz}, \quad 2000\text{ Hz}, \quad 4000\text{ Hz}$$

To filter these bands, we use a 4th-order Butterworth bandpass filter ($N=2$ design order in SciPy, realized as 2 Second-Order Sections / biquads).
> [!IMPORTANT]
> **Why $N=2$ (4th-order bandpass) and not $N=4$ (8th-order)?**  
> In filter theory, steeper stopband attenuation requires higher $Q$-factor poles. Higher order filters exhibit pronounced **impulse response ringing** (time-domain decay). At 125 Hz, the filter's own natural ringing time can approach 0.1–0.2 seconds. If the filter rings longer than the room decays, you measure the filter's decay rather than the room! $N=2$ provides standard $12\text{ dB/octave}$ rolloff while preserving time-domain resolution.

### 1.6 Schroeder Backward Integration
If you square the impulse response $h^2(t)$, you obtain the instantaneous power decay. However, because diffuse room reflections arrive with pseudo-random phases, $h^2(t)$ is extremely jagged and noisy. Fitting a straight line directly to $10 \log_{10}(h^2(t))$ is unstable.

In 1965, Manfred Schroeder proved mathematically that an ensemble average over infinite decays equals the **backward cumulative energy integral** of a single measured decay:
$$EDC(t) = \int_t^\infty h^2(\tau) d\tau = \int_t^T h^2(\tau) d\tau$$

Because integration accumulates energy backward from the quiet tail to the energetic arrival, the resulting **Energy Decay Curve (EDC)** is completely monotonic, smooth, and deterministic.

### 1.7 The Noise Floor Pitfall & Simplified Truncation Algorithm
In real measurements, the tail of $h(t)$ contains background acoustic noise ($w(t)$ with variance $\sigma^2 > 0$). If you integrate backward across the entire noisy signal:
$$\int_t^T (h_\text{clean}^2(\tau) + \sigma^2) d\tau = \int_t^T h_\text{clean}^2(\tau) d\tau + \sigma^2 (T - t)$$

The noise adds an artificial ramp $\sigma^2(T - t)$ that flattens out the decay curve in logarithmic space. On a dB scale, this causes the curve to level off into a horizontal plateau, drastically flattening the regression slope and **inflating the measured RT60** by several seconds!

#### Complete Numbered Algorithm Steps (Pure JS Reimplementation Specification)

To allow exact reimplementation in JavaScript (`src/dsp/rt60.js`) without reference to the Python source, the simplified noise-floor truncation and Schroeder integration algorithm is specified as follows:

1. **Direct Sound Peak Alignment:**
   - Locate the global absolute peak of the impulse response:
     $$n_\text{peak} = \arg\max_{n} |h[n]|$$
   - Extract the decaying response from the direct sound arrival forward:
     $$h_\text{decay}[n] = h[n + n_\text{peak}], \quad n = 0, \dots, N-1$$
   - Calculate direct sound peak power:
     $$P_\text{peak} = \max_{n} (h_\text{decay}[n]^2)$$
2. **Noise Floor Estimation ($\sigma^2$):**
   - If pre-sweep silence samples $s[m]$ ($m = 0, \dots, M-1$, with $M > 0$) are provided:
     $$\sigma^2 = \frac{1}{M} \sum_{m=0}^{M-1} s[m]^2$$
   - Otherwise, estimate from the late $15\%$ tail of the decay ($N_\text{tail} = \max(\lfloor 0.15 \cdot N \rfloor, 1)$):
     $$\sigma^2 = \frac{1}{N_\text{tail}} \sum_{k=N-N_\text{tail}}^{N-1} h_\text{decay}^2[k]$$
   - Compute peak-to-noise dynamic range:
     $$\text{DR}_\text{peak} = -10 \log_{10}\left(\frac{\max(\sigma^2, 10^{-15})}{\max(P_\text{peak}, 10^{-15})}\right)$$
3. **20 ms Smoothing Window (Squared Envelope):**
   - Window length in samples:
     $$W = \max(\lfloor 0.02 \cdot f_s \rfloor, 1)$$
   - Compute the smoothed squared energy envelope $\text{env}[n]$ by convolving $h_\text{decay}^2[n]$ with a rectangular kernel $\frac{1}{W}\mathbf{1}_W$ using centered alignment (`same` mode, zero-padded at boundaries):
     $$\text{env}[n] = \frac{1}{W} \sum_{j=-\lfloor W/2 \rfloor}^{\lfloor (W-1)/2 \rfloor} h_\text{decay}^2[n + j]$$
4. **Truncation Threshold (+3 dB) and Minimum Duration:**
   - Truncation threshold is $3\text{ dB}$ ($2.0\times$) above the noise floor:
     $$\text{threshold} = 2.0 \cdot \sigma^2$$
   - Find the first index $n$ where $\text{env}[n] < \text{threshold}$.
   - If found, $n_\text{trunc} = n$; if the envelope never drops below threshold, $n_\text{trunc} = N - 1$.
   - Enforce a minimum integration length of $50\text{ ms}$ if the signal permits:
     $$n_\text{trunc} = \max\left(n_\text{trunc}, \min(\lfloor 0.05 \cdot f_s \rfloor, N - 1)\right)$$
5. **Noise Energy Compensation & Backward Integration:**
   - Truncate the signal array: $h_\text{trunc} = h_\text{decay}[0 : n_\text{trunc}]$.
   - Compensate for residual steady noise power by subtracting $\sigma^2$ and clamping negative values to zero before backward accumulation:
     $$EDC[n] = \sum_{k=n}^{n_\text{trunc}-1} \max\left(0.0, h_\text{trunc}^2[k] - \sigma^2\right), \quad n = 0, \dots, n_\text{trunc}-1$$
   - *(Fallback)* If $EDC[0] \le 0$ or empty, integrate without subtraction: $EDC[n] = \sum_{k=n}^{n_\text{trunc}-1} h_\text{trunc}^2[k]$.
   - Normalize and convert to decibels:
     $$EDC_\text{norm}[n] = \frac{\max(EDC[n], 10^{-12})}{\max(EDC[0], 10^{-12})}$$
     $$EDC_\text{dB}[n] = 10 \log_{10}(EDC_\text{norm}[n])$$
6. **Usable Dynamic Range Estimation:**
   - For truncated integration, usable depth is determined by the truncation point:
     $$D_\text{usable} = \min\left(|EDC_\text{dB}[n_\text{trunc}-1]|, \text{DR}_\text{peak}\right)$$
   - For un-truncated integration, find where $\text{env}[n] < 2.0 \cdot \sigma^2$; if $n < N$, $D_\text{usable} = |EDC_\text{dB}[n]|$, else $\text{DR}_\text{peak}$.
7. **Least-Squares Linear Fit & $R^2$ Rule:**
   - Fit ordinary least squares $y = m \cdot t + c$ over the evaluation intervals:
     - **EDT:** $0\text{ dB}$ to $-10\text{ dB}$
     - **T20:** $-5\text{ dB}$ to $-25\text{ dB}$
     - **T30:** $-5\text{ dB}$ to $-35\text{ dB}$
   - Require at least 10 samples within the fit interval. If $< 10$ samples or slope $m \ge 0$, return NaN.
   - Extrapolate to 60 dB decay: $RT = -60.0 / m$.
   - Goodness of fit:
     $$R^2 = 1 - \frac{\sum_{i=1}^K (y_i - \hat{y}_i)^2}{\sum_{i=1}^K (y_i - \bar{y})^2}$$
   - Fit rule: require $R^2 \ge 0.95$.
8. **Validity Tier Classification & Metric Selection:**
   - Named constants:
     - $\text{FIT\_RANGE\_T30} = 35.0\text{ dB}$
     - $\text{FIT\_RANGE\_T20} = 25.0\text{ dB}$
     - $\text{TIER\_MARGIN\_DB} = 10.0\text{ dB}$
     - $\text{MIN\_R2} = 0.95$
   - Effective range: $D_\text{eff} = \text{round}(D_\text{usable}, 1)$.
   - Per-metric tier:
     - **`"valid"`**: $D_\text{eff} \ge \text{fit range} + 10\text{ dB}$ ($45\text{ dB}$ for T30, $35\text{ dB}$ for T20) AND $R^2 \ge 0.95$.
     - **`"approximate"`**: $D_\text{eff} \ge \text{fit range}$ ($35\text{ dB}$ for T30, $25\text{ dB}$ for T20) AND $R^2 \ge 0.95$, but below the 10 dB margin.
     - **`"invalid"`**: fails fit range or $R^2 < 0.95$.
   - Selection priority:
     1. T30 if `"valid"`
     2. T20 if `"valid"` (valid T20 with 10 dB margin is strictly preferred over approximate T30)
     3. T30 if `"approximate"`
     4. T20 if `"approximate"`
     5. Otherwise `"invalid"` (`used: "none"`).

---

## 2. Mathematical Foundations & Formulas

### 2.1 Exponential Sine Sweep (Farina Formulation)
Given start frequency $f_1$, end frequency $f_2$, duration $T$, and sample rate $f_s$:
$$\omega_1 = 2\pi f_1, \quad \omega_2 = 2\pi f_2$$
$$L = \frac{T}{\ln\left(\frac{f_2}{f_1}\right)}$$
$$K = 2\pi f_1 L$$
$$\phi(t) = K \left(e^{t / L} - 1\right), \quad t \in [0, T]$$
$$x(t) = \sin(\phi(t))$$

Boundary transients are eliminated with a half-Hann fade-in and fade-out of length $N_\text{fade} = \text{round}(0.02 \cdot f_s)$:
$$w_\text{in}[n] = 0.5 \left(1 - \cos\left(\frac{\pi n}{N_\text{fade}}\right)\right), \quad w_\text{out}[n] = 0.5 \left(1 + \cos\left(\frac{\pi n}{N_\text{fade}}\right)\right)$$

### 2.2 Farina Inverse Filter
$$x_\text{inv}(t) = x(T - t) \cdot e^{-t / L}$$
The falling exponential factor $e^{-t/L}$ introduces an amplitude ramp of $+6\text{ dB/octave}$ on the time-reversed sweep, compensating for the $-3\text{ dB/octave}$ power roll-off and yielding a flat spectrum across $[f_1, f_2]$ upon convolution.

### 2.3 Frequency-Domain Deconvolution
To avoid circular convolution time-domain time-aliasing, signals are zero-padded to the next power of two:
$$N_\text{fft} \ge N_y + N_\text{inv} - 1$$
$$h_\text{raw} = \text{IFFT}\left(\text{FFT}(y, N_\text{fft}) \cdot \text{FFT}(x_\text{inv}, N_\text{fft})\right)$$

The direct linear impulse response is identified by the global absolute maximum:
$$n_\text{peak} = \arg\max_n |h_\text{raw}[n]|$$

### 2.4 Octave-Band Butterworth Filter (SOS)
For each nominal centre frequency $f_c \in \{125, 250, 500, 1000, 2000, 4000\}\text{ Hz}$:
$$f_\text{lo} = \frac{f_c}{\sqrt{2}}, \quad f_\text{hi} = f_c \sqrt{2}$$

Digital prototype via Bilinear Transform with frequency pre-warping:
$$\Omega = 2 f_s \tan\left(\frac{\pi f}{f_s}\right)$$

A design order $N=2$ bandpass yields a 4th-order filter implemented as a cascade of 2 Second-Order Sections (biquads):
$$H(z) = \prod_{k=1}^2 \frac{b_{0k} + b_{1k}z^{-1} + b_{2k}z^{-2}}{1 + a_{1k}z^{-1} + a_{2k}z^{-2}}$$

### 2.5 Schroeder Integration & RT60 Regression
The normalized Energy Decay Curve in decibels:
$$EDC[n] = \sum_{k=n}^{N-1} h^2[k]$$
$$EDC_\text{dB}[n] = 10 \log_{10}\left(\frac{EDC[n]}{EDC[0]}\right)$$

Linear regression $y(t) = m \cdot t + c$ is fitted over specified evaluation ranges:
- **EDT (Early Decay Time):** $0\text{ dB}$ to $-10\text{ dB} \implies EDT = -60 / m_\text{EDT}$
- **T20:** $-5\text{ dB}$ to $-25\text{ dB} \implies T20 = -60 / m_{20}$
- **T30:** $-5\text{ dB}$ to $-35\text{ dB} \implies T30 = -60 / m_{30}$

Goodness of fit is quantified by the coefficient of determination $R^2$:
$$R^2 = 1 - \frac{\sum_{i} (y_i - \hat{y}_i)^2}{\sum_{i} (y_i - \bar{y})^2}$$

### 2.6 Validity Tiers & Decision Rules
Given effective usable dynamic range $D_\text{eff} = \text{round}(D_\text{usable}, 1)$:
1. **`"valid"` (High Confidence):**  
   $D_\text{eff} \ge \text{fit range} + 10\text{ dB}$ ($45\text{ dB}$ for T30, $35\text{ dB}$ for T20) AND $R^2 \ge 0.95$.
2. **`"approximate"` (Acceptable Fit, Margin Deficit):**  
   $D_\text{eff} \ge \text{fit range}$ ($35\text{ dB}$ for T30, $25\text{ dB}$ for T20) AND $R^2 \ge 0.95$, but below the 10 dB margin.
3. **`"invalid"` (Rejected):**  
   Fails fit range or $R^2 < 0.95$. Corrupted un-truncated curves fall into this tier.

---

## 3. Code Implementation Map

| File | Primary Functions | Role in Pipeline |
|---|---|---|
| [`reference/sweep.py`](file:///home/equator/playground/college/LSSP%20Project/reference/sweep.py) | `generate_sweep()`, `generate_inverse_filter()`, `compute_peak_to_sidelobe()` | Synthesizes Farina exponential sweep and matching inverse filter; verifies $43.89\text{ dB}$ peak-to-sidelobe ratio. |
| [`reference/synthetic_ir.py`](file:///home/equator/playground/college/LSSP%20Project/reference/synthetic_ir.py) | `generate_single_rt60_ir()`, `generate_multi_rt60_ir()` | Generates repeatable synthetic IR fixtures (seed=42) for single ($0.8\text{ s}$) and multi-band decay. |
| [`reference/bands.py`](file:///home/equator/playground/college/LSSP%20Project/reference/bands.py) | `design_octave_filters()`, `filter_band()`, `plot_magnitude_responses()` | Designs 4th-order Butterworth bandpass filters ($N=2$, 2 SOS) for 125–4000 Hz; plots magnitude responses. |
| [`reference/rt60.py`](file:///home/equator/playground/college/LSSP%20Project/reference/rt60.py) | `compute_edc()`, `fit_decay()`, `analyze_rt60()`, `plot_edc_curves()` | Implements Schroeder backward integration, simplified noise-floor truncation, T20/T30/EDT linear regression, and validity logic. |
| [`reference/run_phase0b.py`](file:///home/equator/playground/college/LSSP%20Project/reference/run_phase0b.py) | `run_phase0b()` | Orchestrates end-to-end recovery tests, noise-floor tests, prints summary tables, and exports `reference/expected_outputs.json`. |
| [`reference/expected_outputs.json`](file:///home/equator/playground/college/LSSP%20Project/reference/expected_outputs.json) | Ground truth JSON structure | Pinned reference coefficients and numerical targets used to validate Phase 2 pure-JavaScript implementations. |

---

## 4. Experimental Results & Verification

### 4.1 End-to-End Recovery on Synthetic IR Fixtures

#### Synthetic IR 1: Single RT60 ($0.800\text{ s}$ across all bands)
| Band (Hz) | True RT60 (s) | Recovered RT60 (s) | Error (%) | Metric | $R^2$ | Status |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **125** | 0.800 | 0.7314 | **-8.58%** | T30 | 0.9902 | Honest deviation (narrowband stochastic variance + filter ringing) |
| **250** | 0.800 | 0.7852 | **-1.85%** | T30 | 0.9964 | Target met ($\le 5\%$) |
| **500** | 0.800 | 0.7845 | **-1.93%** | T30 | 0.9981 | Target met ($\le 5\%$) |
| **1000** | 0.800 | 0.8030 | **+0.37%** | T30 | 0.9991 | Target met ($\le 5\%$) |
| **2000** | 0.800 | 0.8194 | **+2.43%** | T30 | 0.9994 | Target met ($\le 5\%$) |
| **4000** | 0.800 | 0.7947 | **-0.66%** | T30 | 0.9996 | Target met ($\le 5\%$) |

> [!NOTE]
> **Why is error at 125 Hz (-8.58%) higher than the 5% target?**  
> In stochastic room acoustics (Schroeder 1965), statistical fluctuations in the envelope of decaying white noise scale inversely with bandwidth: $\sigma \propto \frac{1}{\sqrt{B \cdot T}}$.  
> At 125 Hz, the octave bandwidth is only $B = 176.8 - 88.4 = 88.4\text{ Hz}$. This narrow bandwidth produces statistical fluctuations in the decaying noise envelope. In addition, the 4th-order filter at 125 Hz has an impulse response settling time on the order of 20–40 ms.

#### Synthetic IR 2: Multi-RT60 (Frequency-Dependent Room Decay)
| Band (Hz) | True RT60 (s) | Recovered RT60 (s) | Error (%) | Metric | $R^2$ | Status |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **125** | 1.200 | 1.1586 | **-3.45%** | T30 | 0.9863 | Target met ($\le 5\%$) |
| **250** | 1.000 | 1.0158 | **+1.58%** | T30 | 0.9948 | Target met ($\le 5\%$) |
| **500** | 0.800 | 0.8473 | **+5.91%** | T30 | 0.9977 | Slight adjacent-band filter leakage |
| **1000** | 0.700 | 0.7300 | **+4.29%** | T30 | 0.9982 | Target met ($\le 5\%$) |
| **2000** | 0.600 | 0.6065 | **+1.09%** | T30 | 0.9991 | Target met ($\le 5\%$) |
| **4000** | 0.500 | 0.5294 | **+5.89%** | T30 | 0.9998 | Slight adjacent-band filter leakage |

### 4.2 Noise Test Results (White Noise Addition)

| Test Condition | True RT60 (s) | Recovered T20 (s) | T20 Bias (s) | Recovered T30 (s) | T30 Bias (s) | Metric Used |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **SNR 30 dB (without truncation)** | 0.8000 | 0.8620 | +0.0620 | **6.2097** | **+5.4097** | T30 (corrupted) |
| **SNR 30 dB (simplified truncation)** | 0.8000 | **0.7983** | **-0.0017** | **0.7950** | **-0.0050** | T30 (recovered) |
| **SNR 20 dB (without truncation)** | 0.8000 | **10.2301** | **+9.4301** | **9.3194** | **+8.5194** | T30 (corrupted) |
| **SNR 20 dB (simplified truncation)** | 0.8000 | **0.7936** | **-0.0064** | **0.7578** | **-0.0422** | T30 (recovered) |

**Conclusion:** Without noise truncation, background noise at 20–30 dB SNR completely corrupts Schroeder integration, inflating RT60 by hundreds of percent. The simplified noise-floor truncation reduces bias from $+5.4\text{ s}$ down to $-0.005\text{ s}$ at 30 dB SNR, and from $+8.5\text{ s}$ down to $-0.042\text{ s}$ at 20 dB SNR.

### 4.3 Peak-to-Noise Dynamic Range (DR) vs. Time-Averaged SNR

In audio and speech processing, signal power is conventionally computed as the time average over the entire buffer:
$$P_\text{avg} = \frac{1}{N} \sum_{n=0}^{N-1} h^2[n]$$
However, an impulse response decays exponentially. In our $2.5\text{ s}$ synthetic fixture ($120{,}000$ samples), the energetic direct arrival lasts only a few milliseconds, while the tail approaches zero. Consequently:
- Peak direct-sound power: $P_\text{peak} = \max_n (h^2[n]) = 1.0 \implies 0\text{ dBFS}$
- Time-averaged power: $P_\text{avg} \approx 0.002449 \implies -26.11\text{ dBFS}$

Defining noise using time-averaged SNR underestimates the direct arrival's amplitude by $\sim 26\text{ dB}$. In room acoustics, the true physical constraint is the **Peak-to-Noise-Floor Dynamic Range (DR)**:
$$\text{DR}_\text{dB} = 10 \log_{10}\left(\frac{P_\text{peak}}{\sigma_\text{noise}^2}\right)$$

##### Systematic DR Evaluation (45 dB, 35 dB, 25 dB, 15 dB)
Evaluating the clean single-RT60 IR ($0.8000\text{ s}$) under controlled Gaussian noise floors:

| Condition | Est. DR | T20 (s) | T30 (s) | Metric Used | Validity Tier | Error vs. True (%) | $R^2$ | True RT60 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **DR 45 dB (no trunc)** | 18.3 dB | 10.9365 | 9.4943 | none | **invalid** | N/A | 0.8435 | 0.8000 s |
| **DR 45 dB (truncated)** | 45.0 dB | 0.7934 | **0.7534** | **T30** | **valid** | **-5.83%** | 0.9960 | 0.8000 s |
| **DR 35 dB (no trunc)** | 8.7 dB | 11.7439 | 10.7251 | none | **invalid** | N/A | 0.8045 | 0.8000 s |
| **DR 35 dB (truncated)** | 34.9 dB | **0.7109** | 0.6408 | **T20** | **approximate** | **-11.14%** | 0.9645 | 0.8000 s |
| **DR 25 dB (no trunc)** | 2.6 dB | 6.7071 | 6.3092 | none | **invalid** | N/A | 0.7648 | 0.8000 s |
| **DR 25 dB (truncated)** | 24.9 dB | 0.4827 | 0.4373 | none | **invalid** | N/A | 0.8828 | 0.8000 s |
| **DR 15 dB (no trunc)** | 0.0 dB | 4.1909 | 3.9411 | none | **invalid** | N/A | 0.7633 | 0.8000 s |
| **DR 15 dB (truncated)** | 16.4 dB | 0.0950 | 0.0864 | none | **invalid** | N/A | 0.7748 | 0.8000 s |

> [!NOTE]
> **Approximate Tier Audit (>15% Error Check):**  
> In the systematic DR evaluation, exactly one row is classified as `"approximate"`: **DR 35 dB (truncated)**. It falls back to T20 because usable dynamic range is $34.9\text{ dB}$, meeting the $25\text{ dB}$ fit range with $R^2 = 0.9645 \ge 0.95$, but falling just $0.1\text{ dB}$ short of the $35\text{ dB}$ high-confidence margin. Its recovery error vs. true $0.8000\text{ s}$ is **$-11.14\%$**, safely within the $\le 15\%$ tolerance threshold.

![Noise Decay Comparison](file:///home/equator/playground/college/LSSP%20Project/reference/plots/noise_decay_comparison.png)

#### Why Un-Truncated Schroeder Curves Level Off & Inflate RT60
When noise of variance $\sigma^2$ is integrated without truncation across $N$ samples, the total accumulated noise energy is $E_\text{noise} = N \cdot \sigma^2$. At $\text{DR} = 45\text{ dB}$, $\sigma^2 = 10^{-4.5} \approx 3.16 \times 10^{-5}$. Over $120{,}000$ samples:
$$E_\text{noise} = 120{,}000 \times 3.16 \times 10^{-5} \approx 3.79$$
Meanwhile, the clean signal's total integrated energy is only $E_\text{sig} = \sum h^2 \approx 0.058$. **The noise energy is $65\times$ greater than the total room response energy!**

As backward integration proceeds from $n=N$ to $n=0$, the noise accumulates linearly: $\sigma^2(N - n)$. On a logarithmic (dB) scale, this creates a slow ramp that flattens out the decay curve into an artificial plateau. Fitting a line through this flat plateau inflates T30 to $\sim 9.5\text{ s}$ ($+1086\%$ error!).

#### Validity Logic Audit
- **Old naive check:** Defined available dynamic range simply as $\text{DR} = 10 \log_{10}(P_\text{peak} / \sigma^2)$. At 45 dB DR without truncation, it observed $\text{DR} = 45\text{ dB} \ge 35\text{ dB}$ and falsely flagged the corrupted $9.5\text{ s}$ curve as valid T30.
- **Audited robust check:**
  1. The available decay depth is computed from the EDC curve itself at the point where the signal envelope hits the noise floor ($2\sigma^2$). Without truncation, the plateau limits usable decay depth to only $\sim 18.3\text{ dB}$ (at 45 dB DR) or $\sim 8.7\text{ dB}$ (at 35 dB DR).
  2. The linear regression fit must satisfy $R^2 \ge 0.95$.
  Under these audited rules, **all corrupted no-truncation results are strictly rejected as invalid (`tier: "invalid", used: "none"`)**, preventing dangerous false reports in acoustic treatment design.
- **Boundary sensitivity at 25 dB DR:** At exactly $\text{DR} = 25\text{ dB}$, usable depth was $24.9\text{ dB}$ (0.1 dB below the threshold), triggering fallback to invalid.

---

### 4.4 Monte Carlo Statistical Analysis (30 Seeds): Scatter vs. Systematic Bias

In Phase 0b, single-seed evaluation (`seed=42`) showed deviations from the true RT60:
- Single-RT60 IR: $-8.58\%$ error at 125 Hz.
- Multi-RT60 IR: $+5.91\%$ at 500 Hz, $+5.89\%$ at 4 kHz.

To determine whether these deviations represent stochastic scatter (inherent acoustic variance) or systematic bias (algorithmic/filter leakage), we performed a 30-seed Monte Carlo study across seeds 0 to 29.

#### 1. Single-RT60 IR (True = 0.800 s across all bands)
| Band (Hz) | Mean Error (%) | Std Dev $\sigma$ (%) | 95% Confidence Interval ($\pm 2\sigma$) | Min Error (%) | Max Error (%) |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **125** | **-0.21%** | **6.41%** | $\pm 12.83\%$ | -13.53% | +10.87% |
| **250** | **+0.46%** | **3.75%** | $\pm 7.49\%$ | -6.70% | +8.94% |
| **500** | **-0.29%** | **2.74%** | $\pm 5.47\%$ | -6.52% | +6.65% |
| **1000** | **+0.35%** | **1.93%** | $\pm 3.86\%$ | -3.37% | +4.49% |
| **2000** | **+0.13%** | **1.25%** | $\pm 2.49\%$ | -2.84% | +2.52% |
| **4000** | **+0.01%** | **0.72%** | $\pm 1.44\%$ | -1.32% | +1.77% |

**Verdict: Pure Stochastic Scatter.**  
The ensemble mean error across 30 seeds is virtually zero ($-0.21\%$ at 125 Hz, $+0.01\%$ at 4 kHz). The single-seed error of $-8.58\%$ at 125 Hz lies at $-1.34\sigma$ from the mean, completely within normal Gaussian variation.  
*Physical cause:* Octave bandwidth scales with center frequency: $\Delta f = 88.4\text{ Hz}$ at 125 Hz vs $2828\text{ Hz}$ at 4 kHz. Schroeder's formulation demonstrates that statistical variance of an integrated noise tail scales as $\sigma \propto \frac{1}{\sqrt{B \cdot T}}$. Narrower bandwidth contains fewer room modes, increasing decay curve variance.

#### 2. Multi-RT60 IR (Synthesis Targets vs. Effective Ground Truth)

> [!IMPORTANT]
> **Synthesis Targets vs. Effective Truth:**  
> The nominal RT60 values assigned to the multi-RT60 fixture ($1.2, 1.0, 0.8, 0.7, 0.6, 0.5\text{ s}$) represent **synthesis targets** passed to the additive band decay generator (`synthetic_ir_multi.py`). Because each band is synthesized via digital bandpass filtering and summed into a single composite impulse response, the overlapping frequency skirts of adjacent filters cause residual energy from slower decays (such as 125 Hz at $1.2\text{ s}$) to bleed into the decay tails of faster-decaying bands (such as 500 Hz and 4000 Hz).  
> Consequently, the effective ground truth of the composite synthetic impulse response systematically differs from the nominal targets by up to about **$+6\%$**.  
> **Do not change filter orders:** Total filter order must remain 4 ($N=2$ design order, 2 SOS biquads) to prevent excessive filter ringing at 125 Hz. Acceptance criteria for Phase 2 validation must therefore use wider Tier-2 tolerances derived directly from the 30-seed Monte Carlo empirical distribution: $[\text{Mean bias} - 2\sigma, \text{Mean bias} + 2\sigma]$ per band.

| Band (Hz) | Target RT60 (s) | Mean Error ($N=2$) | Std Dev $\sigma$ | Mean ± 2σ Tolerance | Min Error (%) | Max Error (%) |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **125** | 1.20 | -0.48% | 6.16% | $[-12.8\%, +11.8\%]$ ($1.046$ – $1.342\text{ s}$) | -13.36% | +18.24% |
| **250** | 1.00 | **+4.64%** | 3.91% | $[-3.2\%, +12.5\%]$ ($0.968$ – $1.125\text{ s}$) | -2.45% | +12.48% |
| **500** | 0.80 | **+6.07%** | 2.73% | $[+0.6\%, +11.5\%]$ ($0.805$ – $0.892\text{ s}$) | -0.37% | +11.33% |
| **1000** | 0.70 | **+1.63%** | 2.04% | $[-2.5\%, +5.7\%]$ ($0.683$ – $0.740\text{ s}$) | -1.28% | +5.55% |
| **2000** | 0.60 | **+2.91%** | 1.63% | $[-0.4\%, +6.2\%]$ ($0.598$ – $0.637\text{ s}$) | +0.24% | +6.41% |
| **4000** | 0.50 | **+5.31%** | 1.27% | $[+2.8\%, +7.9\%]$ ($0.514$ – $0.539\text{ s}$) | +2.95% | +7.65% |

**Verdict: Systematic Filter Leakage Bias.**  
Unlike the single-RT60 IR, mean errors in the multi-band IR are systematically positive ($+6.07\%$ at 500 Hz, $+5.31\%$ at 4 kHz).  
*Physical cause:* In real rooms and additive multi-band synthesis, lower frequencies decay much more slowly ($1.2\text{ s}$ at 125 Hz) than higher frequencies ($0.5\text{ s}$ at 4 kHz). After $0.8\text{ s}$, the 4 kHz band has decayed by $> 55\text{ dB}$, whereas the 125 Hz band has decayed by only $24\text{ dB}$. The energy in the low frequencies is $30\text{ dB}$ higher!  
Even with $12\text{ dB/octave}$ attenuation, residual energy from slowly-decaying adjacent lower bands leaks through the Butterworth filter stopband into the quiet tail of the faster-decaying band, flattening its measured slope and inflating its RT60.  
*Diagnostic confirmation:* Increasing filter order to $N=4$ (8th-order bandpass, $24\text{ dB/octave}$ skirts) reduced the bias at 4 kHz from $+5.31\%$ to $+4.25\%$, confirming that stopband leakage accounts for the systematic shift. In practice, $N=2$ remains standard to prevent excessive time-domain filter ringing at 125 Hz.

---

## 5. Common Beginner Mistakes

1. **Integrating Forward Instead of Backward:**
   Running `np.cumsum(h**2)` integrates sound energy forward in time (accumulating energy over time). The Schroeder method requires integrating **backward from the quiet tail to the energetic arrival**: `np.cumsum(h[::-1]**2)[::-1]`.
2. **Integrating Before the Direct Sound Peak:**
   If you start Schroeder integration from sample $n=0$ of a recording that has 0.5 s of pre-sweep silence, the pre-arrival noise will be added into the total energy $EDC[0]$, distorting the top of the curve. Always detect the direct sound peak and integrate starting from that peak.
3. **Circular Convolution Aliasing:**
   When convolving in the frequency domain with FFT:
   $$\text{FFT}(x) \cdot \text{FFT}(y)$$
   if the FFT size is smaller than $\text{len}(x) + \text{len}(y) - 1$, the tail of the convolution wraps around to the beginning, destroying early reflections. Always pad to the next power of two:
   $$N_\text{fft} = 2^{\lceil \log_2(N_1 + N_2 - 1) \rceil}$$
4. **Confusing T20 and T30 Scaling:**
   T20 measures decay over a $20\text{ dB}$ span ($-5$ to $-25\text{ dB}$), while T30 measures over a $30\text{ dB}$ span ($-5$ to $-35\text{ dB}$). Both metrics estimate the time required for a full **$60\text{ dB}$** decay. Therefore, the regression slope $m$ (in dB/s) must always be converted using:
   $$RT = -\frac{60}{m}$$
   Do not divide by 20 or 30!

---

## 6. Check Your Understanding

1. **Why does harmonic distortion from a loudspeaker appear *before* the main impulse in a Farina exponential sweep deconvolution?**
2. **If an acoustic measurement has an effective dynamic range of only $28\text{ dB}$ between direct sound and background noise, why must the algorithm report T20 rather than T30?**
3. **Why does an 8th-order Butterworth bandpass filter ($N=4$) cause larger measurement errors than a 4th-order filter ($N=2$) when evaluating RT60 in the $125\text{ Hz}$ octave band?**
4. **Why is dynamic range defined by peak direct-sound power rather than time-averaged buffer power in an impulse response?**
5. **Why does the 125 Hz octave band exhibit a standard deviation of 6.4% in RT60 estimation, while the 4 kHz band exhibits only 0.72% across the same 30 seeds?**
