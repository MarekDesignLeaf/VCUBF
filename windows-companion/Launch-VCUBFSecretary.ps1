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
$localProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
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

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $connection = $client.BeginConnect($HostName, $Port, $null, $null)
    if(!$connection.AsyncWaitHandle.WaitOne(1200)) { return $false }
    $client.EndConnect($connection)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-HttpEndpoint([string]$Url, [string]$Name, [int]$Seconds = 45) {
  $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) { return }
    } catch {}
    Start-Sleep -Milliseconds 500
  } while([datetime]::UtcNow -lt $deadline)
  throw "$Name se nepodařilo spustit. Podrobnosti jsou v $appDir."
}

function Start-LocalPostgres {
  if(Test-TcpPort 'localhost' 5432) { return }
  $pgCtl = Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles 'PostgreSQL') -Filter 'pg_ctl.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if(!$pgCtl) { throw 'Lokální PostgreSQL nebyl nalezen.' }
  $dataDir = Join-Path (Split-Path -Parent (Split-Path -Parent $pgCtl.FullName)) 'data'
  $logPath = Join-Path $appDir 'postgresql.log'
  & $pgCtl.FullName start -D $dataDir -l $logPath -w *> $null
  if($LASTEXITCODE -ne 0 -or !(Test-TcpPort 'localhost' 5432)) {
    throw "Lokální PostgreSQL se nepodařilo spustit. Podrobnosti jsou v $logPath."
  }
}

function Resolve-LocalNode {
  $config = Get-Config
  $candidates = @(
    [string]$config.LocalNodePath,
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
    [string](Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  foreach($candidate in $candidates) {
    try {
      $architecture = (& $candidate -p 'process.arch' 2>$null).Trim()
      if($architecture -eq 'x64') { return $candidate }
    } catch {}
  }
  throw 'Pro lokální backend nebyl nalezen x64 Node.js kompatibilní s databázovým ovladačem Prisma.'
}

function Start-LocalNodeProcess([string]$Name, [string]$WorkingDirectory, [string[]]$Arguments, [bool]$RequireX64 = $false) {
  if($RequireX64) {
    $node = Resolve-LocalNode
  } else {
    $node = [string](Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
    if(!$node) { throw 'Node.js nebyl nalezen.' }
  }
  $stdout = Join-Path $appDir "$Name-local.log"
  $stderr = Join-Path $appDir "$Name-local-error.log"
  Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $localProcesses.Add($process)
}

function Stop-ProcessTree([int]$RootProcessId) {
  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $RootProcessId })
  foreach($child in $children) { Stop-ProcessTree ([int]$child.ProcessId) }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Start-LocalRuntime([string]$ProjectRoot) {
  if(!(Test-Path -LiteralPath (Join-Path $ProjectRoot 'backend\package.json')) -or !(Test-Path -LiteralPath (Join-Path $ProjectRoot 'frontend\package.json'))) {
    throw "Lokální zdrojový projekt VCUBF nebyl nalezen v $ProjectRoot."
  }
  # Desktop shortcuts inherit the environment of Explorer, which can be older
  # than a newly saved user secret. Reload the local language-service key on
  # every launch without putting it in the repository or config JSON.
  $openAiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')
  if($openAiKey) { $env:OPENAI_API_KEY = $openAiKey }
  Start-LocalPostgres
  if(!(Test-TcpPort 'localhost' 4000)) {
    $env:PRISMA_CLIENT_ENGINE_TYPE = 'library'
    Start-LocalNodeProcess 'backend' (Join-Path $ProjectRoot 'backend') @('node_modules\tsx\dist\cli.mjs','watch','src/server.ts') $true
  }
  Wait-HttpEndpoint 'http://localhost:4000/health' 'Lokální backend'
  if(!(Test-TcpPort 'localhost' 5173)) {
    Start-LocalNodeProcess 'frontend' (Join-Path $ProjectRoot 'frontend') @('node_modules\vite\bin\vite.js','--host','localhost')
  }
  Wait-HttpEndpoint 'http://localhost:5173/' 'Lokální frontend'
}

function Stop-LocalRuntime {
  foreach($process in @($localProcesses)) {
    if($process -and !$process.HasExited) { Stop-ProcessTree $process.Id }
  }
  $localProcesses.Clear()
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
  $localMode = $config.LocalMode -eq $true
  if($localMode) {
    $projectRoot = [string]$config.LocalProjectRoot
    Start-LocalRuntime $projectRoot
    $server = 'http://localhost:4000'
    $frontend = 'http://localhost:5173'
  } else {
    $server = if($config.ServerUrl) { ([string]$config.ServerUrl).TrimEnd('/') } else { 'https://backend-production-7952.up.railway.app' }
    $frontend = if($config.FrontendUrl) { ([string]$config.FrontendUrl).TrimEnd('/') } else { 'https://frontend-production-ee13.up.railway.app' }
  }
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
  Stop-LocalRuntime
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
