@echo off
chcp 65001 >nul
rem L4-lite: validate BPMN with Flowable's own converter + process validator.
rem Needs: node scripts\fetch-flowable.js (downloads jars into .cache\flowable)
rem Usage: flowable-check.cmd <file.bpmn> [...]
if "%~1"=="" (
  echo usage: flowable-check.cmd ^<file.bpmn^> [...]
  echo   first run: node scripts\fetch-flowable.js
  exit /b 2
)
setlocal
set JARDIR=..\.cache\flowable
if not exist "%JARDIR%" (
  echo [ERR] jars not found: %JARDIR%
  echo       run: node scripts\fetch-flowable.js
  exit /b 2
)
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -cp "%JARDIR%\*" "tools\flowable-check\FlowableCheck.java" %*
exit /b %errorlevel%
