@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
set "CODEX="
for /d %%B in ("%LOCALAPPDATA%\OpenAI\Codex\bin\*") do if exist "%%B\codex.exe" set "CODEX=%%B\codex.exe"
echo [1/3] speed first/last frames (Codex)...
if not exist "autofix\keys3\speed_a.png" "%CODEX%" exec -i "moban_game\img\speed.jpg" -i "refs\char_dajun.png" -i "refs\bg_highway.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_speed_a.txt" >> autofix\log_keys3.txt 2>&1
if exist "autofix\keys3\speed_a.png" if not exist "autofix\keys3\speed_b.png" "%CODEX%" exec -i "autofix\keys3\speed_a.png" -i "refs\char_dajun.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_speed_b.txt" >> autofix\log_keys3.txt 2>&1
echo [2/3] Shot-specific reference images for multi-image reference (Codex)...
"%PY%" -u autofix\make_refs.py
echo [3/3] Videos (H3 multi-image reference / first+last frame) - QC - retry...
set AUTOFIX_OUT=out_r3
if "%AUTOFIX_BUDGET%"=="" set AUTOFIX_BUDGET=30
"%PY%" -u autofix\autofix.py --redo together,speed,s_envelope,E_cover > autofix\log_round3b.txt 2>&1
type autofix\log_round3b.txt
if exist autofix\out_r3\autofix.html start "" autofix\out_r3\autofix.html
pause
