#!/usr/bin/env python3
"""
reference/gate_reference.py  --  independent Python reference for the EchoMap sweep-presence gate.

Two gates are implemented and compared on the same scenarios:

  CURRENT  (checkSweepSignature in JS): per-octave-band energy peak time = the loudest 50 ms block
           anywhere in the recording; requires ordered peaks ~0.68 s apart.
           Weakness: a loud transient anywhere (button tap, knock, cough) can win a band.

  TEMPLATE (proposed): the matched-filter (deconvolution) peak gives the sweep start time.
           Band energy is then checked ONLY at the times the sweep should be in each band:
               t_k = t_start + L*ln(fc_k/f1),   L = T/ln(f2/f1)
           against the background (median of 50 ms block energies of that band).
           Accept when >= MIN_BANDS of 6 bands exceed the background by >= MIN_MARGIN_DB.

Parameters of the TEMPLATE gate (round numbers, NOT tuned on the scenarios below):
    WIN_S = 0.15 s (half-window), MIN_MARGIN_DB = 10 dB, MIN_BANDS = 4 of 6,
    block = 50 ms, hop = 25 ms, band filters = Butterworth N=2 band-pass (4th order overall).

Run:  python3 reference/gate_reference.py        (deterministic: fixed seeds)
Requires numpy and scipy (see reference/requirements.txt).
All signals are SYNTHETIC; real phone recordings are still required for validation.
"""
import numpy as np
from scipy import signal

FS = 48000
F1, F2, T = 50.0, 8000.0, 5.0
CENT = [125, 250, 500, 1000, 2000, 4000]
L = T / np.log(F2 / F1)

WIN_S, MIN_MARGIN_DB, MIN_BANDS = 0.15, 10.0, 4
BLK, HOP = int(0.050 * FS), int(0.025 * FS)

def make_sweep(amp=0.7):
    n = int(T * FS); t = np.arange(n) / FS
    x = np.sin(2 * np.pi * F1 * L * (np.exp(t / L) - 1))
    nf = int(0.02 * FS); w = np.ones(n)
    w[:nf] = 0.5 * (1 - np.cos(np.pi * np.arange(nf) / nf)); w[-nf:] = w[:nf][::-1]
    return amp * x * w

SW = make_sweep()
INV = SW[::-1] * np.exp(-(np.arange(len(SW)) / FS) / L)       # Farina inverse filter
SOS = {fc: signal.butter(2, [fc / np.sqrt(2), fc * np.sqrt(2)], btype='bandpass', fs=FS, output='sos') for fc in CENT}

def block_energy(f):
    nh = max(1, (len(f) - BLK) // HOP + 1)
    return np.array([np.mean(f[i * HOP:i * HOP + BLK] ** 2) for i in range(nh)])

def current_gate(sig):
    pk = []
    for fc in CENT:
        e = block_energy(signal.sosfilt(SOS[fc], sig))
        pk.append((int(np.argmax(e)) * HOP + BLK / 2) / FS)
    edt = L * np.log(2); espan = 5 * edt
    dts = np.diff(pk); mono = int(np.sum(dts > 0.05)); span = pk[-1] - pk[0]
    err = np.mean(np.abs(dts - edt))
    score = 0.4 * mono / 5 + 0.3 * max(0, 1 - err / edt) + 0.3 * max(0, 1 - abs(span - espan) / espan)
    ok = mono >= 4 and 2.2 <= span <= 4.8 and score >= 0.65
    return ok, round(float(score), 3)

def template_gate(sig):
    h = signal.fftconvolve(sig, INV)
    p = int(np.argmax(np.abs(h)))
    t_start = (p - (len(SW) - 1)) / FS
    matched, margins = 0, []
    for fc in CENT:
        f = signal.sosfilt(SOS[fc], sig)
        bg = np.median(block_energy(f)) + 1e-18
        tk = t_start + L * np.log(fc / F1)
        a, b = int((tk - WIN_S) * FS), int((tk + WIN_S) * FS)
        if a < 0 or b > len(f):
            margins.append(-99.0); continue
        m = float(10 * np.log10(np.mean(f[a:b] ** 2) / bg + 1e-18))
        margins.append(round(m, 1)); matched += m >= MIN_MARGIN_DB
    return matched >= MIN_BANDS, matched, round(float(t_start), 2), margins

# ------------------------------ scenario helpers ------------------------------
rng = np.random.default_rng(2026)
def room_ir(rt60=0.8, dur=1.2):
    n = int(dur * FS); t = np.arange(n) / FS
    h = rng.standard_normal(n) * np.exp(-6.908 * t / rt60) * 0.15; h[0] = 1.0; return h
def recording(total_s=8.5, offset_s=1.0, rt60=0.8):
    x = np.zeros(int(total_s * FS)); y = signal.fftconvolve(SW, room_ir(rt60)); i0 = int(offset_s * FS)
    m = min(len(y), len(x) - i0); x[i0:i0 + m] += y[:m]; return x
def lp_burst(dur=0.03, fmax=500):
    b = np.zeros(int(0.5 * FS)); m = int(dur * FS)
    nz = rng.standard_normal(m) * np.exp(-np.arange(m) / (0.01 * FS))
    b[:m] = signal.sosfilt(signal.butter(4, fmax, btype='low', fs=FS, output='sos'), nz); return b
def bb_burst(dur=0.08, tau=0.02):
    b = np.zeros(max(int(0.4 * FS), int(dur * FS) + 1)); m = int(dur * FS)
    b[:m] = rng.standard_normal(m) * np.exp(-np.arange(m) / (tau * FS)); return b
def add_at(x, ev, t0):
    y = x.copy(); i = int(t0 * FS); m = min(len(ev), len(y) - i); y[i:i + m] += ev[:m]; return y
def peak_block_rms(x, fc): return float(np.sqrt(block_energy(signal.sosfilt(SOS[fc], x)).max()))
def scaled(ev, db, fc, ref):
    tmp = np.zeros(int(8.5 * FS)); tmp[:len(ev)] = ev
    return ev * (peak_block_rms(ref, fc) * 10 ** (db / 20) / peak_block_rms(tmp, fc))
def white(n, s): return rng.standard_normal(n) * s
def brown(n, s): w = np.cumsum(rng.standard_normal(n)); w -= w.mean(); return w / np.std(w) * s
def hum(n, s, harm=(1, 2, 3, 4, 5)):
    t = np.arange(n) / FS; x = sum(np.sin(2 * np.pi * 50 * h * t + rng.uniform(0, 6.28)) / h ** 0.5 for h in harm)
    return x / np.std(x) * s

def run_battery():
    base = recording(); srms = float(np.sqrt(np.mean(SW ** 2))); N = int(8.5 * FS)
    rows = []
    def add(name, x, expect): rows.append((name, x, expect))

    add("clean room (RT60 0.8 s)", base, True)
    for rt in (0.3, 1.5): add(f"clean room RT60 {rt} s", recording(rt60=rt), True)
    for off in (0.5, 3.0, 10.0, 20.0): add(f"sweep at offset {off} s in a 30 s recording", recording(30.0, off), True)
    for db in (0, 6, 12, 20):
        for where, t0 in (("start 0.3 s", 0.3), ("middle 3 s", 3.0), ("end 7.5 s", 7.5)):
            add(f"LF thump {db:+d} dB re sweep (250 Hz band), {where}", add_at(base, scaled(lp_burst(), db, 250, base), t0), True)
    for db in (0, 6, 12): add(f"broadband knock {db:+d} dB re sweep (1 kHz band), 2.5 s", add_at(base, scaled(bb_burst(), db, 1000, base), 2.5), True)
    for hp in (150, 250, 350, 500):
        s = signal.sosfilt(signal.butter(2, hp, btype='high', fs=FS, output='sos'), base)
        for rd in (None, -10, 0):
            x = s if rd is None else s + brown(len(s), float(np.sqrt(np.mean(s ** 2))) * 10 ** (rd / 20))
            add(f"phone-speaker HPF {hp} Hz + brown rumble {rd} dB", x, True)
    for db in (-20, 0, 6): add(f"mains hum + harmonics {db:+d} dB re sweep RMS", base + hum(len(base), srms * 10 ** (db / 20)), True)
    for db in (-10, 0, 3): add(f"white noise {db:+d} dB re sweep RMS", base + white(len(base), srms * 10 ** (db / 20)), True)
    add("sweep played twice back to back", np.concatenate([base[:int(7.0 * FS)], base]), True)

    clap = bb_burst(0.5, 0.03) * 0.8
    add("clean clap, no sweep", add_at(np.zeros(N), clap, 2.0), False)
    for nz in (0.001, 0.005, 0.02):
        for lv in (0.2, 0.8): add(f"clap x{lv} + white noise sigma {nz}", add_at(white(N, nz), clap * lv, 2.0), False)
    for k in range(5): add(f"noise only (seed {k})", white(N, 0.01), False)
    add("silence", np.zeros(N), False)
    add("brown noise only", brown(N, 0.05), False)
    add("mains hum + harmonics + noise, no sweep", hum(N, 0.1) + white(N, 0.01), False)
    add("noise + loud burst, no sweep", add_at(white(N, 0.01), bb_burst() * 0.5, 3.0), False)
    tt = np.arange(N) / FS
    add("speech-like modulated tones, no sweep", sum(np.sin(2 * np.pi * f * tt) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * tt)) for f in (150, 300, 450, 900, 1800)) * 0.05 + white(N, 0.005), False)
    add("two claps 1.5 s apart", add_at(add_at(white(N, 0.003), clap, 2.0), clap, 3.5), False)
    add("rising broadband noise (fan spin-up)", white(N, 1.0) * np.linspace(0.005, 0.1, N), False)
    td = np.arange(int(5 * FS)) / FS
    add("DOWN sweep (wrong direction)", add_at(np.zeros(N), 0.7 * np.sin(2 * np.pi * F1 * L * (np.exp((5 - td) / L) - 1)), 1.0) + white(N, 0.002), False)
    fL = 2.0 / np.log(F2 / F1); tf = np.arange(int(2 * FS)) / FS
    add("FAST 2 s sweep (wrong rate)", add_at(np.zeros(N), 0.7 * np.sin(2 * np.pi * F1 * fL * (np.exp(tf / fL) - 1)), 1.0) + white(N, 0.002), False)

    print(f"{'scenario':58s} {'expect':7s} | {'CURRENT gate':22s} | TEMPLATE gate")
    print("-" * 130)
    cur_ok = tmp_ok = 0
    for name, x, expect in rows:
        ok_c, sc = current_gate(x); ok_t, m, ts, mar = template_gate(x)
        cur_ok += ok_c == expect; tmp_ok += ok_t == expect
        fc_flag = "" if ok_c == expect else " WRONG"; ft_flag = "" if ok_t == expect else " WRONG"
        print(f"{name:58s} {'ACCEPT' if expect else 'REJECT':7s} | {('ACCEPT' if ok_c else 'REJECT')} score={sc:5.3f}{fc_flag:6s} | "
              f"{('ACCEPT' if ok_t else 'REJECT')} {m}/6 t_start={ts:5.2f} min_margin={min(mar):6.1f} dB{ft_flag}")
    print("-" * 130)
    print(f"Correct decisions: CURRENT {cur_ok}/{len(rows)}   TEMPLATE {tmp_ok}/{len(rows)}")


if __name__ == "__main__":
    run_battery()
