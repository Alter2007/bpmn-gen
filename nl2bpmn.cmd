@echo off
chcp 65001 >nul
rem Launcher: natural language -> BPMN (offline, no API key needed)
node "%~dp0bin\nl2bpmn.js" %*
exit /b %errorlevel%
