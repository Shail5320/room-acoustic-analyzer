#!/usr/bin/env python3
"""
reference/treatment_reference.py
--------------------------------
Plain Python reference calculation for Phase 6 Treatment Calculator.
Uses only standard library (math, json, pathlib). No external dependencies.
Does NOT modify any existing reference files.

Computes expected values for:
  1. The worked example from docs/PLAN.md (5x4x3m, RT60 1.2s -> 0.4s, alpha 0.05 -> 0.80)
  2. An Eyring dead-room example (4x3x2.5m, RT60 0.8s -> 0.25s, alpha 0.05 -> 0.85)
  3. Range propagation corners (monotonic min/max volume and RT60)
  4. Mathematical guards and edge cases (deltaA <= 0, alpha_mat <= alpha_exist, sPanel > sWallCeiling)
  5. Top-quartile hotspot percentile threshold logic

Writes output to reference/treatment_expected.json.
"""

import json
import math
from pathlib import Path

SABINE_C = 0.161

def room_geometry(length, width, height):
    volume = length * width * height
    surface_area = 2.0 * (length * width + length * height + width * height)
    # Available wall and ceiling area: walls (2*LH + 2*WH) + ceiling (LW) = surface_area - floor(LW)
    wall_ceiling_area = 2.0 * (length * height + width * height) + (length * width)
    return {
        "length": length,
        "width": width,
        "height": height,
        "volume": volume,
        "surface_area": surface_area,
        "wall_ceiling_area": wall_ceiling_area
    }

def sabine_absorption(volume, rt60):
    if volume <= 0 or rt60 <= 0:
        return 0.0
    return (SABINE_C * volume) / rt60

def sabine_treatment(volume, rt60_measured, rt60_target, alpha_mat, alpha_exist=0.05):
    ratio = rt60_measured / rt60_target
    target_met = ratio <= 1.0
    a_now = sabine_absorption(volume, rt60_measured)
    a_target = sabine_absorption(volume, rt60_target)
    delta_a = a_target - a_now

    net_alpha = alpha_mat - alpha_exist
    if target_met or delta_a <= 0:
        s_panel = 0.0
        guard_reason = "target_met_or_no_absorption_needed"
    elif net_alpha <= 0:
        s_panel = "Infinity"
        guard_reason = "material_alpha_le_existing"
    else:
        s_panel = delta_a / net_alpha
        guard_reason = None

    return {
        "ratio": ratio,
        "target_met": target_met,
        "a_now": a_now,
        "a_target": a_target,
        "delta_a": delta_a,
        "s_panel": s_panel,
        "net_alpha": net_alpha,
        "guard_reason": guard_reason
    }

def eyring_absorption(surface_area, volume, rt60):
    if surface_area <= 0 or volume <= 0 or rt60 <= 0:
        return {"alpha_avg": 0.0, "a_eyring": 0.0}
    exponent = (SABINE_C * volume) / (surface_area * rt60)
    alpha_avg = 1.0 - math.exp(-exponent)
    a_eyring = surface_area * alpha_avg
    return {"alpha_avg": alpha_avg, "a_eyring": a_eyring}

def eyring_treatment(surface_area, volume, rt60_measured, rt60_target, alpha_mat, alpha_exist=0.05):
    now = eyring_absorption(surface_area, volume, rt60_measured)
    target = eyring_absorption(surface_area, volume, rt60_target)
    delta_a = target["a_eyring"] - now["a_eyring"]
    net_alpha = alpha_mat - alpha_exist

    if rt60_measured <= rt60_target or delta_a <= 0:
        s_panel = 0.0
        guard_reason = "target_met_or_no_absorption_needed"
    elif net_alpha <= 0:
        s_panel = "Infinity"
        guard_reason = "material_alpha_le_existing"
    else:
        s_panel = delta_a / net_alpha
        guard_reason = None

    return {
        "alpha_avg_now": now["alpha_avg"],
        "alpha_avg_target": target["alpha_avg"],
        "a_now": now["a_eyring"],
        "a_target": target["a_eyring"],
        "delta_a": delta_a,
        "s_panel": s_panel,
        "net_alpha": net_alpha,
        "guard_reason": guard_reason,
        "is_dead_room": target["alpha_avg"] > 0.3
    }

def compute_corners(volume_nominal, rt60_mean, rt60_min, rt60_max, alpha_mat, alpha_exist=0.05, is_steps=False):
    # If steps, volume uncertainty is about 30% (+/- 30%)
    vol_uncertainty = 0.30 if is_steps else 0.0
    v_min = volume_nominal * (1.0 - vol_uncertainty)
    v_max = volume_nominal * (1.0 + vol_uncertainty)

    # Monotonic corners:
    # min volume and min rt60 give min area
    # max volume and max rt60 give max area
    s_nom = sabine_treatment(volume_nominal, rt60_mean, 0.4, alpha_mat, alpha_exist)["s_panel"]
    s_min = sabine_treatment(v_min, rt60_min, 0.4, alpha_mat, alpha_exist)["s_panel"]
    s_max = sabine_treatment(v_max, rt60_max, 0.4, alpha_mat, alpha_exist)["s_panel"]

    return {
        "volume_nominal": volume_nominal,
        "volume_min": v_min,
        "volume_max": v_max,
        "rt60_mean": rt60_mean,
        "rt60_min": rt60_min,
        "rt60_max": rt60_max,
        "s_panel_nominal": s_nom,
        "s_panel_min": s_min,
        "s_panel_max": s_max
    }

def top_quartile_threshold(values):
    """Compute 75th percentile (Q3) of a list of floats using linear interpolation."""
    sorted_v = sorted(values)
    n = len(sorted_v)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_v[0]
    # Percentile rank p = 0.75 in index space [0, n - 1]
    idx = 0.75 * (n - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    frac = idx - lo
    return sorted_v[lo] * (1.0 - frac) + sorted_v[hi] * frac

def main():
    # 1. PLAN.md Worked Example
    plan_geom = room_geometry(5.0, 4.0, 3.0)
    plan_sabine = sabine_treatment(plan_geom["volume"], 1.2, 0.4, 0.8, 0.05)
    plan_eyring = eyring_treatment(plan_geom["surface_area"], plan_geom["volume"], 1.2, 0.4, 0.8, 0.05)

    # 2. Dead-Room Eyring Example
    # Small vocal booth / control room: 4m x 3m x 2.4m, RT60 = 0.8s -> 0.20s, alpha_mat = 0.85
    dead_geom = room_geometry(4.0, 3.0, 2.4)
    dead_sabine = sabine_treatment(dead_geom["volume"], 0.8, 0.20, 0.85, 0.05)
    dead_eyring = eyring_treatment(dead_geom["surface_area"], dead_geom["volume"], 0.8, 0.20, 0.85, 0.05)

    # 3. Monotonic Corners (Step dimension example)
    corners_step = compute_corners(plan_geom["volume"], 1.2, 1.1, 1.3, 0.8, 0.05, is_steps=True)
    corners_exact = compute_corners(plan_geom["volume"], 1.2, 1.1, 1.3, 0.8, 0.05, is_steps=False)

    # 4. Guards
    guard_target_met = sabine_treatment(60.0, 0.35, 0.4, 0.8, 0.05)
    guard_alpha_low = sabine_treatment(60.0, 1.2, 0.4, 0.04, 0.05)
    guard_alpha_equal = sabine_treatment(60.0, 1.2, 0.4, 0.05, 0.05)
    # Area exceeding wall and ceiling (requires 100 m2 when wall+ceiling is 74 m2)
    guard_exceeds_area = {
        "required_panel_area": 85.0,
        "wall_ceiling_area": plan_geom["wall_ceiling_area"],
        "exceeds": 85.0 > plan_geom["wall_ceiling_area"]
    }

    # 5. Hotspot threshold test data
    grid_sample = [0.45, 0.50, 0.52, 0.55, 0.60, 0.62, 0.70, 0.75, 0.80, 0.95, 1.10, 1.25]
    q3_val = top_quartile_threshold(grid_sample)

    output = {
        "metadata": {
            "description": "Ground truth expected values for Phase 6 Treatment Calculator",
            "sabine_c": SABINE_C
        },
        "plan_example": {
            "geometry": plan_geom,
            "measured_rt60": 1.2,
            "target_rt60": 0.4,
            "existing_alpha": 0.05,
            "material_alpha": 0.80,
            "sabine": plan_sabine,
            "eyring": plan_eyring
        },
        "dead_room_example": {
            "geometry": dead_geom,
            "measured_rt60": 0.8,
            "target_rt60": 0.25,
            "existing_alpha": 0.05,
            "material_alpha": 0.85,
            "sabine": dead_sabine,
            "eyring": dead_eyring
        },
        "corners": {
            "steps": corners_step,
            "exact": corners_exact
        },
        "guards": {
            "target_met": guard_target_met,
            "alpha_lower": guard_alpha_low,
            "alpha_equal": guard_alpha_equal,
            "area_exceeded": guard_exceeds_area
        },
        "hotspot": {
            "values": grid_sample,
            "q3_threshold": q3_val
        }
    }

    out_path = Path(__file__).resolve().parent / "treatment_expected.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Generated {out_path} successfully.")
    print(f"Plan Sabine s_panel: {plan_sabine['s_panel']:.4f} m2 (approx 21.5 m2)")
    print(f"Plan Eyring s_panel: {plan_eyring['s_panel']:.4f} m2 (approx 18.1 m2)")
    print(f"Dead room Eyring target alpha_avg: {dead_eyring['alpha_avg_target']:.4f} (> 0.3? {dead_eyring['is_dead_room']})")

if __name__ == "__main__":
    main()
