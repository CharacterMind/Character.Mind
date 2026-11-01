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
echo  First run will download the F5-TTS model (~1.3 GB).
echo.
set TTS_MODEL=f5tts
python tts_server.py
pause
