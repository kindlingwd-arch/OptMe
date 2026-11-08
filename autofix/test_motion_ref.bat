@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
rem F: use motion_ref\out\ask_svg.mp4 as the reference video
"%PY%" -u test_motion.py ask --variants F %*
echo.
pause
