#!/usr/bin/env python3
"""Transcode main audio and/or stems in songs/ and keep meta.json consistent.

Replaces the former convert-main-to-ogg / convert-stems-to-ogg /
convert-stems-to-flac one-off scripts with a single entry point.

The output codec always replaces its source file (the original is deleted
after a successful encode) and meta.json is updated so audio.file /
stems.files always point at files that exist.

--normalize re-encodes with two-pass loudnorm so every song lands at the
same integrated loudness (default -14 LUFS, the YouTube playback target).
The main mix is measured per song and the SAME gain offset is applied to
every stem so the stem balance is preserved; true-peak limiting protects
against clipping. Run bin/make-stem-chunks.py afterwards to rebuild the
playback chunk caches (they detect the changed sources automatically).

Usage:
  python bin/convert-audio.py --target main  --format ogg           # all songs
  python bin/convert-audio.py --target stems --format flac hakujitsu
  python bin/convert-audio.py --target all   --format ogg --bitrate 192k
  python bin/convert-audio.py --target all   --normalize             # -14 LUFS
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mbp import (
    DEFAULT_TARGET_I,
    DEFAULT_TARGET_LRA,
    DEFAULT_TARGET_TP,
    ffmpeg,
    find_main_audio,
    find_stem_sources,
    iter_song_dirs,
    load_meta,
    loudnorm_apply_filter,
    measure_loudness,
    save_meta,
)

# codec -> ffmpeg encoder args
FORMATS: dict[str, list[str]] = {
    "ogg": ["-c:a", "libopus", "-vbr", "on"],
    "flac": ["-c:a", "flac"],
    "mp3": ["-c:a", "libmp3lame"],
}


def convert_one(
    src: Path,
    fmt: str,
    bitrate: str,
    normalize: bool = False,
    base_target_i: float = DEFAULT_TARGET_I,
    gain_offset: float | None = None,
) -> tuple[bool, str]:
    """Encode one file to `fmt` (optionally loudnorm-normalized).

    Writes to a temp file first so a failed encode never destroys the
    source, then deletes the source on success. `gain_offset` (stems)
    reuses the main mix's measured offset so the stem balance survives.
    """
    dst = src.with_suffix(f".{fmt}")
    tmp = dst.with_name(f"{dst.stem}.tmp{dst.suffix}")
    cmd = ["-i", str(src)]
    if normalize:
        measured = measure_loudness(src, base_target_i)
        file_target = (
            base_target_i if gain_offset is None else measured["input_i"] + gain_offset
        )
        cmd += [
            "-af",
            loudnorm_apply_filter(
                measured, file_target, DEFAULT_TARGET_TP, DEFAULT_TARGET_LRA
            ),
        ]
    cmd += FORMATS[fmt]
    if fmt != "flac":
        cmd += ["-b:a", bitrate]
    cmd.append(str(tmp))
    try:
        ffmpeg(*cmd)
    except RuntimeError as e:
        tmp.unlink(missing_ok=True)
        return False, str(e)
    if tmp.exists() and tmp.stat().st_size > 0:
        if src != dst:
            src.unlink()
        tmp.replace(dst)
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
    ap.add_argument(
        "--normalize", action="store_true",
        help="two-pass loudnorm to --target-i LUFS (forces re-encode of every "
        "selected file; stems get the main mix's gain so balance is kept)",
    )
    ap.add_argument(
        "--target-i", type=float, default=DEFAULT_TARGET_I,
        help=f"integrated loudness target in LUFS (default {DEFAULT_TARGET_I})",
    )
    ap.add_argument("slugs", nargs="*", help="limit to specific song slugs")
    ap.add_argument(
        "--jobs", type=int, default=min(os.cpu_count() or 4, 8),
        help="parallel ffmpeg jobs (default: min(cpu, 8))",
    )
    args = ap.parse_args()

    # (src, song slug, is_main, gain_offset or None for main/individual files)
    jobs: list[tuple[Path, str, bool, float | None]] = []

    for song_dir in iter_song_dirs():
        if args.slugs and song_dir.name not in args.slugs:
            continue
        main_audio = (
            find_main_audio(song_dir) if args.target in ("main", "all") else None
        )
        gain_offset: float | None = None
        if args.normalize:
            if main_audio is None:
                print(f"  warn: {song_dir.name}: no main audio; skipping normalize")
                continue
            measured = measure_loudness(main_audio, args.target_i)
            gain_offset = args.target_i - measured["input_i"]
            print(
                f"  {song_dir.name}: main {measured['input_i']:+.2f} LUFS -> "
                f"{args.target_i:+.2f} LUFS (offset {gain_offset:+.2f} dB)"
            )
        if main_audio and (
            args.normalize or main_audio.suffix.lower() != f".{args.format}"
        ):
            jobs.append((main_audio, song_dir.name, True, gain_offset))
        if args.target in ("stems", "all"):
            for name, src in sorted(find_stem_sources(song_dir / "stems").items()):
                if args.normalize or src.suffix.lower() != f".{args.format}":
                    jobs.append((src, song_dir.name, False, gain_offset))

    if not jobs:
        print("nothing to convert")
        return 0

    verb = "normalizing" if args.normalize else "converting"
    print(f"{verb} {len(jobs)} file(s) to {args.format} ...")
    failures: list[str] = []
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futures = {
            ex.submit(
                convert_one, src, args.format, args.bitrate,
                args.normalize, args.target_i, gain_offset,
            ): (src, slug, is_main)
            for (src, slug, is_main, gain_offset) in jobs
        }
        for fut in as_completed(futures):
            src, slug, is_main = futures[fut]
            ok, err = fut.result()
            if ok:
                print(f"  ok: {slug}/{'main' if is_main else 'stems'}/{src.name} -> .{args.format}")
            else:
                failures.append(f"{slug}/{src.name}: {err}")

    # Update meta.json for songs whose files changed on disk
    touched_songs = {slug for (_, slug, _, _) in jobs} - {
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
    if args.normalize:
        print("\nnote: run 'python bin/make-stem-chunks.py' to rebuild chunk caches")
    print(f"\ndone: {len(jobs)} file(s) {verb} to {args.format}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
