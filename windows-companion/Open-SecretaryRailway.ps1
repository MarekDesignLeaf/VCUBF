# Opens the live Secretary on Railway, signed in without a password.
# device.key is the DPAPI-protected secret for this Windows user (approved 26 Sep 2026);
# the server stores only its hash. Nothing else on this PC is changed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security, System.Windows.Forms
$server = 'https://backend-production-7952.up.railway.app'
$frontend = 'https://frontend-production-ee13.up.railway.app'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
try {
  $key = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes("$dir\device.key"), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
  $session = Invoke-RestMethod -Method POST -Uri "$server/auth/device/key" -ContentType 'application/json' -Body (@{ key = $key } | ConvertTo-Json) -TimeoutSec 20
  $bootstrap = Invoke-RestMethod -Method POST -Uri "$server/auth/desktop-bootstrap" -Headers @{ Authorization = "Bearer $($session.token)" } -ContentType 'application/json' -Body '{}' -TimeoutSec 20
  $url = "$frontend/login?launch=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())#desktop_token=$([uri]::EscapeDataString([string]$bootstrap.bootstrap_token))"
  $browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--no-first-run', "--user-data-dir=$dir\profile")
} catch {
  [Windows.Forms.MessageBox]::Show("Secretary se nepodařilo otevřít: $($_.Exception.Message)", 'Secretary (Railway)', 'OK', 'Error') | Out-Null
}