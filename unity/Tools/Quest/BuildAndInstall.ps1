$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$unity = 'C:\Program Files\Unity\Hub\Editor\6000.4.9f1\Editor\Unity.exe'
$sdk = 'C:\Users\jewoo\AppData\Local\Android\Sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$apk = Join-Path $projectRoot 'Builds\Quest\VirtualMakerspace.apk'
$log = Join-Path $projectRoot 'Artifacts\QuestBuild.log'
$packageName = 'edu.ua.virtualmakerspace'
$buildStamp = Join-Path $projectRoot 'Builds\Quest\.buildstamp'

function Stop-WithMessage([string]$message, [int]$code) {
    Write-Host "`n$message" -ForegroundColor Red
    exit $code
}

function Get-QuestState {
    $lines = & $adb devices 2>$null
    foreach ($line in $lines) {
        if ($line -match '^(\S+)\s+(device|unauthorized|offline)$') {
            return @{ Serial = $Matches[1]; State = $Matches[2] }
        }
    }
    return $null
}

Write-Host 'Virtual Makerspace: Quest one-click build and install' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $unity)) { Stop-WithMessage 'Unity 6000.4.9f1 was not found.' 10 }
if (-not (Test-Path -LiteralPath $adb)) { Stop-WithMessage 'Android ADB was not found.' 11 }

New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot'

$needsBuild = -not (Test-Path -LiteralPath $apk) -or -not (Test-Path -LiteralPath $buildStamp)
if (-not $needsBuild) {
    $apkTime = (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc
    $newerInput = Get-ChildItem -Path @(
        (Join-Path $projectRoot 'Assets'),
        (Join-Path $projectRoot 'Packages'),
        (Join-Path $projectRoot 'ProjectSettings')
    ) -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $apkTime } | Select-Object -First 1
    $needsBuild = $null -ne $newerInput
}

if ($needsBuild) {
    Write-Host '[1/3] Project changed. Building the Quest APK...'
    $unityArguments = "-batchmode -quit -projectPath `"$projectRoot`" -executeMethod VirtualMakerspace.Editor.QuestBuildPipeline.BuildQuestApk -logFile `"$log`""
    $build = Start-Process -FilePath $unity -ArgumentList $unityArguments -WindowStyle Hidden -Wait -PassThru
    if ($build.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $apk)) {
        Get-Content -LiteralPath $log -Tail 60
        Stop-WithMessage "Quest APK build failed. Log: $log" 20
    }
    [System.IO.File]::WriteAllText($buildStamp, (Get-Date).ToUniversalTime().ToString("O"))

} else {
    Write-Host '[1/3] APK is current. Skipping rebuild for a fast install.' -ForegroundColor Green
}

Write-Host '[2/3] Waiting for Quest USB connection and authorization...'
& $adb start-server | Out-Null
$deadline = (Get-Date).AddMinutes(3)
$quest = $null
do {
    $quest = Get-QuestState
    if ($quest -and $quest.State -eq 'unauthorized') {
        Write-Host 'Put on the headset and choose: Always allow from this computer > Allow.' -ForegroundColor Yellow
    } elseif (-not $quest) {
        Write-Host 'Connect Quest by USB. Developer Mode and USB debugging must be enabled.' -ForegroundColor Yellow
    }
    if (-not $quest -or $quest.State -ne 'device') { Start-Sleep -Seconds 3 }
} while ((!$quest -or $quest.State -ne 'device') -and (Get-Date) -lt $deadline)

if (-not $quest -or $quest.State -ne 'device') {
    Stop-WithMessage 'Quest was not authorized within 3 minutes. Reconnect USB and approve debugging in the headset.' 30
}

Write-Host "[3/3] Installing and launching on Quest ($($quest.Serial))..."
& $adb -s $quest.Serial shell am force-stop $packageName | Out-Null
& $adb -s $quest.Serial uninstall $packageName | Out-Null
& $adb -s $quest.Serial install $apk
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'APK installation failed.' 40 }
$packageDump = (& $adb -s $quest.Serial shell dumpsys package $packageName 2>&1) -join "`n"
if ($packageDump -notmatch 'com\.oculus\.intent\.category\.VR') {
    Stop-WithMessage 'Installed APK is missing the Quest VR launch category.' 41
}
if ($packageDump -notmatch 'versionName=1\.0\.7') {
    Stop-WithMessage 'The installed APK is not version 1.0.7.' 42
}
& $adb -s $quest.Serial shell am start -S -a android.intent.action.MAIN -c com.oculus.intent.category.VR -n "$packageName/com.unity3d.player.UnityPlayerGameActivity" | Out-Host
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'The app installed but could not be launched in immersive VR.' 43 }

Write-Host "`nReady: Virtual Makerspace is running in the headset." -ForegroundColor Green
Write-Host "APK: $apk"
