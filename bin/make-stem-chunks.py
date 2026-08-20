#!/usr/bin/env python3
"""Cut stem audio into sample-exact FLAC chunks for instant playback.

Layout produced per song:
  songs/<slug>/stems/chunks/<stem>/00000.flac, 00001.flac, ...
  songs/<slug>/stems/chunks/chunks.json

Each chunk holds exactly CHUNK_SECONDS of audio (last chunk may be shorter).
All stems are cut from raw PCM with identical sample ranges, so chunk i of
every stem starts at exactly i * CHUNK_SECONDS in song time — the runtime
sequencer relies on this alignment.

Usage:
  python bin/make-stem-chunks.py [--seconds 30] [--force] [slug ...]
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"
CHUNK_DIR_NAME = "chunks"


def ffprobe_json(path: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-show_format", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def make_chunks_for_stem(
    src: Path, out_dir: Path, chunk_seconds: float
) -> int:
    info = ffprobe_json(src)
    stream = next(s for s in info["streams"] if s["codec_type"] == "audio")
    sample_rate = int(stream["sample_rate"])
    channels = int(stream["channels"])

    # Decode the whole stem to raw interleaved s16le PCM once.
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(src),
            "-f", "s16le", "-acodec", "pcm_s16le",
            "-ar", str(sample_rate), "-ac", str(channels), "pipe:1",
        ],
        capture_output=True, check=True,
    ).stdout

    bytes_per_frame = 2 * channels
    total_frames = len(raw) // bytes_per_frame
    frames_per_chunk = round(chunk_seconds * sample_rate)
    count = (total_frames + frames_per_chunk - 1) // frames_per_chunk

    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        start = i * frames_per_chunk * bytes_per_frame
        end = min(total_frames, (i + 1) * frames_per_chunk) * bytes_per_frame
        out_path = out_dir / f"{i:05d}.flac"
        with tempfile.NamedTemporaryFile(suffix=".raw", delete=False) as tmp:
            tmp.write(raw[start:end])
            tmp_name = tmp.name
        try:
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-y",
                    "-f", "s16le", "-ar", str(sample_rate),
                    "-ac", str(channels), "-i", tmp_name,
                    "-c:a", "flac", "-compression_level", "4",
                    str(out_path),
                ],
                check=True,
            )
        finally:
            Path(tmp_name).unlink(missing_ok=True)

    # Drop stale chunks beyond the current count (e.g. after re-separation)
    for old in out_dir.glob("*.flac"):
        try:
            if int(old.stem) >= count:
                old.unlink()
        except ValueError:
            old.unlink()

    return count


def process_song(song_dir: Path, chunk_seconds: float, force: bool) -> bool:
    stems_dir = song_dir / "stems"
    if not stems_dir.is_dir():
        return False

    src_stems = sorted(
        p for p in stems_dir.iterdir()
        if p.suffix.lower() == ".mp3" and p.is_file()
    )
    if not src_stems:
        return False

    chunks_root = stems_dir / CHUNK_DIR_NAME
    manifest = chunks_root / "chunks.json"
    if manifest.exists() and not force:
        existing = None
        try:
            existing = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
        if existing and existing.get("chunkSeconds") == chunk_seconds:
            print(f"[skip] {song_dir.name} (chunks.json exists)")
            return False

    print(f"[chunks] {song_dir.name} ({len(src_stems)} stems)...")
    stems_meta = {}
    for src in src_stems:
        count = make_chunks_for_stem(src, chunks_root / src.stem, chunk_seconds)
        stems_meta[src.stem] = {"count": count}
        print(f"  {src.stem}: {count} chunks")

    # Align chunk counts across stems (in case durations differ slightly)
    min_count = min(m["count"] for m in stems_meta.values())
    for name in stems_meta:
        stems_meta[name]["count"] = min_count

    first_info = ffprobe_json(src_stems[0])
    stream = next(s for s in first_info["streams"] if s["codec_type"] == "audio")
    manifest.write_text(
        json.dumps(
            {
                "chunkSeconds": chunk_seconds,
                "sampleRate": int(stream["sample_rate"]),
                "channels": int(stream["channels"]),
                "stems": stems_meta,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("slugs", nargs="*")
    args = ap.parse_args()

    if not SONGS_DIR.is_dir():
        print(f"songs dir not found: {SONGS_DIR}", file=sys.stderr)
        return 1

    changed = 0
    for song_dir in sorted(SONGS_DIR.iterdir()):
        if not song_dir.is_dir():
            continue
        if args.slugs and song_dir.name not in args.slugs:
            continue
        if process_song(song_dir, args.seconds, args.force):
            changed += 1
    print(f"done: {changed} song(s) chunked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
