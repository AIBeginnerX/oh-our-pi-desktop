@echo off
rem Double-click to build the OOP Windows installer and publish it to release\windows.
rem pushd maps a temporary drive when this folder is opened from a \\host\share path.
pushd "%~dp0.."
node scripts\windows.mjs package %*
set BUILD_EXIT=%ERRORLEVEL%
popd
pause
exit /b %BUILD_EXIT%
