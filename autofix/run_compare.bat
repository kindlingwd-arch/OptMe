@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Comparing MiniMax-H3 vs Gemini Omni Flash on E_cover (needs the proxy; exit node must be US/JP etc.)...
"%PY%" -u autofix\compare_engines.py E_cover > autofix\log_compare.txt 2>&1
type autofix\log_compare.txt
if exist autofix\compare\E_cover.html start "" autofix\compare\E_cover.html
pause
