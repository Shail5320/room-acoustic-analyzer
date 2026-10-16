"""
reference/run_phase0b.py — Phase 0b complete evaluation and expected_outputs.json generator.
Performs:
  1. Sweep & inverse filter metrics (peak-to-sidelobe ratio, first/last 100 samples)
  2. Octave band Butterworth filter coefficients & response points
  3. End-to-end recovery on BOTH synthetic IRs (Single RT60 and Multi RT60)
  4. Noise-floor test at 30 dB and 20 dB SNR (with and without simplified noise-floor truncation)
  5. Serializes all ground truth reference data to reference/expected_outputs.json
"""

import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-echomap")
import sys
import json

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import scipy.signal

from reference.sweep import (
    generate_sweep, generate_inverse_filter, compute_peak_to_sidelobe,
    FS, T, F1, F2
)
from reference.bands import (
    design_octave_filters, filter_band, get_band_edges, CENTRE_FREQUENCIES
)
from reference.rt60 import (
    analyze_rt60, plot_edc_curves
)

def run_phase0b():
    print("=" * 80)
    print("EchoMap — Phase 0b: Octave Filtering, Schroeder RT60, & Noise Analysis")
    print("=" * 80)

    output_data = {
        "metadata": {
            "sample_rate_hz": FS,
            "sweep_duration_s": T,
            "f1_hz": F1,
            "f2_hz": F2,
            "filter_type": "4th-order Butterworth bandpass (N=2 design order, 2 SOS)",
            "octave_bands_hz": CENTRE_FREQUENCIES
        }
    }

    # ---------------------------------------------------------
    # 1. Sweep and Inverse Filter
    # ---------------------------------------------------------
    print("\n[1/4] Evaluating Sweep and Inverse Filter...")
    sweep, _ = generate_sweep(fs=FS)
    inv = generate_inverse_filter(sweep, fs=FS)
    conv = scipy.signal.fftconvolve(sweep, inv, mode="full")
    psr_db, peak_val, max_sidelobe, peak_idx = compute_peak_to_sidelobe(conv, fs=FS)

    print(f"  Sweep length: {len(sweep)} samples ({len(sweep)/FS:.2f} s)")
    print(f"  Peak convolution amplitude: {peak_val:.4f}")
    print(f"  Max sidelobe amplitude: {max_sidelobe:.6e}")
    print(f"  Peak-to-sidelobe ratio: {psr_db:.2f} dB")

    output_data["sweep"] = {
        "f1": F1,
        "f2": F2,
        "duration_s": T,
        "fs": FS,
        "peak_to_sidelobe_ratio_db": round(psr_db, 2),
        "peak_value": round(float(peak_val), 6),
        "max_sidelobe": float(f"{max_sidelobe:.6e}"),
        "first_100_samples": [round(float(x), 8) for x in sweep[:100]],
        "last_100_samples": [round(float(x), 8) for x in sweep[-100:]]
    }

    # ---------------------------------------------------------
    # 2. Octave Filter Coefficients & Frequency Responses
    # ---------------------------------------------------------
    print("\n[2/4] Designing 4th-Order Butterworth Octave Bandpass Filters...")
    filters = design_octave_filters(fs=FS)
    filters_meta = {}

    for fc in CENTRE_FREQUENCIES:
        sos = filters[fc]
        lo, hi = get_band_edges(fc)
        
        # Test frequency responses at key diagnostic frequencies
        test_freqs = [fc / 2.0, lo, fc, hi, fc * 2.0]
        w, h = scipy.signal.sosfreqz(sos, worN=test_freqs, fs=FS)
        mag_db = 20.0 * np.log10(np.maximum(np.abs(h), 1e-12))
        
        freq_resp_list = []
        for freq, m_db in zip(test_freqs, mag_db):
            freq_resp_list.append({
                "freq_hz": round(float(freq), 2),
                "mag_db": round(float(m_db), 4)
            })

        filters_meta[str(fc)] = {
            "centre_hz": fc,
            "edges_hz": [round(float(lo), 4), round(float(hi), 4)],
            "sos": [[round(float(c), 12) for c in section] for section in sos],
            "diagnostic_responses": freq_resp_list
        }
        print(f"  Band {fc:4d} Hz: edges [{lo:6.1f}, {hi:6.1f}] Hz | Resp at fc: {mag_db[2]:+.2f} dB, lo: {mag_db[1]:+.2f} dB, hi: {mag_db[3]:+.2f} dB")

    output_data["filters"] = filters_meta

    # ---------------------------------------------------------
    # 3. End-to-End Recovery on BOTH Synthetic IRs
    # ---------------------------------------------------------
    print("\n[3/4] Running End-to-End Recovery on Both Synthetic IR Fixtures...")

    single_fixture_path = "reference/fixtures/synthetic_ir_single.npy"
    multi_fixture_path = "reference/fixtures/synthetic_ir_multi.npy"

    ir_single = np.load(single_fixture_path)
    ir_multi = np.load(multi_fixture_path)

    # 3a. Single RT60 IR (True RT60 = 0.800 s)
    true_single = 0.8
    single_results = {}
    edc_single_dict = {}

    print("\n  " + "-" * 75)
    print(f"  SYNTHETIC IR 1: SINGLE-RT60 (True RT60 = {true_single:.3f} s across all bands)")
    print("  " + "-" * 75)
    print(f"  {'Band (Hz)':<10} | {'True (s)':<10} | {'Recovered (s)':<14} | {'Error (%)':<10} | {'Metric':<8} | {'R^2':<8}")
    print("  " + "-" * 75)

    for fc in CENTRE_FREQUENCIES:
        sos = filters[fc]
        filtered = filter_band(ir_single, sos)
        res = analyze_rt60(filtered, fs=FS, truncate_noise=False)
        edc_single_dict[fc] = res
        err_pct = (res["rt60"] - true_single) / true_single * 100.0

        single_results[str(fc)] = {
            "true_rt60": true_single,
            "recovered_rt60": round(float(res["rt60"]), 4),
            "error_pct": round(float(err_pct), 2),
            "used_metric": res["used"],
            "valid": res["valid"],
            "r2": round(float(res["r2"]), 4),
            "t20": round(float(res["t20"]), 4),
            "r2_t20": round(float(res["r2_t20"]), 4),
            "t30": round(float(res["t30"]), 4),
            "r2_t30": round(float(res["r2_t30"]), 4),
            "edt": round(float(res["edt"]), 4),
            "r2_edt": round(float(res["r2_edt"]), 4),
            "dynamic_range_db": round(float(res["dynamic_range_db"]), 1)
        }

        print(f"  {fc:<10} | {true_single:<10.3f} | {res['rt60']:<14.4f} | {err_pct:<+10.2f} | {res['used']:<8} | {res['r2']:<8.4f}")

    output_data["single_rt60_recovery"] = single_results
    plot_edc_curves(edc_single_dict, output_path="reference/plots/edc_curves_single.png")

    # 3b. Multi RT60 IR
    multi_targets = {125: 1.2, 250: 1.0, 500: 0.8, 1000: 0.7, 2000: 0.6, 4000: 0.5}
    multi_results = {}
    edc_multi_dict = {}

    print("\n  " + "-" * 75)
    print("  SYNTHETIC IR 2: MULTI-RT60 (Frequency-dependent RT60 targets)")
    print("  " + "-" * 75)
    print(f"  {'Band (Hz)':<10} | {'True (s)':<10} | {'Recovered (s)':<14} | {'Error (%)':<10} | {'Metric':<8} | {'R^2':<8}")
    print("  " + "-" * 75)

    for fc in CENTRE_FREQUENCIES:
        sos = filters[fc]
        filtered = filter_band(ir_multi, sos)
        res = analyze_rt60(filtered, fs=FS, truncate_noise=False)
        edc_multi_dict[fc] = res
        t_target = multi_targets[fc]
        err_pct = (res["rt60"] - t_target) / t_target * 100.0

        multi_results[str(fc)] = {
            "true_rt60": t_target,
            "recovered_rt60": round(float(res["rt60"]), 4),
            "error_pct": round(float(err_pct), 2),
            "used_metric": res["used"],
            "valid": res["valid"],
            "r2": round(float(res["r2"]), 4),
            "t20": round(float(res["t20"]), 4),
            "r2_t20": round(float(res["r2_t20"]), 4),
            "t30": round(float(res["t30"]), 4),
            "r2_t30": round(float(res["r2_t30"]), 4),
            "edt": round(float(res["edt"]), 4),
            "r2_edt": round(float(res["r2_edt"]), 4),
            "dynamic_range_db": round(float(res["dynamic_range_db"]), 1)
        }

        print(f"  {fc:<10} | {t_target:<10.3f} | {res['rt60']:<14.4f} | {err_pct:<+10.2f} | {res['used']:<8} | {res['r2']:<8.4f}")

    output_data["multi_rt60_recovery"] = multi_results
    plot_edc_curves(edc_multi_dict, output_path="reference/plots/edc_curves_multi.png")

    # ---------------------------------------------------------
    # 4. Noise-Floor Test
    # ---------------------------------------------------------
    print("\n[4/4] Running Noise-Floor Robustness Test (30 dB & 20 dB SNR)...")
    sig_power = float(np.mean(ir_single**2))
    noise_results = {}

    print("\n  " + "-" * 90)
    print("  NOISE ROBUSTNESS COMPARISON (True RT60 = 0.8000 s)")
    print("  " + "-" * 90)
    print(f"  {'Condition':<35} | {'T20 (s)':<10} | {'T20 Bias':<10} | {'T30 (s)':<10} | {'T30 Bias':<10} | {'Used'}")
    print("  " + "-" * 90)

    for snr_db in [30, 20]:
        noise_power = sig_power / (10.0 ** (snr_db / 10.0))
        rng = np.random.default_rng(123)
        noise = rng.normal(0.0, np.sqrt(noise_power), len(ir_single))
        h_noisy = ir_single + noise

        res_raw = analyze_rt60(h_noisy, fs=FS, truncate_noise=False)
        res_trunc = analyze_rt60(h_noisy, fs=FS, truncate_noise=True)

        bias_raw_t20 = res_raw["t20"] - true_single
        bias_raw_t30 = res_raw["t30"] - true_single
        bias_trunc_t20 = res_trunc["t20"] - true_single
        bias_trunc_t30 = res_trunc["t30"] - true_single

        cond_raw_name = f"SNR {snr_db} dB (without truncation)"
        cond_trunc_name = f"SNR {snr_db} dB (simplified noise-floor trunc)"

        print(f"  {cond_raw_name:<35} | {res_raw['t20']:<10.4f} | {bias_raw_t20:<+10.4f} | {res_raw['t30']:<10.4f} | {bias_raw_t30:<+10.4f} | {res_raw['used']}")
        print(f"  {cond_trunc_name:<35} | {res_trunc['t20']:<10.4f} | {bias_trunc_t20:<+10.4f} | {res_trunc['t30']:<10.4f} | {bias_trunc_t30:<+10.4f} | {res_trunc['used']}")
        print("  " + "-" * 90)

        noise_results[f"snr_{snr_db}db"] = {
            "snr_db": snr_db,
            "true_rt60": true_single,
            "without_truncation": {
                "t20": round(float(res_raw["t20"]), 4),
                "bias_t20": round(float(bias_raw_t20), 4),
                "r2_t20": round(float(res_raw["r2_t20"]), 4),
                "t30": round(float(res_raw["t30"]), 4),
                "bias_t30": round(float(bias_raw_t30), 4),
                "r2_t30": round(float(res_raw["r2_t30"]), 4),
                "used_metric": res_raw["used"]
            },
            "simplified_noise_floor_truncation": {
                "t20": round(float(res_trunc["t20"]), 4),
                "bias_t20": round(float(bias_trunc_t20), 4),
                "r2_t20": round(float(res_trunc["r2_t20"]), 4),
                "t30": round(float(res_trunc["t30"]), 4),
                "bias_t30": round(float(bias_trunc_t30), 4),
                "r2_t30": round(float(res_trunc["r2_t30"]), 4),
                "used_metric": res_trunc["used"]
            }
        }

    output_data["noise_test"] = noise_results

    # ---------------------------------------------------------
    # 5. Save Expected Outputs JSON
    # ---------------------------------------------------------
    json_path = "reference/expected_outputs.json"
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
                for k in ["noise_test_dr", "monte_carlo_stats"]:
                    if k in existing and k not in output_data:
                        output_data[k] = existing[k]
        except Exception:
            pass
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)

    print(f"\nGround truth successfully exported to: {json_path}")
    print("=" * 80)

if __name__ == "__main__":
    run_phase0b()
