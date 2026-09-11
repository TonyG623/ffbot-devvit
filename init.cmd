@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  FFBot Devvit - ONE-TIME app registration
echo ============================================
echo.
echo This registers this folder as a Devvit app on your Reddit account.
echo A browser window will open to create the app and hand back a code.
echo.
echo   * If it asks for an app NAME, use:  ffbot
echo     ^(matches devvit.json, and the name is confirmed available^)
echo.
echo   * If it offers to pick a TEMPLATE, something is wrong - press Ctrl-C
echo     and tell Claude. This folder is already a project and should not
echo     be scaffolded over.
echo.
echo Your work is committed to git, so anything unexpected is recoverable
echo with:  git checkout .
echo.
pause

call npx devvit init
if errorlevel 1 (
  echo.
  echo Registration failed. Copy the output above and send it to Claude.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Registered. Now double-click playtest.cmd
echo ============================================
pause
