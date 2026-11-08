@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
set "CODEX="
for /d %%B in ("%LOCALAPPDATA%\OpenAI\Codex\bin\*") do if exist "%%B\codex.exe" set "CODEX=%%B\codex.exe"
set "IMG=moban_game\img"
echo ===== %date% %time% ===== >> autofix\log_keys3.txt
echo [1/2] Fixing keyframes first (Codex, old keyframe + model sheets as references)...
if not exist "autofix\keys3\s_pager.png" "%CODEX%" exec -i "%IMG%\s_pager.jpg" -i "refs\char_woman.png" -i "refs\bg_interior.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_s_pager.txt" >> autofix\log_keys3.txt 2>&1
if not exist "autofix\keys3\together.png" "%CODEX%" exec -i "%IMG%\together.jpg" -i "refs\char_woman.png" -i "refs\char_dajun.png" -i "refs\char_driver.png" -i "refs\prop_case.png" -i "refs\bg_interior.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_together.txt" >> autofix\log_keys3.txt 2>&1
if not exist "autofix\keys3\speed_a.png" "%CODEX%" exec -i "%IMG%\speed.jpg" -i "refs\char_dajun.png" -i "refs\bg_highway.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_speed_a.txt" >> autofix\log_keys3.txt 2>&1
if exist "autofix\keys3\speed_a.png" if not exist "autofix\keys3\speed_b.png" "%CODEX%" exec -i "autofix\keys3\speed_a.png" -i "refs\char_dajun.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_speed_b.txt" >> autofix\log_keys3.txt 2>&1
if not exist "autofix\keys3\s_envelope.png" "%CODEX%" exec -i "%IMG%\s_envelope.jpg" -i "refs\char_woman.png" -i "refs\bg_interior.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_s_envelope.txt" >> autofix\log_keys3.txt 2>&1
if not exist "autofix\keys3\E_cover.png" "%CODEX%" exec -i "%IMG%\E_cover.jpg" -i "refs\char_woman.png" -i "refs\char_driver.png" -i "refs\prop_taxi.png" -i "refs\bg_railway.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys3\i_E_cover.txt" >> autofix\log_keys3.txt 2>&1
dir /b autofix\keys3\*.png
echo [2/2] Videos: generate - Gemini QC - retry (speed uses first + last frame)...
set AUTOFIX_OUT=out_r3
if "%AUTOFIX_BUDGET%"=="" set AUTOFIX_BUDGET=30
"%PY%" -u autofix\autofix.py %* > autofix\log_round3.txt 2>&1
type autofix\log_round3.txt
if exist autofix\out_r3\autofix.html start "" autofix\out_r3\autofix.html
pause
