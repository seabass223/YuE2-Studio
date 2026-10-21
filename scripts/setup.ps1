# Installs YuE2 Studio. Safe to re-run (finished steps are quick the second time).
#   - Python 3.12 venv with CUDA PyTorch + yue2-infer + FastAPI
#   - YuE2-3B and YuE2-Vae weights (~7.8 GB) and the vocal check (~410 MB) into .\models
#   - Import from audio: Python 3.11 venv (.venv-sheetsage2, ~7 GB) with SheetSage2 and its
#     MERT-v2 encoder (~2.8 GB) into .\models
#   - Web app build + icons
#   - "YuE2 Studio.exe" launcher and Start menu entry
# Double-click Install.cmd in the root folder to run it. -Pause keeps the window open at the end.
param([switch]$Pause, [switch]$Desktop)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"
# SheetSage2 pins torch 2.8 / transformers 4.45 and Python 3.10-3.11, so it gets its own venv.
$ssVenv = Join-Path $root ".venv-sheetsage2"
$ssPython = Join-Path $ssVenv "Scripts\python.exe"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Check { if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" } }
function Require($command, $hint) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command was not found. $hint" }
}

$failed = $false
try {
    Step "Checking prerequisites"
    Require "py" "Install Python 3.12 from https://www.python.org/downloads/ (includes the 'py' launcher)."
    Require "npm" "Install Node.js LTS from https://nodejs.org/."
    py -3.12 --version; Check
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

    if (-not (Test-Path $python)) {
        Step "Creating Python 3.12 virtual environment"
        py -3.12 -m venv $venv; Check
    }

    Step "Installing PyTorch (CUDA 12.8) and YuE2"
    & $python -m pip install --upgrade pip; Check
    & $python -m pip install torch==2.10.0 torchaudio==2.10.0 --index-url https://download.pytorch.org/whl/cu128; Check
    & $python -m pip install -r (Join-Path $root "backend\requirements.txt"); Check

    Step "Downloading model weights (skipped if present)"
    Push-Location (Join-Path $root "backend")
    try {
        & $python -c "import engine, vocal_check; engine.models_present() or engine.download_models(); vocal_check.downloaded() or vocal_check.load(); print('models ok')"; Check
    } finally { Pop-Location }

    Step "Installing Import from audio (SheetSage2: Python 3.11, PyTorch 2.8, ~2.8 GB of weights)"
    if (-not (Test-Path $ssPython)) {
        cmd /c "py -3.11 --version >nul 2>&1"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Python 3.11 not found; installing it with the Python install manager"
            py install 3.11
            if ($LASTEXITCODE -ne 0) { throw "Python 3.11 is needed for Import from audio. Install it from https://www.python.org/downloads/ and run this again." }
        }
        py -3.11 -m venv $ssVenv; Check
    }
    & $ssPython -m pip install --upgrade pip; Check
    & $ssPython -m pip install huggingface-hub==0.36.0; Check
    & $ssPython (Join-Path $root "backend\sheetsage2_worker.py") download; Check
    & $ssPython -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126; Check
    & $ssPython -m pip install -r (Join-Path $root "models\SheetSage2\requirements.txt"); Check
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Write-Host "Import from audio decodes files with FFmpeg, which isn't on PATH. Install it with: winget install Gyan.FFmpeg" -ForegroundColor Yellow
    }

    Step "Building the web app"
    Push-Location (Join-Path $root "frontend")
    try {
        npm ci; Check
        npm run icons; Check
        npm run build; Check
    } finally { Pop-Location }

    Step "Building YuE2 Studio.exe"
    & (Join-Path $PSScriptRoot "build-launcher.ps1")

    Step "Adding YuE2 Studio to the Start menu"
    & (Join-Path $PSScriptRoot "install-shortcut.ps1") -Desktop:$Desktop

    Write-Host "`nDone. Open Start, find 'YuE2 Studio', right-click it -> Pin to Start." -ForegroundColor Green
} catch {
    $failed = $true
    Write-Host "`nSetup failed: $_" -ForegroundColor Red
}
if ($Pause) { Read-Host "`nPress Enter to close" | Out-Null }
if ($failed) { exit 1 }
