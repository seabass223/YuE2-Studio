"""Import from audio: transcribe a recording to a melody score, for a score-based cover.

YuE2 can't take audio as a prompt (its semantic audio tokenizer is unreleased), so a cover goes
through a score, as in upstream's docs/covers.md: SheetSage2 transcribes the recording to a
melody-only ABC (no chord symbols), and YuE2 sings or plays that melody with cot="melody" in a
new style.

SheetSage2 runs in its own venv as a subprocess (sheetsage2_worker.py). The engine gives it the
same job slot as a song, so it never shares the GPU with a generation.
"""
from __future__ import annotations

import collections
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

import fitted

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv-sheetsage2" / "Scripts" / "python.exe"
WORKER = Path(__file__).with_name("sheetsage2_worker.py")
WEIGHTS = [ROOT / "models" / "SheetSage2" / "model.safetensors",
           ROOT / "models" / "MERT-v2-FullSong" / "model.safetensors"]
IMPORTS = ROOT / "imports"  # one folder per import with SheetSage2's score, MIDI and annotations
MAX_UPLOAD = 200 * 2**20


def installed() -> bool:
    return PYTHON.is_file() and all(path.is_file() for path in WEIGHTS)


def unavailable_reason() -> str | None:
    if not installed():
        return "Import from audio isn't installed. Run Install.cmd again."
    if not shutil.which("ffmpeg"):
        return "Import from audio needs FFmpeg on PATH (winget install Gyan.FFmpeg), then restart YuE2 Studio."
    return None


def new_import(name: str) -> tuple[Path, Path]:
    """A fresh imports/<timestamp>-<id>/ folder and the path to save the upload to."""
    directory = IMPORTS / f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
    directory.mkdir(parents=True)
    suffix = Path(name).suffix.lower()
    return directory, directory / ("source" + (suffix if re.fullmatch(r"\.[a-z0-9]{1,5}", suffix) else ""))


_FIELD = re.compile(r"^(%|[A-Za-z+]:)")  # header, voice and lyric lines and comments carry no chords


def strip_chords(abc: str) -> str:
    """Drop quoted chord symbols from the music lines. Upstream's cover recipe pairs cot="melody"
    with a chordless score so the accompaniment is free to follow the new style. SheetSage2's
    melody-only score should have none already."""
    return "\n".join(line if _FIELD.match(line) else re.sub(r'"[^"\n]*"', "", line)
                     for line in abc.splitlines()) + "\n"


def run(audio: Path, output: Path, *, max_seconds, on_progress, cancelled) -> dict:
    """Transcribe in the SheetSage2 venv. on_progress(event) gets the worker's progress events.
    Returns the worker's result with the cleaned score in "abc"; raises InterruptedError when
    cancelled() turns true and RuntimeError when the transcription fails."""
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    # -I: don't let .venv's PYTHONPATH or user site-packages leak into the other environment.
    command = [str(PYTHON), "-I", "-u", str(WORKER), "transcribe", str(audio), "--output", str(output),
               "--max-seconds", str(max_seconds)]
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                               creationflags=subprocess.CREATE_NO_WINDOW)
    stderr = collections.deque(maxlen=40)
    threading.Thread(target=lambda: stderr.extend(process.stderr), name="sheetsage2-stderr", daemon=True).start()
    done = threading.Event()

    def watch():  # kill the worker (and its ffmpeg) as soon as the job is cancelled
        while not done.wait(0.5):
            if cancelled():
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
                return

    threading.Thread(target=watch, name="sheetsage2-cancel", daemon=True).start()
    result, error = None, None
    try:
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:  # stray library output
                print(f"SheetSage2: {line.rstrip()}", flush=True)
                continue
            if event["stage"] == "done":
                result = event
            elif event["stage"] == "error":
                error = event["message"]
            else:
                on_progress(event)
        process.wait()
    finally:
        done.set()
    if cancelled():
        raise InterruptedError("Cancelled")
    if result is None:
        print(f"SheetSage2 failed: {error}\n{''.join(stderr)}", flush=True)
        if error and error.startswith("Cannot decode audio"):  # followed by FFmpeg's own lines
            raise RuntimeError("FFmpeg can't read it as audio")
        raise RuntimeError((error or (stderr[-1] if stderr else f"SheetSage2 exited with code {process.returncode}"))
                           .strip().splitlines()[0])
    result["abc"] = fitted.clean_abc(strip_chords(result["abc"]))
    return result
