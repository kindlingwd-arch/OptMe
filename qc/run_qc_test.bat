@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import imageio_ffmpeg" 2>nul || "%PY%" -m pip install imageio-ffmpeg
echo Checking videos (Gemini is used if GEMINI_API_KEY is set; needs the proxy)...
"%PY%" -u qc.py "..\moban_game" --refs "..\refs" --only together,E_truth > qc_log.txt 2>&1
type qc_log.txt
if exist out\report.html start "" out\report.html
pause
