@echo off
title Smart Video Compressor (FAST - native FFmpeg)
echo ============================================================
echo   Smart Video Compressor  -  FAST (native FFmpeg)
echo   http://127.0.0.1:5060
echo ------------------------------------------------------------
echo   Keep this window OPEN while you use the compressor.
echo   Close it to stop the server.
echo ============================================================
echo.
echo Starting engine (detecting encoders)... the browser opens when ready.
echo.
REM The server opens the browser itself once it is actually listening.
set OPEN_BROWSER=1
node "%~dp0server\server.mjs"
