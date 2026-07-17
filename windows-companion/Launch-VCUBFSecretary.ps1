param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class VcubfWindowApi {
  private delegate bool EnumWindowsDelegate(IntPtr handle, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsDelegate callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr handle);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr handle);

  public static IntPtr[] TopLevelWindows() {
    var result = new List<IntPtr>();
    EnumWindows((handle, parameter) => {
      if (IsWindowVisible(handle)) result.Add(handle);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static bool WindowExists(long handle) {
    return IsWindow(new IntPtr(handle));
  }
}
'@

$app = Split-Path -Parent $PSCommandPath
$appDir = Split-Path -Parent $app
$configPath = Join-Path $appDir 'config.json'
$tokenPath = Join-Path $appDir 'token.bin'
$stopFile = Join-Path $appDir 'voice-v2.stop'
$v2Runtime = Join-Path $app 'emma_voice_v2.py'
$v2Runner = Join-Path $app 'Run-VoiceV2.ps1'
$legacyScripts = @(
  (Join-Path $app 'VCUBF-Emma.ps1'),
  (Join-Path $app 'emma_realtime.py'),
  (Join-Path $app 'Open-VCUBF.ps1')
)
$mutex = New-Object System.Threading.Mutex($false, 'Local\VCUBFSecretaryUnifiedLauncher')

if(!$mutex.WaitOne(0, $false)) { exit 0 }

function Get-Config {
  if(!(Test-Path -LiteralPath $configPath)) { return [pscustomobject]@{} }
  try { return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { return [pscustomobject]@{} }
}

function Save-PairedProfile($Result, [string]$Server) {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Result.token)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($tokenPath, $protected)
  $config = Get-Config
  foreach($pair in @(
    @('Email', [string]$Result.user.email),
    @('WakeWord', [string]$Result.user.voiceWakeWord),
    @('Language', [string]$Result.user.voiceLanguage)
  )) {
    if(!$pair[1]) { continue }
    if($config.PSObject.Properties.Name -contains $pair[0]) { $config.($pair[0]) = $pair[1] }
    else { $config | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] }
  }
  if(!($config.PSObject.Properties.Name -contains 'ServerUrl')) {
    $config | Add-Member -NotePropertyName ServerUrl -NotePropertyValue $Server
  }
  $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}

function Get-ExistingDeviceProfile([string]$Server) {
  if(!(Test-Path -LiteralPath $tokenPath)) { return $null }
  try {
    $protected = [IO.File]::ReadAllBytes($tokenPath)
    $token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
    return Invoke-RestMethod -Method GET -Uri "$Server/auth/me" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15
  } catch {
    if($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
      Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
    }
    return $null
  }
}

function Stop-LegacyEmma {
  Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if(!$commandLine) { return $false }
    return @($legacyScripts | Where-Object {
      $commandLine.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0
    }).Count -gt 0
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-VoiceV2 {
  Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII
  Start-Sleep -Milliseconds 500
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
      $_.CommandLine.IndexOf($v2Runner,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ($_.CommandLine.IndexOf($v2Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -like '*--run*')
    )
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-VoiceV2 {
  if(!(Test-Path -LiteralPath $v2Runner) -or !(Test-Path -LiteralPath $v2Runtime)) {
    throw 'Emma Voice v2 is not installed. Run Install-VoiceV2.ps1 again.'
  }
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$v2Runner`"",
    '-OwnerProcessId', $PID, '-StopFile', "`"$stopFile`""
  ) -WorkingDirectory $app -WindowStyle Hidden | Out-Null
}

function Find-AppBrowser {
  $chrome = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  $edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  $defaultBrowser = ''
  try { $defaultBrowser = [string](Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice').ProgId } catch {}
  $candidates = if($defaultBrowser -like '*Chrome*') { @($chrome + $edge) } elseif($defaultBrowser -like '*Edge*') { @($edge + $chrome) } else { @($chrome + $edge) }
  $candidates = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return $candidates | Select-Object -First 1
}

function Get-SecretaryUrl([string]$BaseUrl, [string]$Email) {
  $separator = if($BaseUrl.Contains('?')) { '&' } else { '?' }
  $url = "$BaseUrl$separator" + "desktop=1&launch=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  if($Email) { $url += '&email=' + [uri]::EscapeDataString($Email) }
  return $url
}

function Get-BrowserWindowHandles([string]$BrowserPath) {
  $browserName = [IO.Path]::GetFileNameWithoutExtension($BrowserPath)
  foreach($handle in [VcubfWindowApi]::TopLevelWindows()) {
    [uint32]$windowProcessId = 0
    [void][VcubfWindowApi]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
    try {
      if((Get-Process -Id $windowProcessId -ErrorAction Stop).ProcessName -ieq $browserName) {
        $handle.ToInt64()
      }
    } catch {}
  }
}

function Open-SecretaryWindow([string]$BrowserPath, [string]$Url) {
  $before = @(Get-BrowserWindowHandles $BrowserPath)
  Start-Process -FilePath $BrowserPath -ArgumentList @("--app=$Url", '--no-first-run') | Out-Null
  $deadline = [datetime]::UtcNow.AddSeconds(20)
  do {
    $created = @(Get-BrowserWindowHandles $BrowserPath | Where-Object { $before -notcontains $_ })
    if($created.Count -gt 0) { return [int64]$created[0] }
    Start-Sleep -Milliseconds 200
  } while([datetime]::UtcNow -lt $deadline)
  throw 'Secretary browser window did not open.'
}

try {
  if(!(Test-Path -LiteralPath $app)) { throw 'VCUBF Secretary is not installed. Run Install-VoiceV2.ps1 again.' }
  Stop-LegacyEmma
  Stop-VoiceV2

  $config = Get-Config
  $server = if($config.ServerUrl) { ([string]$config.ServerUrl).TrimEnd('/') } else { 'https://backend-production-7952.up.railway.app' }
  $frontend = if($config.FrontendUrl) { ([string]$config.FrontendUrl).TrimEnd('/') } else { 'https://frontend-production-ee13.up.railway.app' }
  $profile = Get-ExistingDeviceProfile $server
  $pairing = $null
  if(!$profile) {
    try { $pairing = Invoke-RestMethod -Method POST -Uri "$server/auth/device/start" -ContentType 'application/json' -Body '{}' -TimeoutSec 15 } catch {}
  }
  $browserUrl = if($pairing -and $pairing.verification_url) { [string]$pairing.verification_url } else { Get-SecretaryUrl "$frontend/login" ([string]$config.Email) }
  $browser = Find-AppBrowser
  if(!$browser) { throw 'Microsoft Edge or Google Chrome is required to open VCUBF Secretary.' }
  # Use the person's normal browser profile. That preserves the browser's
  # encrypted password manager and its built-in autofill; no password is read,
  # copied or stored by VCUBF. The newly created app window itself is tracked.
  $secretaryWindow = Open-SecretaryWindow $browser $browserUrl

  if($profile) { Start-VoiceV2 }
  $pairingDeadline = if($pairing) { [datetime]::UtcNow.AddMinutes(10) } else { [datetime]::MinValue }
  while([VcubfWindowApi]::WindowExists($secretaryWindow)) {

    if($pairing -and !$profile -and [datetime]::UtcNow -lt $pairingDeadline) {
      try {
        $result = Invoke-RestMethod -Method POST -Uri "$server/auth/device/token" -ContentType 'application/json' -Body (@{ pairing_id = $pairing.pairing_id; secret = $pairing.secret } | ConvertTo-Json) -TimeoutSec 15
        if($result.token) {
          Save-PairedProfile $result $server
          $profile = $result.user
          Start-VoiceV2
        }
      } catch {}
    }
    Start-Sleep -Seconds 1
  }
} catch {
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'VCUBF Secretary', 'OK', 'Error') | Out-Null
} finally {
  Stop-VoiceV2
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
