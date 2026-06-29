@echo off
title Smart Video Compressor (web)
echo ============================================================
echo   Smart Video Compressor  -  http://localhost:5050
echo ------------------------------------------------------------
echo   Keep this window OPEN while you use the compressor.
echo   Close it to stop the local server.
echo ============================================================
echo.
REM Open the browser, then start the static server (serves web\ with the
REM COOP/COEP headers from serve.json that ffmpeg.wasm requires).
start "" http://localhost:5050/
npx --yes serve -l 5050 "%~dp0web"
