@echo off
title PlexurioMail
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   1^) Install the LTS version from https://nodejs.org
  echo   2^) Then double-click this start.bat again.
  echo.
  pause
  exit /b
)
if not exist node_modules (
  echo Installing dependencies ^(one-time, may take a minute^)...
  call npm install
)
if not exist .env copy .env.example .env >nul
echo.
echo   Starting PlexurioMail...
echo   Your browser will open at http://localhost:3000
echo   Keep this window open while you use the app. Close it to stop.
echo.
start "" http://localhost:3000
call npm start
pause
