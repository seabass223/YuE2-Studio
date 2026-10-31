"""MCP endpoint for YuE2 Studio, implementing the MCP Micro-UI Jobs profile.

Spec: specs/mcp-micro-ui-jobs/README.md. `generate_song` starts a job and returns a handle at
once; the micro UI (ui://yue2/song.html) or a headless client follows it with job_status,
job_result and job_cancel. Finished songs are readable as yue2://tracks/{id}/... resources.

Jobs queue here rather than in the engine: a dispatcher hands the next one to the engine
whenever the model is ready and no song (including one started from the studio page) is running.
"""
from __future__ import annotations

import base64
import dataclasses
import hashlib
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

import anyio
from mcp.server.apps import Apps, client_supports_apps
from mcp.server.extension import Extension, ToolBinding
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.resources.base import Resource
from mcp_types import AudioContent, CallToolResult, ResourceLink, TextContent
from pydantic import Field

from engine import ROOT, Engine, Job, ensure_mp3, normalize_params

PROFILE = "dev.micro-ui/jobs"
PROFILE_VERSION = "0.1.0"
UI_URI = "ui://yue2/song.html"
MICRO_UI = ROOT / "frontend" / "dist-micro" / "micro.html"
POLL_MS = 1000
TTL_MS = 60 * 60 * 1000
MAX_WAIT_MS = 30_000
TOOLS = {"statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel"}

STATES = {"queued": "working", "running": "working", "done": "completed", "error": "failed",
          "cancelled": "cancelled"}
PHASES = {"Queued": "queued", "Loading model": "loading", "Planning score": "planning",
          "Generating song": "generating", "Synthesizing audio": "synthesizing", "Decoding audio": "decoding",
          "Saving": "saving", "Done": "done", "Cancelled": "cancelled", "Failed": "failed"}
# Share of overall progress each stage covers; token generation dominates the wall clock.
SPANS = {"Planning score": (0.0, 0.15), "Generating song": (0.15, 0.85), "Synthesizing audio": (0.85, 0.95),
         "Decoding audio": (0.95, 0.99), "Saving": (0.99, 1.0)}
FILES = [("audio.mp3", "audio/mpeg", "primary"), ("audio.flac", "audio/flac", "alternate"),
         ("score.abc", "text/plain", "auxiliary")]

FALLBACK_HTML = """<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">
YuE2 Studio's micro UI is not built yet. Run <code>npm run build</code> in <code>frontend/</code>.
The song is still generating; ask for its status with job_status."""


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _error(code: str, message: str, **extra) -> CallToolResult:
    return CallToolResult(content=[TextContent(text=f"{code}: {message}")], is_error=True,
                          structured_content={"error": {"code": code, "message": message, **extra}})


@dataclasses.dataclass
class McpJob:
    id: str
    raw: dict
    summary: dict
    created: float = dataclasses.field(default_factory=time.time)
    job: Job | None = None  # set once the engine accepts it
    cancelled: bool = False
    error: str | None = None  # failure before the engine took it
    progress: float = 0.0  # high-water mark, so progress never goes backwards
    finished: float | None = None


class Jobs:
    def __init__(self, engine: Engine):
        self.engine = engine
        self.items: dict[str, McpJob] = {}
        self.lock = threading.Lock()
        self.wake = threading.Event()
        threading.Thread(target=self._dispatch, name="mcp-jobs", daemon=True).start()

    def add(self, raw: dict) -> McpJob:
        params = normalize_params(raw)  # raises ValueError for bad input before anything is queued
        summary = {"style": params["style"], "instrumental": params["instrumental"],
                   "max_seconds": params["max_seconds"]}
        job = McpJob(id=f"song_{uuid.uuid4().hex[:16]}", raw=raw, summary=summary)
        with self.lock:
            self._expire()
            self.items[job.id] = job
        self.wake.set()
        return job

    def get(self, job_id: str) -> McpJob | None:
        return self.items.get(job_id)

    def active(self) -> bool:
        return any(self.state(j) == "working" for j in list(self.items.values()))

    def cancel(self, job: McpJob):
        job.cancelled = True
        if job.job is not None and self.engine.job is job.job:
            self.engine.cancel()

    def _expire(self):
        cutoff = time.time() - TTL_MS / 1000
        for key, job in list(self.items.items()):
            if job.finished and job.finished < cutoff:
                del self.items[key]

    def _dispatch(self):
        while True:
            self.wake.wait(0.5)
            self.wake.clear()
            pending = sorted((j for j in list(self.items.values()) if j.job is None and not j.cancelled
                              and not j.error), key=lambda j: j.created)
            if not pending:
                continue
            if self.engine.status == "error":
                for job in pending:
                    job.error = f"Model failed to load: {self.engine.status_detail}"
                continue
            if self.engine.status != "ready" or self.engine.busy():
                continue
            job = pending[0]
            try:
                job.job = self.engine.start_job(job.raw, source="mcp")
            except RuntimeError:  # the studio page started a song in between; try again shortly
                continue
            except ValueError as exc:
                job.error = str(exc)

    # Status ----------------------------------------------------------------
    def state(self, job: McpJob) -> str:
        if job.job is not None:
            return STATES[job.job.state]
        if job.error:
            return "failed"
        return "cancelled" if job.cancelled else "working"

    def status(self, job: McpJob) -> dict:
        now = time.time()
        state = self.state(job)
        out: dict[str, Any] = {"jobId": job.id, "state": state, "pollIntervalMs": POLL_MS,
                               "elapsedMs": int(((job.finished or now) - job.created) * 1000), "updatedAt": _iso(now)}
        if job.job is None:
            if state == "working":
                waiting = self.engine.status != "ready"
                out |= {"phase": "loading" if waiting else "queued", "progress": 0.0,
                        "message": (self.engine.status_detail or "Loading model") if waiting
                        else "Waiting for the current song to finish"}
            else:
                out |= {"phase": state, "progress": None,
                        "message": job.error or "Cancelled before it started"}
        else:
            view = job.job.view()
            for key in ("track", "kind", "result"):  # kind/result are the studio's Import from audio
                view.pop(key, None)
            job.progress = max(job.progress, self._progress(view))
            out |= {"phase": PHASES.get(view["stage"], view["stage"].lower().replace(" ", "-")),
                    "progress": 1.0 if state == "completed" else round(min(job.progress, 0.99), 3),
                    "message": self._message(view), "data": {"job": view, "request": job.summary}}
            if state == "failed":
                out["message"] = view["error"] or "Generation failed"
        if state == "failed":
            out["error"] = {"code": "failed", "message": out["message"]}
        if state != "working" and job.finished is None:
            job.finished = now
        return out

    @staticmethod
    def _progress(view: dict) -> float:
        span = SPANS.get(view["stage"])
        if span is None:
            return 0.0
        if view["stage"] == "Generating song":
            fraction = view["audio_seconds"] / max(view["max_seconds"], 1)
        elif view["total"]:
            fraction = view["completed"] / view["total"]
        else:
            fraction = 0.0
        low, high = span
        return low + (high - low) * min(max(fraction, 0.0), 1.0)

    @staticmethod
    def _message(view: dict) -> str:
        """Same wording as the studio's progress bar (JobProgress in App.tsx)."""
        stage = view["stage"]
        if stage not in SPANS or stage == "Saving":  # counters are stale once a stage clears them
            detail = ""
        elif stage == "Generating song":
            detail = f"{_clock(view['audio_seconds'])} of music (max {_clock(view['max_seconds'])})"
        elif view["total"]:
            detail = f"{view['completed']} / {view['total']} {view['unit'] or ''}".strip()
        elif stage == "Planning score":
            detail = f"{view['completed']} score tokens"
        else:
            detail = ""
        return " · ".join(part for part in (stage, view["part"], detail) if part)


class MicroUi(Resource):
    """The built micro UI, read from disk on every request so a rebuild needs no restart."""

    async def read(self) -> str:
        if MICRO_UI.is_file():
            return MICRO_UI.read_text(encoding="utf-8")
        return FALLBACK_HTML


class MicroUiJobs(Extension):
    """Advertises the profile and contributes its companion tools (status, result, cancel)."""

    identifier = PROFILE

    def __init__(self, tools: list[ToolBinding]):
        self._tools = tools

    def settings(self) -> dict[str, Any]:
        return {"version": PROFILE_VERSION}

    def tools(self) -> list[ToolBinding]:
        return self._tools


_hashes: dict[tuple[str, int, int], str] = {}


def _sha256(path: Path) -> str:
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key not in _hashes:
        digest = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                digest.update(block)
        _hashes[key] = digest.hexdigest()
    return _hashes[key]


def build(engine: Engine, *, base_url: str) -> tuple[MCPServer, Jobs]:
    jobs = Jobs(engine)
    apps = Apps()

    def handle(job: McpJob) -> dict:
        return {"jobId": job.id, "state": jobs.state(job), "pollIntervalMs": POLL_MS, "ttlMs": TTL_MS,
                "createdAt": _iso(job.created), **TOOLS}

    def artifacts(track: dict) -> list[dict]:
        directory = engine.track_dir(track["id"])
        ensure_mp3(directory)
        out = []
        for name, mime, role in FILES:
            path = directory / name
            if not path.is_file():
                continue
            item = {"uri": f"yue2://tracks/{track['id']}/{name}", "name": f"{track['id']}{path.suffix}",
                    "mimeType": mime, "size": path.stat().st_size, "sha256": _sha256(path), "role": role,
                    "url": f"{base_url}/api/tracks/{track['id']}/{name}"}
            if mime.startswith("audio/"):
                item["durationMs"] = int(track["duration"] * 1000)
            out.append(item)
        return out

    def lookup(job_id: str) -> McpJob | CallToolResult:
        job = jobs.get(job_id)
        if job is None:
            return _error("not_found", f"No job {job_id!r}. Jobs are kept for {TTL_MS // 60000} minutes.")
        return job

    @apps.tool(
        resource_uri=UI_URI,
        name="generate_song",
        title="Generate a song",
        meta={PROFILE: {"role": "start", **TOOLS}},
        description=(
            "Generate a full song (vocal or instrumental) with YuE2 on the local GPU. Returns a job handle "
            "immediately; generation takes roughly 1-2x the song length. Follow it with job_status (pass "
            "waitMs to long-poll) and fetch the audio with job_result once state is 'completed'. In hosts "
            "with MCP Apps the song's progress and player appear inline, so there is no need to poll."),
    )
    async def generate_song(
        ctx: Context,
        style: Annotated[str | None, Field(description=(
            "Genre, mood, instrumentation and vocal description, e.g. 'dreamy synth-pop, airy female "
            "vocals, 100 bpm'. Required."))] = None,
        lyrics: Annotated[str | None, Field(description=(
            "Lyrics with section tags such as [verse], [chorus], [bridge]. Required unless instrumental."))] = None,
        instrumental: Annotated[bool, Field(description=(
            "No vocals. The song is fitted to exactly max_seconds."))] = False,
        max_seconds: Annotated[int, Field(ge=10, le=360, description=(
            "Maximum length in seconds (exact length for instrumentals)."))] = 180,
        seed: Annotated[int | None, Field(description="Random seed for a reproducible song. Omit for random.")] = None,
        cot: Annotated[Literal["full", "melody", "off"], Field(description=(
            "Score planning before audio: 'full' (melody and chords, best structure), 'melody', or 'off'."))] = "full",
        timeline: Annotated[dict | None, Field(description=(
            "Instrumental only. Exact section layout: {bpm: 40-240, meter: '4/4'|'3/4', key?: str, strict: bool, "
            "sections: [{label: intro|verse|pre-chorus|chorus|bridge|interlude|instrumental|outro|silence, "
            "bars: 1-64, description?: str}]}. Overrides max_seconds. timeline.key works like the top-level "
            "key; give either (if both are given they must agree)."))] = None,
        key: Annotated[str | None, Field(description=(
            "Musical key of the song, major or minor: 'A', 'Em', 'Bb', 'F#m', 'C major', 'D minor' (up to 7 "
            "sharps or flats). Omit or 'auto' to let YuE2 choose; it almost always picks E or A minor over the "
            "same i-VI-VII chords whatever the style says, so set a key to vary the harmony between songs. "
            "Works for vocal songs and instrumentals (with or without a timeline); needs cot 'full' or "
            "'melody'."))] = None,
        temperature: Annotated[float | None, Field(ge=0.05, le=2.0, description="Sampling temperature (default 1.0).")] = None,
        cfg_scale: Annotated[float | None, Field(ge=0, le=5, description="Style adherence (default: model's own).")] = None,
        vocal_check: Annotated[bool, Field(description=(
            "Instrumental only. Listen for stray singing and re-render the part that has it, up to 2 "
            "more times."))] = True,
    ) -> CallToolResult:
        raw = {"style": style or "", "lyrics": lyrics or "", "instrumental": instrumental, "max_seconds": max_seconds,
               "seed": seed, "cot": cot, "key": key, "timeline": timeline, "temperature": temperature,
               "cfg_scale": cfg_scale,
               "vocal_check": vocal_check}
        missing = [name for name, value in (("style", style), ("lyrics", instrumental or lyrics)) if not
                   (value.strip() if isinstance(value, str) else value)]
        if missing and client_supports_apps(ctx):
            draft = {k: v for k, v in raw.items() if v not in (None, "")}
            return CallToolResult(
                content=[TextContent(text=(
                    f"The song form is open for the user to fill in ({', '.join(missing)} missing). "
                    "It starts generating when they press Generate."))],
                structured_content={"state": "input_required", "missing": missing, "draft": draft,
                                    "pollIntervalMs": POLL_MS, "ttlMs": TTL_MS, **TOOLS})
        try:
            job = jobs.add(raw)
        except ValueError as exc:
            return _error("invalid_input", str(exc))
        kind = "instrumental" if instrumental else "song"
        text = (f"Started generating a {kind} ({job.summary['style']}, up to {_clock(job.summary['max_seconds'])}). "
                f"Job id: {job.id}. It usually takes 1-2x the song length. Call job_status with "
                f"{{\"jobId\": \"{job.id}\", \"waitMs\": 25000}} to wait for progress, then job_result when "
                "state is 'completed'.")
        return CallToolResult(content=[TextContent(text=text)], structured_content=handle(job))

    async def job_status(
        ctx: Context,
        jobId: Annotated[str, Field(description="Job id from the start tool's handle.")],
        waitMs: Annotated[int, Field(ge=0, le=MAX_WAIT_MS, description=(
            "Long-poll: hold the call up to this many ms until the job finishes or its phase changes, "
            "sending progress notifications meanwhile. 0 returns immediately."))] = 0,
    ) -> CallToolResult:
        found = lookup(jobId)
        if isinstance(found, CallToolResult):
            return found
        status = jobs.status(found)
        deadline = time.monotonic() + waitMs / 1000
        phase, reported = status["phase"], None
        while status["state"] == "working" and time.monotonic() < deadline:
            if status["progress"] != reported:
                reported = status["progress"]
                await ctx.report_progress(reported or 0.0, 1.0, status["message"])
            await anyio.sleep(0.5)
            status = jobs.status(found)
            if status["phase"] != phase:
                break
        percent = "" if status["progress"] is None else f" ({status['progress']:.0%})"
        return CallToolResult(content=[TextContent(text=f"{status['state']}{percent}: {status['message']}")],
                              structured_content=status)

    async def job_result(
        jobId: Annotated[str, Field(description="Job id from the start tool's handle.")],
        inline: Annotated[bool, Field(description=(
            "Also embed the primary audio (MP3, base64) in the result. Large; prefer resources/read."))] = False,
    ) -> CallToolResult:
        found = lookup(jobId)
        if isinstance(found, CallToolResult):
            return found
        status = jobs.status(found)
        if status["state"] == "working":
            return _error("not_ready", "The song is still generating.", retryAfterMs=POLL_MS)
        if status["state"] != "completed":
            code = "cancelled" if status["state"] == "cancelled" else "failed"
            return _error(code, status["message"])
        track = found.job.track
        items = await anyio.to_thread.run_sync(artifacts, track)
        content: list = [TextContent(text=(
            f"Song ready: {track['params']['style']} ({_clock(track['duration'])}, seed {track['params']['seed']}). "
            f"Audio: {items[0]['uri']}"))]
        content += [ResourceLink(uri=a["uri"], name=a["name"], mime_type=a["mimeType"], size=a["size"],
                                 description=f"{a['role']} artifact") for a in items]
        if inline:
            data = await anyio.to_thread.run_sync((engine.track_dir(track["id"]) / "audio.mp3").read_bytes)
            content.append(AudioContent(data=base64.b64encode(data).decode(), mime_type="audio/mpeg"))
        return CallToolResult(content=content, structured_content={
            "jobId": found.id, "state": "completed", "artifacts": items,
            "data": {"track": track, "studioUrl": base_url}})

    async def job_cancel(
        jobId: Annotated[str, Field(description="Job id from the start tool's handle.")],
    ) -> CallToolResult:
        found = lookup(jobId)
        if isinstance(found, CallToolResult):
            return found
        if jobs.state(found) == "working":
            jobs.cancel(found)
        status = jobs.status(found)
        return CallToolResult(content=[TextContent(text=f"{status['state']}: {status['message']}")],
                              structured_content=status)

    companion = [
        ToolBinding(job_status, meta={PROFILE: {"role": "status"}}, kwargs={
            "name": "job_status", "title": "Song job status",
            "description": "Status and progress (0-1) of a generate_song job. Pass waitMs to long-poll."}),
        ToolBinding(job_result, meta={PROFILE: {"role": "result"}}, kwargs={
            "name": "job_result", "title": "Song job result",
            "description": ("The finished song: resource links (yue2://tracks/...) to the MP3, FLAC and score, "
                            "with size and sha256. Read them with resources/read.")}),
        ToolBinding(job_cancel, meta={PROFILE: {"role": "cancel"}}, kwargs={
            "name": "job_cancel", "title": "Cancel song job", "description": "Stop a generate_song job."}),
    ]

    apps.add_resource(MicroUi(uri=UI_URI, name="song", title="YuE2 song",
                              description="Live progress and player for a generate_song job."))
    server = MCPServer("yue2-studio", title="YuE2 Studio", version="1.0.0",
                       instructions=("Local song generator. generate_song returns a job handle; poll job_status, "
                                     "then fetch audio with job_result and resources/read."),
                       extensions=[apps, MicroUiJobs(companion)], log_level="WARNING")
    # 2025-era handshakes have no capabilities.extensions on the wire; the profile also goes under
    # capabilities.experimental there (spec section 2).
    lowlevel = server._lowlevel_server
    initialization_options = lowlevel.create_initialization_options
    lowlevel.create_initialization_options = lambda *args, **kwargs: initialization_options(
        *args, **{"experimental_capabilities": {PROFILE: {"version": PROFILE_VERSION}}, **kwargs})

    def track_reader(name: str, mime: str):
        async def read(track_id: str) -> bytes | str:
            def load():
                directory = engine.track_dir(track_id)
                path = ensure_mp3(directory) if name == "audio.mp3" else directory / name
                return path.read_text(encoding="utf-8") if mime.startswith("text/") else path.read_bytes()
            try:
                return await anyio.to_thread.run_sync(load)
            except FileNotFoundError:
                raise ValueError(f"No {name} for track {track_id!r}")
        return read

    for name, mime, _ in FILES:
        server.resource(f"yue2://tracks/{{track_id}}/{name}", name=name, mime_type=mime,
                        description=f"{name} of a finished song")(track_reader(name, mime))
    return server, jobs
