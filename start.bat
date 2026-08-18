:: CII Logistics Platform - India Post Bulk Tracker Launcher
@echo off
title India Post Bulk Tracker - CII
color 0A
echo.
echo  ================================================
echo   India Post Bulk Tracker - CII — Starting...
echo  ================================================
echo.
cd /d "%~dp0"

:: Check if node_modules exists
if not exist node_modules (
    echo  Installing dependencies, please wait...
    npm install
    echo.
)

echo  Starting server on http://localhost:3001
echo  Opening browser...
echo.
echo  Press Ctrl+C to stop the server.
echo.

node server.js
pause
