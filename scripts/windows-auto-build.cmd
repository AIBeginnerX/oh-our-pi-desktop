@echo off
rem Run by the "OoP Windows Auto Build" scheduled task (see windows-auto-build-setup.cmd):
rem builds and publishes the installer when the source has a newer version than release\windows.
rem The log sits on the share next to release\windows so the progress can be read from any machine.
pushd "%~dp0.."
echo [%DATE% %TIME%] task started >> "release\windows-auto-build.log"
node scripts\windows.mjs auto >> "release\windows-auto-build.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo [%DATE% %TIME%] task finished with exit %BUILD_EXIT% >> "release\windows-auto-build.log"
popd
exit /b %BUILD_EXIT%
