@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
"%PY%" -u run3d.py %*
echo.
echo Videos: motion_ref\out\start_3d.mp4 / ask_3d.mp4 / check_3d.mp4 (and start_three3d.mp4 for the three.js version)
pause
