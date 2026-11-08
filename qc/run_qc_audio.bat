@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import imageio_ffmpeg" 2>/dev/null || "%PY%" -m pip install imageio-ffmpeg
echo Checking voice lines and sound effects (Gemini is used if GEMINI_API_KEY is set; needs the proxy)...
"%PY%" -u qc_audio.py "..\moban_game" %* > qc_audio_log.txt 2>&1
type qc_audio_log.txt
if exist out\audio_report.html start "" out\audio_report.html
pause
