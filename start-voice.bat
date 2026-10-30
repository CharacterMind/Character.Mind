@echo off
title Poppy Voice Server
color 0A
echo.
echo  =============================================
echo   Character.Mind - Poppy Voice Server
echo  =============================================
echo.
echo  This runs Poppy's voice cloning on YOUR PC
echo  and creates a tunnel so Render can use it.
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found. Install from python.org first.
    pause
    exit /b 1
)

:: Install Python requirements if needed
echo  [1/3] Checking Python requirements...
pip install -q -r tts_server\requirements.txt
if errorlevel 1 (
    echo  WARNING: Some requirements failed to install.
)

:: Start tts_server.py in a new window
echo  [2/3] Starting Poppy voice model (first load takes ~30s)...
start "Poppy TTS Model" cmd /c "python tts_server\tts_server.py && pause"

:: Wait for it to be ready
echo  Waiting for model to load...
:wait_loop
timeout /t 3 /nobreak >nul
python -c "import urllib.request; urllib.request.urlopen('http://localhost:8765/health', timeout=2)" >nul 2>&1
if errorlevel 1 goto wait_loop
echo  Model is ready!

:: Download cloudflared if not present (free tunnel, no account needed)
echo  [3/3] Starting free tunnel...
if not exist cloudflared.exe (
    echo  Downloading cloudflared tunnel tool...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
    if errorlevel 1 (
        echo  Could not download cloudflared. Try manually: https://github.com/cloudflare/cloudflared/releases
        pause
        exit /b 1
    )
)

echo.
echo  =============================================
echo   Starting tunnel to localhost:8765...
echo   Copy the URL below and set it on Render:
echo.
echo   Render Dashboard ^> charactermind ^>
echo   Environment ^> TTS_CLONE_URL ^= [the URL]
echo  =============================================
echo.

cloudflared.exe tunnel --url http://localhost:8765

pause
