# Adds "YuE2 Studio" to the Start menu (then right-click it there -> Pin to Start / Pin to taskbar).
#   -Desktop    also put a shortcut on the desktop
#   -Uninstall  remove the Start menu and desktop shortcuts (files and models are left in place)
param([switch]$Desktop, [switch]$Uninstall)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "YuE2 Studio.exe"
$name = "YuE2 Studio.lnk"
$programs = [Environment]::GetFolderPath("Programs")
$desktopDir = [Environment]::GetFolderPath("Desktop")

if ($Uninstall) {
    foreach ($path in @((Join-Path $programs $name), (Join-Path $desktopDir $name))) {
        if (Test-Path $path) { Remove-Item $path; Write-Host "Removed $path" }
    }
    return
}

if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot "build-launcher.ps1") }

$targets = @($programs)
if ($Desktop) { $targets += $desktopDir }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in $targets) {
    $path = Join-Path $folder $name
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $exe
    $link.Arguments = ""
    $link.WorkingDirectory = $root
    $link.IconLocation = "$exe,0"
    $link.Description = "Local music generation with YuE2"
    $link.Save()
    Write-Host "Created $path"
}
