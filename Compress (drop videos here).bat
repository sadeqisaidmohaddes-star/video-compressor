@echo off
setlocal EnableDelayedExpansion
title Smart Video Compressor

REM Drag-and-drop wrapper for Compress-Video.ps1
REM Drop one or more video files (or a folder) onto this .bat to compress them.

if "%~1"=="" (
    echo.
    echo   Smart Video Compressor
    echo   ----------------------
    echo   Drag one or more video files - or a folder - onto this file.
    echo.
    echo   For more control, run from PowerShell:
    echo     .\Compress-Video.ps1 -Source "clip.mp4" -Level small -Dedupe aggressive
    echo.
    pause
    exit /b
)

:loop
if "%~1"=="" goto done
echo.
echo Processing: %~1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Compress-Video.ps1" -Source "%~1"
shift
goto loop

:done
echo.
echo ============================================
echo  All done. Compressed files end in ".compressed.mp4"
echo ============================================
pause
