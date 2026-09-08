@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  FFBot Devvit - playtest on r/ffbottest
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node is not on PATH.
  echo Close this window, open a NEW terminal after installing Node, and retry.
  pause
  exit /b 1
)

echo Node version:
node --version
echo.

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 goto fail

echo.
echo [2/4] Verifying locally ^(types + tests + bundle^)...
call npm test
if errorlevel 1 (
  echo.
  echo Local verification FAILED. Not deploying a broken build.
  echo Send the output above to Claude.
  pause
  exit /b 1
)

echo.
echo [3/4] Logging in to Devvit ^(a browser window will open^)...
call npx devvit login
if errorlevel 1 goto fail

echo.
echo [4/4] Starting playtest on r/ffbottest...
echo.
echo   Leave this window OPEN. It streams logs and hot-reloads.
echo   Trigger a run now from the r/ffbottest subreddit menu:
echo       [FFBot] Run cycle now
echo.
echo   Watch for:   SUBMITTING THREAD ...
echo   Then run it a SECOND time and confirm you see:
echo                ALREADY SUBMITTED, USING: ...
echo   ^(a duplicate post there would be a real bug^)
echo.
echo   Ctrl-C to stop. Copy this window's output back to Claude.
echo.
call npx devvit playtest r/ffbottest
goto end

:fail
echo.
echo A step failed. Copy the output above and send it to Claude.

:end
echo.
pause
