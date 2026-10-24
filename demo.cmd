@echo off
chcp 65001 >nul
title BPMN Generator - local app
setlocal
cd /d "%~dp0"

set PORT=8099
set URL=http://127.0.0.1:%PORT%/

rem --- 1) If the port is already serving, just open the browser ---
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Server already running on port %PORT%.
  echo Opening %URL%
  start "" explorer %URL%
  echo.
  echo If the page does not load, press F5 after a second.
  timeout /t 3 >nul
  exit /b 0
)

rem --- 2) Open the browser a few seconds later, then run the server in foreground ---
echo Starting server, browser will open in ~3s ...
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & explorer %URL%"

node web\serve.js %PORT%
set CODE=%errorlevel%

echo.
if %CODE%==0 (
  echo Server stopped normally.
) else (
  echo Server exited with code %CODE%.
  echo - If it says EADDRINUSE, port %PORT% is taken. Try: node web\serve.js 8100
  echo - If it says cannot find module, check web\node_modules exists.
)
pause
exit /b %CODE%
