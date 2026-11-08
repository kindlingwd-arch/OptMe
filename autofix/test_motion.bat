@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
"%PY%" -u test_motion.py %*
echo.
echo (log: autofix\test_motion\ask\log.txt)
pause
