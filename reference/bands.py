"""
reference/bands.py — Octave-band Butterworth band-pass filter design.
Uses 4th-order Butterworth (N=2 design order -> 2 SOS biquad sections).
Centres: 125, 250, 500, 1000, 2000, 4000 Hz.
Band edges: fc / sqrt(2) and fc * sqrt(2).
"""

import os
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'

import numpy as np
import scipy.signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

CENTRE_FREQUENCIES = [125, 250, 500, 1000, 2000, 4000]

def get_band_edges(fc: float) -> tuple[float, float]:
    """Calculate lower and upper band edges for an octave band."""
    sqrt2 = np.sqrt(2.0)
    return fc / sqrt2, fc * sqrt2

def design_octave_filters(fs: int = 48000, centres: list[int] = CENTRE_FREQUENCIES) -> dict[int, np.ndarray]:
    """
    Design 4th-order Butterworth bandpass filter (N=2 design order, 2 SOS sections)
    for each octave centre frequency.
    
    Returns a dict mapping centre frequency (Hz) -> SOS array of shape (2, 6).
    """
    filters = {}
    for fc in centres:
        lo, hi = get_band_edges(fc)
        sos = scipy.signal.butter(N=2, Wn=[lo, hi], btype='bandpass', fs=fs, output='sos')
        filters[fc] = sos
    return filters

def filter_band(signal: np.ndarray, sos: np.ndarray) -> np.ndarray:
    """Filter a 1D signal with an SOS cascade."""
    return scipy.signal.sosfilt(sos, signal)

def plot_magnitude_responses(filters: dict[int, np.ndarray], fs: int = 48000,
                             output_path: str = 'reference/plots/bandpass_magnitude.png'):
    """Plot magnitude response curves (dB vs frequency) for all octave bands."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    fig, ax = plt.subplots(figsize=(10, 6))
    
    # Generate frequencies log-spaced from 20 Hz to 20 kHz
    w_freqs = np.geomspace(20, 20000, 1000)
    
    colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b']
    
    for (fc, sos), color in zip(filters.items(), colors):
        _, h = scipy.signal.sosfreqz(sos, worN=w_freqs, fs=fs)
        mag_db = 20.0 * np.log10(np.maximum(np.abs(h), 1e-10))
        lo, hi = get_band_edges(fc)
        ax.semilogx(w_freqs, mag_db, label=f"{fc} Hz (edges: {lo:.1f}–{hi:.1f} Hz)", color=color, linewidth=1.8)
        # Mark center frequency
        ax.axvline(fc, color=color, linestyle=':', alpha=0.4)
    
    ax.set_title("Octave-Band Butterworth Filter Responses (4th Order, N=2, fs=48000 Hz)", fontsize=13, pad=12)
    ax.set_xlabel("Frequency (Hz)", fontsize=11)
    ax.set_ylabel("Magnitude (dB)", fontsize=11)
    ax.set_ylim(-60, 5)
    ax.set_xlim(20, 20000)
    ax.grid(True, which="both", ls="-", alpha=0.3)
    ax.axhline(0, color='black', linewidth=0.8, linestyle='--')
    ax.axhline(-3, color='gray', linewidth=0.8, linestyle=':', label='-3 dB cutoff')
    ax.legend(loc='lower center', ncol=2, framealpha=0.9, fontsize=9)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=200)
    plt.close(fig)
    print(f"Saved magnitude response plot to: {output_path}")

if __name__ == '__main__':
    filters = design_octave_filters(48000)
    print("Butterworth octave bandpass filters designed (N=2, 2 SOS per band):")
    for fc, sos in filters.items():
        lo, hi = get_band_edges(fc)
        print(f"\nBand {fc} Hz: edges [{lo:.2f}, {hi:.2f}] Hz")
        print(f"SOS shape: {sos.shape}")
        for i, s in enumerate(sos):
            print(f"  Section {i+1}: b=[{s[0]:.6e}, {s[1]:.6e}, {s[2]:.6e}], a=[{s[3]:.6f}, {s[4]:.6f}, {s[5]:.6f}]")
    
    plot_magnitude_responses(filters)
