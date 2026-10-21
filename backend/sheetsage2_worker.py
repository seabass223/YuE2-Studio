"""SheetSage2 melody transcription. Runs in its own environment (.venv-sheetsage2), started by
transcribe.py: SheetSage2 pins torch 2.8 and transformers 4.45, which can't share YuE2's .venv.

  python sheetsage2_worker.py download
  python sheetsage2_worker.py transcribe song.mp3 --output dir [--max-seconds 360]

transcribe prints one JSON object per line on stdout (progress, then the result) and writes
SheetSage2's usual files (score.abc, MIDI, annotations) to --output. Only SheetSage2's own
dependencies are imported here.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "m-a-p/SheetSage2"
REVISION = "b83c3d79a6d98bcffaf8f9ed112c90aa887887bc"  # 2026-10-12; its config pins the MERT revision
MODEL_DIR = ROOT / "models" / "SheetSage2"
ENCODER_DIR = ROOT / "models" / "MERT-v2-FullSong"
SKIP = ["assets/*", "benchmarks/*", "render_assets/*", "tests/*"]  # docs, evaluation and score rendering


def emit(**fields):
    print(json.dumps(fields), flush=True)


def download():
    from huggingface_hub import snapshot_download
    # Both repos are public. token=False skips a saved Hugging Face login, which gets a 401 once expired.
    snapshot_download(REPO, revision=REVISION, local_dir=MODEL_DIR, ignore_patterns=SKIP, token=False)
    config = json.loads((MODEL_DIR / "config.json").read_text(encoding="utf-8"))
    snapshot_download(config["base_model_name_or_path"], revision=config["base_model_revision"],
                      local_dir=ENCODER_DIR, ignore_patterns=SKIP, token=False)
    print("SheetSage2 ok", flush=True)


def transcribe(audio, output, max_seconds):
    import torch
    from transformers import AutoModel

    torch.set_num_threads(min(4, torch.get_num_threads()))
    emit(stage="loading")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # The encoder's sha256 is checked against SheetSage2's config on every load.
    model = AutoModel.from_pretrained(MODEL_DIR, base_model_path=str(ENCODER_DIR), local_files_only=True,
                                      trust_remote_code=True).eval().to(device)
    last = 0.0

    def progress(value):
        nonlocal last
        stage = value["stage"]
        if stage == "decoding" and time.monotonic() - last < 0.5:  # called once per token
            return
        last = time.monotonic()
        if stage in ("encoding", "decoding"):
            emit(stage=stage, window=value["window"], windows=value["windows"], tokens=value.get("tokens", 0))
        elif stage == "notation":
            emit(stage=stage)

    # melody_only keeps the vocal and instrumental melody lines and leaves chord symbols out.
    result = model.transcribe(audio, output_dir=output, melody_only=True, max_seconds=max_seconds,
                              progress=progress)
    if result.get("abc_error") or not result.get("abc"):
        raise RuntimeError(f"no melody score: {result.get('abc_error') or 'the transcription is empty'}")
    emit(stage="done", abc=result["abc"], duration=round(result["duration_seconds"], 2),
         warnings=result.get("warnings", []), peak_gpu_mib=round(result.get("peak_gpu_mib", 0)),
         seconds=round(result["elapsed_seconds"], 1), device=device)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("download")
    run = commands.add_parser("transcribe")
    run.add_argument("audio", type=Path)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--max-seconds", type=float)
    args = parser.parse_args()
    if args.command == "download":
        download()
        return
    try:
        transcribe(args.audio, args.output, args.max_seconds)
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        emit(stage="error", message=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
