@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Storyboard pilot: 5 shots, Gemini vs MiniMax (needs the proxy, US/JP exit node)...
"%PY%" -u gen_images.py --engines gemini,minimax --only ride_00,together_00,check_00,start_05,speed_03 > pilot_log.txt 2>&1
type pilot_log.txt
if exist out\compare.html start "" out\compare.html
pause
