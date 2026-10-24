@echo off
chcp 65001 >nul
rem Validate a BPMN file against the official BPMN 2.0 XSD (needs JDK 11+, no build tools).
rem Usage: validate-xsd.cmd <file.bpmn>
if "%~1"=="" (
  echo usage: validate-xsd.cmd ^<file.bpmn^>
  echo   first run: node scripts\fetch-schema.js
  exit /b 2
)
java "%~dp0tools\xsd-validate\Validate.java" "%~1" "%~dp0..\.cache\schema\bpmn20"
exit /b %errorlevel%
