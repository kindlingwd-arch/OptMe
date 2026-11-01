@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo 用 GPT(Codex) 画精绘 SVG 草图，结果在 storyboard\sketch\gpt\
"%PY%" -u gpt_svg.py %*
pause
