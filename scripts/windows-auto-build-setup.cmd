@echo off
rem Double-click once on the Windows build PC: from then on a newer OoP version in this folder
rem is built and published to release\windows automatically every 10 minutes while you are signed in.
rem To stop it, run: node scripts\windows.mjs unschedule
pushd "%~dp0.."
node scripts\windows.mjs schedule
set SETUP_EXIT=%ERRORLEVEL%
popd
pause
exit /b %SETUP_EXIT%
