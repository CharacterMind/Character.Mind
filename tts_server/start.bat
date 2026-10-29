@echo off
cd /d "%~dp0"
echo Starting Character.Mind voice clone TTS server...
echo First run will download the XTTS-v2 model (~1.8 GB). Please wait.
python tts_server.py
pause
