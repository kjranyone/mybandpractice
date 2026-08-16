#!/usr/bin/env python3
"""YouTube URL -> normalized mp3 pipeline for band practice song management.

Pipeline stages
---------------
1. yt-dlp fetches metadata + best-audio stream to a temp file.
2. ffmpeg pass 1: silenceremove (head/tail) + loudnorm measurement (JSON).
3. ffmpeg pass 2: silenceremove + loudnorm linear apply -> libmp3lame mp3
   with embedded ID3 tags.
4. meta.json is written next to audio.mp3 inside songs/<slug>/.

Usage
-----
    python bin/yt-to-mp3.py <youtube-url>
    python bin/yt-to-mp3.py            # prompts for URL
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"

# Force UTF-8 for child processes so yt-dlp / ffmpeg never emit cp932-mangled
# Japanese on Windows (PYTHONUTF8 covers yt-dlp's Python stdout).
UTF8_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

DEFAULT_TARGET_I = -16.0  # LUFS, EBU R128 streaming target
DEFAULT_TARGET_TP = -1.5  # dBFS true peak
DEFAULT_TARGET_LRA = 11.0  # loudness range
DEFAULT_SILENCE_DB = -50.0  # peak threshold for head/tail silence
DEFAULT_KEEP_SILENCE = 0.05  # seconds retained to avoid clicks
DEFAULT_BITRATE = "192k"
DEFAULT_SAMPLE_RATE = 44100


# --------------------------------------------------------------------------- #
# subprocess helpers
# --------------------------------------------------------------------------- #
def run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a command, capture output as UTF-8. Raises CalledProcessError."""
    # text=True alone uses locale (cp932 on JP Windows) which corrupts non-ASCII.
    return subprocess.run(
        cmd,
        capture_output=True,
        check=True,
        encoding="utf-8",
        errors="replace",
        env=UTF8_ENV,
    )


def run_live(cmd: list[str]) -> int:
    """Run a command streaming stdout/stderr to the terminal (for progress)."""
    return subprocess.run(cmd, env=UTF8_ENV).returncode


# --------------------------------------------------------------------------- #
# title cleaning + romanization -> ASCII slug
# --------------------------------------------------------------------------- #
_NOISE_KEYWORDS = (
    "official",
    "music video",
    "music clip",
    "mv",
    "pv",
    "promo",
    "opテーマ",
    "edテーマ",
    "アニメ",
    "anime",
    "theme",
    "lyric video",
    "audio",
    "visualizer",
    "short ver",
)
_KEEP_KEYWORDS = (
    "ver.",
    "version",
    "remix",
    "edit",
    "size",
    "short",
    "full",
    "live",
    "acoustic",
    "cover",
)
_NOISE_WORDS = re.compile(
    r"\b(?:official\s+music\s+video|music\s+video|official\s+video|"
    r"music\s+clip|official|mv|pv)\b",
    re.IGNORECASE,
)
_kks = None


def _get_kks():
    global _kks
    if _kks is None:
        import pykakasi

        _kks = pykakasi.kakasi()
    return _kks


def _is_noise_group(s: str) -> bool:
    sl = s.lower()
    if any(k in sl for k in _KEEP_KEYWORDS):
        return False
    return any(k in sl for k in _NOISE_KEYWORDS)


def _strip_noise_groups(t: str) -> str:
    for pat in (r"\([^()]*\)", r"\[[^\[\]]*\]"):
        prev = None
        while prev != t:
            prev = t
            m = re.search(pat, t)
            if m and _is_noise_group(m.group(0)):
                t = t[: m.start()] + " " + t[m.end() :]
    return t


def clean_title(raw: str) -> str:
    """Strip YouTube cruft (Official Music Video, anime OP info, artist prefix)
    from a raw video title, returning just the song name."""
    t = raw.strip()
    t = _strip_noise_groups(t)
    m = re.search(r"[「『](.+?)[」』]", t)
    if m:
        t = m.group(1)
    elif "\u3000" in t:  # full-width space: drop leading artist, keep last seg
        segs = [s.strip() for s in t.split("\u3000") if s.strip()]
        segs = [s for s in segs if not _NOISE_WORDS.fullmatch(s)]
        if segs:
            t = segs[-1]
    else:
        parts = re.split(r"\s+[-–—]\s+|\s*[:：]\s*", t)
        if len(parts) > 1:
            t = parts[-1].strip()
    t = _NOISE_WORDS.sub("", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" -–")
    return t or raw


def romanize(s: str) -> str:
    try:
        out = []
        for item in _get_kks().convert(s):
            if item["hepburn"]:
                out.append(item["hepburn"])
        return " ".join(out)
    except Exception:
        return s


def to_slug(s: str) -> str:
    r = romanize(s)
    r = re.sub(r"[^a-zA-Z0-9\s-]", "", r)
    r = re.sub(r"[\s]+", "-", r)
    r = re.sub(r"-+", "-", r)
    return r.strip("-").lower() or "untitled"


def make_slug(raw_title: str) -> str:
    """Full pipeline: raw YouTube title -> clean ASCII slug."""
    return to_slug(clean_title(raw_title))


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hms(seconds: float) -> str:
    s = round(seconds)
    return f"{s // 60:>02d}:{s % 60:02d}"


# --------------------------------------------------------------------------- #
# yt-dlp
# --------------------------------------------------------------------------- #
def fetch_meta(url: str) -> dict:
    """Return yt-dlp --dump-json metadata dict (no download)."""
    res = run(["yt-dlp", "--dump-json", "--no-playlist", "--no-warnings", url])
    return json.loads(res.stdout)


def download_audio(url: str, dest_dir: Path) -> Path:
    """Download bestaudio into dest_dir; return the resulting file path."""
    out_tmpl = str(dest_dir / "source.%(ext)s")
    # -q keeps stderr quiet, but progress is on stdout; --newline keeps it tidy
    rc = run_live(
        [
            "yt-dlp",
            "-f",
            "bestaudio",
            "--no-playlist",
            "--no-warnings",
            "-q",
            "--no-progress",
            "-o",
            out_tmpl,
            url,
        ]
    )
    if rc != 0:
        raise RuntimeError("yt-dlp download failed")
    files = list(dest_dir.glob("source.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no file")
    return files[0]


# --------------------------------------------------------------------------- #
# ffprobe
# --------------------------------------------------------------------------- #
def probe_duration(path: Path) -> float:
    res = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    return float(res.stdout.strip())


# --------------------------------------------------------------------------- #
# ffmpeg filters
# --------------------------------------------------------------------------- #
def silence_filter(threshold_db: float, keep_silence_sec: float) -> str:
    """Head + tail silence removal via the reverse trick."""
    seg = (
        f"silenceremove=start_periods=1:"
        f"start_silence={keep_silence_sec}:"
        f"start_threshold={threshold_db}dB:detection=peak"
    )
    return f"{seg},areverse,{seg},areverse"


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


# --------------------------------------------------------------------------- #
# interactive prompts
# --------------------------------------------------------------------------- #
def prompt_url() -> str:
    url = input("YouTube URL: ").strip()
    if not url:
        sys.exit("Aborted: no URL given.")
    return url


def prompt_slug(title: str, suggested: str) -> str:
    print(f"\n  title     : {title}")
    print(f"  suggested : {suggested}")
    while True:
        ans = input("  use this dir name? [Enter=yes / type new / q=quit] ").strip()
        if ans.lower() in ("q", "quit", "exit"):
            sys.exit("Aborted by user.")
        return make_slug(ans) if ans else suggested


def ensure_empty_song_dir(song_dir: Path, slug: str) -> None:
    if not song_dir.exists():
        song_dir.mkdir(parents=True)
        return
    if not any(song_dir.iterdir()):
        return
    ans = input(f"  '{slug}/' already has content. Overwrite? [y/N] ").strip().lower()
    if ans not in ("y", "yes"):
        sys.exit("Aborted to avoid overwriting existing song dir.")
    shutil.rmtree(song_dir)
    song_dir.mkdir(parents=True)


def ensure_empty_song_dir_auto(song_dir: Path, slug: str) -> None:
    """Non-interactive variant: silently recreate the directory."""
    if song_dir.exists() and any(song_dir.iterdir()):
        shutil.rmtree(song_dir)
    song_dir.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- #
# main pipeline
# --------------------------------------------------------------------------- #
def process(
    url: str,
    target_i: float,
    target_tp: float,
    target_lra: float,
    silence_db: float,
    keep_silence: float,
    bitrate: str,
    sample_rate: int,
    assume_yes: bool = False,
    name_override: str | None = None,
) -> Path:
    print(f"[1/5] fetching metadata ...")
    meta = fetch_meta(url)
    title = meta.get("title", "untitled")
    uploader = meta.get("uploader") or meta.get("channel") or ""
    yt_duration = meta.get("duration")
    video_id = meta.get("id", "")
    # Resolve the real watch URL even when the input was a ytsearch: query,
    # so meta.json records a stable, clickable source.
    resolved_url = meta.get("webpage_url") or (
        f"https://www.youtube.com/watch?v={video_id}" if video_id else url
    )

    suggested = make_slug(title)
    if name_override:
        slug = to_slug(name_override)
    elif assume_yes:
        slug = suggested
    else:
        slug = prompt_slug(title, suggested)
    song_dir = SONGS_DIR / slug
    if assume_yes:
        ensure_empty_song_dir_auto(song_dir, slug)
    else:
        ensure_empty_song_dir(song_dir, slug)
    audio_path = song_dir / f"{slug}.mp3"
    meta_path = song_dir / "meta.json"

    with tempfile.TemporaryDirectory(prefix="ytmp3_") as tmp:
        tmp_dir = Path(tmp)

        print(f"[2/5] downloading best audio ...")
        source = download_audio(url, tmp_dir)
        src_duration = probe_duration(source)
        print(f"      source: {source.name}  ({hms(src_duration)})")

        # --- pass 1: silence trim + loudnorm measure ---
        print(f"[3/5] measuring loudness (after silence trim) ...")
        silence_af = silence_filter(silence_db, keep_silence)
        measure_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-y",
            "-i",
            str(source),
            "-af",
            f"{silence_af},{loudnorm_measure_filter(target_i, target_tp, target_lra)}",
            "-f",
            "null",
            "-",
        ]
        p1 = subprocess.run(
            measure_cmd,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=UTF8_ENV,
        )
        if p1.returncode != 0:
            sys.exit("ffmpeg pass 1 failed:\n" + p1.stderr)
        measured = parse_loudnorm_json(p1.stderr)
        print(
            f"      input  : I={measured['input_i']:+.2f} LUFS  "
            f"TP={measured['input_tp']:+.2f} dB  LRA={measured['input_lra']:.2f}"
        )

        # --- pass 2: silence trim + loudnorm linear apply + mp3 encode ---
        print(f"[4/5] applying loudnorm + trimming silence -> mp3 ...")
        apply_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-y",
            "-i",
            str(source),
            "-af",
            f"{silence_af},{loudnorm_apply_filter(measured, target_i, target_tp, target_lra)}",
            "-c:a",
            "libmp3lame",
            "-b:a",
            bitrate,
            "-ar",
            str(sample_rate),
            "-map_metadata",
            "-1",
            "-metadata",
            f"title={title}",
            "-metadata",
            f"artist={uploader}",
            "-metadata",
            f"comment=source={resolved_url}",
            "-metadata",
            f"genre=band-practice",
            str(audio_path),
        ]
        p2 = subprocess.run(
            apply_cmd,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=UTF8_ENV,
        )
        if p2.returncode != 0:
            sys.exit("ffmpeg pass 2 failed:\n" + p2.stderr)

    out_duration = probe_duration(audio_path)
    trimmed = max(0.0, src_duration - out_duration)
    print(
        f"      output : {audio_path.name}  ({hms(out_duration)})  "
        f"trimmed {trimmed:.2f}s"
    )

    # --- meta.json ---
    print(f"[5/5] writing meta.json ...")
    record = {
        "slug": slug,
        "title": title,
        "artist": uploader,
        "source_url": resolved_url,
        "source_query": url if url != resolved_url else None,
        "video_id": video_id,
        "yt_duration_seconds": yt_duration,
        "downloaded_at": iso_now(),
        "pipeline": {
            "tool": "bin/yt-to-mp3.py",
            "target_i_lufs": target_i,
            "target_tp_db": target_tp,
            "target_lra": target_lra,
            "silence_threshold_db": silence_db,
            "keep_silence_sec": keep_silence,
            "bitrate": bitrate,
            "sample_rate": sample_rate,
        },
        "audio": {
            "file": audio_path.name,
            "source_duration_seconds": src_duration,
            "output_duration_seconds": out_duration,
            "silence_trimmed_seconds": trimmed,
            "loudnorm_measured": {
                "input_i": measured["input_i"],
                "input_tp": measured["input_tp"],
                "input_lra": measured["input_lra"],
                "input_thresh": measured["input_thresh"],
                "output_i": measured["output_i"],
                "output_tp": measured["output_tp"],
                "output_lra": measured["output_lra"],
                "output_thresh": measured["output_thresh"],
                "target_offset": measured["target_offset"],
                "normalization_type": measured["normalization_type"],
            },
        },
    }
    meta_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\ndone -> {song_dir.relative_to(ROOT)}")
    return song_dir


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Convert a YouTube URL to a normalized, silence-trimmed mp3 "
        "inside songs/<slug>/.",
    )
    ap.add_argument("url", nargs="?", help="YouTube watch URL or ytsearch1:query")
    ap.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="non-interactive: auto-accept slug, overwrite existing dir",
    )
    ap.add_argument(
        "--name",
        default=None,
        help="override the song directory name (slug)",
    )
    ap.add_argument(
        "--target-i",
        type=float,
        default=DEFAULT_TARGET_I,
        help=f"target integrated loudness in LUFS (default {DEFAULT_TARGET_I})",
    )
    ap.add_argument(
        "--target-tp",
        type=float,
        default=DEFAULT_TARGET_TP,
        help=f"target true peak in dBFS (default {DEFAULT_TARGET_TP})",
    )
    ap.add_argument(
        "--target-lra",
        type=float,
        default=DEFAULT_TARGET_LRA,
        help=f"target loudness range (default {DEFAULT_TARGET_LRA})",
    )
    ap.add_argument(
        "--silence-db",
        type=float,
        default=DEFAULT_SILENCE_DB,
        help=f"silence threshold in dB (default {DEFAULT_SILENCE_DB})",
    )
    ap.add_argument(
        "--keep-silence",
        type=float,
        default=DEFAULT_KEEP_SILENCE,
        help=f"silence retained at edges in seconds (default {DEFAULT_KEEP_SILENCE})",
    )
    ap.add_argument(
        "--bitrate",
        default=DEFAULT_BITRATE,
        help=f"mp3 bitrate (default {DEFAULT_BITRATE})",
    )
    ap.add_argument(
        "--sample-rate",
        type=int,
        default=DEFAULT_SAMPLE_RATE,
        help=f"sample rate (default {DEFAULT_SAMPLE_RATE})",
    )
    args = ap.parse_args()

    SONGS_DIR.mkdir(parents=True, exist_ok=True)

    url = args.url or prompt_url()
    process(
        url=url,
        target_i=args.target_i,
        target_tp=args.target_tp,
        target_lra=args.target_lra,
        silence_db=args.silence_db,
        keep_silence=args.keep_silence,
        bitrate=args.bitrate,
        sample_rate=args.sample_rate,
        assume_yes=args.yes,
        name_override=args.name,
    )


if __name__ == "__main__":
    main()
