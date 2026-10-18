"""Start the YuE2 Studio backend (if needed) and open it in a chromeless browser window.

Runs under the venv's pythonw.exe, so there is no console window. The backend exits on its
own ~20 s after the last page is closed.
"""
import ctypes
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

from backend import URL, BackendError, ensure_backend


def message(text, error=True):
    ctypes.windll.user32.MessageBoxW(None, text, "YuE2 Studio", 0x10 if error else 0x40)


def find_browser():
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Google/Chrome/Application/chrome.exe",
        local / "Google/Chrome/Application/chrome.exe",
    ]
    for path in candidates:
        if path.is_file():
            return str(path)
    return shutil.which("msedge") or shutil.which("chrome")


def main():
    try:
        ensure_backend()
    except BackendError as exc:
        message(str(exc))
        sys.exit(1)
    browser = find_browser()
    if browser:
        subprocess.Popen([browser, f"--app={URL}"], creationflags=subprocess.DETACHED_PROCESS)
    else:
        webbrowser.open(URL)


if __name__ == "__main__":
    main()
