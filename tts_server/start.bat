@echo off
cd /d "%~dp0"
echo ============================================================
echo  Character.Mind Voice AI
echo  Free local voice cloning -- no API keys, no subscriptions
echo ============================================================
echo.
echo  Voice samples folder: %~dp0voices\
echo  Drop any character .wav file in the voices\ folder,
echo  then restart this server to use it.
echo.
echo  First run will download the XTTS-v2 model (~1.8 GB).
echo.
set TTS_MODEL=xtts_v2
python tts_server.py
pause
