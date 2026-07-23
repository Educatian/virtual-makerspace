$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$player = Join-Path $projectRoot 'Builds\Acceptance\VirtualMakerspaceAcceptance.exe'
if (-not (Test-Path -LiteralPath $player)) {
    throw "Acceptance player not found: $player"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $projectRoot "Artifacts\TwoProcessAcceptance\$stamp"
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)

$env:VM_ACCEPTANCE_DIR = $runDirectory
$env:VM_AUTH_PROFILE = "accept-host-$suffix"
$hostLog = Join-Path $runDirectory 'host-player.log'
$hostArguments = "-batchmode -vmAcceptanceRole host -logFile `"$hostLog`""
$hostProcess = Start-Process -FilePath $player -ArgumentList $hostArguments -WindowStyle Hidden -PassThru

$env:VM_AUTH_PROFILE = "accept-guest-$suffix"
$guestLog = Join-Path $runDirectory 'guest-player.log'
$guestArguments = "-batchmode -vmAcceptanceRole guest -logFile `"$guestLog`""
$guestProcess = Start-Process -FilePath $player -ArgumentList $guestArguments -WindowStyle Hidden -PassThru

Remove-Item Env:VM_AUTH_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:VM_ACCEPTANCE_DIR -ErrorAction SilentlyContinue

$deadline = (Get-Date).AddMinutes(3)
while ((!$hostProcess.HasExited -or !$guestProcess.HasExited) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $hostProcess.Refresh()
    $guestProcess.Refresh()
}

if (!$hostProcess.HasExited) { Stop-Process -Id $hostProcess.Id -Force }
if (!$guestProcess.HasExited) { Stop-Process -Id $guestProcess.Id -Force }

$hostResultPath = Join-Path $runDirectory 'host-result.json'
$guestResultPath = Join-Path $runDirectory 'guest-result.json'
if (-not (Test-Path $hostResultPath) -or -not (Test-Path $guestResultPath)) {
    throw "Acceptance result missing. Inspect $runDirectory"
}

$hostResult = Get-Content -Raw $hostResultPath | ConvertFrom-Json
$guestResult = Get-Content -Raw $guestResultPath | ConvertFrom-Json
if (-not $hostResult.passed -or -not $guestResult.passed -or $hostResult.roomCode -ne $guestResult.roomCode) {
    throw "Two-process acceptance failed. Inspect $runDirectory"
}

Write-Host "TWO_PROCESS_ACCEPTANCE_PASS room=$($hostResult.roomCode)" -ForegroundColor Green
Write-Host "Evidence: $runDirectory"
