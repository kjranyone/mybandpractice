import os
import subprocess
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

SONGS_DIR = Path("songs").resolve()

def convert_main(song_dir: Path):
    slug = song_dir.name
    mp3_file = song_dir / f"{slug}.mp3"
    if not mp3_file.exists():
        mp3s = list(song_dir.glob("*.mp3"))
        if mp3s:
            mp3_file = mp3s[0]
        else:
            return
    
    ogg_file = song_dir / f"{slug}.ogg"
    cmd = [
        "ffmpeg", "-y", "-i", str(mp3_file),
        "-c:a", "libopus",
        "-b:a", "256k",
        "-vbr", "on",
        str(ogg_file)
    ]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if res.returncode == 0 and ogg_file.exists() and ogg_file.stat().st_size > 0:
        mp3_file.unlink()
        print(f"Converted main audio: {slug}.ogg ({ogg_file.stat().st_size // 1024} KB)")

if __name__ == '__main__':
    dirs = [d for d in SONGS_DIR.iterdir() if d.is_dir()]
    with ProcessPoolExecutor(max_workers=8) as ex:
        list(ex.map(convert_main, dirs))
    print("Done converting main tracks to Ogg Opus!")
