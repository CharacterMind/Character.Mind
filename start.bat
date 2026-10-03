@echo off
echo Starting Character.Mind...
start "" "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8080
timeout /t 3 /nobreak >nul
node server.js
