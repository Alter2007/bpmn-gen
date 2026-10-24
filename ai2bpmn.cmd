@echo off
chcp 65001 >nul
rem Launcher: natural language -> BPMN via LLM (needs DASHSCOPE_API_KEY in this window)
node "%~dp0bin\ai2bpmn.js" %*
exit /b %errorlevel%
