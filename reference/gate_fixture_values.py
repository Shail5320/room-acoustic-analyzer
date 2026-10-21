#!/usr/bin/env python3
"""
reference/gate_fixture_values.py — Run Python template gate on reference fixtures and update expected_outputs.json.

Cross-checks reference/fixtures/fake_recording_single and fake_recording_multi
using template_gate imported from reference/gate_reference.py.
Adds a "gate" section to reference/expected_outputs.json without modifying any existing sections.
"""

import os
import sys
import json
import numpy as np

# Ensure reference package directory is in sys.path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from gate_reference import template_gate, SW, FS

def main():
    fixtures_dir = os.path.join(current_dir, "fixtures")
    single_path = os.path.join(fixtures_dir, "fake_recording_single.npy")
    multi_path = os.path.join(fixtures_dir, "fake_recording_multi.npy")

    rec_single = np.load(single_path)
    rec_multi = np.load(multi_path)

    ok_s, matched_s, ts_s, margins_s = template_gate(rec_single)
    ok_m, matched_m, ts_m, margins_m = template_gate(rec_multi)

    expected_path = os.path.join(current_dir, "expected_outputs.json")
    with open(expected_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Peak indices from pipeline section
    single_peak = data["pipeline"]["single_recording"]["peak_idx"]
    multi_peak = data["pipeline"]["multi_recording"]["peak_idx"]

    sweep_len = len(SW)
    t_start_s_exact = (single_peak - (sweep_len - 1)) / FS
    t_start_m_exact = (multi_peak - (sweep_len - 1)) / FS

    gate_section = {
        "single_recording": {
            "ok": bool(ok_s),
            "matched_bands": int(matched_s),
            "t_start_s": round(float(t_start_s_exact), 6),
            "t_start_rounded_s": float(ts_s),
            "margins_db": [float(m) for m in margins_s],
        },
        "multi_recording": {
            "ok": bool(ok_m),
            "matched_bands": int(matched_m),
            "t_start_s": round(float(t_start_m_exact), 6),
            "t_start_rounded_s": float(ts_m),
            "margins_db": [float(m) for m in margins_m],
        },
    }

    data["gate"] = gate_section

    with open(expected_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print("Updated reference/expected_outputs.json with 'gate' section:")
    print(json.dumps(gate_section, indent=2))

if __name__ == "__main__":
    main()
