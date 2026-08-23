@echo off
echo Starting Share 0n Land services on network...
echo.
echo This will open 3 terminal windows:
echo   1. Backend
echo   3. Frontend
echo.
timeout /t 2

REM Get the directory where this script is located
cd /d "%~dp0"

REM Start Backend in new window
echo Starting Backend...
start "Backend" cmd /k "cd backend && npm start"
timeout /t 2

REM Start Manager Frontend in new window
echo Starting Manager...
start "Frontend" cmd /k "cd frontend && npm run dev"
timeout /t 2
