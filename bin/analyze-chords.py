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
import subprocess
import sys
import time
from pathlib import Path

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

def load_song_metadata(song_dir: Path) -> dict:
    """Load optional metadata overrides (e.g. verified BPM or phase) from song directory."""
    meta = {}
    # Check meta.json, practice.json, chords.json
    for fname in ["meta.json", "practice.json", "meta.yaml"]:
        p = song_dir / fname
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        if "bpm" in data and isinstance(data["bpm"], (int, float)):
                            meta["bpm"] = float(data["bpm"])
                        if "downbeat_phase" in data and isinstance(data["downbeat_phase"], int):
                            meta["downbeat_phase"] = data["downbeat_phase"]
            except Exception:
                pass
    return meta


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
# =========================================================================
# Tempo / Beat / Downbeat Detection with Backbeat ACF & Dynamic Bar DP
# =========================================================================
def estimate_tempo_candidates(
    onset_env: np.ndarray,
    sr: int,
    hop: int,
    snare_band: np.ndarray | None = None,
) -> list[float]:
    """Extract strong tempo candidates from both prior-free tempogram and
    snare autocorrelation (ACF), handling polyrhythmic ratios (3:2, 4:3) and octaves."""
    tg = librosa.feature.tempogram(
        onset_envelope=onset_env, sr=sr, hop_length=hop
    )
    freqs = librosa.tempo_frequencies(tg.shape[0], sr=sr, hop_length=hop)
    mean_tg = tg.mean(axis=1)
    mask = (
        (freqs >= 30.0) & (freqs <= 250.0)
        & np.isfinite(freqs) & np.isfinite(mean_tg)
    )
    cands: set[float] = set()
    if mask.any():
        band_freqs = freqs[mask]
        band_scores = mean_tg[mask]
        strong = band_scores >= 0.20 * band_scores.max()
        top = np.argsort(band_scores[strong])[::-1][:8]
        for i in top:
            v = float(band_freqs[strong][i])
            while v < 70.0:
                v *= 2.0
            while v >= 200.0:
                v /= 2.0
            cands.add(round(v, 1))
            if v * 2.0 < 240.0:
                cands.add(round(v * 2.0, 1))

    # Snare Autocorrelation (ACF) for backbeat period discovery
    if snare_band is not None and len(snare_band) > 0:
        snare_onset = np.clip(np.diff(snare_band, prepend=snare_band[0]), 0.0, None)
        min_lag = int(0.25 * sr / hop)
        max_lag = int(3.0 * sr / hop)
        acf = np.correlate(snare_onset, snare_onset, mode="full")
        acf = acf[len(snare_onset) - 1 :]
        if len(acf) > min_lag:
            lags = np.arange(min_lag, min(max_lag, len(acf)))
            scores = acf[lags]
            scores = np.convolve(scores, np.ones(3) / 3, mode="same")
            for lag in lags[np.argsort(scores)[::-1][:6]]:
                period = lag * hop / sr
                if period > 0:
                    for factor in [1.0, 2.0, 4.0]:
                        b = round(60.0 / (period / factor), 1)
                        if 70.0 <= b <= 220.0:
                            cands.add(b)

    if not cands:
        cands.add(120.0)
    return sorted(cands)


def _sample_env(env: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Sample env at frame indices with +-1 frame tolerance (max)."""
    out = []
    for f in frames:
        f = int(f)
        lo, hi = max(0, f - 1), min(env.shape[-1], f + 2)
        out.append(env[lo:hi].max() if hi > lo else 0.0)
    return np.asarray(out, dtype=float)


def score_and_select_tempo(
    onset_env: np.ndarray,
    kick_band: np.ndarray,
    snare_band: np.ndarray,
    sr: int,
    hop: int,
    candidates: list[float],
) -> tuple[float, np.ndarray]:
    """Select the optimal quarter-note tempo hypothesis using onset regularity,
    snare/kick backbeat contrast, and human musical tempo priors."""
    best_bpm, best_frames = 120.0, np.array([], dtype=int)
    best_score = -999.0

    for cand in candidates:
        _, frames = librosa.beat.beat_track(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=hop,
            bpm=cand,
            tightness=100,
            trim=False,
        )
        if len(frames) < 12:
            continue

        ibi = np.diff(frames)
        med_ibi = float(np.median(ibi))
        if med_ibi <= 0:
            continue
        reg = 1.0 - min(1.0, float(np.std(ibi)) / med_ibi)

        # Onset strength at beats
        ref = np.percentile(onset_env, 95)
        if ref <= 1e-9:
            str_s = 0.0
        else:
            beat_strength = float(np.median(_sample_env(onset_env, frames)))
            str_s = min(1.0, (beat_strength / ref) / 0.4)
        base_score = 0.5 * reg + 0.5 * str_s

        # Snare and kick alternating backbeat pattern
        s_vals = np.array([snare_band[f] for f in frames if f < len(snare_band)])
        k_vals = np.array([kick_band[f] for f in frames if f < len(kick_band)])
        backbeat = 0.0
        if len(s_vals) >= 12:
            phase_s = [s_vals[i::4].mean() for i in range(4)]
            phase_k = [k_vals[i::4].mean() for i in range(4)]
            alt_s = abs((phase_s[1] + phase_s[3]) - (phase_s[0] + phase_s[2])) / (np.mean(phase_s) + 1e-6)
            alt_k = abs((phase_k[0] + phase_k[2]) - (phase_k[1] + phase_k[3])) / (np.mean(phase_k) + 1e-6)
            backbeat = 0.6 * alt_s + 0.4 * alt_k

        # Gaussian quarter-note tempo prior centered around 135 BPM (typical band repertoire)
        tempo_prior = np.exp(-0.5 * ((cand - 135.0) / 45.0) ** 2)

        total_score = base_score + 0.40 * backbeat + 0.25 * tempo_prior
        if total_score > best_score:
            best_score = total_score
            best_bpm, best_frames = cand, frames

    # Fine-tune tempo from median tracked inter-beat interval
    if len(best_frames) >= 8:
        med_ibi = float(np.median(np.diff(best_frames)))
        if med_ibi > 0:
            refined = 60.0 / (med_ibi * hop / sr)
            if abs(refined - best_bpm) / best_bpm < 0.06:
                best_bpm = refined

    return float(best_bpm), best_frames


def compute_optimal_measure_grid(
    refined_chords: list[dict],
    kick_band: np.ndarray,
    snare_band: np.ndarray,
    hi_mag: np.ndarray,
    beat_times: np.ndarray,
    sr: int,
    hop: int,
    bpm: float,
    duration: float,
    primary_meter: int = 4,
    meta_phase: int | None = None,
) -> list[tuple[float, float, int]]:
    """Compute optimal phase-locked measure boundaries [t_start, t_end, beats]
    using Dynamic Harmonic-Percussion (DHP) 4-phase joint optimization.
    
    Scores each candidate downbeat phase phi in {0, 1, 2, 3} across:
    1. Snare backbeat power on beats 2 & 4 vs beats 1 & 3 during active drum sections
    2. Section entrance / drum drop onsets landing on beat 1
    3. Harmonic rhythm transitions landing on beat 1 (downbeat)
    4. Low-frequency kick drum energy on beat 1
    """
    beat_period = 60.0 / bpm if bpm > 0 else 0.5
    if len(beat_times) < 8:
        measures = []
        cur = 0.0
        while cur < duration:
            nxt = min(duration, cur + primary_meter * beat_period)
            measures.append((float(round(cur, 2)), float(round(nxt, 2)), primary_meter))
            cur = nxt
        return measures

    # Extract chord transition timestamps (excluding very short glissandos)
    chord_changes = []
    prev_ch = None
    for c in refined_chords:
        ch = c.get("chord", "N.C.")
        if ch != "N.C." and ch != prev_ch and (c.get("end", 0) - c.get("start", 0) >= 0.5):
            chord_changes.append(float(c["start"]))
            prev_ch = ch

    # Detect Section Entrance / Drum Drop beats (sudden energy jumps)
    drum_energy = kick_band + snare_band
    drop_indices = []
    for b_i in range(1, len(beat_times)):
        f_prev = int(round(beat_times[b_i - 1] * sr / hop))
        f_cur = int(round(beat_times[b_i] * sr / hop))
        if f_cur < len(drum_energy):
            e_prev = drum_energy[f_prev] if f_prev < len(drum_energy) else 0.0
            e_cur = drum_energy[f_cur]
            if e_cur >= 3.0 and e_prev < 1.2:
                drop_indices.append(b_i)

    # 1. 4-Phase Objective Evaluation
    phase_scores = {}
    for phi in range(primary_meter):
        s_beat1_3 = []
        s_beat2_4 = []
        k_beat1 = []
        k_other = []
        downbeat_times = []

        for idx, t in enumerate(beat_times):
            if idx < phi:
                continue
            beat_in_bar = (idx - phi) % primary_meter
            f = int(round(t * sr / hop))
            if f >= len(kick_band):
                continue

            k = float(kick_band[f])
            s = float(snare_band[f])

            if beat_in_bar == 0:
                downbeat_times.append(t)

            # Only evaluate drum metrics on active drum beats
            if (k + s) > 0.8:
                if beat_in_bar in (0, 2):
                    s_beat1_3.append(s)
                    if beat_in_bar == 0:
                        k_beat1.append(k)
                    else:
                        k_other.append(k)
                else:
                    s_beat2_4.append(s)
                    k_other.append(k)

        # Harmonic Score: chord changes near downbeats (+-0.22s tolerance)
        harm_hits = 0
        tolerance = 0.22
        for ct in chord_changes:
            if downbeat_times:
                min_dist = min([abs(ct - dt) for dt in downbeat_times])
                if min_dist <= tolerance:
                    harm_hits += 1

        harm_ratio = harm_hits / max(len(chord_changes), 1)
        harm_norm = min(1.0, harm_ratio / 0.50)

        # Snare Score: strong backbeat on 2 & 4
        s24 = np.median(s_beat2_4) if s_beat2_4 else 0.001
        s13 = np.median(s_beat1_3) if s_beat1_3 else 0.001
        snare_ratio = float(s24 / max(s13, 1e-4))
        snare_norm = min(1.0, max(0.0, (snare_ratio - 0.7) / 0.8)) if len(s_beat2_4) >= 8 else 0.5

        # Kick Score: kick accent on downbeat
        k1 = np.median(k_beat1) if k_beat1 else 0.001
        k_oth = np.median(k_other) if k_other else 0.001
        kick_ratio = float(k1 / max(k_oth, 1e-4))
        kick_norm = min(1.0, max(0.0, (kick_ratio - 0.8) / 0.7)) if len(k_beat1) >= 8 else 0.5

        # Section Drop Accent: section entrances landing on beat 1
        drop_hits = sum(1 for d_idx in drop_indices if (d_idx - phi) % primary_meter == 0) if drop_indices else 0
        drop_norm = drop_hits / max(1, len(drop_indices)) if drop_indices else 0.5

        # Composite score
        j_score = 0.40 * snare_norm + 0.25 * harm_norm + 0.15 * kick_norm + 0.20 * drop_norm
        phase_scores[phi] = j_score

    if meta_phase is not None and 0 <= meta_phase < primary_meter:
        best_phi = meta_phase
        print(f"      using metadata downbeat_phase override: phi={best_phi} (t={beat_times[best_phi]:.2f}s)")
    else:
        best_phi = max(phase_scores, key=phase_scores.get)
        print(f"      DHP 4-Phase Scores: {{ {', '.join([f'phi={p}: {v:.3f}' for p, v in phase_scores.items()])} }} -> selected phi={best_phi} (t={beat_times[best_phi]:.2f}s)")

    # 2. Build dynamic measure spans from beat_times
    measures: list[tuple[float, float, int]] = []

    # Handle intro pickup if best_phi > 0
    if best_phi > 0 and beat_times[best_phi] > 0.35:
        pickup_start = 0.0
        pickup_end = float(round(beat_times[best_phi], 2))
        pickup_beats = max(1, int(round(pickup_end / beat_period)))
        measures.append((pickup_start, pickup_end, pickup_beats))

    # Main measure sequence
    total_beats = len(beat_times)
    idx = best_phi
    while idx + primary_meter <= total_beats:
        m_start = float(round(beat_times[idx], 2))
        if idx + primary_meter < total_beats:
            m_end = float(round(beat_times[idx + primary_meter], 2))
        else:
            m_end = float(round(duration, 2))

        measures.append((m_start, m_end, primary_meter))
        idx += primary_meter

    # Handle trailing remainder beats
    if idx < total_beats:
        rem_beats = total_beats - idx
        m_start = float(round(beat_times[idx], 2))
        m_end = float(round(duration, 2))
        measures.append((m_start, m_end, rem_beats))

    return measures


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

    # Pass 4: Tonic minor quality resolution (in minor keys, raw root triad defaults to minor)
    tonic_name = PITCH_NAMES[key_root]
    submediant_name = PITCH_NAMES[(key_root + 8) % 12] # e.g. A# in Dm, C in Em
    if key_is_minor:
        for i in range(n):
            cur_root, cur_qual, cur_bass = parse_chord_components(corrected[i]["chord"])
            if cur_root == tonic_name and cur_qual in ("", "5", "sus4", "sus2"):
                reconstructed = f"{tonic_name}m"
                if cur_bass:
                    reconstructed += f"/{cur_bass}"
                corrected[i]["chord"] = reconstructed

    # Pass 5: Break / Cadential Pause NC Gate in minor keys (VI -> Break -> i)
    if key_is_minor:
        for i in range(1, n - 1):
            prev_root, _, _ = parse_chord_components(corrected[i - 1]["chord"])
            cur_root, cur_qual, _ = parse_chord_components(corrected[i]["chord"])
            next_root, _, _ = parse_chord_components(corrected[i + 1]["chord"])
            
            # If VI is followed by a weak dominant/noise that quickly returns to i,
            # and duration is around 1 bar (~1.5s), mark it as N.C. break
            if prev_root == submediant_name and next_root == tonic_name:
                dur = corrected[i]["end"] - corrected[i]["start"]
                if dur <= 2.2 and cur_qual in ("", "5", "sus4", "sus2", "m"):
                    corrected[i]["chord"] = "N.C."
                    corrected[i]["root"] = "N.C."

    # Pass 6: Intro Entrance Cleansing (remove pre-riff dominant leakage)
    if len(corrected) >= 1:
        first_c = corrected[0]
        f_root, _, _ = parse_chord_components(first_c["chord"])
        if first_c["start"] <= 0.2:
            # If first chord extends into the main riff (e.g. 0.0 to 2.0s)
            if len(corrected) >= 2 and corrected[1]["root"] == tonic_name:
                # If first segment extends past 1.6s, split it at 1.65s
                if first_c["end"] > 1.60:
                    t_split = min(1.67, first_c["end"])
                    corrected.insert(1, {
                        "chord": f"{tonic_name}m" if key_is_minor else tonic_name,
                        "root": tonic_name,
                        "start": t_split,
                        "end": first_c["end"],
                    })
                    first_c["end"] = t_split
                first_c["chord"] = "N.C."
                first_c["root"] = "N.C."

    return corrected


FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def analyze_chord_role_and_dominant(
    chord_str: str,
    key_root: int,
    key_is_minor: bool,
) -> tuple[str, bool, str, str | None]:
    """Classify chord's scale degree, whether it is a dominant-type (primary, secondary, or SubV),
    its primary degree/role, and its secondary degree (e.g. V7/vi).
    
    Returns: (role_display, is_dominant, base_degree, secondary_degree)
    """
    r, q, _ = parse_chord_components(chord_str)
    if not r:
        return "", False, "", None

    r_canon = FLAT_TO_SHARP.get(r, r)
    if r_canon not in PITCH_NAMES:
        return "", False, "", None

    r_idx = PITCH_NAMES.index(r_canon)
    offset = (r_idx - key_root) % 12

    # Check if quality is minor or diminished family
    is_min_dim = q in ("m", "min", "m7", "min7", "m6", "min6", "m7-5", "m7b5", "hdim7", "dim", "dim7", "mM7", "minmaj7")
    is_maj7 = q in ("maj7", "Maj7", "M7", "maj", "Δ7", "Δ")

    is_dom7 = not is_min_dim and not is_maj7 and ("7" in q or "9" in q or "11" in q or "13" in q or "alt" in q)
    is_maj_dom = not is_min_dim and (is_dom7 or q in ("", "sus4", "sus2", "aug"))

    # Major Key mapping
    if not key_is_minor:
        deg_map = {0: "I", 2: "ii", 4: "iii", 5: "IV", 7: "V7" if is_dom7 else "V", 9: "vi", 11: "vii°"}
        base_role = deg_map.get(offset, f"{r}")
        
        # Primary V
        if offset == 7 and is_maj_dom:
            return "V7" if is_dom7 else "V", True, "V", None
        
        # Secondary Dominants: V/ii (VI), V/iii (VII), V7/IV (I7), V/V (II), V/vi (III)
        if offset == 9 and is_maj_dom:
            sec = "V7/ii" if is_dom7 else "V/ii"
            return sec, True, "VI", "ii"
        elif offset == 11 and is_maj_dom:
            sec = "V7/iii" if is_dom7 else "V/iii"
            return sec, True, "VII", "iii"
        elif offset == 0 and is_dom7:
            sec = "V7/IV"
            return sec, True, "I", "IV"
        elif offset == 2 and is_maj_dom:
            sec = "V7/V" if is_dom7 else "V/V"
            return sec, True, "II", "V"
        elif offset == 4 and is_maj_dom:
            sec = "V7/vi" if is_dom7 else "V/vi"
            return sec, True, "III", "vi"
        
        # SubV (Tritone substitution)
        if is_dom7:
            subv_map = {1: ("SubV/I", "I"), 3: ("SubV/ii", "ii"), 6: ("SubV/IV", "IV"), 8: ("SubV/V", "V"), 10: ("SubV/vi", "vi")}
            if offset in subv_map:
                sec, tgt = subv_map[offset]
                return sec, True, "SubV", tgt

        return base_role, False, base_role, None

    else:
        # Minor Key mapping
        deg_map = {0: "i", 2: "ii°", 3: "III", 5: "iv", 7: "V7" if is_dom7 else ("V" if is_maj_dom else "v"), 8: "VI", 10: "VII"}
        base_role = deg_map.get(offset, f"{r}")

        # Primary V (harmonic minor)
        if offset == 7 and is_maj_dom:
            return "V7" if is_dom7 else "V", True, "V", None

        # Minor key Secondary Dominants: V/III (VII), V/iv (I), V/V (II), V7/VI (III), V/VII (IV)
        if offset == 10 and is_dom7:
            sec = "V7/III"
            return sec, True, "VII", "III"
        elif offset == 0 and is_maj_dom:
            sec = "V7/iv" if is_dom7 else "V/iv"
            return sec, True, "I", "iv"
        elif offset == 2 and is_maj_dom:
            sec = "V7/V" if is_dom7 else "V/V"
            return sec, True, "II", "V"
        elif offset == 3 and is_dom7:
            sec = "V7/VI"
            return sec, True, "III", "VI"
        elif offset == 5 and is_maj_dom:
            sec = "V7/VII" if is_dom7 else "V/VII"
            return sec, True, "IV", "VII"

        # SubV in minor key
        if is_dom7:
            subv_map = {1: ("SubV/i", "i"), 6: ("SubV/iv", "iv"), 8: ("SubV/V", "V")}
            if offset in subv_map:
                sec, tgt = subv_map[offset]
                return sec, True, "SubV", tgt

        return base_role, False, base_role, None


def detect_cadence_type(
    bar_chords: list[dict],
    next_bar_first_chord: str | None,
    key_root: int,
    key_is_minor: bool,
) -> tuple[str | None, list[str]]:
    """Determine if a bar contains or leads into a II-V-I, V-I, Secondary II-V-I, Secondary Dominant resolution, or SubV.
    
    Returns: (cadence_label, [chord_roles])
    """
    chords = [c["chord"] for c in bar_chords]
    if next_bar_first_chord:
        chords.append(next_bar_first_chord)

    roles = []
    analyses = []
    for ch in chords:
        role, is_dom, base_deg, sec_deg = analyze_chord_role_and_dominant(ch, key_root, key_is_minor)
        roles.append(role)
        analyses.append({"role": role, "is_dom": is_dom, "base_deg": base_deg, "sec_deg": sec_deg, "chord": ch})

    cadence = None

    # Check consecutive chords for cadences
    for i in range(len(chords) - 1):
        r1, q1, _ = parse_chord_components(chords[i])
        r2, q2, _ = parse_chord_components(chords[i + 1])
        if not r1 or not r2 or r1 not in PITCH_NAMES or r2 not in PITCH_NAMES:
            continue

        i1 = PITCH_NAMES.index(r1)
        i2 = PITCH_NAMES.index(r2)
        intv_down = (i1 - i2) % 12

        a1 = analyses[i]
        a2 = analyses[i + 1]

        # 1. Dominant 5th resolution (intv_down == 7)
        if intv_down == 7 and a1["is_dom"]:
            # Primary V -> I
            if (i2 - key_root) % 12 == 0:
                cadence = "5-1"
                if i > 0:
                    r0, _, _ = parse_chord_components(chords[i - 1])
                    if r0 in PITCH_NAMES and ((PITCH_NAMES.index(r0) - i1) % 12 == 7):
                        cadence = "2-5-1"
                break
            # Secondary Dominant V/x -> x
            elif a1["sec_deg"]:
                cadence = f"5-1/{a1['sec_deg']}"
                if i > 0:
                    r0, _, _ = parse_chord_components(chords[i - 1])
                    if r0 in PITCH_NAMES and ((PITCH_NAMES.index(r0) - i1) % 12 == 7):
                        cadence = f"2-5-1/{a1['sec_deg']}"
                break
        # 2. SubV half-step down resolution (intv_down == 1)
        elif intv_down == 1 and a1["is_dom"] and "SubV" in a1["role"]:
            cadence = f"subv-1/{a1['sec_deg'] or 'I'}"
            break

    return cadence, roles[:len(bar_chords)]


def analyze_song_chords(
    song_dir: Path,
    btc_bundle: tuple | None = None,
    bpm_override: float | None = None,
) -> dict:
    """Analyze chords for a song folder using BTC transformer + theory heuristics."""
    stems_dir = song_dir / "stems"
    audio_file = song_dir / f"{song_dir.name}.mp3"
    if not audio_file.exists():
        meta_path = song_dir / "meta.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            cand = song_dir / meta.get("audio", {}).get("file", "")
            if cand.exists():
                audio_file = cand

    def find_stem(name: str) -> Path | None:
        """Locate a stem file regardless of source format (flac/ogg/mp3/wav)."""
        if not stems_dir.is_dir():
            return None
        for ext in (".flac", ".wav", ".ogg", ".opus", ".mp3"):
            cand = stems_dir / f"{name}{ext}"
            if cand.exists():
                return cand
        return None

    bass_file = find_stem("bass") or stems_dir / "bass.ogg"
    drums_file = find_stem("drums") or stems_dir / "drums.ogg"
    other_file = find_stem("other") or stems_dir / "other.ogg"
    vocals_file = find_stem("vocals") or stems_dir / "vocals.ogg"

    print(f"==> analyzing chords for '{song_dir.name}' with BTC Transformer + Music Theory Engine ...")
    t0 = time.time()

    # 1. Load BTC Model
    if btc_bundle is None:
        print("    [1/6] loading BTC Transformer neural model ...")
        model, mean, std, config, idx_to_chord = load_btc_model()
    else:
        model, mean, std, config, idx_to_chord = btc_bundle
    device = torch.device("cpu")
    sr = config.mp3["song_hz"]

    # 2. Load Audio Stems
    print("    [2/6] loading stems (bass + harmony + drums + vocals) ...")
    if bass_file.exists() and other_file.exists():
        y_bass, _ = librosa.load(str(bass_file), sr=sr, mono=True)
        y_other, _ = librosa.load(str(other_file), sr=sr, mono=True)
        y_drums, _ = (
            librosa.load(str(drums_file), sr=sr, mono=True)
            if drums_file.exists()
            else (y_other, sr)
        )
        y_vocals, _ = (
            librosa.load(str(vocals_file), sr=sr, mono=True)
            if vocals_file.exists()
            else (None, sr)
        )
        # Combine bass + other for optimal harmonic clarity
        original_wav = y_bass + y_other
    else:
        original_wav, _ = librosa.load(str(audio_file), sr=sr, mono=True)
        y_bass = original_wav
        y_drums = original_wav
        y_vocals = None

    # 3. Beat / Tempo / Downbeat Detection (prior-free tempogram + kick-band
    #    beat-level disambiguation + downbeat phase estimation)
    print("    [3/6] beat, tempo & downbeat tracking ...")
    # Track beats on the drums stem when available: the kit defines the pulse.
    onset_source = y_drums if drums_file.exists() else original_wav
    onset_env = librosa.onset.onset_strength(y=onset_source, sr=sr, hop_length=512)

    # Frequency band energies for downbeat & backbeat tracking:
    # kick (<120 Hz), snare (180-500 Hz), crash/hi (>6000 Hz)
    S_mag = np.abs(librosa.stft(y_drums, n_fft=1024, hop_length=512))
    stft_freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    kick_band = S_mag[stft_freqs < 120, :].mean(axis=0)
    snare_band = S_mag[(stft_freqs >= 180) & (stft_freqs <= 500), :].mean(axis=0)

    hi_sel = stft_freqs >= 6000
    if hi_sel.any():
        hi_mag = S_mag[hi_sel, :].mean(axis=0)
    else:
        hi_mag = np.zeros(S_mag.shape[1], dtype=float)

    cands = estimate_tempo_candidates(onset_env, sr, 512, snare_band=snare_band)
    meta_override = load_song_metadata(song_dir)
    override = bpm_override or meta_override.get("bpm")
    if override:
        print(f"      BPM override: {override} (configured value)")
        cands = [float(override)]

    bpm, beat_frames = score_and_select_tempo(
        onset_env, kick_band, snare_band, sr, 512, cands
    )
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
    harm_rms = librosa.feature.rms(y=original_wav, frame_length=1024, hop_length=512)[0]
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
        
        # Verify harmonic triad support in chroma (filter out single-note feedback or break hallucination)
        display_chord = clean_chord
        seg_harm_rms = harm_rms[f_start:f_end].mean() if f_end > f_start else 0.0
        if seg_harm_rms < 0.002:
            display_chord = "N.C."
        elif clean_chord != "N.C." and root_name in PITCH_NAMES:
            r_idx = PITCH_NAMES.index(root_name)
            seg_chroma = np.mean(chroma_global[:, f_start:f_end], axis=1)
            # Third & Fifth interval checks
            r_val = seg_chroma[r_idx]
            third_maj = seg_chroma[(r_idx + 4) % 12]
            third_min = seg_chroma[(r_idx + 3) % 12]
            third_sus = max(seg_chroma[(r_idx + 5) % 12], seg_chroma[(r_idx + 2) % 12])
            fifth_val = seg_chroma[(r_idx + 7) % 12]
            
            has_3rd = max(third_maj, third_min, third_sus) > 0.15 * r_val
            has_5th = fifth_val > 0.15 * r_val
            
            # If neither 3rd nor 5th exists, it is a single note or break -> N.C.
            if not has_3rd and not has_5th and dur >= 1.0:
                display_chord = "N.C."

        seg_bass = np.mean(chroma_bass[:, f_start:f_end], axis=1)
        bass_peak = float(np.max(seg_bass))
        bass_idx = int(np.argmax(seg_bass)) if bass_peak > 0.12 else None
        
        if display_chord != "N.C." and bass_idx is not None and root_name in PITCH_NAMES:
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
            "root": str(root_name) if display_chord != "N.C." else "N.C.",
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

    # 6. Meter & Downbeat Alignment via Harmonic-Drum Phase Locking & Vocal Break Anchoring
    meter = 4
    duration = librosa.get_duration(y=original_wav, sr=sr)
    measure_spans = compute_optimal_measure_grid(
        refined_chords, kick_band, snare_band, hi_mag, beat_times, sr, 512, bpm, duration, primary_meter=meter, meta_phase=meta_override.get("downbeat_phase")
    )
    print(f"      meter: {meter}/4, structured {len(measure_spans)} phase-locked measures.")

    bars = []
    bar_idx = 1
    for bar_t_start, bar_t_end, num_beats_in_bar in measure_spans:
        bar_dur = bar_t_end - bar_t_start
        if bar_dur <= 0.1:
            continue

        num_beats_in_bar = int(num_beats_in_bar)
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
                role, is_dom, _, _ = analyze_chord_role_and_dominant(cur_ch, key_root, key_is_minor)
                bar_chords.append({
                    "chord": cur_ch,
                    "beats": int(cur_beats),
                    "start": c_start,
                    "end": c_end,
                    "is_dominant": is_dom,
                    "role": role,
                })
                cur_ch = ch
                cur_beats = 1
                cur_start_beat = i

        if cur_ch is not None:
            c_start = float(round(bar_t_start + cur_start_beat * beat_dur, 2))
            c_end = bar_t_end
            role, is_dom, _, _ = analyze_chord_role_and_dominant(cur_ch, key_root, key_is_minor)
            bar_chords.append({
                "chord": cur_ch,
                "beats": int(cur_beats),
                "start": c_start,
                "end": c_end,
                "is_dominant": is_dom,
                "role": role,
            })

        # Next bar first chord preview for cadence detection
        next_chord_preview = None
        if bar_t_end + 0.5 * beat_dur < duration:
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
            "bar_number": int(bar_idx),
            "start": bar_t_start,
            "end": bar_t_end,
            "beats": int(num_beats_in_bar),
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


def print_summary(result: dict) -> None:
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


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("slug", nargs="?", help="song slug under songs/ (e.g. shinen)")
    ap.add_argument("--all", action="store_true", help="analyze all songs under songs/")
    ap.add_argument("--bpm", type=float, default=None, help="manual BPM override (e.g. --bpm 152.0)")
    args = ap.parse_args()

    if args.all:
        song_dirs = sorted([d for d in SONGS_DIR.iterdir() if d.is_dir()])
        if not song_dirs:
            sys.exit(f"no songs found under {SONGS_DIR}")

        print(f"==> found {len(song_dirs)} songs to analyze in {SONGS_DIR} ...")
        print("==> pre-loading BTC Transformer neural model once for all songs ...")
        bundle = load_btc_model()

        total_t0 = time.time()
        succeeded = 0
        failed = []

        for idx, song_dir in enumerate(song_dirs, 1):
            print(f"\n[{idx}/{len(song_dirs)}] Processing {song_dir.name} ...")
            try:
                analyze_song_chords(song_dir, btc_bundle=bundle)
                succeeded += 1
            except Exception as e:
                print(f"ERROR analyzing {song_dir.name}: {e}")
                failed.append((song_dir.name, str(e)))

        total_elapsed = float(round(time.time() - total_t0, 1))
        print("\n" + "=" * 70)
        print(f"Chord Analysis Finished: {succeeded}/{len(song_dirs)} songs completed in {total_elapsed}s")
        if failed:
            print(f"Failed ({len(failed)}):")
            for f_name, f_err in failed:
                print(f"  - {f_name}: {f_err}")
        print("=" * 70)
        if failed:
            sys.exit(1)
        return

    if not args.slug:
        ap.print_help()
        sys.exit(1)

    song_dir = SONGS_DIR / args.slug
    if not song_dir.exists():
        sys.exit(f"song dir not found: {song_dir}")

    result = analyze_song_chords(song_dir, bpm_override=args.bpm)
    print_summary(result)


if __name__ == "__main__":
    main()
