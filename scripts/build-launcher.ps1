# Compiles launcher\YuE2Studio.cs into "YuE2 Studio.exe" (with assets\app.ico embedded) using the
# .NET Framework C# compiler that ships with Windows; no SDK needed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc (.NET Framework 4 is part of Windows)." }
$out = Join-Path $root "YuE2 Studio.exe"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/win32icon:$(Join-Path $root 'assets\app.ico')" "/out:$out" `
    /reference:System.Windows.Forms.dll (Join-Path $root "launcher\YuE2Studio.cs")
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed" }
Write-Host "Built $out"
