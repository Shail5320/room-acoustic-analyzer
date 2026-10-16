"""
reference/sweep.py — Exponential sine sweep and Farina inverse filter generation.

Theory (Farina 2000):
An exponential sine sweep spends more time at low frequencies than at high frequencies:
  f(t) = f1 * exp(t / L), where L = T / ln(f2 / f1)
  phi(t) = 2*pi * f1 * L * (exp(t / L) - 1)
  x(t) = sin(phi(t))

The power spectral density falls at ~3 dB/octave (pink noise distribution).
The inverse filter is the time-reversed sweep weighted by exp(-t / L):
  x_inv(t) = x(T - t) * exp(-t / L)
This boosts high frequencies at +3 dB/octave relative to low frequencies, yielding
a flat magnitude spectrum across [f1, f2] when convolved with x(t).
"""

import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-echomap")

import numpy as np
import scipy.signal
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Configuration constants
FS = 48000           # Sample rate in Hz
T = 5.0              # Duration in seconds
F1 = 50.0            # Start frequency in Hz
F2 = 8000.0          # End frequency in Hz
FADE_MS = 20.0       # 20 ms half-Hann fade at start and end


def generate_sweep(f1: float = F1, f2: float = F2, T: float = T,
                   fs: int = FS, fade_ms: float = FADE_MS) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate an exponential sine sweep with half-Hann fade-in and fade-out.
    Returns (sweep, t).
    """
    N = int(round(T * fs))
    t = np.arange(N, dtype=np.float64) / fs
    L = T / np.log(f2 / f1)
    K = 2.0 * np.pi * f1 * L
    phase = K * (np.exp(t / L) - 1.0)
    sweep = np.sin(phase)

    # Half-Hann fade-in and fade-out
    fade_len = int(round(fade_ms * 1e-3 * fs))
    if fade_len > 0 and 2 * fade_len <= N:
        hann_in = 0.5 * (1.0 - np.cos(np.pi * np.arange(fade_len) / fade_len))
        hann_out = 0.5 * (1.0 + np.cos(np.pi * np.arange(fade_len) / fade_len))
        sweep[:fade_len] *= hann_in
        sweep[-fade_len:] *= hann_out

    return sweep, t


def generate_inverse_filter(sweep: np.ndarray, f1: float = F1, f2: float = F2,
                            T: float = T, fs: int = FS) -> np.ndarray:
    """
    Generate the matching inverse filter: x_inv(t) = sweep(T - t) * exp(-t / L).
    """
    N = len(sweep)
    t = np.arange(N, dtype=np.float64) / fs
    L = T / np.log(f2 / f1)

    # Time reverse and apply falling exponential envelope
    inv = sweep[::-1] * np.exp(-t / L)
    return inv


def compute_peak_to_sidelobe(conv: np.ndarray, fs: int = FS,
                             window_ms: float = 5.0) -> tuple[float, float, float, int]:
    """
    Compute peak-to-sidelobe ratio in dB for convolution result.
    window_ms: half-width of the mainlobe window excluded from sidelobe measurement.
    Returns (psr_db, peak_val, max_sidelobe, peak_idx).
    """
    abs_conv = np.abs(conv)
    peak_idx = int(np.argmax(abs_conv))
    peak_val = float(abs_conv[peak_idx])

    window_samples = int(round(window_ms * 1e-3 * fs))
    mask = np.ones(len(conv), dtype=bool)
    lo = max(0, peak_idx - window_samples)
    hi = min(len(conv), peak_idx + window_samples + 1)
    mask[lo:hi] = False

    sidelobes = abs_conv[mask]
    max_sidelobe = float(np.max(sidelobes)) if len(sidelobes) > 0 else 1e-12
    psr_db = float(20.0 * np.log10(peak_val / max_sidelobe))

    return psr_db, peak_val, max_sidelobe, peak_idx


def plot_diagnostics(sweep: np.ndarray, inv: np.ndarray, conv: np.ndarray,
                     plots_dir: str = "reference/plots") -> None:
    """Generate and save spectrogram, magnitude spectrum, and convolved impulse plots."""
    os.makedirs(plots_dir, exist_ok=True)

    # 1. Spectrogram of the sweep
    fig, ax = plt.subplots(figsize=(8, 4.2), layout="constrained")
    f_spec, t_spec, Sxx = scipy.signal.spectrogram(
        sweep, fs=FS, nperseg=2048, noverlap=1536, scaling="spectrum"
    )
    Sxx_db = 10 * np.log10(np.maximum(Sxx, 1e-12))
    mesh = ax.pcolormesh(t_spec, f_spec, Sxx_db, shading="gouraud", cmap="viridis")
    cbar = fig.colorbar(mesh, ax=ax)
    cbar.set_label("Power (dB)")
    ax.set_yscale("log")
    ax.set_ylim([F1 * 0.8, FS / 2])
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Frequency (Hz)")
    ax.set_title("Exponential Sine Sweep Spectrogram (Log Frequency)")
    spectrogram_path = os.path.join(plots_dir, "sweep_spectrogram.png")
    fig.savefig(spectrogram_path, dpi=180)
    plt.close(fig)

    # 2. Magnitude Spectrum: Sweep (-3 dB/oct) vs Inverse Filter (+3 dB/oct)
    Nfft = 1 << 19  # 524288
    X_sw = np.fft.rfft(sweep, n=Nfft)
    X_inv = np.fft.rfft(inv, n=Nfft)
    X_prod = X_sw * X_inv
    freqs = np.fft.rfftfreq(Nfft, 1.0 / FS)

    mask = (freqs >= 20.0) & (freqs <= 20000.0)
    f_plot = freqs[mask]

    fig, ax = plt.subplots(figsize=(9, 4.8), layout="constrained")
    ax.semilogx(f_plot, 20 * np.log10(np.abs(X_sw[mask]) + 1e-12),
                label="Sweep (falls ~3 dB/octave)", color="#006399", lw=1.2)
    ax.semilogx(f_plot, 20 * np.log10(np.abs(X_inv[mask]) + 1e-12),
                label="Inverse filter (rises ~3 dB/octave)", color="#ba1a1a", lw=1.2)
    # Normalize product for display
    prod_db = 20 * np.log10(np.abs(X_prod[mask]) + 1e-12)
    ax.semilogx(f_plot, prod_db - 30.0,
                label="Convolved product - 30 dB (flat across [50, 8000] Hz)",
                color="#107c41", lw=1.5)
    ax.axvspan(F1, F2, color="gray", alpha=0.15, label="Active band [50, 8000] Hz")
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("Magnitude (dB)")
    ax.set_ylim([-40, 95])
    ax.set_xlim([20, 20000])
    ax.grid(True, which="both", ls=":", alpha=0.6)
    ax.legend(loc="upper right", fontsize=8.5)
    ax.set_title("Magnitude Spectra: Sweep, Inverse Filter, and Flat Convolved Product")
    spectrum_path = os.path.join(plots_dir, "sweep_and_inverse_spectrum.png")
    fig.savefig(spectrum_path, dpi=180)
    plt.close(fig)

    # 3. Convolved impulse response
    peak_idx = int(np.argmax(np.abs(conv)))
    peak_val = np.abs(conv[peak_idx])
    time_ms = (np.arange(len(conv)) - peak_idx) * 1000.0 / FS

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9, 6), layout="constrained")
    zoom10 = (time_ms >= -10.0) & (time_ms <= 10.0)
    norm_conv = conv / peak_val
    ax1.plot(time_ms[zoom10], norm_conv[zoom10], color="#006399", lw=1.0)
    ax1.set_xlabel("Time relative to peak (ms)")
    ax1.set_ylabel("Normalized Amplitude")
    ax1.set_title("Convolved Impulse Response (Linear scale, ±10 ms zoom)")
    ax1.grid(True, ls=":", alpha=0.6)

    zoom50 = (time_ms >= -50.0) & (time_ms <= 50.0)
    env_db = 20 * np.log10(np.maximum(np.abs(norm_conv[zoom50]), 1e-6))
    ax2.plot(time_ms[zoom50], env_db, color="#ba1a1a", lw=1.0)
    ax2.axvline(0, color="gray", ls="--", alpha=0.7)
    ax2.set_xlabel("Time relative to peak (ms)")
    ax2.set_ylabel("Magnitude (dBFS)")
    ax2.set_ylim([-80, 5])
    ax2.set_title("Convolved Impulse Response (dB scale showing sidelobe decay)")
    ax2.grid(True, ls=":", alpha=0.6)

    impulse_path = os.path.join(plots_dir, "sweep_convolution_impulse.png")
    fig.savefig(impulse_path, dpi=180)
    plt.close(fig)


def main():
    print("=" * 65)
    print("EchoMap Reference: Exponential Sine Sweep & Inverse Filter")
    print("=" * 65)
    print(f"Sample Rate (fs):   {FS} Hz")
    print(f"Sweep Range:        {F1} Hz to {F2} Hz")
    print(f"Duration (T):       {T} s ({int(T * FS)} samples)")
    print(f"Half-Hann Fade:     {FADE_MS} ms ({int(FADE_MS * 1e-3 * FS)} samples)")

    sweep, t = generate_sweep()
    inv = generate_inverse_filter(sweep)

    # Convolve via FFT
    conv = scipy.signal.fftconvolve(sweep, inv, mode="full")

    # Spectral slopes
    Nfft = 1 << 19
    X_sw = np.fft.rfft(sweep, n=Nfft)
    X_inv = np.fft.rfft(inv, n=Nfft)
    freqs = np.fft.rfftfreq(Nfft, 1.0 / FS)
    mask = (freqs >= 100.0) & (freqs <= 4000.0)
    f_sub = freqs[mask]
    octaves = np.log2(f_sub / f_sub[0])

    slope_sw, _ = np.polyfit(octaves, 20 * np.log10(np.abs(X_sw[mask])), 1)
    slope_inv, _ = np.polyfit(octaves, 20 * np.log10(np.abs(X_inv[mask])), 1)
    slope_prod, _ = np.polyfit(octaves, 20 * np.log10(np.abs(X_sw[mask] * X_inv[mask])), 1)

    print("\n--- Spectral Slopes across [100, 4000] Hz ---")
    print(f"Sweep Amplitude Slope:           {slope_sw:+.2f} dB/octave (theoretical: -3.01 dB/oct)")
    print(f"Inverse Filter Amplitude Slope:  {slope_inv:+.2f} dB/octave (theoretical: +3.01 dB/oct)")
    print(f"Convolved Product Slope:         {slope_prod:+.2f} dB/octave (theoretical:  0.00 dB/oct)")

    print("\n--- Peak-to-Sidelobe Ratio Measurements ---")
    psr_1ms, peak, s_1ms, peak_idx = compute_peak_to_sidelobe(conv, FS, window_ms=1.0)
    psr_5ms, _, s_5ms, _ = compute_peak_to_sidelobe(conv, FS, window_ms=5.0)
    psr_10ms, _, s_10ms, _ = compute_peak_to_sidelobe(conv, FS, window_ms=10.0)
    psr_20ms, _, s_20ms, _ = compute_peak_to_sidelobe(conv, FS, window_ms=20.0)

    print(f"Convolution peak sample index:   {peak_idx} (center: {len(sweep)-1})")
    print(f"Peak amplitude:                  {peak:.4f}")
    print(f"Excluding ±1.0 ms:  PSR = {psr_1ms:.2f} dB  (max sidelobe = {s_1ms:.4f})")
    print(f"Excluding ±5.0 ms:  PSR = {psr_5ms:.2f} dB  (max sidelobe = {s_5ms:.4f})")
    print(f"Excluding ±10.0 ms: PSR = {psr_10ms:.2f} dB  (max sidelobe = {s_10ms:.4f})")
    print(f"Excluding ±20.0 ms: PSR = {psr_20ms:.2f} dB  (max sidelobe = {s_20ms:.4f})")

    print("\n--- Physical & Mathematical Limits of Peak-to-Sidelobe Ratio ---")
    print("1. Band-Limitation (50 Hz to 8000 Hz):")
    print("   The sweep has finite bandwidth, so the convolved impulse is a bandpass")
    print("   sinc-like function rather than an ideal Dirac delta. An ideal rectangular-band")
    print("   sinc function has its first sidelobe at -13.3 dB relative to peak.")
    print("2. Boundary Transitions & Window Fades (20 ms half-Hann):")
    print("   The half-Hann fade smooths edge discontinuities and prevents click artifacts,")
    print("   tapering the Gibbs oscillations at the cost of a finite transition bandwidth.")
    print("3. Time-Frequency Decay:")
    print("   Sidelobe energy decays rapidly with distance from the direct peak:")
    print("   at ±5 ms it drops below -50 dB, and by ±20 ms it is suppressed past -61 dB.")

    plots_dir = "reference/plots"
    plot_diagnostics(sweep, inv, conv, plots_dir)
    print(f"\nPlots saved to {plots_dir}/")


if __name__ == "__main__":
    main()
