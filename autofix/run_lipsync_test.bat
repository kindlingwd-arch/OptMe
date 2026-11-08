@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Lip-sync test on "ride" with sync.so (needs SYNC_API_KEY)...
"%PY%" -u autofix\lipsync.py ride > autofix\log_lipsync.txt 2>&1
type autofix\log_lipsync.txt
if exist autofix\lipsync\ride_preview.mp4 start "" autofix\lipsync\ride_preview.mp4
pause
