"""
reference/pipeline_reference.py — Reference deconvolution and analysis pipeline on fake recordings.

This script executes the reference end-to-end pipeline in Python:
  1. Load fake recordings (fake_recording_single and fake_recording_multi).
  2. Generate reference exponential sweep and inverse filter (f1=50, f2=8000, T=5.0, fs=48000).
  3. Frequency-domain deconvolution via zero-padded rfft / irfft.
  4. Find peak and PNR (pre-peak noise region).
  5. Extract impulse response (120,000 samples = 2.5 s tail starting pre-peak).
  6. 4th-order Butterworth octave-band filtering (N=2, 2 SOS) across 125–4000 Hz.
  7. Schroeder backward integration and RT60 estimation (analyze_rt60 with truncation).
  8. Derive per-point dynamic range (minimum across bands) and weakest band.

When run, updates the "pipeline" section in reference/expected_outputs.json.
"""

import os
import sys
import json
import numpy as np

# Ensure reference package is importable
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from sweep import generate_sweep, generate_inverse_filter, FS, T, F1, F2
from bands import design_octave_filters, filter_band, CENTRE_FREQUENCIES
from rt60 import analyze_rt60
from deconvolve import deconvolve, find_peak_and_snr, extract_impulse_response


def run_pipeline_on_recording(rec_path: str, fs: int = FS, ir_length_samples: int = 120000):
    """Run full reference pipeline on a recorded signal array."""
    if rec_path.endswith(".npy"):
        rec = np.load(rec_path)
    else:
        rec = np.fromfile(rec_path, dtype="<f8")

    sweep, _ = generate_sweep(f1=F1, f2=F2, T=T, fs=fs)
    inv_filter = generate_inverse_filter(sweep, f1=F1, f2=F2, T=T, fs=fs)

    # 1. Deconvolve
    h_full = deconvolve(rec, inv_filter)

    # 2. Peak and PNR
    peak_idx, peak_val, pnr_db = find_peak_and_snr(h_full, fs, pre_peak_ms=5.0)

    # 3. Extract impulse response
    ir_extracted = extract_impulse_response(h_full, peak_idx, ir_length_samples, fs=fs, pre_peak_ms=5.0)

    # 4. Octave band filtering and RT60 analysis
    filters = design_octave_filters(fs)
    bands_res = {}
    dr_list = []

    for fc in CENTRE_FREQUENCIES:
        sos = filters[fc]
        filtered = filter_band(ir_extracted, sos)
        res = analyze_rt60(filtered, fs=fs, truncate_noise=True)

        dr_val = round(float(res["dynamic_range_db"]), 1)
        dr_list.append((dr_val, fc))

        bands_res[str(fc)] = {
            "rt60": round(float(res["rt60"]), 6),
            "t20": round(float(res["t20"]), 6),
            "t30": round(float(res["t30"]), 6),
            "edt": round(float(res["edt"]), 6),
            "r2": round(float(res["r2"]), 6),
            "r2_t20": round(float(res["r2_t20"]), 6),
            "r2_t30": round(float(res["r2_t30"]), 6),
            "r2_edt": round(float(res["r2_edt"]), 6),
            "used": res["used"],
            "tier": res["tier"],
            "valid": bool(res["valid"]),
            "dynamic_range_db": dr_val,
        }

    # Minimum dynamic range over all 6 bands
    min_dr, weakest_band = min(dr_list, key=lambda x: x[0])

    return {
        "pnr_db": round(float(pnr_db), 2),
        "peak_idx": int(peak_idx),
        "peak_val": round(float(peak_val), 6),
        "dynamic_range_db": min_dr,
        "weakest_band_hz": weakest_band,
        "bands": bands_res,
    }


def main():
    fixtures_dir = os.path.join(parent_dir, "reference", "fixtures")
    single_path = os.path.join(fixtures_dir, "fake_recording_single.npy")
    multi_path = os.path.join(fixtures_dir, "fake_recording_multi.npy")

    print("Running reference pipeline on fake_recording_single.npy...")
    single_res = run_pipeline_on_recording(single_path)

    print("Running reference pipeline on fake_recording_multi.npy...")
    multi_res = run_pipeline_on_recording(multi_path)

    expected_path = os.path.join(parent_dir, "reference", "expected_outputs.json")
    with open(expected_path, "r") as f:
        data = json.load(f)

    # ADD (not edit) "pipeline" section
    data["pipeline"] = {
        "single_recording": single_res,
        "multi_recording": multi_res,
    }

    with open(expected_path, "w") as f:
        json.dump(data, f, indent=2)

    print("Successfully added 'pipeline' section to reference/expected_outputs.json")
    print("\nSingle Recording Results:")
    print(f"  PNR: {single_res['pnr_db']} dB | DR: {single_res['dynamic_range_db']} dB (weakest: {single_res['weakest_band_hz']} Hz)")
    for fc, b in single_res["bands"].items():
        print(f"  {fc:>4} Hz: RT60={b['rt60']:.6f}s ({b['used']}, {b['tier']})")

    print("\nMulti Recording Results:")
    print(f"  PNR: {multi_res['pnr_db']} dB | DR: {multi_res['dynamic_range_db']} dB (weakest: {multi_res['weakest_band_hz']} Hz)")
    for fc, b in multi_res["bands"].items():
        print(f"  {fc:>4} Hz: RT60={b['rt60']:.6f}s ({b['used']}, {b['tier']})")


if __name__ == "__main__":
    main()
