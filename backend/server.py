"""YuE2 Studio backend: REST + WebSocket API, the MCP endpoint and the built SPA on one port.

The page keeps a WebSocket open. When the last page disconnects and nobody reconnects within
IDLE_GRACE seconds, the process exits. If no page ever connects, it exits after STARTUP_GRACE.
MCP clients (/mcp) keep it alive too: for MCP_GRACE seconds after their last request, and for
as long as a song they started is queued or generating.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import mcp_server
import transcribe
from engine import ROOT, Engine, ensure_mp3

HOST, PORT = "127.0.0.1", int(os.environ.get("YUE2_PORT", "7862"))
IDLE_GRACE = 20
STARTUP_GRACE = 180
MCP_GRACE = 300
DIST = ROOT / "frontend" / "dist"

engine = Engine()
mcp, mcp_jobs = mcp_server.build(engine, base_url=f"http://{HOST}:{PORT}")
mcp_http = mcp.streamable_http_app()  # Host/Origin checks default to loopback only


@contextlib.asynccontextmanager
async def lifespan(_app):
    async with mcp.session_manager.run():  # a mounted sub-app's own lifespan never runs
        yield


app = FastAPI(title="YuE2 Studio", lifespan=lifespan)
server: uvicorn.Server | None = None


class Presence:
    def __init__(self):
        self.clients = 0
        self.last_seen = time.time()
        self.ever_connected = False
        self.mcp_seen = 0.0

    def watch(self):
        while True:
            time.sleep(2)
            if self.clients or mcp_jobs.active() or time.time() - self.mcp_seen < MCP_GRACE:
                continue
            idle = time.time() - self.last_seen
            if idle > (IDLE_GRACE if self.ever_connected else STARTUP_GRACE):
                print(f"No open pages for {idle:.0f}s; shutting down", flush=True)
                engine.cancel()
                if server is not None:
                    server.should_exit = True
                time.sleep(10)
                os._exit(0)  # generation thread may be mid-kernel; don't wait on it


presence = Presence()


class McpActivity:
    """Stamps MCP requests for Presence. Plain ASGI so it never buffers the SSE responses."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] == "/mcp":
            presence.mcp_seen = time.time()
        await self.inner(scope, receive, send)


app.add_middleware(McpActivity)
app.router.routes.extend(mcp_http.routes)  # POST/GET/DELETE /mcp; must precede the SPA catch-all


@app.get("/api/health")
def health():
    return {"ok": True, "app": "yue2-studio"}


@app.get("/api/status")
def status():
    return engine.snapshot()


@app.post("/api/generate")
async def generate(body: dict):
    try:
        return engine.submit(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@app.post("/api/transcribe")
async def transcribe_audio(request: Request, name: str = "audio"):
    """Import from audio. The request body is the audio file itself; returns the transcription job,
    whose result (on the WebSocket) holds the melody score."""
    reason = transcribe.unavailable_reason()
    if reason:
        raise HTTPException(503, reason)
    name = Path(name).name[:120] or "audio"
    directory, path = transcribe.new_import(name)
    try:
        size = 0
        with path.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > transcribe.MAX_UPLOAD:
                    raise HTTPException(413, f"{name} is over {transcribe.MAX_UPLOAD >> 20} MB")
                out.write(chunk)
        if not size:
            raise HTTPException(400, f"{name} is empty")
        try:
            return engine.start_transcription(path, name).view()
        except RuntimeError as exc:
            raise HTTPException(409, str(exc))
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise


@app.post("/api/cancel")
def cancel():
    engine.cancel()
    return {"ok": True}


@app.get("/api/tracks")
def tracks():
    return engine.tracks()


def _track_file(track_id, name):
    try:
        path = engine.track_dir(track_id) / name
    except FileNotFoundError:
        raise HTTPException(404, "Track not found")
    if not path.is_file():
        raise HTTPException(404, "File not found")
    return path


@app.get("/api/tracks/{track_id}/audio.flac")
def track_audio(track_id: str, download: bool = False):
    path = _track_file(track_id, "audio.flac")
    return FileResponse(path, media_type="audio/flac", filename=f"{track_id}.flac" if download else None)


@app.get("/api/tracks/{track_id}/audio.mp3")
def track_mp3(track_id: str):
    """320 kbps MP3, encoded from the FLAC on first request and cached next to it."""
    mp3 = ensure_mp3(_track_file(track_id, "audio.flac").parent)
    return FileResponse(mp3, media_type="audio/mpeg", filename=f"{track_id}.mp3")


@app.get("/api/tracks/{track_id}/score.abc")
def track_score(track_id: str):
    return FileResponse(_track_file(track_id, "score.abc"), media_type="text/plain; charset=utf-8",
                        filename=f"{track_id}.abc")


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    try:
        engine.delete(track_id)
    except FileNotFoundError:
        raise HTTPException(404, "Track not found")
    return {"ok": True}


@app.websocket("/api/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    presence.clients += 1
    presence.ever_connected = True
    last = None
    try:
        while True:
            snapshot = json.dumps(engine.snapshot())
            if snapshot != last:
                await socket.send_text(snapshot)
                last = snapshot
            try:  # also notices a closed socket promptly
                await asyncio.wait_for(socket.receive_text(), timeout=0.5)
            except asyncio.TimeoutError:
                pass
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        presence.clients -= 1
        presence.last_seen = time.time()


if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")


def main():
    global server
    # pythonw has no console; keep logs in a file.
    if sys.stdout is None or sys.stderr is None:
        (ROOT / "logs").mkdir(exist_ok=True)
        log = open(ROOT / "logs" / "backend.log", "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr = log
    # Windows' proactor loop logs a ConnectionResetError traceback whenever a tab closes abruptly.
    logging.getLogger("asyncio").setLevel(logging.CRITICAL)
    engine.start()
    threading.Thread(target=presence.watch, name="presence", daemon=True).start()
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=PORT, log_level="warning", access_log=False))
    server.run()


if __name__ == "__main__":
    main()
