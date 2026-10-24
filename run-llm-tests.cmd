@echo off
chcp 65001 >nul
rem Launcher: batch regression against the real LLM (needs Key in this window)
rem ASCII only in this file - cmd reads the batch before chcp takes effect.
rem   run-llm-tests.cmd          real calls
rem   run-llm-tests.cmd --mock   self-test, no network
node "%~dp0scripts\llm-batch.js" %*
exit /b %errorlevel%
