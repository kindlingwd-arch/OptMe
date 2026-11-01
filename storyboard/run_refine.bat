@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Refining storyboard images that did not pass: check - local edit (or redraw) - check again. Needs the proxy.
echo Manual: run_refine.bat ride_00 "your change request"   (add --force to install even if QC still complains)
"%PY%" -u refine.py %* > refine_log.txt 2>&1
type refine_log.txt
pause
