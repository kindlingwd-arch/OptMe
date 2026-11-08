@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo [1/2] Woman voice audition (MiniMax)...
"%PY%" -u autofix\voice_audition.py > autofix\log_audio_fix.txt 2>&1
echo [2/2] Re-making amb_check and amb_kitchen (ElevenLabs, needs the proxy)...
"%PY%" -u autofix\el_sfx2.py >> autofix\log_audio_fix.txt 2>&1
type autofix\log_audio_fix.txt
if exist autofix\audition\audition.html start "" autofix\audition\audition.html
pause
