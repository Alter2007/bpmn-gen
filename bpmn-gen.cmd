@echo off
chcp 65001 >nul
rem Launcher: run bpmn-gen CLI (keeps console in UTF-8)
node "%~dp0bin\bpmn-gen.js" %*
exit /b %errorlevel%
