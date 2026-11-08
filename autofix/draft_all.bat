@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
if "%~1"=="" ("%PY%" -u draft_video.py --all) else ("%PY%" -u draft_video.py %*)
echo.
echo Drafts are in moban_game\vid_draft\ . In the studio preview, switch the mode to "草稿".
pause
