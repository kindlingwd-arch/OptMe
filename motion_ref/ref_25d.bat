@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
if "%~1"=="" ("%PY%" -u scene25d.py start start_car ask) else ("%PY%" -u scene25d.py %*)
echo.
echo Videos: motion_ref\out\*_25d.mp4   Parameters: motion_ref\scenes\*.json
pause
