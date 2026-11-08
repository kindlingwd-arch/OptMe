@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo More mature voice candidates + Gemini ranking (needs the proxy)...
"%PY%" -u autofix\pick_audio.py > autofix\log_pick.txt 2>&1
type autofix\log_pick.txt
if exist autofix\audition\pick.html start "" autofix\audition\pick.html
pause
