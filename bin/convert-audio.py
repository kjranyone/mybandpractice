#!/usr/bin/env python3
"""Transcode main audio and/or stems in songs/ and keep meta.json consistent.

Replaces the former convert-main-to-ogg / convert-stems-to-ogg /
convert-stems-to-flac one-off scripts with a single entry point.

The output codec always replaces its source file (the original is deleted
after a successful encode) and meta.json is updated so audio.file /
stems.files always point at files that exist.

Usage:
  python bin/convert-audio.py --target main  --format ogg           # all songs
  python bin/convert-audio.py --target stems --format flac hakujitsu
  python bin/convert-audio.py --target all   --format ogg --bitrate 192k
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mbp import (
    ffmpeg,
    find_main_audio,
    find_stem_sources,
    iter_song_dirs,
    load_meta,
    save_meta,
)

# codec -> ffmpeg encoder args
FORMATS: dict[str, list[str]] = {
    "ogg": ["-c:a", "libopus", "-vbr", "on"],
    "flac": ["-c:a", "flac"],
    "mp3": ["-c:a", "libmp3lame"],
}


def convert_one(src: Path, fmt: str, bitrate: str) -> tuple[bool, str]:
    """Encode one file to `fmt`; delete the source on success."""
    dst = src.with_suffix(f".{fmt}")
    if src.suffix.lower() == dst.suffix.lower():
        return True, ""
    cmd = ["-i", str(src), *FORMATS[fmt]]
    if fmt != "flac":
        cmd += ["-b:a", bitrate]
    cmd.append(str(dst))
    try:
        ffmpeg(*cmd)
    except RuntimeError as e:
        return False, str(e)
    if dst.exists() and dst.stat().st_size > 0:
        src.unlink()
        return True, ""
    return False, "output missing/empty"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--target", choices=["main", "stems", "all"], default="all",
        help="what to transcode (default: all)",
    )
    ap.add_argument(
        "--format", choices=list(FORMATS), default="ogg",
        help="output codec (default: ogg/opus)",
    )
    ap.add_argument(
        "--bitrate", default="192k",
        help="target bitrate for lossy codecs (default 192k; ignored for flac)",
    )
    ap.add_argument("slugs", nargs="*", help="limit to specific song slugs")
    ap.add_argument(
        "--jobs", type=int, default=min(os.cpu_count() or 4, 8),
        help="parallel ffmpeg jobs (default: min(cpu, 8))",
    )
    args = ap.parse_args()

    jobs: list[tuple[Path, str, bool]] = []  # (src, song slug, is_main)

    for song_dir in iter_song_dirs():
        if args.slugs and song_dir.name not in args.slugs:
            continue
        if args.target in ("main", "all"):
            main_audio = find_main_audio(song_dir)
            if main_audio and main_audio.suffix.lower() != f".{args.format}":
                jobs.append((main_audio, song_dir.name, True))
        if args.target in ("stems", "all"):
            for name, src in sorted(find_stem_sources(song_dir / "stems").items()):
                if src.suffix.lower() != f".{args.format}":
                    jobs.append((src, song_dir.name, False))

    if not jobs:
        print("nothing to convert")
        return 0

    print(f"converting {len(jobs)} file(s) to {args.format} ...")
    failures: list[str] = []
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futures = {
            ex.submit(convert_one, src, args.format, args.bitrate): (src, slug, is_main)
            for src, slug, is_main in jobs
        }
        for fut in as_completed(futures):
            src, slug, is_main = futures[fut]
            ok, err = fut.result()
            if ok:
                print(f"  ok: {slug}/{'main' if is_main else 'stems'}/{src.name} -> .{args.format}")
            else:
                failures.append(f"{slug}/{src.name}: {err}")

    # Update meta.json for songs whose files changed on disk
    touched_songs = {slug for (_, slug, _) in jobs} - {
        f.rsplit("/", 1)[0] for f in failures
    }
    for song_dir in iter_song_dirs():
        if song_dir.name not in touched_songs:
            continue
        meta = load_meta(song_dir)
        changed = False
        if args.target in ("main", "all"):
            main_audio = find_main_audio(song_dir)
            if main_audio and meta.get("audio", {}).get("file") != main_audio.name:
                meta.setdefault("audio", {})["file"] = main_audio.name
                changed = True
        if args.target in ("stems", "all"):
            stems_meta = meta.setdefault("stems", {})
            files = stems_meta.setdefault("files", {})
            for name, src in sorted(find_stem_sources(song_dir / "stems").items()):
                rel = f"stems/{src.name}"
                if files.get(name) != rel:
                    files[name] = rel
                    changed = True
            stems_meta["format"] = args.format
            changed = True
        if changed:
            save_meta(song_dir, meta)

    if failures:
        print(f"\n{len(failures)} failure(s):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"\ndone: {len(jobs)} file(s) converted to {args.format}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
