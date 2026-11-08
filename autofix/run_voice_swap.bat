@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Re-voicing the woman with 热心大婶 + new police line (MiniMax, no proxy needed)...
"%PY%" -u autofix\voice_swap.py > autofix\log_voice_swap.txt 2>&1
type autofix\log_voice_swap.txt
pause
