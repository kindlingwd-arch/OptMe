@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Storyboard batch: Gemini draws ~38 shots, checks each one, redraws failures, installs into the game.
echo Needs the proxy (US/JP exit). Takes about 1-2 hours. Budget: IMG_BUDGET_USD (default 15).
"%PY%" -u batch.py %* > batch_log.txt 2>&1
type batch_log.txt
if exist out\batch\report.html start "" out\batch\report.html
pause
