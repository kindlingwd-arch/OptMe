@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo 框选修图：浏览器会自动打开。需要代理和 Gemini 额度。用完关掉这个窗口。
"%PY%" -u fix_box.py
pause
