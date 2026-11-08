@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import manim" 2>nul || "%PY%" -m pip install manim
"%PY%" -u manim_ref.py %*
"%PY%" compare.py %*
echo.
pause
