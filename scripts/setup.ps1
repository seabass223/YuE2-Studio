# Installs YuE2 Studio. Safe to re-run (finished steps are quick the second time).
#   - Python 3.12 venv with CUDA PyTorch + yue2-infer + FastAPI
#   - YuE2-3B and YuE2-Vae weights (~7.8 GB) into .\models
#   - Web app build + icons
#   - "YuE2 Studio.exe" launcher and Start menu entry
# Double-click Install.cmd in the root folder to run it. -Pause keeps the window open at the end.
param([switch]$Pause, [switch]$Desktop)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"

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
    & $python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128; Check
    & $python -m pip install -r (Join-Path $root "backend\requirements.txt"); Check

    Step "Downloading model weights (skipped if present)"
    Push-Location (Join-Path $root "backend")
    try {
        & $python -c "import engine; engine.models_present() or engine.download_models(); print('models ok')"; Check
    } finally { Pop-Location }

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
