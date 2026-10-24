@echo off
chcp 65001 >nul
rem Render a .bpmn to SVG without a browser (reads the DI coordinates directly).
rem ASCII only + CRLF: cmd parsing requirement.
cd /d "%~dp0"
node scripts\bpmn2svg.js %*
exit /b %errorlevel%
