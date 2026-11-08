@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
set "CODEX="
for /d %%B in ("%LOCALAPPDATA%\OpenAI\Codex\bin\*") do if exist "%%B\codex.exe" set "CODEX=%%B\codex.exe"
echo ===== %date% %time% ===== >> autofix\log_keys.txt
if not exist "autofix\keys\check.png" (
  echo [1/2] Drawing new keyframe: check ...
  "%CODEX%" exec -i "refs\char_police.png" -i "refs\char_driver.png" -i "refs\prop_taxi.png" -i "refs\bg_checkpoint.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys\i_check.txt" >> autofix\log_keys.txt 2>&1
)
if not exist "autofix\keys\E_truth.png" (
  echo [1/2] Drawing new keyframe: E_truth ...
  "%CODEX%" exec -i "refs\char_woman.png" -i "refs\char_dajun.png" -i "refs\char_police.png" -i "refs\prop_case.png" -i "refs\bg_checkpoint.png" --skip-git-repo-check -c model_reasoning_effort="low" -s workspace-write --add-dir "%USERPROFILE%\.codex" - < "autofix\keys\i_E_truth.txt" >> autofix\log_keys.txt 2>&1
)
echo [2/2] Auto re-shoot: generate - QC - retry (max 1 retry, 2 attempts total, budget AUTOFIX_BUDGET, default 20 yuan)...
"%PY%" -u autofix\autofix.py %* > autofix\log_autofix.txt 2>&1
type autofix\log_autofix.txt
if exist autofix\out\autofix.html start "" autofix\out\autofix.html
pause
