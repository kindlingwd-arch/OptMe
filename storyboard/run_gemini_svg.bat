@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo 用 Gemini 写精绘 SVG 草图（需要代理和 Gemini 额度），结果在 storyboard\sketch\gemini\
"%PY%" -u gemini_svg.py %*
pause
