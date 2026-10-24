@echo off
chcp 65001 >nul
rem Create the desktop shortcut by generating it on the fly (works on a fresh clone).
rem Kept ASCII-only + CRLF: cmd parsing requirement.
set HERE=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%create-shortcut.ps1"
echo.
echo Press any key to close.
pause >nul
