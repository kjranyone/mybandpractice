#!/usr/bin/env python3
"""Cut stem audio into sample-aligned chunks for instant on-device playback.

Layout produced per song:
  songs/<slug>/stems/chunks/<stem>/00000.<ext>, 00001.<ext>, ...
  songs/<slug>/stems/chunks/chunks.json

Each chunk holds exactly CHUNK_SECONDS of audio (the last chunk may be
shorter). Every stem is cut from the same raw PCM decode with identical
sample ranges, so chunk i of all stems starts at exactly i * CHUNK_SECONDS
in song time — the runtime sequencer (useAudioPlayer.ts) relies on this
alignment for gapless scheduling.

Codecs (--codec):
  flac   Lossless, zero encoder delay: decoded chunk length is exactly the
         cut length (safest boundaries, largest files).
  opus   ~4x smaller than flac. Opus is 48 kHz only (input is resampled at
         cut time) and uses 20 ms CELT frames: the decoder must trim
         pre-skip/padding for sample alignment. Verified on-device; the
         runtime also hard-trims each source at the nominal boundary.
  vorbis 44.1 kHz native Ogg Vorbis fallback if Opus misbehaves.

chunks.json stores a fingerprint (name/size/mtime) of each source stem and
the codec; a changed source or codec invalidates and rebuilds the song's
chunks automatically. Run with --force to rebuild unconditionally.

Usage:
  python bin/make-stem-chunks.py [--seconds 30] [--codec flac] [--force] [slug ...]
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mbp import (
    audio_stream,
    ffmpeg,
    ffmpeg_read,
    file_fingerprint,
    find_stem_sources,
    iter_song_dirs,
)

MANIFEST_NAME = "chunks.json"
# Bump when the cutting algorithm changes so existing manifests rebuild.
ALGORITHM_VERSION = 3

# codec -> {ext, ffmpeg encoder args (with {bitrate} placeholder), forced rate}
CODECS: dict[str, dict] = {
    "flac": {
        "ext": "flac",
        "args": ["-c:a", "flac", "-compression_level", "4"],
        "rate": None,
    },
    "opus": {
        "ext": "opus",
        "args": ["-c:a", "libopus", "-b:a", "{bitrate}", "-vbr", "on"],
        "rate": 48000,
    },
    "vorbis": {
        "ext": "ogg",
        "args": ["-c:a", "libvorbis", "-b:a", "{bitrate}"],
        "rate": None,
    },
}


def decode_raw_pcm(src: Path) -> tuple[bytes, int, int]:
    """Decode a whole file to interleaved s16le PCM at its native rate."""
    stream = audio_stream(src)
    sample_rate = int(stream["sample_rate"])
    channels = int(stream["channels"])
    res = ffmpeg_read(
        "-i", str(src),
        "-f", "s16le", "-c:a", "pcm_s16le",
        "-ar", str(sample_rate), "-ac", str(channels), "pipe:1",
    )
    return res, sample_rate, channels


def make_chunks_for_stem(
    src: Path, out_dir: Path, chunk_seconds: float, codec: str, bitrate: str
) -> int:
    """Cut one stem into codec chunks; returns the chunk count."""
    spec = CODECS[codec]
    ext = spec["ext"]
    raw, sample_rate, channels = decode_raw_pcm(src)
    encode_rate = spec["rate"]
    rate_args = ["-ar", str(encode_rate)] if encode_rate else []
    enc_args = [a.replace("{bitrate}", bitrate) for a in spec["args"]]

    bytes_per_frame = 2 * channels
    total_frames = len(raw) // bytes_per_frame
    frames_per_chunk = round(chunk_seconds * sample_rate)
    if frames_per_chunk <= 0:
        raise ValueError(f"non-positive chunk size for {src}")
    count = (total_frames + frames_per_chunk - 1) // frames_per_chunk

    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        start = i * frames_per_chunk * bytes_per_frame
        end = min(total_frames, (i + 1) * frames_per_chunk) * bytes_per_frame
        out_path = out_dir / f"{i:05d}.{ext}"
        ffmpeg(
            "-f", "s16le", "-ar", str(sample_rate), "-ac", str(channels),
            "-i", "pipe:0", *rate_args, *enc_args,
            str(out_path),
            stdin_data=raw[start:end],
        )

    # Drop stale chunks: wrong extension, or index >= count (shorter re-sep)
    for old in out_dir.iterdir():
        if not old.is_file() or not old.stem.isdigit():
            continue
        if old.suffix.lstrip(".") != ext or int(old.stem) >= count:
            old.unlink(missing_ok=True)
    return count


def clean_orphan_chunk_dirs(chunks_root: Path, valid_stems: set[str]) -> None:
    if not chunks_root.is_dir():
        return
    for d in chunks_root.iterdir():
        if d.is_dir() and d.name not in valid_stems:
            for f in d.iterdir():
                f.unlink(missing_ok=True)
            d.rmdir()


def process_song(
    song_dir: Path, chunk_seconds: float, codec: str, bitrate: str, force: bool
) -> bool:
    stems_dir = song_dir / "stems"
    sources = find_stem_sources(stems_dir)
    if not sources:
        return False

    chunks_root = stems_dir / "chunks"
    manifest_path = chunks_root / MANIFEST_NAME
    fingerprints = {name: file_fingerprint(p) for name, p in sources.items()}

    if not force and manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = None
        if (
            manifest
            and manifest.get("algorithm") == ALGORITHM_VERSION
            and manifest.get("chunkSeconds") == chunk_seconds
            and manifest.get("codec") == codec
            and manifest.get("sources") == fingerprints
        ):
            return False  # up to date

    print(f"[chunks] {song_dir.name} ({len(sources)} stems, {codec})...")
    counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=min(4, len(sources))) as ex:
        futures = {
            name: ex.submit(
                make_chunks_for_stem,
                src, chunks_root / name, chunk_seconds, codec, bitrate,
            )
            for name, src in sources.items()
        }
        for name, fut in futures.items():
            counts[name] = fut.result()
            print(f"  {name}: {counts[name]} chunks")

    # Align chunk counts across stems (slight duration differences)
    min_count = min(counts.values())
    for name in counts:
        counts[name] = min_count

    first_src = next(iter(sources.values()))
    stream = audio_stream(first_src)
    manifest_path.write_text(
        json.dumps(
            {
                "algorithm": ALGORITHM_VERSION,
                "codec": codec,
                "ext": CODECS[codec]["ext"],
                "chunkSeconds": chunk_seconds,
                "sampleRate": int(stream["sample_rate"]),
                "channels": int(stream["channels"]),
                "sources": fingerprints,
                "stems": {name: {"count": c} for name, c in counts.items()},
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    clean_orphan_chunk_dirs(chunks_root, set(sources))
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--seconds", type=float, default=30.0,
        help="chunk length in seconds (default 30)",
    )
    ap.add_argument(
        "--codec", choices=list(CODECS), default="opus",
        help="chunk codec (default opus; verified sample-aligned on-device)",
    )
    ap.add_argument(
        "--bitrate", default="128k",
        help="bitrate for lossy codecs (default 128k)",
    )
    ap.add_argument("--force", action="store_true", help="rebuild existing chunks")
    ap.add_argument("slugs", nargs="*", help="limit to specific song slugs")
    args = ap.parse_args()

    if not (5.0 <= args.seconds <= 120.0):
        print("error: --seconds must be within 5..120", file=sys.stderr)
        return 1

    changed = 0
    for song_dir in iter_song_dirs():
        if args.slugs and song_dir.name not in args.slugs:
            continue
        if process_song(song_dir, args.seconds, args.codec, args.bitrate, args.force):
            changed += 1
    print(f"done: {changed} song(s) chunked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
