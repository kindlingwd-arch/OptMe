@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
echo Install the depth model runtime: onnxruntime (about 15MB, CPU, no PyTorch needed) + OpenCV
"%PY%" -m pip install -U onnxruntime opencv-python huggingface_hub
echo.
echo The depth model (Depth-Anything-V2-Small ONNX, about 100MB) downloads on first use.
echo If it is slow:  setx HF_ENDPOINT https://hf-mirror.com   then reopen this window / the studio.
echo Blender: write the full path of blender.exe into motion_ref\blender_path.txt if it is not in the default folder.
pause
