@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not defined IMG_BUDGET_USD set IMG_BUDGET_USD=25
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
set IDS=start_04 stop_00 speed_03 together_00 check_01 check_02 E_late_00 E_half_00 E_truth_00 E_truth_02
echo Redrawing 10 problem shots WITH composition sketches (storyboard\sketch\), then check-and-fix. Needs the proxy and Gemini credits.
"%PY%" -u batch.py %IDS% > sketch_fix_log.txt 2>&1
"%PY%" -u refine.py >> sketch_fix_log.txt 2>&1
type sketch_fix_log.txt
pause
