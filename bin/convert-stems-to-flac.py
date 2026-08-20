#!/usr/bin/env python3
"""Convert all existing mp3 stems in songs/ to flac and update meta.json."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"

def convert_all():
    converted_count = 0
    for song_dir in sorted(SONGS_DIR.iterdir()):
        if not song_dir.is_dir():
            continue
        stems_dir = song_dir / "stems"
        if not stems_dir.exists():
            continue

        meta_path = song_dir / "meta.json"
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}

        mp3_files = list(stems_dir.glob("*.mp3"))
        if not mp3_files:
            continue

        print(f"[*] Converting {song_dir.name} ({len(mp3_files)} stems)...")
        updated_files = {}

        for mp3 in mp3_files:
            stem_name = mp3.stem
            flac_path = stems_dir / f"{stem_name}.flac"

            # Run ffmpeg to convert to FLAC (16-bit PCM lossless)
            cmd = [
                "ffmpeg", "-y", "-v", "error",
                "-i", str(mp3),
                "-c:a", "flac",
                str(flac_path)
            ]
            res = subprocess.run(cmd)
            if res.returncode == 0 and flac_path.exists():
                mp3.unlink()
                updated_files[stem_name] = f"stems/{stem_name}.flac"
                converted_count += 1
            else:
                print(f"  [!] Failed to convert {mp3.name}")

        if "stems" in meta and isinstance(meta["stems"], dict):
            if "files" in meta["stems"] and isinstance(meta["stems"]["files"], dict):
                for k, v in updated_files.items():
                    meta["stems"]["files"][k] = v
            else:
                meta["stems"]["files"] = updated_files
            meta["stems"]["format"] = "flac"
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n[+] Done! Successfully converted {converted_count} stems to FLAC.")

if __name__ == "__main__":
    convert_all()
