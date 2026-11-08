@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
set LOG=out\qc_test_log.txt
echo Running checks (about $0.20, 3-5 minutes). Results also saved to storyboard\%LOG%
echo ==== 1. single-image QC (new item 7: people and objects) ==== > %LOG%
"%PY%" qc_check.py ask_03 ride_01 ride_04 road_02 speed_00 together_01 E_half_00 E_half_01 >> %LOG% 2>&1
echo. >> %LOG%
echo ==== 2. continuity: prompts ==== >> %LOG%
"%PY%" continuity.py prompt start ask ride E_half >> %LOG% 2>&1
echo. >> %LOG%
echo ==== 3. continuity: images ==== >> %LOG%
"%PY%" continuity.py image start ask ride E_half >> %LOG% 2>&1
type %LOG%
pause
