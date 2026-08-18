#!/usr/bin/env python3
"""Stem separation for band practice songs (4-stem: vocals/drums/bass/other).

Wraps Music-Source-Separation-Training (cloned to tools/msst) inference for
one song directory, writes stems/<stem>.mp3 files, and records results in
meta.json. By default an ensemble of models is averaged (avg_wave) for best
quality. Supports CUDA, Intel XPU (Arc, opt-in), and CPU.

Usage
-----
    uv run python bin/separate-stems.py <song-slug> [--force]
    uv run python bin/separate-stems.py --all
    uv run python bin/separate-stems.py <slug> --single bs_roformer_4stem
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = ROOT / "songs"
MSST_DIR = ROOT / "tools" / "msst"
MODELS_DIR = ROOT / "models"
sys.path.insert(0, str(MSST_DIR))

MSST_RELEASE = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download"

# Default ensemble: two 4-stem models of comparable quality.
# BS-Roformer (MUSDB18 avg SDR 9.65) + SCNet XL IHF (MUSDB18 avg SDR 10.08).
ENSEMBLE_MODELS = [
    {
        "name": "bs_roformer_4stem",
        "model_type": "bs_roformer",
        "config_url": f"{MSST_RELEASE}/v1.0.12/config_bs_roformer_384_8_2_485100.yaml",
        "checkpoint_url": f"{MSST_RELEASE}/v1.0.12/model_bs_roformer_ep_17_sdr_9.6568.ckpt",
    },
    {
        "name": "scnet_xl_ihf_4stem",
        "model_type": "scnet",
        "config_url": f"{MSST_RELEASE}/v1.0.15/config_musdb18_scnet_xl_more_wide_v5.yaml",
        "checkpoint_url": f"{MSST_RELEASE}/v1.0.15/model_scnet_ep_36_sdr_10.0891.ckpt",
    },
]

UTF8_ENV = {**__import__("os").environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

DEFAULT_ENSEMBLE_TYPE = "avg_wave"


def pick_device() -> str:
    """cuda > cpu. XPU is opt-in only: Intel Arc XPU compute can hard-freeze
    some Windows systems under load, so it is never auto-selected."""
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def device_summary() -> str:
    import torch

    parts = []
    if torch.cuda.is_available():
        parts.append(f"cuda:{torch.cuda.get_device_name(0)}")
    if getattr(torch, "xpu", None) and torch.xpu.is_available():
        parts.append(f"xpu:{torch.xpu.get_device_name(0)} (opt-in via --device xpu)")
    parts.append("cpu")
    return ", ".join(parts)


def download(url: str, dest: Path) -> None:
    import requests

    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"      downloading {dest.name} ...")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        last_pct = -5
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    if pct - last_pct >= 5:
                        last_pct = pct
                        print(f"      {pct}% ({done >> 20}/{total >> 20} MiB)")
        print("      download complete")
    tmp.rename(dest)


def ensure_model(model: dict) -> tuple[Path, Path]:
    subdir = MODELS_DIR / model["name"]
    config_path = subdir / "config.yaml"
    ckpt_path = subdir / "model.ckpt"
    download(model["config_url"], config_path)
    download(model["checkpoint_url"], ckpt_path)
    return config_path, ckpt_path


def load_model(model_type: str, config_path: Path, ckpt_path: Path, device: str):
    import torch
    from utils.model_utils import load_start_checkpoint
    from utils.settings import get_model_from_config

    model, config = get_model_from_config(model_type, str(config_path))
    checkpoint = torch.load(
        str(ckpt_path), map_location="cpu", weights_only=False
    )
    args = argparse.Namespace(
        start_check_point=str(ckpt_path),
        model_type=model_type,
        lora_checkpoint_loralib="",
        load_only_compatible_weights=False,
    )
    load_start_checkpoint(args, model, checkpoint, type_="inference")
    model = model.to(torch.device(device))
    model.eval()
    return model, config


def encode_mp3(wav_path: Path, mp3_path: Path, bitrate: str) -> None:
    res = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-y",
            "-i", str(wav_path),
            "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", "44100",
            str(mp3_path),
        ],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env=UTF8_ENV,
    )
    if res.returncode != 0:
        raise RuntimeError("ffmpeg mp3 encode failed:\n" + res.stderr)


def separate_song(
    song_dir: Path,
    models: list[dict],
    ensemble_type: str,
    device: str,
    bitrate: str,
    force: bool = False,
    batch_size: int | None = None,
) -> bool:
    import gc

    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from ensemble import average_waveforms
    from utils.model_utils import demix

    meta_path = song_dir / "meta.json"
    if not meta_path.exists():
        print(f"  [skip] {song_dir.name}: no meta.json")
        return False
    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    audio_file = song_dir / f"{song_dir.name}.mp3"
    if not audio_file.exists():
        cand = song_dir / meta.get("audio", {}).get("file", "")
        if cand and cand.exists() and cand.suffix == ".mp3":
            audio_file = cand
        else:
            print(f"  [skip] {song_dir.name}: audio file not found")
            return False

    stems_dir = song_dir / "stems"
    instruments = ["vocals", "drums", "bass", "other"]
    if stems_dir.exists() and all(
        (stems_dir / f"{i}.mp3").exists() for i in instruments
    ):
        if not force:
            print(f"  [skip] {song_dir.name}: stems exist (--force to redo)")
            return False

    print(f"  [separating] {song_dir.name}")
    t_start = time.time()

    # --- run each model, keep per-stem waveforms in memory ---
    # per_model: {instr: [waveform_model0, waveform_model1, ...]}
    per_model: dict[str, list[np.ndarray]] = {}
    sample_rate = 44100
    model_reports = []

    for mi, model in enumerate(models):
        label = f"{model['name']} ({model['model_type']})"
        print(f"    [{mi + 1}/{len(models)}] {label}")
        config_path, ckpt_path = ensure_model(model)
        t0 = time.time()
        net, config = load_model(model["model_type"], config_path, ckpt_path, device)
        print(f"      model loaded in {time.time() - t0:.1f}s on {device}")

        # Free-memory guard: oversubscription on iGPU systems can
        # hard-freeze the whole machine.
        if device in ("cuda", "xpu"):
            free, total = (
                torch.cuda.mem_get_info()
                if device == "cuda"
                else torch.xpu.mem_get_info()
            )
            need = 2.5 * 1024**3  # fp32 model + activations, conservative
            free_g = free / 1024**3
            print(f"      VRAM free: {free_g:.2f} GiB / {total / 1024**3:.2f} GiB")
            if free < need:
                if device == "xpu":
                    raise RuntimeError(
                        f"only {free_g:.2f} GiB VRAM free (< "
                        f"{need / 1024**3:.1f} GiB needed); refusing to run on "
                        "xpu to avoid a system freeze. Close GPU apps or "
                        "rerun with --device cpu."
                    )
                print("      warning: low VRAM — expect slowdowns or failure")

        # Clamp inference batch size: shipped configs target big NVIDIA GPUs.
        effective_batch = batch_size or (1 if device == "xpu" else 4)
        if int(config.inference.batch_size) > effective_batch:
            config.inference.batch_size = effective_batch
        print(f"      inference batch_size: {config.inference.batch_size}")

        sample_rate = int(getattr(config.audio, "sample_rate", 44100))
        mix, _ = librosa.load(str(audio_file), sr=sample_rate, mono=False)
        if mix.ndim == 1:
            mix = np.stack([mix, mix])

        t1 = time.time()
        waveforms = demix(
            config,
            net,
            mix,
            torch.device(device),
            model_type=model["model_type"],
            pbar=True,
        )
        elapsed = time.time() - t1
        audio_len = mix.shape[-1] / sample_rate
        print(f"\n      separation done in {elapsed:.1f}s "
              f"(realtime x{audio_len / max(elapsed, 0.01):.1f})")

        model_reports.append(
            {
                "model": model["name"],
                "model_type": model["model_type"],
                "elapsed_seconds": round(elapsed, 1),
                "realtime_factor": round(elapsed / max(audio_len, 0.01), 3),
                "batch_size": int(config.inference.batch_size),
            }
        )
        for instr, wav in waveforms.items():
            per_model.setdefault(instr, []).append(wav)

        # free VRAM before the next model
        del net, waveforms, mix
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "xpu":
            torch.xpu.empty_cache()

    # --- ensemble ---
    if len(models) > 1:
        print(f"    ensembling ({ensemble_type}, {len(models)} models) ...")
        combined = {
            instr: average_waveforms(
                np.array(wavs), np.ones(len(wavs)), ensemble_type
            )
            for instr, wavs in per_model.items()
        }
    else:
        combined = {instr: wavs[0] for instr, wavs in per_model.items()}

    instruments_out = sorted(combined.keys())
    stems_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    for instr in instruments_out:
        est = combined[instr]
        peak = float(np.abs(est).max())
        if peak > 0.999:  # prevent clipping on encode
            est = est / peak * 0.999
        tmp_wav = stems_dir / f"{instr}.wav"
        sf.write(str(tmp_wav), est.T, sample_rate, subtype="PCM_16")
        encode_mp3(tmp_wav, stems_dir / f"{instr}.mp3", bitrate)
        tmp_wav.unlink()
        files[instr] = f"stems/{instr}.mp3"

    meta["stems"] = {
        "models": model_reports,
        "ensemble": (
            {"type": ensemble_type, "model_count": len(models)}
            if len(models) > 1
            else None
        ),
        "device": device,
        "bitrate": bitrate,
        "separated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elapsed_seconds": round(time.time() - t_start, 1),
        "files": files,
    }
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"      wrote {len(files)} stems -> {stems_dir.relative_to(ROOT)}")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("slug", nargs="?", help="song slug under songs/")
    ap.add_argument("--all", action="store_true", help="process all songs")
    ap.add_argument("--force", action="store_true", help="redo existing stems")
    ap.add_argument(
        "--single",
        metavar="NAME",
        default=None,
        help="run only one config.yaml/ensemble model by name (skip ensemble)",
    )
    ap.add_argument(
        "--type",
        default=None,
        help="ensemble algorithm: avg_wave (default), median_wave, min_fft, max_fft, ...",
    )
    ap.add_argument(
        "--device",
        default=None,
        help="cuda (NVIDIA or AMD ROCm via torch cuda API) | xpu (Intel Arc, "
        "opt-in) | cpu (default: auto)",
    )
    ap.add_argument("--batch-size", type=int, default=None, help="inference batch size (default: 1 on xpu, 4 otherwise)")
    ap.add_argument("--bitrate", default="192k", help="mp3 bitrate (default 192k)")
    args = ap.parse_args()

    if not MSST_DIR.exists():
        sys.exit(
            "tools/msst not found. Clone it first:\n"
            "  git clone --depth 1 "
            "https://github.com/ZFTurbo/Music-Source-Separation-Training.git tools/msst"
        )

    if args.all:
        targets = sorted(
            d for d in SONGS_DIR.iterdir() if d.is_dir() and (d / "meta.json").exists()
        )
    elif args.slug:
        targets = [SONGS_DIR / args.slug]
        if not targets[0].exists():
            sys.exit(f"song dir not found: {targets[0]}")
    else:
        ap.error("specify a slug or --all")

    device = args.device or pick_device()
    models = [dict(m) for m in ENSEMBLE_MODELS]
    ensemble_type = args.type or DEFAULT_ENSEMBLE_TYPE
    if args.single:
        match = [m for m in models if m["name"] == args.single]
        if not match:
            names = ", ".join(m["name"] for m in models)
            sys.exit(f"model '{args.single}' not found [{names}]")
        models = [match[0]]
    print(f"==> device: {device}  [available: {device_summary()}]")
    print(f"==> models: {' + '.join(m['name'] for m in models)}"
          f"{' (ensemble: ' + ensemble_type + ')' if len(models) > 1 else ''}")
    ok = skip = fail = 0
    for d in targets:
        try:
            if separate_song(
                d, models, ensemble_type, device, args.bitrate, args.force,
                args.batch_size,
            ):
                ok += 1
            else:
                skip += 1
        except Exception as e:
            fail += 1
            print(f"  [error] {d.name}: {type(e).__name__}: {e}")
            if device == "xpu":
                print(
                    "  hint: XPU compute can destabilize some systems; "
                    "retry with --device cpu if this repeats"
                )

    print(f"\ndone: {ok} separated, {skip} skipped, {fail} failed")


if __name__ == "__main__":
    main()
