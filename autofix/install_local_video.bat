@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Python: %PY%
echo.
echo Step 1/2: check NVIDIA GPU
nvidia-smi
if errorlevel 1 (
  echo.
  echo No NVIDIA GPU / driver found. Local video model needs an NVIDIA card. Code drafts still work without it.
  pause
  exit /b 1
)
echo.
echo Step 2/2: install PyTorch CUDA 12.4 + diffusers (about 3GB download)
"%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
"%PY%" -m pip install -U diffusers transformers accelerate sentencepiece protobuf imageio imageio-ffmpeg
echo.
"%PY%" -u draft_video.py --gpu
echo.
echo The model (Lightricks/LTX-Video, about 20GB) downloads the first time you make a local draft.
echo If the download is slow, run:  setx HF_ENDPOINT https://hf-mirror.com   then reopen the studio.
pause
