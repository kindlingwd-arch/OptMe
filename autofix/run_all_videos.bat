@echo off
chcp 65001 >nul
setlocal
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -u "%~dp0run_all_videos.py" --run %*
set "RESULT=%ERRORLEVEL%"
echo.
echo Finished. Exit code: %RESULT%
pause
exit /b %RESULT%
