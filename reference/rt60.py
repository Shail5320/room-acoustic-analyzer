"""
reference/rt60.py — Schroeder backward integration and RT60 estimation.
Implements:
  - Schroeder integration (EDC)
  - T20 (-5 to -25 dB), T30 (-5 to -35 dB), EDT (0 to -10 dB), R^2
  - Validity rules: T30 if >= 35 dB range, else T20 if >= 25 dB, else invalid
  - Simplified noise-floor truncation
"""

import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-echomap")
import sys

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

def compute_edc(h: np.ndarray, fs: int = 48000, truncate_noise: bool = True,
                pre_silence: np.ndarray = None) -> tuple[np.ndarray, np.ndarray, float]:
    """
    Compute Energy Decay Curve (EDC) using Schroeder backward integration.
    
    Formula:
        EDC[n] = sum_{k=n}^{N-1} h[k]^2
        EDC_dB[n] = 10 * log10( EDC[n] / EDC[0] )
        
    If truncate_noise is True:
        Applies "simplified noise-floor truncation":
        - Estimates noise floor sigma^2 from pre_silence or IR tail.
        - Finds truncation index where smoothed squared envelope reaches noise floor.
        - Truncates backward integration and subtracts steady noise power.
        
    Returns:
        (t, edc_db, available_range_db)
    """
    # Direct sound alignment: find peak of IR and start integration from direct sound
    peak_idx = int(np.argmax(np.abs(h)))
    h_decay = h[peak_idx:].copy()
    N = len(h_decay)
    
    if N == 0 or np.max(np.abs(h_decay)) == 0:
        return np.array([0.0]), np.array([0.0]), 0.0

    peak_power = float(np.max(h_decay**2))
    
    # Estimate noise floor power sigma^2
    if pre_silence is not None and len(pre_silence) > 0:
        sigma2 = float(np.mean(pre_silence**2))
    else:
        # Estimate from last 15% of decay
        tail_len = max(int(0.15 * N), 1)
        sigma2 = float(np.mean(h_decay[-tail_len:]**2))
        
    noise_floor_relative_db = 10.0 * np.log10(max(sigma2, 1e-15) / max(peak_power, 1e-15))
    peak_to_noise_dr = float(-noise_floor_relative_db)

    if truncate_noise:
        # Smoothed squared envelope with 20 ms moving window
        win_len = max(int(0.02 * fs), 1)
        kernel = np.ones(win_len, dtype=np.float64) / win_len
        env = np.convolve(h_decay**2, kernel, mode='same')
        
        # Truncation point: where smoothed envelope drops to 3 dB above noise floor (2 * sigma2)
        threshold = 2.0 * sigma2
        below = np.where(env < threshold)[0]
        if len(below) > 0:
            trunc_idx = int(below[0])
        else:
            trunc_idx = N - 1
            
        # Ensure at least 50 ms of signal if available
        trunc_idx = max(trunc_idx, min(int(0.05 * fs), N - 1))
        
        # Truncate and subtract noise energy
        h_trunc = h_decay[:trunc_idx]
        edc = np.cumsum(np.maximum(0.0, h_trunc[::-1]**2 - sigma2))[::-1]
        
        if len(edc) == 0 or edc[0] <= 0:
            edc = np.cumsum(h_trunc[::-1]**2)[::-1]
            
        t = np.arange(len(edc), dtype=np.float64) / fs
        edc_norm = np.maximum(edc, 1e-12) / max(edc[0], 1e-12)
        edc_db = 10.0 * np.log10(edc_norm)
        
        # Available range is depth reached before truncation
        available_range_db = min(float(abs(edc_db[-1])), peak_to_noise_dr)
    else:
        # Standard un-truncated Schroeder backward integration
        edc = np.cumsum(h_decay[::-1]**2)[::-1]
        t = np.arange(N, dtype=np.float64) / fs
        edc_norm = np.maximum(edc, 1e-12) / max(edc[0], 1e-12)
        edc_db = 10.0 * np.log10(edc_norm)
        
        # In un-truncated integration, noise accumulation flattens the curve.
        # Determine the depth on the EDC curve where the signal envelope hits the noise floor (2 * sigma2).
        win_len = max(int(0.02 * fs), 1)
        kernel = np.ones(win_len, dtype=np.float64) / win_len
        env = np.convolve(h_decay**2, kernel, mode='same')
        below = np.where(env < 2.0 * sigma2)[0]
        if len(below) > 0 and below[0] < N:
            trunc_idx = int(below[0])
            available_range_db = float(abs(edc_db[trunc_idx]))
        else:
            available_range_db = peak_to_noise_dr
        
    return t, edc_db, available_range_db

def fit_decay(t: np.ndarray, edc_db: np.ndarray, db_start: float, db_end: float) -> tuple[float, float]:
    """
    Fit ordinary least-squares regression line over a specified dB range [db_start, db_end].
    
    Formula:
        y = m * t + c
        RT = -60 / m
        R^2 = 1 - sum(residuals^2) / sum((y - y_mean)^2)
        
    Returns:
        (rt_val, r2)
    """
    mask = (edc_db <= db_start) & (edc_db >= db_end)
    t_sub = t[mask]
    y_sub = edc_db[mask]
    
    if len(t_sub) < 10:
        return float('nan'), float('nan')
        
    A = np.vstack([t_sub, np.ones_like(t_sub)]).T
    m, c = np.linalg.lstsq(A, y_sub, rcond=None)[0]
    
    if m >= 0:
        return float('nan'), float('nan')
        
    y_pred = m * t_sub + c
    ss_res = np.sum((y_sub - y_pred)**2)
    ss_tot = np.sum((y_sub - np.mean(y_sub))**2)
    r2 = float(1.0 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0
    
    rt_val = float(-60.0 / m)
    return rt_val, r2

def analyze_rt60(h: np.ndarray, fs: int = 48000, truncate_noise: bool = True,
                 pre_silence: np.ndarray = None, min_r2: float = 0.95) -> dict:
    """
    Full RT60 analysis of an impulse response.
    
    Calculates:
      - EDT (0 to -10 dB)
      - T20 (-5 to -25 dB)
      - T30 (-5 to -35 dB)
      - R^2 for each fit
      - Usable dynamic range
      - Validity decision:
          * T30 if dynamic range >= 35 dB AND R^2 >= min_r2
          * T20 if dynamic range >= 25 dB AND R^2 >= min_r2
          * invalid otherwise
    """
    t, edc_db, available_range_db = compute_edc(h, fs=fs, truncate_noise=truncate_noise,
                                                pre_silence=pre_silence)
    
    edt, r2_edt = fit_decay(t, edc_db, 0.0, -10.0)
    t20, r2_t20 = fit_decay(t, edc_db, -5.0, -25.0)
    t30, r2_t30 = fit_decay(t, edc_db, -5.0, -35.0)
    
    # Validity rules:
    # T30 only if >= 35 dB range and linear fit R^2 >= min_r2,
    # else T20 if >= 25 dB and R^2 >= min_r2,
    # else invalid
    if available_range_db >= 35.0 and not np.isnan(t30) and r2_t30 >= min_r2:
        used = 'T30'
        valid = True
        rt60 = t30
        r2 = r2_t30
    elif available_range_db >= 25.0 and not np.isnan(t20) and r2_t20 >= min_r2:
        used = 'T20'
        valid = True
        rt60 = t20
        r2 = r2_t20
    else:
        used = 'none'
        valid = False
        rt60 = float('nan')
        r2 = float('nan')
        
    return {
        'rt60': rt60,
        'used': used,
        'valid': valid,
        'r2': r2,
        't20': t20,
        'r2_t20': r2_t20,
        't30': t30,
        'r2_t30': r2_t30,
        'edt': edt,
        'r2_edt': r2_edt,
        'dynamic_range_db': available_range_db,
        't': t,
        'edc_db': edc_db
    }

def plot_edc_curves(results_per_band: dict, output_path: str = 'reference/plots/edc_curves.png'):
    """Plot EDC curves across bands."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    fig, ax = plt.subplots(figsize=(10, 6))
    
    colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b']
    for (fc, res), color in zip(results_per_band.items(), colors):
        t = res['t']
        edc_db = res['edc_db']
        label = f"{fc} Hz: {res['used']}={res['rt60']:.3f}s (R2={res['r2']:.4f})"
        ax.plot(t, edc_db, label=label, color=color, linewidth=1.8)
        
    ax.set_title("Energy Decay Curves (EDC) — Schroeder Backward Integration", fontsize=13, pad=12)
    ax.set_xlabel("Time (s)", fontsize=11)
    ax.set_ylabel("Energy (dB)", fontsize=11)
    ax.set_ylim(-65, 5)
    ax.set_xlim(0, max(res['t'][-1] for res in results_per_band.values()) * 0.8)
    ax.axhline(-5, color='gray', linestyle=':', label='-5 dB (start fit)')
    ax.axhline(-25, color='gray', linestyle='--', label='-25 dB (T20 end)')
    ax.axhline(-35, color='black', linestyle='-.', label='-35 dB (T30 end)')
    ax.grid(True, which="both", ls="-", alpha=0.3)
    ax.legend(loc='upper right', framealpha=0.9, fontsize=9)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=200)
    plt.close(fig)
    print(f"Saved EDC curves plot to: {output_path}")

if __name__ == '__main__':
    from reference.synthetic_ir import generate_single_rt60_ir
    
    h_clean, _ = generate_single_rt60_ir(fs=48000, rt60=0.8, seed=42)
    res = analyze_rt60(h_clean, fs=48000, truncate_noise=False)
    
    print("Clean Single-RT60 (True RT60 = 0.8000 s):")
    print(f"  Available range: {res['dynamic_range_db']:.1f} dB")
    print(f"  EDT: {res['edt']:.4f} s (R2 = {res['r2_edt']:.4f})")
    print(f"  T20: {res['t20']:.4f} s (R2 = {res['r2_t20']:.4f})")
    print(f"  T30: {res['t30']:.4f} s (R2 = {res['r2_t30']:.4f})")
    print(f"  Selected: {res['used']} = {res['rt60']:.4f} s, Valid: {res['valid']}, R2: {res['r2']:.4f}")
    error_pct = abs(res['rt60'] - 0.8) / 0.8 * 100.0
    print(f"  Error: {error_pct:.2f}%")
