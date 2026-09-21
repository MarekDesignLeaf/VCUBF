<#
.SYNOPSIS
  Restart the Voice v2 companion without leaving a dead tray icon behind.

.DESCRIPTION
  Run-VoiceV2.ps1 owns the tray icon and removes it in its finally block. It
  also watches the Python listener once a second and ends itself as soon as that
  listener exits. So the whole thing is stopped by stopping the listener: the
  wrapper then notices, disposes its icon and exits on its own.

  Killing the wrapper instead skips that finally block, and Windows leaves the
  icon in the notification area with nothing behind it — which looks exactly
  like the assistant running twice. It is not running twice; the single-instance
  mutex in the runtime makes that impossible. It is one live icon and one
  corpse, and the corpse only disappears when the mouse passes over it.

  This script exists so the restart is one command with one behaviour, rather
  than being improvised differently each time.
#>
[CmdletBinding()]
param(
  [switch]$StopOnly
)

$ErrorActionPreference = 'Stop'
$app = Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app'
$wrapper = Join-Path $app 'Run-VoiceV2.ps1'
$stopFile = Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\voice-v2.stop'

function Voice-Processes {
  @(Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='pythonw.exe'" |
      Where-Object { $_.CommandLine -like '*emma_voice_v2.py*' })
}

function Tray-Wrappers {
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -like '*Run-VoiceV2.ps1*' -and $_.ProcessId -ne $PID })
}

$listeners = Voice-Processes
if ($listeners.Count -gt 0) {
  Write-Host "Stopping $($listeners.Count) listener(s) the way the wrapper expects..."
  # The stop file is the runtime's own shutdown signal; companion_is_running()
  # checks it every loop, so the listener finishes its current turn and exits.
  Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(15)
  while ((Voice-Processes).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }

  $stubborn = Voice-Processes
  if ($stubborn.Count -gt 0) {
    Write-Warning "Listener did not stop on the stop file; ending it."
    $stubborn | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  # The wrapper polls the listener once a second, then disposes its icon. Give
  # it time to do that itself rather than killing it, which is what strands the
  # icon in the notification area.
  $deadline = (Get-Date).AddSeconds(10)
  while ((Tray-Wrappers).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }

  $leftover = Tray-Wrappers
  if ($leftover.Count -gt 0) {
    Write-Warning "A tray wrapper is still up after its listener ended; ending it. Its icon may linger until the mouse passes over it."
    $leftover | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

if ($StopOnly) {
  Write-Host "Stopped. Listeners: $((Voice-Processes).Count), tray wrappers: $((Tray-Wrappers).Count)."
  return
}

Write-Host "Starting $wrapper ..."
Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-File', $wrapper -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(45)
while ((Voice-Processes).Count -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

$running = Voice-Processes
$wrappers = Tray-Wrappers
Write-Host "Listeners: $($running.Count) (expected 1). Tray wrappers: $($wrappers.Count) (expected 1)."
if ($running.Count -ne 1 -or $wrappers.Count -ne 1) {
  Write-Warning "That is not one of each. Run with -StopOnly and start again rather than adding another."
  exit 1
}
Write-Host "One listener, one tray icon."
