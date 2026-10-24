@echo off
chcp 65001 >nul
rem Full verification pipeline (ASCII only in this file).
rem   1) unit tests   1.5) coverage specs   2) XSD cache   3) OMG XSD validation
rem   4) Flowable jars   5) Flowable engine parse+validate   6) L4 real instance run
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [1/6] unit tests ...
node test\run.js
if errorlevel 1 goto fail

echo.
echo [1.5/6] generate per-template coverage specs ...
node scripts\coverage-specs.js
if errorlevel 1 goto fail

echo.
echo [2/6] ensure BPMN 2.0 XSD cached ...
node scripts\fetch-schema.js
if errorlevel 1 goto fail

echo.
echo [3/6] official OMG XSD validation ...
set XSDDIR=..\.cache\schema\bpmn20
set COUNT=0
for %%f in ("..\.data\out\*.bpmn") do (
  java "tools\xsd-validate\Validate.java" "%%f" "%XSDDIR%"
  if errorlevel 1 goto fail
  set /a COUNT+=1
)
echo   validated: !COUNT! files

echo.
echo [4/6] ensure Flowable jars ...
node scripts\fetch-flowable.js
if errorlevel 1 goto fail

echo.
echo [5/6] Flowable engine parse + process validation ...
set JARDIR=..\.cache\flowable
set ARGS=
for %%f in ("..\.data\out\*.bpmn") do set ARGS=!ARGS! "%%f"
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "%JARDIR%\*" "tools\flowable-check\FlowableCheck.java" !ARGS!
if errorlevel 1 goto fail

echo.
echo [6/6] L4 real instance run (deploy + execute + path assertions) ...
node scripts\fetch-flowable-engine.js
if errorlevel 1 goto fail
set RUNJARS=..\.cache\flowable-engine
set OUTDIR=..\.data\out
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "%RUNJARS%\*" "tools\flowable-run\FlowableRun.java" ^
  "%OUTDIR%\travel-expense.bpmn|amount=800|expect=Task_Submit>Task_Manager" ^
  "%OUTDIR%\travel-expense.bpmn|amount=2500|expect=Task_Submit>Task_Director" ^
  "%OUTDIR%\travel-expense.bpmn|amount=6000|expect=Task_Submit>Task_Finance" ^
  "%OUTDIR%\leave-request.bpmn|days=2|expect=Task_Fill>Task_Leader" ^
  "%OUTDIR%\leave-request.bpmn|days=9|expect=Task_Fill>Task_HR" ^
  "%OUTDIR%\contract-review.bpmn|expectcontains=Task_Legal,Task_Finance,Task_Business" ^
  "%OUTDIR%\travel-reject.bpmn|amount=800|expect=Task_Submit>Task_Level1" ^
  "%OUTDIR%\travel-reject.bpmn|amount=800,approved=false|expectprefix=Task_Submit>Task_Level1>Task_Submit" ^
  "%OUTDIR%\travel-reject.bpmn|amount=6000,approved=false|expectprefix=Task_Submit>Task_Finance>Task_Submit" ^
  "%OUTDIR%\mi-all.bpmn|approvers=u1+u2+u3|expect=Task_Submit>Task_Sign>Task_Sign>Task_Sign" ^
  "%OUTDIR%\mi-all.bpmn|approvers=u1+u2|expect=Task_Submit>Task_Sign>Task_Sign" ^
  "%OUTDIR%\mi-any.bpmn|approvers=u1+u2+u3|expect=Task_Submit>Task_Sign"
if errorlevel 1 goto fail

echo.
echo   ---- coverage: every template, every branch ----
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "%RUNJARS%\*" "tools\flowable-run\FlowableRun.java" "%OUTDIR%\coverage-specs.txt"
if errorlevel 1 goto fail

echo.
echo ALL GREEN
exit /b 0

:fail
echo.
echo FAILED
exit /b 1
