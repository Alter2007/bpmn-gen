@echo off
chcp 65001 >nul
rem L4: deploy and actually RUN process instances (Flowable + H2 in-memory).
rem Needs: node scripts\fetch-flowable-engine.js
rem Usage: flowable-run.cmd "<file.bpmn|amount=800>" ["<file.bpmn|amount=6000>"]
if "%~1"=="" (
  echo usage: flowable-run.cmd ^<file.bpmn^|var=value^> [...]
  echo   example: flowable-run.cmd "..\.data\out\travel-expense.bpmn|amount=800"
  exit /b 2
)
setlocal
set JARDIR=..\.cache\flowable-engine
if not exist "%JARDIR%" (
  echo [ERR] jars not found: %JARDIR%
  echo       run: node scripts\fetch-flowable-engine.js
  exit /b 2
)
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "%JARDIR%\*" "tools\flowable-run\FlowableRun.java" %*
exit /b %errorlevel%
