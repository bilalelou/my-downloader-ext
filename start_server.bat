@echo off
chcp 65001 >nul
title Bilal Downloader Server
echo.
echo ========================================
echo   Bilal Downloader - Setup & Start
echo ========================================
echo.

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python is not installed!
    echo Download it from: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

:: Check and install yt-dlp
echo 📦 Checking yt-dlp...
pip show yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo 📥 Installing yt-dlp...
    pip install yt-dlp
    echo.
)

:: Update yt-dlp
echo 🔄 Updating yt-dlp to latest version...
pip install -U yt-dlp >nul 2>&1

echo.
echo ✅ Everything is ready! Starting server...
echo.

:: Start server
python "%~dp0download_server.py"

pause
