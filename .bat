@echo off
echo Starting LAN-CHAT services on network...
echo.
timeout /t 2

REM Get the directory where this script is located
cd /d "%~dp0"

REM Start Backend in new window
echo Starting Backend...
start "Backend" cmd /k "cd backend && npm start"
timeout /t 2

REM Start Frontend in new window
echo Starting Frontend...
start "Frontend" cmd /k "cd frontend && npm run dev"
timeout /t 2
