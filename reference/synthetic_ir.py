"""
reference/synthetic_ir.py — Generation of reproducible synthetic impulse responses and fake recordings.

Generates two test impulse responses at fs = 48000 Hz:
  (a) Single RT60 = 0.8 s:
      h(t) = n(t) * exp(-6.908 * t / 0.8)
  (b) Multi-RT60 per octave band (125, 250, 500, 1000, 2000, 4000 Hz):
      Target RT60s = [1.2, 1.0, 0.8, 0.7, 0.6, 0.5] s
      Built by filtering white noise into 6 octave bands with 4th-order Butterworth
      bandpass filters (N=2, 2 SOS), applying exponential decay to each, and summing.

Saves fixtures to reference/fixtures/ in both .npy and raw float64 little-endian (.bin)
for Node.js unit tests in Phase 2.
"""

import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-echomap")

import json
import numpy as np
import scipy.signal
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sweep import generate_sweep, generate_inverse_filter, FS, T, F1, F2

RNG_SEED = 42
IR_DURATION = 2.5    # 2.5 seconds (120,000 samples at 48 kHz)
OCTAVE_CENTRES = [125, 250, 500, 1000, 2000, 4000]
MULTI_RT60_TARGETS = [1.2, 1.0, 0.8, 0.7, 0.6, 0.5]
SINGLE_RT60_TARGET = 0.8


def generate_single_rt60_ir(fs: int = FS, duration: float = IR_DURATION,
                            rt60: float = SINGLE_RT60_TARGET, seed: int = RNG_SEED) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate synthetic IR with single exponential decay: h(t) = n(t) * exp(-6.908 * t / RT60).
    """
    rng = np.random.default_rng(seed)
    N = int(round(duration * fs))
    t = np.arange(N, dtype=np.float64) / fs

    # Decay factor: 10 * log10(exp(-2 * 6.907755 * t / RT60)) = -60 dB at t = RT60
    decay_constant = 6.907755278982137  # ln(1000)
    noise = rng.normal(0.0, 1.0, N)
    ir = noise * np.exp(-decay_constant * t / rt60)

    # Normalize by absolute peak
    peak = np.max(np.abs(ir))
    if peak > 0:
        ir /= peak

    return ir, t


def generate_multi_rt60_ir(fs: int = FS, duration: float = IR_DURATION,
                           centres: list[int] = OCTAVE_CENTRES,
                           rt60s: list[float] = MULTI_RT60_TARGETS,
                           seed: int = RNG_SEED) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate synthetic IR with different RT60 per octave band by summing decaying band-limited noises.
    """
    rng = np.random.default_rng(seed)
    N = int(round(duration * fs))
    t = np.arange(N, dtype=np.float64) / fs
    decay_constant = 6.907755278982137

    ir_multi = np.zeros(N, dtype=np.float64)
    sqrt2 = np.sqrt(2.0)

    for fc, rt in zip(centres, rt60s):
        lo = fc / sqrt2
        hi = fc * sqrt2
        # 4th-order Butterworth bandpass: N=2 design order produces 2 SOS biquads
        sos = scipy.signal.butter(N=2, Wn=[lo, hi], btype="bandpass", fs=fs, output="sos")
        wn = rng.normal(0.0, 1.0, N)
        wn_band = scipy.signal.sosfilt(sos, wn)
        ir_multi += wn_band * np.exp(-decay_constant * t / rt)

    # Normalize by absolute peak
    peak = np.max(np.abs(ir_multi))
    if peak > 0:
        ir_multi /= peak

    return ir_multi, t


def create_fake_recording(sweep: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """
    Create fake room recording: y(t) = sweep(t) * h(t).
    """
    return scipy.signal.fftconvolve(sweep, ir, mode="full")


def plot_synthetic_irs(h_single: np.ndarray, h_multi: np.ndarray, fs: int, plots_dir: str):
    """Plot synthetic impulse response waveforms and energy decay curves."""
    os.makedirs(plots_dir, exist_ok=True)
    t = np.arange(len(h_single)) / fs

    fig, axes = plt.subplots(2, 2, figsize=(11, 7), layout="constrained")

    # Single RT60 linear
    axes[0, 0].plot(t, h_single, color="#006399", lw=0.6, alpha=0.85)
    axes[0, 0].set_title(f"Synthetic IR: Single RT60 = {SINGLE_RT60_TARGET}s (Linear)")
    axes[0, 0].set_ylabel("Normalized Amplitude")
    axes[0, 0].set_xlabel("Time (s)")
    axes[0, 0].grid(True, ls=":", alpha=0.5)

    # Single RT60 EDC (Schroeder reverse integration)
    edc_single = np.cumsum(h_single[::-1]**2)[::-1]
    edc_single_db = 10 * np.log10(np.maximum(edc_single / edc_single[0], 1e-12))
    axes[0, 1].plot(t, edc_single_db, color="#006399", lw=1.2)
    axes[0, 1].axhline(-60, color="gray", ls="--", label="-60 dB")
    axes[0, 1].axvline(SINGLE_RT60_TARGET, color="red", ls=":", label=f"t = {SINGLE_RT60_TARGET}s")
    axes[0, 1].set_title("Energy Decay Curve (EDC in dB)")
    axes[0, 1].set_ylabel("Level (dB)")
    axes[0, 1].set_xlabel("Time (s)")
    axes[0, 1].set_ylim([-80, 5])
    axes[0, 1].grid(True, ls=":", alpha=0.5)
    axes[0, 1].legend(loc="upper right", fontsize=8.5)

    # Multi RT60 linear
    axes[1, 0].plot(t, h_multi, color="#ba1a1a", lw=0.6, alpha=0.85)
    axes[1, 0].set_title("Synthetic IR: Multi-band RT60 (125Hz-4kHz: 1.2s to 0.5s)")
    axes[1, 0].set_ylabel("Normalized Amplitude")
    axes[1, 0].set_xlabel("Time (s)")
    axes[1, 0].grid(True, ls=":", alpha=0.5)

    # Multi RT60 EDC
    edc_multi = np.cumsum(h_multi[::-1]**2)[::-1]
    edc_multi_db = 10 * np.log10(np.maximum(edc_multi / edc_multi[0], 1e-12))
    axes[1, 1].plot(t, edc_multi_db, color="#ba1a1a", lw=1.2)
    axes[1, 1].axhline(-60, color="gray", ls="--", label="-60 dB")
    axes[1, 1].set_title("Multi-band Energy Decay Curve (Composite)")
    axes[1, 1].set_ylabel("Level (dB)")
    axes[1, 1].set_xlabel("Time (s)")
    axes[1, 1].set_ylim([-80, 5])
    axes[1, 1].grid(True, ls=":", alpha=0.5)
    axes[1, 1].legend(loc="upper right", fontsize=8.5)

    plot_path = os.path.join(plots_dir, "synthetic_ir_waveforms.png")
    fig.savefig(plot_path, dpi=180)
    plt.close(fig)


def save_fixtures(h_single: np.ndarray, h_multi: np.ndarray,
                  y_single: np.ndarray, y_multi: np.ndarray,
                  fixtures_dir: str):
    """Save float64 arrays in both .npy and raw little-endian binary (.bin) formats."""
    os.makedirs(fixtures_dir, exist_ok=True)

    # Save .npy
    np.save(os.path.join(fixtures_dir, "synthetic_ir_single.npy"), h_single)
    np.save(os.path.join(fixtures_dir, "synthetic_ir_multi.npy"), h_multi)
    np.save(os.path.join(fixtures_dir, "fake_recording_single.npy"), y_single)
    np.save(os.path.join(fixtures_dir, "fake_recording_multi.npy"), y_multi)

    # Save raw float64 little-endian binaries for direct Node.js Buffer reading
    h_single.astype("<f8").tofile(os.path.join(fixtures_dir, "synthetic_ir_single.bin"))
    h_multi.astype("<f8").tofile(os.path.join(fixtures_dir, "synthetic_ir_multi.bin"))
    y_single.astype("<f8").tofile(os.path.join(fixtures_dir, "fake_recording_single.bin"))
    y_multi.astype("<f8").tofile(os.path.join(fixtures_dir, "fake_recording_multi.bin"))

    # Metadata JSON
    meta = {
        "fs": FS,
        "rng_seed": RNG_SEED,
        "ir_duration_s": IR_DURATION,
        "ir_samples": len(h_single),
        "single_rt60_target_s": SINGLE_RT60_TARGET,
        "octave_centres_hz": OCTAVE_CENTRES,
        "multi_rt60_targets_s": MULTI_RT60_TARGETS,
        "recording_samples": len(y_single),
        "recording_duration_s": len(y_single) / FS,
    }
    meta_path = os.path.join(fixtures_dir, "fixtures_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    return meta


def main():
    print("=" * 65)
    print("EchoMap Reference: Synthetic Impulse Response Generation")
    print("=" * 65)
    print(f"Sample Rate:          {FS} Hz")
    print(f"RNG Seed:             {RNG_SEED} (fixed for reproducibility)")
    print(f"IR Duration:          {IR_DURATION} s ({int(IR_DURATION * FS)} samples)")

    h_single, _ = generate_single_rt60_ir()
    h_multi, _ = generate_multi_rt60_ir()

    print("\n--- Synthetic IR Specifications ---")
    print(f"IR A (Single RT60):   RT60 = {SINGLE_RT60_TARGET} s, peak = {np.max(np.abs(h_single)):.4f}")
    print("IR B (Multi-band RT60):")
    for fc, rt in zip(OCTAVE_CENTRES, MULTI_RT60_TARGETS):
        print(f"  - {fc:4d} Hz band: target RT60 = {rt:.2f} s")
    print(f"  Composite peak:     {np.max(np.abs(h_multi)):.4f}")

    # Generate sweep and fake recordings
    sweep, _ = generate_sweep()
    y_single = create_fake_recording(sweep, h_single)
    y_multi = create_fake_recording(sweep, h_multi)

    print("\n--- Fake Recordings (y = sweep * h) ---")
    print(f"Sweep samples:        {len(sweep)} ({len(sweep)/FS:.2f} s)")
    print(f"Recording A length:   {len(y_single)} samples ({len(y_single)/FS:.2f} s)")
    print(f"Recording B length:   {len(y_multi)} samples ({len(y_multi)/FS:.2f} s)")

    fixtures_dir = "reference/fixtures"
    meta = save_fixtures(h_single, h_multi, y_single, y_multi, fixtures_dir)
    print(f"\nSaved fixtures to:    {fixtures_dir}/ (.npy and .bin float64 LE)")

    plots_dir = "reference/plots"
    plot_synthetic_irs(h_single, h_multi, FS, plots_dir)
    print(f"Saved IR plots to:    {plots_dir}/synthetic_ir_waveforms.png")


if __name__ == "__main__":
    main()
