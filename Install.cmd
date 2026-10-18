@echo off
rem Sets up YuE2 Studio and adds it to the Start menu. Safe to run again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -Pause %*
