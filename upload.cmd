@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  FFBot Devvit - ONE-TIME upload
echo ============================================
echo.
echo `devvit init` marks this folder as an app locally.
echo `devvit upload` is what actually creates the app on Reddit.
echo That is the step that was missing.
echo.
echo The app uploads as PRIVATE, visible only to you. This is NOT
echo publishing it for public use - that is a separate step later.
echo.
echo If it says the app NAME is taken, press Ctrl-C and tell Claude.
echo.
pause

call npx devvit upload
if errorlevel 1 (
  echo.
  echo Upload failed. Copy the output above and send it to Claude.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Uploaded. Now double-click playtest.cmd
echo ============================================
pause
