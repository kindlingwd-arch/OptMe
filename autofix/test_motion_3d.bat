@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
rem G: render the three.js previs, then use it as the reference video
"%PY%" -c "import playwright" 2>nul || "%PY%" -m pip install playwright
pushd ..\motion_ref
"%PY%" -u three_ref.py ask
popd
"%PY%" -u test_motion.py ask --variants G %*
echo.
pause
