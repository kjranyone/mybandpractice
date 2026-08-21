"""Shared helpers for the bin/ audio pipeline scripts."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"

# ffmpeg/ffprobe emit localized text on Windows; force UTF-8 so captured
# stderr decodes reliably regardless of the console codepage.
UTF8_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

# Loudness normalization defaults shared by every ingest/normalize path so
# all sources (YouTube rips, CD imports, ...) land at the same loudness.
DEFAULT_TARGET_I = -14.0  # LUFS — matches YouTube playback loudness
DEFAULT_TARGET_TP = -1.5  # dBFS true peak
DEFAULT_TARGET_LRA = 11.0  # loudness range

# Stem source preference: lossless first, then lossy (ogg = opus in .ogg).
STEM_SOURCE_EXTS = (".flac", ".wav", ".ogg", ".opus", ".mp3")
MAIN_SOURCE_EXTS = (".flac", ".wav", ".mp3", ".m4a", ".ogg", ".opus")


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def ffmpeg(*args: str, stdin_data: bytes | None = None) -> None:
    """Run ffmpeg with UTF-8 stdio; raise with stderr on failure."""
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-y", *args],
        input=stdin_data,
        capture_output=True,
        env=UTF8_ENV,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            "ffmpeg failed: " + res.stderr.decode("utf-8", "replace").strip()
        )


def ffmpeg_read(*args: str) -> bytes:
    """Run ffmpeg capturing stdout (pipe output)."""
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", *args],
        capture_output=True,
        env=UTF8_ENV,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            "ffmpeg failed: " + res.stderr.decode("utf-8", "replace").strip()
        )
    return res.stdout


def ffprobe_json(path: Path) -> dict:
    """Return parsed ffprobe stream/format info for a media file."""
    res = subprocess.run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-show_format", str(path),
        ],
        capture_output=True,
        env=UTF8_ENV,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed for {path}: "
            + res.stderr.decode("utf-8", "replace").strip()
        )
    return json.loads(res.stdout.decode("utf-8", "replace"))


def audio_stream(path: Path) -> dict:
    info = ffprobe_json(path)
    stream = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "audio"),
        None,
    )
    if stream is None:
        raise RuntimeError(f"no audio stream in {path}")
    return stream


def iter_song_dirs() -> list[Path]:
    if not SONGS_DIR.is_dir():
        die(f"songs dir not found: {SONGS_DIR}")
    return sorted(d for d in SONGS_DIR.iterdir() if d.is_dir())


def load_meta(song_dir: Path) -> dict:
    meta_path = song_dir / "meta.json"
    if not meta_path.exists():
        return {}
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"warn: malformed meta.json in {song_dir.name}", file=sys.stderr)
        return {}


def save_meta(song_dir: Path, meta: dict) -> None:
    (song_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def find_main_audio(song_dir: Path) -> Path | None:
    """Locate the song's main audio file (prefers <slug>.<ext> exact matches)."""
    for ext in MAIN_SOURCE_EXTS:
        exact = song_dir / f"{song_dir.name}{ext}"
        if exact.exists():
            return exact
    for p in sorted(song_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in MAIN_SOURCE_EXTS:
            return p
    return None


def find_stem_sources(stems_dir: Path) -> dict[str, Path]:
    """Map stem name -> source file, preferring lossless formats.

    Skips the chunks/ directory and mixdown artifacts.
    """
    if not stems_dir.is_dir():
        return {}
    by_stem: dict[str, Path] = {}
    for p in sorted(stems_dir.iterdir()):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext not in STEM_SOURCE_EXTS:
            continue
        if p.stem.lower() in ("mix", "mixdown", "original"):
            continue
        rank = STEM_SOURCE_EXTS.index(ext)
        prev = by_stem.get(p.stem)
        if prev is None or rank < STEM_SOURCE_EXTS.index(prev.suffix.lower()):
            by_stem[p.stem] = p
    return by_stem


def file_fingerprint(path: Path) -> dict:
    """Cheap change detector for pipeline caches (name, size, mtime)."""
    st = path.stat()
    return {"file": path.name, "size": st.st_size, "mtime_ns": st.st_mtime_ns}


# --------------------------------------------------------------------------- #
# loudnorm two-pass helpers
# --------------------------------------------------------------------------- #
def loudnorm_measure_filter(
    target_i: float, target_tp: float, target_lra: float
) -> str:
    return f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json"


def loudnorm_apply_filter(
    measured: dict, target_i: float, target_tp: float, target_lra: float
) -> str:
    return (
        f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:"
        f"measured_I={measured['input_i']}:"
        f"measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:"
        f"linear=true"
    )


LOUDNORM_JSON_RE = re.compile(r"\{\s*\"input_i\".*?\}", re.DOTALL)


def parse_loudnorm_json(stderr: str) -> dict:
    m = LOUDNORM_JSON_RE.search(stderr)
    if not m:
        raise RuntimeError("loudnorm JSON not found in ffmpeg output:\n" + stderr)
    raw = json.loads(m.group(0))
    out = {k: float(v) for k, v in raw.items() if k != "normalization_type"}
    out["normalization_type"] = raw.get("normalization_type", "linear")
    return out


def measure_loudness(src: Path, target_i: float = DEFAULT_TARGET_I) -> dict:
    """First loudnorm pass over `src`; returns the parsed measurement dict."""
    res = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-y",
            "-i", str(src),
            "-af",
            loudnorm_measure_filter(target_i, DEFAULT_TARGET_TP, DEFAULT_TARGET_LRA),
            "-f", "null", "-",
        ],
        capture_output=True,
        env=UTF8_ENV,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"loudnorm measure failed for {src}:\n"
            + res.stderr.decode("utf-8", "replace").strip()
        )
    return parse_loudnorm_json(res.stderr.decode("utf-8", "replace"))
