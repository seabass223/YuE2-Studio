"""Find or start the YuE2 Studio backend. Shared by launch.pyw and mcp_stdio.py."""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("YUE2_PORT", "7862"))
URL = f"http://127.0.0.1:{PORT}"
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"


class BackendError(RuntimeError):
    pass


def backend_state():
    """'ours' if YuE2 Studio answers, 'other' if something else holds the port, None if free."""
    try:
        with urllib.request.urlopen(f"{URL}/api/health", timeout=1) as response:
            return "ours" if json.load(response).get("app") == "yue2-studio" else "other"
    except urllib.error.HTTPError:
        return "other"
    except (OSError, ValueError):
        return None


def start_backend():
    """Start the backend detached (it outlives the caller) and wait until it answers."""
    if not PYTHONW.exists() or not (ROOT / "frontend" / "dist" / "index.html").exists():
        raise BackendError("YuE2 Studio is not set up yet.\n\nDouble-click Install.cmd in the YuE2 Studio folder first.")
    (ROOT / "logs").mkdir(exist_ok=True)
    log = open(ROOT / "logs" / "backend.log", "w", encoding="utf-8")
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    command = [str(PYTHONW), str(ROOT / "backend" / "server.py")]
    try:
        # MCP clients often run stdio servers in a kill-on-close job; leave it when that is allowed so
        # the backend (and any studio page using it) outlives the client.
        subprocess.Popen(command, cwd=ROOT / "backend", stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
    except OSError:  # the job forbids breakaway: the backend stops when the client does
        subprocess.Popen(command, cwd=ROOT / "backend", stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         creationflags=flags, close_fds=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        if backend_state() == "ours":
            return
        time.sleep(0.3)
    raise BackendError(f"The backend did not start within 60 seconds.\n\nSee {ROOT / 'logs' / 'backend.log'}")


def ensure_backend():
    state = backend_state()
    if state == "other":
        raise BackendError(f"Port {PORT} is in use by another program.\nSet YUE2_PORT to a free port and try again.")
    if state is None:
        start_backend()
