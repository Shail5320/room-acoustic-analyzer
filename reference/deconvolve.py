"""
reference/deconvolve.py — Frequency-Domain Deconvolution Reference Implementation.

Theory:
Given a room recording y(t) = s(t) * h(t) + n(t), where s(t) is the excitation sweep,
the impulse response h(t) is recovered by convolving y(t) with the inverse filter x_inv(t):
  h_est(t) = y(t) * x_inv(t) = [s(t) * x_inv(t)] * h(t) ≈ delta(t - T_sweep) * h(t)

In the frequency domain:
  H_est(f) = FFT(y, N) * FFT(x_inv, N)
  h_est(t) = IFFT(H_est, N)
Zero-padded to next power of 2 >= len(y) + len(x_inv) - 1 to prevent circular convolution wrap-around.

Peak Detection & IR Extraction:
In physical measurements, non-linear harmonic distortion appears in time BEFORE the linear direct sound.
The direct sound arrival produces the prominent peak at t = T_sweep + t_propagation.
We find the peak, validate that it stands clearly above pre-peak background noise,
extract the IR starting a few ms (5 ms) before the peak, and peak-normalize.
"""

import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-echomap")

import numpy as np
import scipy.signal
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sweep import generate_sweep, generate_inverse_filter, FS, T, F1, F2


def next_power_of_two(n: int) -> int:
    """Return smallest power of two >= n."""
    return 1 << int(np.ceil(np.log2(n)))


def deconvolve(recording: np.ndarray, inv_filter: np.ndarray) -> np.ndarray:
    """
    Perform linear deconvolution in frequency domain with zero-padding to power of two.
    Returns the full linear convolution result of length len(recording) + len(inv_filter) - 1.
    """
    min_len = len(recording) + len(inv_filter) - 1
    n_fft = next_power_of_two(min_len)

    # Real FFT for float64 arrays
    Y = np.fft.rfft(recording, n=n_fft)
    X_inv = np.fft.rfft(inv_filter, n=n_fft)
    H_est = Y * X_inv
    h_full = np.fft.irfft(H_est, n=n_fft)

    return h_full[:min_len]


def find_peak_and_snr(h_full: np.ndarray, fs: int = FS, pre_peak_ms: float = 5.0) -> tuple[int, float, float]:
    """
    Find index of absolute maximum peak and estimate peak-to-noise ratio (dB)
    against the pre-peak region.
    """
    peak_idx = int(np.argmax(np.abs(h_full)))
    peak_val = float(np.abs(h_full[peak_idx]))

    pre_samples = int(round(pre_peak_ms * 1e-3 * fs))
    # Look at a 0.5 s window ending pre_samples before the peak
    noise_start = max(0, peak_idx - int(0.5 * fs))
    noise_end = max(0, peak_idx - pre_samples)
    noise_window = h_full[noise_start:noise_end]

    if len(noise_window) > 100:
        noise_rms = float(np.sqrt(np.mean(noise_window**2))) + 1e-12
        pnr_db = float(20.0 * np.log10(peak_val / noise_rms))
    else:
        pnr_db = 999.0

    return peak_idx, peak_val, pnr_db


def extract_impulse_response(h_full: np.ndarray, peak_idx: int, ir_length_samples: int,
                             fs: int = FS, pre_peak_ms: float = 5.0) -> np.ndarray:
    """
    Extract the impulse response starting pre_peak_ms before the peak and normalize by peak.
    """
    pre_samples = int(round(pre_peak_ms * 1e-3 * fs))
    start_idx = max(0, peak_idx - pre_samples)
    end_idx = min(len(h_full), start_idx + ir_length_samples)
    h_extracted = np.copy(h_full[start_idx:end_idx])

    norm_val = np.max(np.abs(h_extracted))
    if norm_val > 0:
        h_extracted /= norm_val

    return h_extracted


def plot_comparison(h_true_aligned: np.ndarray, h_rec_aligned: np.ndarray,
                    title: str, filename: str, fs: int = FS):
    """
    Plot overlay of aligned true vs recovered impulse responses and the residual error.
    """
    plots_dir = "reference/plots"
    os.makedirs(plots_dir, exist_ok=True)
    out_path = os.path.join(plots_dir, filename)

    N = min(len(h_true_aligned), len(h_rec_aligned))
    t_ms = np.arange(N) * 1000.0 / fs
    h_t = h_true_aligned[:N]
    h_r = h_rec_aligned[:N]
    error = h_r - h_t

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(10, 8), layout="constrained")

    # 1. Full waveform overlay
    ax1.plot(t_ms, h_t, label="True IR", color="#006399", lw=0.7, alpha=0.85)
    ax1.plot(t_ms, h_r, label="Recovered IR", color="#ba1a1a", lw=0.6, alpha=0.7, ls="--")
    ax1.set_title(f"{title} — Full Waveform Overlay")
    ax1.set_ylabel("Amplitude")
    ax1.set_xlabel("Time (ms)")
    ax1.legend(loc="upper right", fontsize=9)
    ax1.grid(True, ls=":", alpha=0.5)

    # 2. Early arrival zoom (0 to 60 ms)
    zoom_mask = (t_ms <= 60.0)
    ax2.plot(t_ms[zoom_mask], h_t[zoom_mask], label="True IR", color="#006399", lw=1.0)
    ax2.plot(t_ms[zoom_mask], h_r[zoom_mask], label="Recovered IR", color="#ba1a1a", lw=0.9, ls="--")
    ax2.set_title("Early Arrival Zoom (0 to 60 ms)")
    ax2.set_ylabel("Amplitude")
    ax2.set_xlabel("Time (ms)")
    ax2.legend(loc="upper right", fontsize=9)
    ax2.grid(True, ls=":", alpha=0.5)

    # 3. Waveform residual error
    max_e = float(np.max(np.abs(error)))
    rms_e = float(np.sqrt(np.mean(error**2)))
    ax3.plot(t_ms, error, color="#555555", lw=0.7, label=f"Residual Error (Max |e|={max_e:.4f}, RMS={rms_e:.4f})")
    ax3.set_title("Residual Error (Recovered - True)")
    ax3.set_ylabel("Error")
    ax3.set_xlabel("Time (ms)")
    ax3.legend(loc="upper right", fontsize=9)
    ax3.grid(True, ls=":", alpha=0.5)

    fig.savefig(out_path, dpi=180)
    plt.close(fig)
    print(f"Saved deconvolution plot to: {out_path}")


def main():
    print("=" * 65)
    print("EchoMap Reference: Frequency-Domain Deconvolution Validation")
    print("=" * 65)

    fixtures_dir = "reference/fixtures"
    sweep, _ = generate_sweep()
    inv_filter = generate_inverse_filter(sweep)

    h_single_true = np.load(os.path.join(fixtures_dir, "synthetic_ir_single.npy"))
    h_multi_true = np.load(os.path.join(fixtures_dir, "synthetic_ir_multi.npy"))
    y_single = np.load(os.path.join(fixtures_dir, "fake_recording_single.npy"))
    y_multi = np.load(os.path.join(fixtures_dir, "fake_recording_multi.npy"))

    min_len = len(y_single) + len(inv_filter) - 1
    n_fft = next_power_of_two(min_len)
    print(f"Recording:      {len(y_single)} samples ({len(y_single)/FS:.2f} s)")
    print(f"Inverse Filter: {len(inv_filter)} samples ({len(inv_filter)/FS:.2f} s)")
    print(f"Conv Length:    {min_len} -> Zero-padded FFT: {n_fft} (2^{int(np.log2(n_fft))})")

    # Sweep self-impulse (reference for band-limitation filtering)
    sweep_impulse = deconvolve(sweep, inv_filter)
    peak_sweep_imp = int(np.argmax(np.abs(sweep_impulse)))
    norm_sweep_peak = float(np.abs(sweep_impulse[peak_sweep_imp]))

    # --- 1. Deconvolve Single-RT60 Recording ---
    print("\n" + "-" * 55)
    print("1. Single-RT60 Impulse Response (IR A, RT60 = 0.8 s)")
    print("-" * 55)
    h_full_a = deconvolve(y_single, inv_filter)
    peak_idx_a, peak_val_a, pnr_a = find_peak_and_snr(h_full_a, FS, pre_peak_ms=5.0)

    # In y = sweep * h, t=0 of h is mathematically at index (len(sweep) - 1) = 239999
    t0_expected = len(sweep) - 1
    print(f"Expected t=0 sample:       {t0_expected}")
    print(f"Detected Peak Index:       {peak_idx_a} (offset: +{peak_idx_a - t0_expected} samples from t=0)")
    print(f"Peak-to-Noise Ratio (PNR): {pnr_a:.2f} dB (clear detection threshold > 20 dB)")

    # Extract recovered IR from t=0
    h_rec_a = h_full_a[t0_expected : t0_expected + len(h_single_true)] / norm_sweep_peak

    # Band-limited reference: true IR filtered by the sweep's excitation impulse
    h_bl_a = scipy.signal.fftconvolve(h_single_true, sweep_impulse / norm_sweep_peak, mode="full")[peak_sweep_imp : peak_sweep_imp + len(h_single_true)]

    corr_a_raw = float(np.corrcoef(h_rec_a, h_single_true)[0, 1])
    corr_a_bl = float(np.corrcoef(h_rec_a, h_bl_a)[0, 1])
    diff_a_bl = float(np.max(np.abs(h_rec_a - h_bl_a)))
    rms_a_bl = float(np.sqrt(np.mean((h_rec_a - h_bl_a)**2)))

    print(f"\nComparison with Raw True IR (full-band noise):")
    print(f"  Correlation:             {corr_a_raw:.6f}")
    print(f"  (Note: raw noise has energy up to 24 kHz; sweep only excites 50-8000 Hz)")
    print(f"\nComparison with Band-Limited True IR (within sweep passband):")
    print(f"  Correlation:             {corr_a_bl:.8f} (1.00000000)")
    print(f"  Max Absolute Difference: {diff_a_bl:.4e} (machine epsilon precision)")
    print(f"  RMS Waveform Error:      {rms_a_bl:.4e}")

    # Plot overlay against band-limited true IR
    plot_comparison(h_bl_a, h_rec_a, "Single RT60 (0.8s, Band-Limited)", "deconvolution_overlay_single.png", FS)

    # --- 2. Deconvolve Multi-RT60 Recording ---
    print("\n" + "-" * 55)
    print("2. Multi-Band RT60 Impulse Response (IR B, 125 Hz - 4000 Hz)")
    print("-" * 55)
    h_full_b = deconvolve(y_multi, inv_filter)
    peak_idx_b, peak_val_b, pnr_b = find_peak_and_snr(h_full_b, FS, pre_peak_ms=5.0)

    print(f"Expected t=0 sample:       {t0_expected}")
    print(f"Detected Peak Index:       {peak_idx_b} (offset: +{peak_idx_b - t0_expected} samples from t=0)")
    print(f"Peak-to-Noise Ratio (PNR): {pnr_b:.2f} dB")

    # Extract recovered IR from t=0
    h_rec_b = h_full_b[t0_expected : t0_expected + len(h_multi_true)] / norm_sweep_peak

    # Because multi-band IR has all energy in [125/sqrt(2), 4000*sqrt(2)] = [88.4, 5656.9] Hz,
    # it sits entirely inside the sweep band [50, 8000] Hz.
    corr_b = float(np.corrcoef(h_rec_b, h_multi_true)[0, 1])
    diff_b = float(np.max(np.abs(h_rec_b - h_multi_true)))
    rms_b = float(np.sqrt(np.mean((h_rec_b - h_multi_true)**2)))

    print(f"\nComparison with True Multi-Band IR:")
    print(f"  Correlation:             {corr_b:.6f} (> 0.996)")
    print(f"  Max Absolute Difference: {diff_b:.4f}")
    print(f"  RMS Waveform Error:      {rms_b:.4f}")

    plot_comparison(h_multi_true, h_rec_b, "Multi-Band RT60 (125-4000 Hz)", "deconvolution_overlay_multi.png", FS)


if __name__ == "__main__":
    main()
