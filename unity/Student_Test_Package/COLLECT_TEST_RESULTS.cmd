@echo off
setlocal
cd /d "%~dp0"
title Virtual Makerspace Acceptance Collector

set "ADB=%~dp0platform-tools\adb.exe"
set "REPORT=%~dp0VirtualMakerspace_Acceptance_Report.txt"
set "PACKAGE=edu.ua.virtualmakerspace"

if not exist "%ADB%" (
  echo ERROR: Bundled ADB was not found.
  pause
  exit /b 10
)

set "DEVICE="
for /f "tokens=1,2" %%A in ('"%ADB%" devices') do (
  if "%%B"=="device" set "DEVICE=%%A"
)
if not defined DEVICE (
  echo ERROR: Connect and authorize one Quest, then run this file again.
  pause
  exit /b 20
)

echo Keep Virtual Makerspace open in the headset.
echo Complete CREATE/JOIN, confirm voice, and grab and place one part.
echo Then return here and press any key.
pause

> "%REPORT%" echo VIRTUAL MAKERSPACE PHYSICAL QUEST ACCEPTANCE REPORT
>> "%REPORT%" echo Device: %DEVICE%
>> "%REPORT%" echo Collected: %DATE% %TIME%
>> "%REPORT%" echo.
>> "%REPORT%" echo ===== PACKAGE =====
"%ADB%" -s %DEVICE% shell dumpsys package %PACKAGE% | findstr /I /C:"versionName=" /C:"versionCode=" /C:"com.oculus.intent.category.VR" >> "%REPORT%" 2>&1
>> "%REPORT%" echo.
>> "%REPORT%" echo ===== PROCESS AND FOREGROUND ACTIVITY =====
"%ADB%" -s %DEVICE% shell pidof %PACKAGE% >> "%REPORT%" 2>&1
"%ADB%" -s %DEVICE% shell dumpsys activity activities | findstr /I /C:"mResumedActivity" /C:"topResumedActivity" /C:"%PACKAGE%" >> "%REPORT%" 2>&1
>> "%REPORT%" echo.
>> "%REPORT%" echo ===== OPENXR / SESSION / VOICE / INTERACTION =====
"%ADB%" -s %DEVICE% logcat -d -t 8000 | findstr /I /C:"VM_ACCEPTANCE" /C:"XR_SESSION_STATE_FOCUSED" /C:"HasFocus = 1" /C:"OpenXR" /C:"Vivox" /C:"CONNECTION FAILED" /C:"Exception" >> "%REPORT%" 2>&1

findstr /C:"XR_SESSION_STATE_FOCUSED" "%REPORT%" >nul
if errorlevel 1 findstr /C:"HasFocus = 1" "%REPORT%" >nul
if errorlevel 1 (
  >> "%REPORT%" echo.
  >> "%REPORT%" echo RESULT: INCOMPLETE - immersive OpenXR focus was not captured.
  echo INCOMPLETE: The report did not capture immersive OpenXR focus.
) else (
  findstr /C:"VM_ACCEPTANCE ACTIVITY_UNLOCKED" "%REPORT%" >nul
  if errorlevel 1 (
    >> "%REPORT%" echo.
    >> "%REPORT%" echo RESULT: INCOMPLETE - no 2/2 activity-unlocked marker was captured.
    echo INCOMPLETE: Immersive VR passed, but the 2/2 room did not.
  ) else (
    findstr /C:"VM_ACCEPTANCE VOICE_CONNECTED" "%REPORT%" >nul
    if errorlevel 1 (
      >> "%REPORT%" echo.
      >> "%REPORT%" echo RESULT: INCOMPLETE - room passed but voice marker is missing.
      echo INCOMPLETE: VR and room passed, but voice evidence is missing.
    ) else (
      findstr /C:"VM_ACCEPTANCE PART_GRABBED" "%REPORT%" >nul
      if errorlevel 1 (
        >> "%REPORT%" echo.
        >> "%REPORT%" echo RESULT: INCOMPLETE - room and voice passed but no part grab was captured.
        echo INCOMPLETE: VR, room, and voice passed, but interaction evidence is missing.
      ) else (
        >> "%REPORT%" echo.
        >> "%REPORT%" echo RESULT: PASS - immersive VR, 2/2 room, Vivox, and part interaction markers captured.
        echo PASS: Immersive VR, room, voice, and interaction evidence were captured.
      )
    )
  )
)

echo Send VirtualMakerspace_Acceptance_Report.txt to the instructor.
pause
