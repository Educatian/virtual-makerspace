@echo off
setlocal
cd /d "%~dp0"
title Virtual Makerspace Quest Installer

echo ============================================================
echo   VIRTUAL MAKERSPACE - QUEST STUDENT INSTALLER
echo ============================================================
echo.
echo 1. Turn on the Quest headset.
echo 2. Connect it to this computer with a USB data cable.
echo 3. Put on the headset and select:
echo       Always allow from this computer ^> Allow
echo.
pause

set "ADB=%~dp0platform-tools\adb.exe"
set "APK=%~dp0VirtualMakerspace.apk"
set "DIAG=%~dp0VirtualMakerspace_Device_Diagnostics.txt"
if not exist "%ADB%" (
  echo ERROR: Bundled ADB was not found.
  pause
  exit /b 10
)
if not exist "%APK%" (
  echo ERROR: VirtualMakerspace.apk was not found.
  pause
  exit /b 11
)

"%ADB%" start-server >nul
set "DEVICE="
for /f "tokens=1,2" %%A in ('"%ADB%" devices') do (
  if "%%B"=="device" set "DEVICE=%%A"
)

if not defined DEVICE (
  echo.
  echo Quest is not authorized.
  echo Put on the headset, approve USB debugging, then run this file again.
  pause
  exit /b 20
)

echo.
echo Removing any older Virtual Makerspace installation and saved session...
"%ADB%" -s %DEVICE% shell am force-stop edu.ua.virtualmakerspace >nul 2>&1
"%ADB%" -s %DEVICE% uninstall edu.ua.virtualmakerspace >nul 2>&1

echo Installing a clean copy of Virtual Makerspace...
"%ADB%" -s %DEVICE% install "%APK%"
if errorlevel 1 (
  echo.
  echo Installation failed. Reconnect USB and try again.
  pause
  exit /b 30
)

echo Verifying immersive Quest manifest...
"%ADB%" -s %DEVICE% shell dumpsys package edu.ua.virtualmakerspace | findstr /C:"com.oculus.intent.category.VR" >nul
if errorlevel 1 (
  echo ERROR: Installed build is missing the Quest VR launch category.
  echo Do not continue testing. Send this message to the instructor.
  pause
  exit /b 31
)
for /f "tokens=2 delims==" %%V in ('"%ADB%" -s %DEVICE% shell dumpsys package edu.ua.virtualmakerspace ^| findstr /C:"versionName="') do set "VERSION=%%V"
if not "%VERSION%"=="1.0.7" (
  echo ERROR: Expected version 1.0.7, but the installed version is %VERSION%.
  echo Do not continue testing. Send this message to the instructor.
  pause
  exit /b 32
)
echo Verified: version %VERSION%, immersive Quest launch enabled.

echo Launching Virtual Makerspace directly in immersive VR...
"%ADB%" -s %DEVICE% logcat -c >nul 2>&1
"%ADB%" -s %DEVICE% shell am force-stop edu.ua.virtualmakerspace >nul
"%ADB%" -s %DEVICE% shell am start -S -a android.intent.action.MAIN -c com.oculus.intent.category.VR -n edu.ua.virtualmakerspace/com.unity3d.player.UnityPlayerGameActivity > "%DIAG%" 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: The APK installed, but Quest rejected the immersive VR launch.
  echo Copy this entire window or take a photo and send it to the instructor.
  pause
  exit /b 40
)

ping 127.0.0.1 -n 6 >nul
>> "%DIAG%" echo.
>> "%DIAG%" echo ===== INSTALLED PACKAGE =====
"%ADB%" -s %DEVICE% shell dumpsys package edu.ua.virtualmakerspace | findstr /I /C:"versionName=" /C:"versionCode=" /C:"com.oculus.intent.category.VR" >> "%DIAG%" 2>&1
>> "%DIAG%" echo.
>> "%DIAG%" echo ===== UNITY / OPENXR STARTUP LOG =====
"%ADB%" -s %DEVICE% logcat -d -t 1200 | findstr /I /C:"Unity" /C:"OpenXR" /C:"XR_SESSION" /C:"VirtualMakerspace" >> "%DIAG%" 2>&1
set "APP_PID="
for /f "delims=" %%P in ('"%ADB%" -s %DEVICE% shell pidof edu.ua.virtualmakerspace') do set "APP_PID=%%P"
if not defined APP_PID (
  echo.
  echo ERROR: The VR app stopped during startup.
  echo Send VirtualMakerspace_Device_Diagnostics.txt to the instructor.
  pause
  exit /b 41
)

echo.
echo SUCCESS: Put on the headset. Virtual Makerspace is starting directly in VR.
echo Allow microphone access when requested.
echo If anything is wrong, send VirtualMakerspace_Device_Diagnostics.txt.
echo.
pause

