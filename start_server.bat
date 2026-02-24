@echo off
chcp 65001 >nul
title Bilal Downloader Server
echo.
echo ========================================
echo   Bilal Downloader - تثبيت وتشغيل
echo ========================================
echo.

:: فحص Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python غير مثبت!
    echo حمله من: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

:: فحص وتثبيت yt-dlp
echo 📦 فحص yt-dlp...
pip show yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo 📥 تثبيت yt-dlp...
    pip install yt-dlp
    echo.
)

:: تحديث yt-dlp
echo 🔄 تحديث yt-dlp لآخر نسخة...
pip install -U yt-dlp >nul 2>&1

echo.
echo ✅ كل شي جاهز! جاري تشغيل السيرفر...
echo.

:: تشغيل السيرفر
python "%~dp0download_server.py"

pause
