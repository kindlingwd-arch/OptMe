@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import playwright" 2>nul || "%PY%" -m pip install playwright
"%PY%" -c "import manim" 2>nul || "%PY%" -m pip install manim
echo ===== 1/4 SVG =====
"%PY%" -u svg_ref.py %*
echo ===== 2/4 Manim =====
"%PY%" -u manim_ref.py %*
echo ===== 3/4 Remotion =====
"%PY%" -u remotion_ref.py %*
echo ===== 4/4 three.js 3D =====
"%PY%" -u three_ref.py %*
"%PY%" compare.py %*
echo.
pause
