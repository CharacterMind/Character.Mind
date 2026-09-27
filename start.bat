@echo off
echo Starting CharacterMind AI Chat Site...
cd /d D:\AICharacterSite
if not exist node_modules (
    echo Installing packages...
    npm install
)
echo.
echo Site is running at: http://localhost:8080
echo Open that URL in your browser to use the site.
echo Press Ctrl+C to stop the server.
echo.
node server.js
pause
