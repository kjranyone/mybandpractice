#!/usr/bin/env python3
"""Stem-based deep learning chord analysis using BTC Transformer (ISMIR19)
with Music Theory Heuristic Post-Processor (Dominant Motion & II-V-I Cadences).

Leverages:
- BTC (Bidirectional Transformer for Chord Recognition) pretrained neural model
- Stems (bass.mp3 + other.mp3): eliminates vocal formant/vibrato & drum cymbal noise
- drums.mp3: beat & bar downbeat alignment
- Inversion/Slash chord detection from bass.mp3 root analysis
- Music Theory Heuristic Post-Processor:
  - Resolves Dominant motions (V7 -> I, V7 -> i)
  - Identifies & labels II-V-I cadences (Major & Minor)
  - Filters out transient non-harmonic passing glitches

Usage:
    uv run python bin/analyze-chords.py <slug>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Add tools/btc to path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
BTC_DIR = ROOT / "tools" / "btc"


def ensure_btc_installed() -> None:
    """Ensure BTC-ISMIR19 model repository is cloned to tools/btc with modern compatibility patches."""
    if (BTC_DIR / "btc_model.py").exists():
        return
    print("==> cloning BTC-ISMIR19 repository to tools/btc ...")
    BTC_DIR.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "clone", "https://github.com/jayg996/BTC-ISMIR19.git", str(BTC_DIR)],
        check=True,
    )
    # Modern PyYAML and NumPy compatibility patches
    hparams_path = BTC_DIR / "utils" / "hparams.py"
    if hparams_path.exists():
        txt = hparams_path.read_text(encoding="utf-8")
        txt = txt.replace("yaml.load(f)", "yaml.safe_load(f)")
        hparams_path.write_text(txt, encoding="utf-8")

    tf_path = BTC_DIR / "utils" / "transformer_modules.py"
    if tf_path.exists():
        txt = tf_path.read_text(encoding="utf-8")
        txt = txt.replace(".astype(np.float)", ".astype(float)")
        tf_path.write_text(txt, encoding="utf-8")


ensure_btc_installed()
if str(BTC_DIR) not in sys.path:
    sys.path.insert(0, str(BTC_DIR))

import librosa
import numpy as np
import torch
from btc_model import BTC_model
from utils.hparams import HParams

SONGS_DIR = ROOT / "songs"

# Verified tempo overrides (BPM) per song slug. The automatic detector
# resolves tempo-octave ambiguity well for most songs, but quarter-note
# level is genuinely ambiguous from audio alone; where an official /
# authoritative BPM is known it wins. Sources checked 2026-08:
# tunebat.com, ongakumichi523.jp, chordwiki (band scores).
BPM_OVERRIDES = {
    "danderaion": 152.0,                     # chordwiki band score
    "drivers-high": 86.0,                    # tunebat / songbpm
    "enter-sandman": 123.0,                  # tunebat
    "get-wild": 87.0,                        # snare backbeat measurement
    "hakujitsu": 92.0,                       # ongakumichi
    "hitorino-yoru": 172.0,                  # snare backbeat (official n/a)
    "inmu-king-yaju-mc": 130.0,              # snare backbeat (official n/a)
    "nokishita-no-monsutaa-nokimon": 120.0,  # snare backbeat measurement
    "oyasumi-naki-koe-sayonara-utahime": 92.3,
    "oyasumi-nakigoe-unagiuna-cover": 94.0,  # cover perf., measured
    "red-reduction-division-murai-cover": 136.0,  # tempogram dominant
    "sailing-day": 96.0,                     # snare backbeat measurement
    "shining-ray": 161.5,                    # snare backbeat (official n/a)
    "tentaikansoku": 165.0,                  # tunebat / chiebukuro
    "tiger-punch": 138.0,                    # snare backbeat (official n/a)
    "zenzen-zense-movie-ver": 190.0,         # tunebat / ongakumichi
}

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ROOT_LIST = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
QUALITY_LIST = [
    "min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7",
    "dim7", "hdim7", "sus2", "sus4"
]

# Krumhansl-Schmuckler Key Profiles
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def idx2voca_chord_map() -> dict[int, str]:
    """Generate index-to-chord mapping for 170-class large vocabulary BTC model."""
    idx2voca: dict[int, str] = {168: "X", 169: "N"}
    for i in range(168):
        root = ROOT_LIST[i // 14]
        quality = QUALITY_LIST[i % 14]
        if i % 14 != 1:  # not 'maj'
            chord = f"{root}:{quality}"
        else:
            chord = root
        idx2voca[i] = chord
    return idx2voca


def parse_chord_components(chord_str: str) -> tuple[str, str, str]:
    """Parse chord string into (root, quality, bass).
    
    e.g. 'C#maj7/G#' -> ('C#', 'maj7', 'G#')
         'Em'        -> ('E', 'm', '')
         'N.C.'      -> ('', 'N.C.', '')
    """
    if not chord_str or chord_str in ("N.C.", "N", "X", "--"):
        return "", "N.C.", ""

    base = chord_str
    bass = ""
    if "/" in base:
        base, bass = base.split("/", 1)

    # Extract root (1 or 2 chars)
    if len(base) >= 2 and base[1] in ("#", "b"):
        root = base[:2]
        quality = base[2:]
    else:
        root = base[:1]
        quality = base[1:]

    return root, quality, bass


def format_chord_symbol(btc_raw: str) -> tuple[str, str]:
    """Convert BTC notation (e.g. 'E:min7', 'C:maj7', 'B:7', 'N') to clean notation ('Em7', 'Cmaj7', 'B7', 'N.C.').
    
    Returns: (formatted_chord, root_name)
    """
    if not btc_raw or btc_raw in ("N", "X", "N.C."):
        return "N.C.", ""

    if ":" not in btc_raw:
        return btc_raw, btc_raw  # e.g. "C", "G"

    root, quality = btc_raw.split(":", 1)
    quality_map = {
        "min": "m",
        "maj": "",
        "min7": "m7",
        "maj7": "maj7",
        "7": "7",
        "sus4": "sus4",
        "sus2": "sus2",
        "dim": "dim",
        "dim7": "dim7",
        "hdim7": "m7-5",
        "aug": "aug",
        "min6": "m6",
        "maj6": "6",
        "minmaj7": "mM7",
    }
    fmt_qual = quality_map.get(quality, quality)
    return f"{root}{fmt_qual}", root


def estimate_key(chroma_mean: np.ndarray) -> tuple[str, int, bool, float]:
    """Estimate musical key from global chroma mean vector.
    
    Returns: (key_name, root_idx, is_minor, score)
    """
    best_key = "C"
    best_root = 0
    best_is_minor = False
    best_score = -1.0

    for root_idx in range(12):
        rotated = np.roll(chroma_mean, -root_idx)
        score_maj = float(np.corrcoef(rotated, KS_MAJOR)[0, 1])
        if score_maj > best_score:
            best_score = score_maj
            best_key = f"{PITCH_NAMES[root_idx]}"
            best_root = root_idx
            best_is_minor = False

        score_min = float(np.corrcoef(rotated, KS_MINOR)[0, 1])
        if score_min > best_score:
            best_score = score_min
            best_key = f"{PITCH_NAMES[root_idx]}m"
            best_root = root_idx
            best_is_minor = True

    return best_key, best_root, best_is_minor, float(best_score)


def load_btc_model() -> tuple[BTC_model, dict, dict, HParams, dict[int, str]]:
    config = HParams.load(str(BTC_DIR / "run_config.yaml"))
    config.feature["large_voca"] = True
    config.model["num_chords"] = 170
    model_file = str(BTC_DIR / "test" / "btc_model_large_voca.pt")
    idx_to_chord = idx2voca_chord_map()

    device = torch.device("cpu")
    model = BTC_model(config=config.model).to(device)
    checkpoint = torch.load(model_file, map_location=device, weights_only=False)
    mean = checkpoint["mean"]
    std = checkpoint["std"]
    model.load_state_dict(checkpoint["model"])
    model.eval()

    return model, mean, std, config, idx_to_chord


# =========================================================================
# Tempo / Beat / Downbeat Detection
# =========================================================================
def estimate_tempo_candidates(onset_env: np.ndarray, sr: int, hop: int) -> list[float]:
    """Strong tempogram peaks folded into the [70, 200) BPM range.

    Strong bins carrying >= 25% of the dominant peak energy are collected
    in a musically sane band (30-250 BPM, excluding librosa's inf/DC bins),
    octave-folded into [70, 200) (some J-rock lives at 190+ BPM), and each
    gains an octave-up variant when < 240. The prior-free tempogram is used
    (librosa.feature.tempo's start_bpm prior returns values that do not
    even exist in the tempogram for some songs)."""
    tg = librosa.feature.tempogram(
        onset_envelope=onset_env, sr=sr, hop_length=hop
    )
    freqs = librosa.tempo_frequencies(tg.shape[0], sr=sr, hop_length=hop)
    mean_tg = tg.mean(axis=1)
    mask = (
        (freqs >= 30.0) & (freqs <= 250.0)
        & np.isfinite(freqs) & np.isfinite(mean_tg)
    )
    if not mask.any():
        return [120.0]

    band_freqs = freqs[mask]
    band_scores = mean_tg[mask]
    strong = band_scores >= 0.25 * band_scores.max()
    top = np.argsort(band_scores[strong])[::-1][:8]

    cands: set[float] = set()
    for i in top:
        v = float(band_freqs[strong][i])
        while v < 70.0:
            v *= 2.0
        while v >= 200.0:
            v /= 2.0
        cands.add(round(v, 2))
        if v * 2.0 < 240.0:
            cands.add(round(v * 2.0, 2))
    return sorted(cands)


def _sample_env(env: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Sample env at frame indices with +-1 frame tolerance (max)."""
    out = []
    for f in frames:
        f = int(f)
        lo, hi = max(0, f - 1), min(env.shape[-1], f + 2)
        out.append(env[lo:hi].max() if hi > lo else 0.0)
    return np.asarray(out, dtype=float)


def score_beat_candidate(
    onset_env: np.ndarray,
    sr: int,
    hop: int,
    bpm: float,
) -> tuple[float, np.ndarray, float]:
    """Track beats at the given BPM and score the hypothesis by
    (inter-beat regularity + onset strength at beats).

    Returns (bpm, beat_frames, score). Higher is better; -1 = unusable."""
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop,
        bpm=bpm,
        tightness=100,
        trim=False,
    )
    if len(beat_frames) < 8:
        return bpm, beat_frames, -1.0
    ibi = np.diff(beat_frames)
    med_ibi = float(np.median(ibi))
    if med_ibi <= 0:
        return bpm, beat_frames, -1.0
    reg = 1.0 - min(1.0, float(np.std(ibi)) / med_ibi)

    ref = np.percentile(onset_env, 95)
    if ref <= 1e-9:
        str_s = 0.0
    else:
        beat_strength = float(np.median(_sample_env(onset_env, beat_frames)))
        str_s = min(1.0, (beat_strength / ref) / 0.4)

    return bpm, beat_frames, 0.5 * reg + 0.5 * str_s


def band_onset_peaks(
    S_mag: np.ndarray,
    stft_freqs: np.ndarray,
    lo: float,
    hi: float,
    sr: int,
    hop: int,
    min_gap: float = 0.08,
) -> np.ndarray:
    """Salient onset peak frames within a frequency band [lo, hi) Hz."""
    sel = (stft_freqs >= lo) & (stft_freqs < hi)
    if not sel.any():
        return np.array([], dtype=int)
    band = S_mag[sel, :].mean(axis=0)
    env = np.clip(np.diff(band, prepend=band[0]), 0.0, None)
    ref = np.percentile(env, 95)
    if ref <= 1e-9:
        return np.array([], dtype=int)
    thr = 0.3 * ref
    min_dist = max(1, int(min_gap * sr / hop))
    peaks: list[int] = []
    for i in range(1, len(env) - 1):
        v = env[i]
        if v > thr and v >= env[i - 1] and v > env[i + 1]:
            if not peaks or i - peaks[-1] >= min_dist:
                peaks.append(i)
    return np.asarray(peaks, dtype=int)


def detect_meter_and_downbeat(
    beat_frames: np.ndarray,
    kick_peaks: np.ndarray,
    snare_peaks: np.ndarray,
    onset_env: np.ndarray,
    hi_mag: np.ndarray,
    chord_starts: np.ndarray,
    sr: int,
    hop: int,
) -> tuple[int, int]:
    """Estimate meter (3 or 4 beats/bar) and downbeat phase in two stages.

    Stage 1 - parity (phase mod 2), from the drum kit: pop/rock places the
    kick on beats 1 & 3 and the snare on 2 & 4. The kick/snare hit-rate
    difference between even and odd beats is usually large and decisive.
    The pattern is identical for p and p+2 by construction, so it cannot
    resolve the final ambiguity.

    Stage 2 - p vs p+2 within the winning parity, from:
      * harmonic rhythm: chord changes prefer bar starts
      * crash resonance: beat 1 carries a ringing crash cymbal; we measure
        sustained high-band energy over [beat, beat+300ms] (crashes ring,
        closed hi-hats do not), relative to the all-beat mean.

    Returns (meter, phase) where phase in [0, meter)."""
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    tol_frames = 0.06 * sr / hop
    tol = 0.07

    def hit_fraction(frames: np.ndarray, peaks: np.ndarray) -> float:
        if len(frames) == 0 or len(peaks) == 0:
            return -1.0
        hits = sum(
            1 for b in frames if np.abs(peaks - b).min() <= tol_frames
        )
        return hits / len(frames)

    def chord_alignment(m: int, p: int) -> float:
        grid = beat_times[p::m]
        if len(grid) == 0 or len(chord_starts) == 0:
            return 0.0
        hits_grid = sum(
            1 for g in grid if np.any(np.abs(chord_starts - g) <= tol)
        )
        hits_chords = sum(
            1 for c in chord_starts if np.any(np.abs(grid - c) <= tol)
        )
        return 0.6 * (hits_grid / len(grid)) + 0.4 * (
            hits_chords / len(chord_starts)
        )

    def drum_score(m: int, parity: int) -> float:
        if len(kick_peaks) == 0 and len(snare_peaks) == 0:
            return -1.0
        kick_pos = [i for i in range(m) if i % 2 == parity]
        snare_pos = [i for i in range(m) if i % 2 != parity]
        k = [hit_fraction(beat_frames[i::m], kick_peaks) for i in kick_pos]
        s = [hit_fraction(beat_frames[i::m], snare_peaks) for i in snare_pos]
        k = [v for v in k if v >= 0]
        s = [v for v in s if v >= 0]
        kv = float(np.mean(k)) if k else 0.0
        sv = float(np.mean(s)) if s else 0.0
        return 0.5 * kv + 0.5 * sv

    def crash_resonance(m: int, p: int) -> float:
        """Sustained high-band magnitude after phase beats vs all beats
        (1.0 = average; >1 = crash-like ringing on this phase)."""
        if len(hi_mag) == 0 or len(beat_frames) <= m:
            return 1.0
        win = max(1, int(0.3 * sr / hop))

        def seg_mean(b: int) -> float:
            seg = hi_mag[b : b + win]
            return float(seg.mean()) if len(seg) else 0.0

        at_phase = [seg_mean(int(b)) for b in beat_frames[p::m]]
        all_b = [seg_mean(int(b)) for b in beat_frames]
        base = float(np.mean(all_b)) if all_b else 0.0
        if base <= 1e-12:
            return 1.0
        return float(np.mean(at_phase)) / base

    def stage2(m: int, p: int) -> float:
        return 0.55 * chord_alignment(m, p) + 0.45 * min(
            1.0, crash_resonance(m, p) / 1.6
        )

    best = (4, 0, -1.0)
    dbg = []

    # Meter first: the kit pattern's own periodicity. 4/4 gets a prior
    # (it covers the vast majority of this repertoire).
    d4 = max(drum_score(4, 0), drum_score(4, 1))
    d3 = max(drum_score(3, 0), drum_score(3, 1))
    meter = 4 if d4 + 0.08 >= d3 else 3

    # Stage 1: parity from kick/snare pattern (decisive when confident).
    d_even, d_odd = drum_score(meter, 0), drum_score(meter, 1)
    if d_even >= 0 and d_odd >= 0 and abs(d_even - d_odd) > 0.12:
        parity = 0 if d_even > d_odd else 1
        phases = [p for p in range(meter) if p % 2 == parity]
    else:
        phases = list(range(meter))

    # Stage 2: p vs p+2 via harmonic rhythm + crash resonance.
    for p in phases:
        sc = stage2(meter, p)
        dbg.append(
            f"m{meter}p{p}={sc:.2f}[c={chord_alignment(meter, p):.2f} "
            f"cr={crash_resonance(meter, p):.2f}]"
        )
        if sc > best[2]:
            best = (meter, p, sc)
    dbg.append(f"(dEven={d_even:.2f} dOdd={d_odd:.2f} d4={d4:.2f} d3={d3:.2f})")
    print(f"      phase voting: {' '.join(dbg)}")
    return best[0], best[1]


# =========================================================================
# Music Theory Heuristic Post-Processor
# =========================================================================

def apply_music_theory_heuristics(
    raw_chords: list[dict],
    key_root: int,
    key_is_minor: bool,
) -> list[dict]:
    """Heuristic correction for MIR classification errors:
    
    1. Dominant 7th / Major quality resolution:
       When V (or secondary dominant) precedes I or i (e.g. B -> Em, G -> C, C -> Fm),
       ensure it is represented as a harmonic dominant (e.g. B7/B instead of Bm).
    2. II-V-I cadence consolidation (F#m7 -> B7 -> Em).
    3. Transient glitch elimination.
    """
    n = len(raw_chords)
    if n == 0:
        return raw_chords

    corrected = [dict(c) for c in raw_chords]

    # Pass 1: Eliminate very short non-harmonic glitches (< 0.3s)
    for i in range(1, n - 1):
        dur = corrected[i]["end"] - corrected[i]["start"]
        prev_ch = corrected[i - 1]["chord"]
        next_ch = corrected[i + 1]["chord"]
        # If sandwiched between identical chords, absorb glitch
        if prev_ch == next_ch and dur < 0.6:
            corrected[i]["chord"] = prev_ch
            root, _, _ = parse_chord_components(prev_ch)
            corrected[i]["root"] = root

    # Pass 2: Dominant Motion (V -> I / V -> i) resolution
    for i in range(n - 1):
        cur_ch = corrected[i]["chord"]
        next_ch = corrected[i + 1]["chord"]

        cur_root, cur_qual, cur_bass = parse_chord_components(cur_ch)
        next_root, next_qual, _ = parse_chord_components(next_ch)

        if cur_root in PITCH_NAMES and next_root in PITCH_NAMES:
            c_idx = PITCH_NAMES.index(cur_root)
            n_idx = PITCH_NAMES.index(next_root)

            # Circle of fifths down (5th up -> Root, i.e., (c_idx - n_idx) % 12 == 7)
            # e.g. B (11) -> E (4) -> (11 - 4) % 12 = 7!
            # e.g. G (7) -> C (0) -> (7 - 0) % 12 = 7!
            # e.g. C (0) -> F (5) -> (0 - 5) % 12 = 7!
            # e.g. D (2) -> G (7) -> (2 - 7) % 12 = 7!
            # e.g. A (9) -> D (2) -> (9 - 2) % 12 = 7!
            is_perfect_5th_resolution = ((c_idx - n_idx) % 12 == 7)

            if is_perfect_5th_resolution:
                # If resolving to minor tonic (e.g. B -> Em) or major (G -> C):
                # Upgrade minor/sus artifacts to Dominant 7th or Major Dominant
                if cur_qual in ("m", "m7", "sus4", "sus2", "5"):
                    # Check if resolving to minor tonic or major
                    new_qual = "7" if cur_qual in ("m7", "7") else ""
                    reconstructed = f"{cur_root}{new_qual}"
                    if cur_bass:
                        reconstructed += f"/{cur_bass}"
                    corrected[i]["chord"] = reconstructed

    # Pass 3: II -> V -> I supertonic cadence recognition
    # e.g. F#m7 -> B7 -> Em  or  Dm7 -> G7 -> C  or  A#m7 -> C7 -> Fm
    for i in range(n - 2):
        c1_root, c1_qual, _ = parse_chord_components(corrected[i]["chord"])
        c2_root, c2_qual, _ = parse_chord_components(corrected[i + 1]["chord"])
        c3_root, c3_qual, _ = parse_chord_components(corrected[i + 2]["chord"])

        if c1_root in PITCH_NAMES and c2_root in PITCH_NAMES and c3_root in PITCH_NAMES:
            idx1 = PITCH_NAMES.index(c1_root)
            idx2 = PITCH_NAMES.index(c2_root)
            idx3 = PITCH_NAMES.index(c3_root)

            # II -> V -> I intervals: (idx1 - idx2)%12 == 7 and (idx2 - idx3)%12 == 7
            # e.g. F# (6) -> B (11) -> E (4)
            if ((idx1 - idx2) % 12 == 7) and ((idx2 - idx3) % 12 == 7):
                # Ensure c2 is dominant 7th
                if "7" not in c2_qual and c2_qual not in ("maj7", "dim"):
                    base, bass = corrected[i + 1]["chord"], ""
                    if "/" in base:
                        base, bass = base.split("/", 1)
                    corrected[i + 1]["chord"] = f"{c2_root}7" + (f"/{bass}" if bass else "")

    return corrected


def detect_cadence_type(
    bar_chords: list[dict],
    next_bar_first_chord: str | None,
    key_root: int,
    key_is_minor: bool,
) -> tuple[str | None, list[str]]:
    """Determine if a bar contains or leads into a II-V-I or V-I Dominant Motion.
    
    Returns: (cadence_label, [chord_roles])
    """
    chords = [c["chord"] for c in bar_chords]
    if next_bar_first_chord:
        chords.append(next_bar_first_chord)

    roles = []
    has_2_5_1 = False
    has_5_1 = False

    for i in range(len(chords)):
        r, q, _ = parse_chord_components(chords[i])
        if not r or r not in PITCH_NAMES:
            roles.append("")
            continue
        r_idx = PITCH_NAMES.index(r)
        interval = (r_idx - key_root) % 12
        # Assign Roman numeral / scale degree
        if key_is_minor:
            deg_map = {0: "i", 2: "ii°", 3: "III", 5: "iv", 7: "V7" if "7" in q or q == "" else "v", 8: "VI", 10: "VII"}
        else:
            deg_map = {0: "I", 2: "ii", 4: "iii", 5: "IV", 7: "V7" if "7" in q or q == "" else "V", 9: "vi", 11: "vii°"}
        role = deg_map.get(interval, f"{r}")
        roles.append(role)

    # Check for II-V-I or V-I in consecutive chords
    for i in range(len(chords) - 1):
        r1, q1, _ = parse_chord_components(chords[i])
        r2, q2, _ = parse_chord_components(chords[i + 1])
        if r1 in PITCH_NAMES and r2 in PITCH_NAMES:
            i1 = PITCH_NAMES.index(r1)
            i2 = PITCH_NAMES.index(r2)
            if (i1 - i2) % 12 == 7:  # Dominant 5th resolution
                has_5_1 = True
                if i > 0:
                    r0, _, _ = parse_chord_components(chords[i - 1])
                    if r0 in PITCH_NAMES:
                        i0 = PITCH_NAMES.index(r0)
                        if (i0 - i1) % 12 == 7:
                            has_2_5_1 = True

    cadence = "2-5-1" if has_2_5_1 else ("5-1" if has_5_1 else None)
    return cadence, roles[:len(bar_chords)]


def analyze_song_chords(song_dir: Path) -> dict:
    stems_dir = song_dir / "stems"
    audio_file = song_dir / f"{song_dir.name}.mp3"
    if not audio_file.exists():
        meta_path = song_dir / "meta.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            cand = song_dir / meta.get("audio", {}).get("file", "")
            if cand.exists():
                audio_file = cand

    bass_file = stems_dir / "bass.mp3"
    drums_file = stems_dir / "drums.mp3"
    other_file = stems_dir / "other.mp3"

    print(f"==> analyzing chords for '{song_dir.name}' with BTC Transformer + Music Theory Engine ...")
    t0 = time.time()

    # 1. Load BTC Model
    print("    [1/6] loading BTC Transformer neural model ...")
    model, mean, std, config, idx_to_chord = load_btc_model()
    device = torch.device("cpu")
    sr = config.mp3["song_hz"]

    # 2. Load Audio Stems
    print("    [2/6] loading stems (bass + harmony) ...")
    if bass_file.exists() and other_file.exists():
        y_bass, _ = librosa.load(str(bass_file), sr=sr, mono=True)
        y_other, _ = librosa.load(str(other_file), sr=sr, mono=True)
        y_drums, _ = (
            librosa.load(str(drums_file), sr=sr, mono=True)
            if drums_file.exists()
            else (y_other, sr)
        )
        # Combine bass + other for optimal harmonic clarity
        original_wav = y_bass + y_other
    else:
        original_wav, _ = librosa.load(str(audio_file), sr=sr, mono=True)
        y_bass = original_wav
        y_drums = original_wav

    # 3. Beat / Tempo / Downbeat Detection (prior-free tempogram + kick-band
    #    beat-level disambiguation + downbeat phase estimation)
    print("    [3/6] beat, tempo & downbeat tracking ...")
    # Track beats on the drums stem when available: the kit defines the
    # pulse. (Bass+other mixes can lock onto syncopated patterns that are
    # not the quarter note.) Chord inference below still uses bass+other.
    onset_source = y_drums if drums_file.exists() else original_wav
    onset_env = librosa.onset.onset_strength(y=onset_source, sr=sr, hop_length=512)

    # Drum-band onset peaks for downbeat phase detection:
    # kick (<120 Hz) lands on beats 1&3, snare (180-500 Hz) on 2&4.
    S_mag = np.abs(librosa.stft(y_drums, n_fft=1024, hop_length=512))
    stft_freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    kick_peaks = band_onset_peaks(S_mag, stft_freqs, 0, 120, sr, 512)
    snare_peaks = band_onset_peaks(S_mag, stft_freqs, 180, 500, sr, 512)

    # Cymbal-band sustained magnitude (crash/ride ring) for the beat-1
    # accent: crashes ring for ~1s, closed hi-hats do not.
    hi_sel = stft_freqs >= 6000
    if hi_sel.any():
        hi_mag = S_mag[hi_sel, :].mean(axis=0)
    else:
        hi_mag = np.zeros(S_mag.shape[1], dtype=float)

    cands = estimate_tempo_candidates(onset_env, sr, 512)
    override = BPM_OVERRIDES.get(song_dir.name)
    if override:
        print(f"      BPM override: {override} (verified value)")
        cands = [float(override)]

    def octave_pair(a: float, b: float) -> bool:
        r = max(a, b) / min(a, b)
        return abs(r - 2.0) < 0.07  # within 3.5% of a 2:1 relation

    scored = []
    for c in cands:
        c_bpm, c_frames, c_score = score_beat_candidate(onset_env, sr, 512, c)
        scored.append((c_bpm, c_frames, c_score))

    best_bpm, best_frames, best_score = None, None, -1.0
    for c_bpm, c_frames, c_score in sorted(scored, key=lambda x: -x[2]):
        if c_score <= 0:
            continue
        if best_bpm is None:
            best_bpm, best_frames, best_score = c_bpm, c_frames, c_score
        elif (
            octave_pair(best_bpm, c_bpm)
            and c_bpm < best_bpm
            and c_score > best_score - 0.04
        ):
            # octave-related: prefer the slower (quarter-note) level on ties
            best_bpm, best_frames, best_score = c_bpm, c_frames, c_score

    # Refine tempo from actual tracked inter-beat intervals (tempogram bins
    # are coarse, and a YouTube upload's audio may run a few percent off the
    # official tempo: the grid must match THIS audio, not the label).
    if len(best_frames) >= 8:
        med_ibi = float(np.median(np.diff(best_frames)))
        if med_ibi > 0:
            refined_bpm = 60.0 / (med_ibi * 512.0 / sr)
            if abs(refined_bpm - best_bpm) / best_bpm < 0.08:
                r_bpm, r_frames, r_score = score_beat_candidate(
                    onset_env, sr, 512, refined_bpm
                )
                if r_score > 0 and r_score >= best_score and len(r_frames) >= 8:
                    best_bpm, best_frames = r_bpm, r_frames

    bpm = float(best_bpm)
    beat_frames = best_frames
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=512)
    print(f"      tempo candidates: {[round(c, 1) for c in cands]} -> selected {bpm:.1f} BPM, {len(beat_times)} beats")

    # Global Key estimation via CQT Chromagram
    chroma_global = librosa.feature.chroma_cqt(y=original_wav, sr=sr, n_octaves=5)
    estimated_key, key_root, key_is_minor, key_conf = estimate_key(np.mean(chroma_global, axis=1))
    print(f"      estimated global key: {estimated_key} (confidence: {key_conf:.2f})")

    # Low register bass chroma for slash chords (C1 to C3)
    chroma_bass = librosa.feature.chroma_cqt(
        y=y_bass, sr=sr, hop_length=512, fmin=librosa.note_to_hz("C1"), n_octaves=3
    )

    # 4. Extract CQT Features & Run BTC Inference
    print("    [4/6] running BTC Bi-directional Transformer inference ...")
    currunt_sec_hz = 0
    feature = None
    step_hz = int(config.mp3["song_hz"] * config.mp3["inst_len"])
    while len(original_wav) > currunt_sec_hz + step_hz:
        start_idx = currunt_sec_hz
        end_idx = currunt_sec_hz + step_hz
        tmp = librosa.cqt(
            original_wav[start_idx:end_idx],
            sr=sr,
            n_bins=config.feature["n_bins"],
            bins_per_octave=config.feature["bins_per_octave"],
            hop_length=config.feature["hop_length"],
        )
        feature = tmp if feature is None else np.concatenate((feature, tmp), axis=1)
        currunt_sec_hz = end_idx

    tmp = librosa.cqt(
        original_wav[currunt_sec_hz:],
        sr=sr,
        n_bins=config.feature["n_bins"],
        bins_per_octave=config.feature["bins_per_octave"],
        hop_length=config.feature["hop_length"],
    )
    feature = np.concatenate((feature, tmp), axis=1) if feature is not None else tmp
    feature = np.log(np.abs(feature) + 1e-6)

    feature_per_second = config.mp3["inst_len"] / config.model["timestep"]
    feature = feature.T
    feature = (feature - mean) / std
    time_unit = feature_per_second
    n_timestep = config.model["timestep"]

    num_pad = n_timestep - (feature.shape[0] % n_timestep)
    feature = np.pad(
        feature, ((0, num_pad), (0, 0)), mode="constant", constant_values=0
    )
    num_instance = feature.shape[0] // n_timestep

    raw_segments = []
    start_time = 0.0
    with torch.no_grad():
        feature_tensor = torch.tensor(feature, dtype=torch.float32).unsqueeze(0).to(device)
        for t in range(num_instance):
            self_attn_output, _ = model.self_attn_layers(
                feature_tensor[:, n_timestep * t : n_timestep * (t + 1), :]
            )
            prediction, _ = model.output_layer(self_attn_output)
            prediction = prediction.squeeze()
            for i in range(n_timestep):
                if t == 0 and i == 0:
                    prev_chord = prediction[i].item()
                    continue
                if prediction[i].item() != prev_chord:
                    raw_segments.append(
                        (start_time, time_unit * (n_timestep * t + i), idx_to_chord[prev_chord])
                    )
                    start_time = time_unit * (n_timestep * t + i)
                    prev_chord = prediction[i].item()
                if t == num_instance - 1 and i + num_pad == n_timestep:
                    if start_time != time_unit * (n_timestep * t + i):
                        raw_segments.append(
                            (start_time, time_unit * (n_timestep * t + i), idx_to_chord[prev_chord])
                        )
                    break

    # 5. Format Symbols & Detect Slash Inversions
    print("    [5/6] formatting symbols & detecting slash inversions ...")
    formatted_segments = []
    for s_start, s_end, raw_chord in raw_segments:
        dur = s_end - s_start
        if dur < 0.25 and len(formatted_segments) > 0:
            continue

        clean_chord, root_name = format_chord_symbol(raw_chord)
        if clean_chord == "N.C." and dur < 0.8 and len(formatted_segments) > 0:
            continue

        f_start = librosa.time_to_frames(s_start, sr=sr, hop_length=512)
        f_end = max(f_start + 1, librosa.time_to_frames(s_end, sr=sr, hop_length=512))
        seg_bass = np.mean(chroma_bass[:, f_start:f_end], axis=1)
        bass_peak = float(np.max(seg_bass))
        bass_idx = int(np.argmax(seg_bass)) if bass_peak > 0.12 else None
        
        display_chord = clean_chord
        if bass_idx is not None and root_name in PITCH_NAMES:
            root_idx = PITCH_NAMES.index(root_name)
            if bass_idx != root_idx:
                interval = (bass_idx - root_idx) % 12
                if interval in (3, 4, 7, 10, 2, 5):
                    bass_name = PITCH_NAMES[bass_idx]
                    display_chord = f"{clean_chord}/{bass_name}"

        formatted_segments.append({
            "start": float(round(s_start, 2)),
            "end": float(round(s_end, 2)),
            "chord": str(display_chord),
            "root": str(root_name),
            "confidence": 0.95,
        })

    # Merge adjacent identical chords
    merged_chords = []
    for c in formatted_segments:
        if not merged_chords:
            merged_chords.append(dict(c))
        else:
            prev = merged_chords[-1]
            if prev["chord"] == c["chord"]:
                prev["end"] = float(c["end"])
            else:
                if (c["end"] - c["start"] < 0.35) and len(merged_chords) > 0:
                    prev["end"] = float(c["end"])
                else:
                    merged_chords.append(dict(c))

    # Apply Music Theory Heuristic Post-Processor
    print("    [6/6] applying music theory heuristics & II-V-I cadence analysis ...")
    refined_chords = apply_music_theory_heuristics(merged_chords, key_root, key_is_minor)

    # Meter & downbeat detection: drum pattern (kick 1&3 / snare 2&4),
    # harmonic rhythm (chord changes on bar starts) and beat strength.
    chord_starts = np.asarray(
        [c["start"] for c in refined_chords if c["end"] - c["start"] >= 0.5],
        dtype=float,
    )
    meter, downbeat_phase = detect_meter_and_downbeat(
        beat_frames, kick_peaks, snare_peaks, onset_env, hi_mag,
        chord_starts, sr, 512,
    )
    print(f"      meter: {meter}/4, downbeat phase: {downbeat_phase}")

    # Divide beats into measures (bars)
    bars = []
    num_beats = len(beat_times)
    bar_idx = 1
    # align the first bar to the estimated downbeat
    first_beat = min(downbeat_phase, max(0, num_beats - 2))
    for b_start_idx in range(first_beat, num_beats - 1, meter):
        b_end_idx = min(b_start_idx + meter, num_beats - 1)
        bar_t_start = float(round(beat_times[b_start_idx], 2))
        bar_t_end = float(round(beat_times[b_end_idx], 2))
        bar_dur = bar_t_end - bar_t_start
        if bar_dur <= 0.1:
            continue

        num_beats_in_bar = b_end_idx - b_start_idx
        beat_dur = bar_dur / max(1, num_beats_in_bar)

        # Sample chord at midpoint of each beat in this bar
        beat_chords = []
        for beat_i in range(num_beats_in_bar):
            t_mid = bar_t_start + (beat_i + 0.5) * beat_dur
            matched_chord = "N.C."
            for c in refined_chords:
                if c["start"] <= t_mid < c["end"]:
                    matched_chord = c["chord"]
                    break
            beat_chords.append(matched_chord)

        # Compress identical consecutive beats inside the bar
        bar_chords = []
        cur_ch = None
        cur_beats = 0
        cur_start_beat = 0
        for i, ch in enumerate(beat_chords):
            if cur_ch is None:
                cur_ch = ch
                cur_beats = 1
                cur_start_beat = i
            elif ch == cur_ch:
                cur_beats += 1
            else:
                c_start = float(round(bar_t_start + cur_start_beat * beat_dur, 2))
                c_end = float(round(bar_t_start + (cur_start_beat + cur_beats) * beat_dur, 2))
                r, q, _ = parse_chord_components(cur_ch)
                is_dom = ("7" in q or q == "") and r in PITCH_NAMES and ((PITCH_NAMES.index(r) - key_root) % 12 == 7)
                bar_chords.append({
                    "chord": cur_ch,
                    "beats": cur_beats,
                    "start": c_start,
                    "end": c_end,
                    "is_dominant": is_dom,
                })
                cur_ch = ch
                cur_beats = 1
                cur_start_beat = i

        if cur_ch is not None:
            c_start = float(round(bar_t_start + cur_start_beat * beat_dur, 2))
            c_end = bar_t_end
            r, q, _ = parse_chord_components(cur_ch)
            is_dom = ("7" in q or q == "") and r in PITCH_NAMES and ((PITCH_NAMES.index(r) - key_root) % 12 == 7)
            bar_chords.append({
                "chord": cur_ch,
                "beats": cur_beats,
                "start": c_start,
                "end": c_end,
                "is_dominant": is_dom,
            })

        # Next bar first chord preview for cadence detection
        next_chord_preview = None
        if b_end_idx < num_beats - 1:
            t_next_mid = bar_t_end + 0.5 * beat_dur
            for c in refined_chords:
                if c["start"] <= t_next_mid < c["end"]:
                    next_chord_preview = c["chord"]
                    break

        cadence_type, roles = detect_cadence_type(
            bar_chords, next_chord_preview, key_root, key_is_minor
        )

        for bc_i, bc in enumerate(bar_chords):
            if bc_i < len(roles) and roles[bc_i]:
                bc["role"] = roles[bc_i]

        bars.append({
            "bar_number": bar_idx,
            "start": bar_t_start,
            "end": bar_t_end,
            "beats": num_beats_in_bar,
            "cadence": cadence_type,
            "chords": bar_chords,
        })
        bar_idx += 1

    elapsed = float(round(time.time() - t0, 2))
    print(f"==> analysis complete in {elapsed}s: structured {len(bars)} bars ({len(refined_chords)} chords).")

    result = {
        "slug": str(song_dir.name),
        "key": str(estimated_key),
        "key_confidence": float(round(key_conf, 2)),
        "bpm": float(round(bpm, 1)),
        "time_signature": f"{meter}/4",
        "analyzed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsed_seconds": elapsed,
        "model": "BTC-ISMIR19 + Music Theory Heuristics",
        "bars": bars,
        "chords": refined_chords,
    }

    # Save to songs/<slug>/chords.json (for app inspection)
    chords_file = song_dir / "chords.json"
    chords_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"      saved results to {chords_file.relative_to(ROOT)}")

    return result


def format_timestamp(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m:02d}:{s:05.2f}"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("slug", help="song slug under songs/ (e.g. shinen)")
    args = ap.parse_args()

    song_dir = SONGS_DIR / args.slug
    if not song_dir.exists():
        sys.exit(f"song dir not found: {song_dir}")

    result = analyze_song_chords(song_dir)

    print("\n" + "=" * 70)
    print(f"[Heuristic + BTC] Chord Progression for '{result['slug']}'")
    print(f"   Estimated Key: {result['key']} (conf: {result['key_confidence']}) | Tempo: {result['bpm']} BPM")
    print("=" * 70)
    print(f"{'Bar':<6} {'Time Range':<18} {'Cadence':<10} {'Chords (Beats)'}")
    print("-" * 70)
    for b in result["bars"]:
        t_range = f"{format_timestamp(b['start'])} - {format_timestamp(b['end'])}"
        ch_str = " | ".join(f"{c['chord']} ({c['beats']}拍)" for c in b["chords"])
        cad_badge = f"[{b['cadence']}]" if b.get("cadence") else ""
        print(f"#{b['bar_number']:<4} {t_range:<18} {cad_badge:<10} {ch_str}")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    main()
