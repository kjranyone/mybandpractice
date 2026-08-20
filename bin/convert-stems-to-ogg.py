import os
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

SONGS_DIR = Path("songs").resolve()

def convert_stem(src_file: Path) -> tuple[Path, bool, str]:
    dst_file = src_file.with_suffix(".ogg")
    
    cmd = [
        "ffmpeg", "-y", "-i", str(src_file),
        "-c:a", "libopus",
        "-b:a", "256k",
        "-vbr", "on",
        str(dst_file)
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if res.returncode == 0 and dst_file.exists() and dst_file.stat().st_size > 0:
            if src_file.suffix != ".ogg":
                src_file.unlink()
            return (dst_file, True, "")
        else:
            return (src_file, False, res.stderr)
    except Exception as e:
        return (src_file, False, str(e))

def main():
    if not SONGS_DIR.exists():
        print(f"Error: {SONGS_DIR} does not exist.")
        sys.exit(1)

    stem_files = []
    for song_dir in SONGS_DIR.iterdir():
        if not song_dir.is_dir():
            continue
        stems_dir = song_dir / "stems"
        if not stems_dir.exists():
            continue
        for f in stems_dir.iterdir():
            if f.is_file() and f.suffix.lower() in [".flac", ".mp3", ".wav"] and not f.name.startswith("mix"):
                stem_files.append(f)

    print(f"Found {len(stem_files)} stems to convert to Ogg Opus...")
    if not stem_files:
        print("No stems found.")
        return

    workers = min(os.cpu_count() or 4, 8)
    print(f"Starting conversion with {workers} workers...")

    converted = 0
    with ProcessPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(convert_stem, f) for f in stem_files]
        for fut in futures:
            dst, ok, err = fut.result()
            if ok:
                converted += 1
                print(f"[{converted}/{len(stem_files)}] Converted: {dst.parent.parent.name}/stems/{dst.name}")
            else:
                print(f"FAILED: {dst.name} - {err}", file=sys.stderr)

    print(f"\nAll done! Successfully converted {converted}/{len(stem_files)} stems to Ogg Opus.")

if __name__ == "__main__":
    main()
