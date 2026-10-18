@echo off
rem Removes the YuE2 Studio Start menu and desktop shortcuts. Your songs, models and this folder are kept;
rem delete the folder afterwards to remove everything.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-shortcut.ps1" -Uninstall
pause
