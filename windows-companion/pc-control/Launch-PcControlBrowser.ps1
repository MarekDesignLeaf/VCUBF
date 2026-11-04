<#
.SYNOPSIS
  Starts Edge (or Chrome) with a dedicated profile that the pc-control plugin
  can attach to over the Chrome DevTools Protocol.

.DESCRIPTION
  Sign in to the sites you want the assistant to use once in this window; the
  profile keeps the sessions. The plugin (browser.mode: auto) attaches to this
  browser when it is running and otherwise starts its own window with the same
  kind of dedicated profile.

  The debugging port listens on 127.0.0.1 only. While it is open, programs on
  this PC can control this browser profile, so keep only the sites you want the
  assistant to use signed in here, and close the window when you are done.
  Current Chrome and Edge versions refuse remote debugging on the everyday
  default profile, which is why a separate profile is used.
#>
[CmdletBinding()]
param(
    [ValidateSet("Edge", "Chrome")]
    [string]$Browser = "Edge",
    [ValidateRange(1024, 65535)]
    [int]$Port = 9222,
    [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA "VCUBF\Alfonzo\pc-control\browser-cdp-profile")
)

$ErrorActionPreference = "Stop"

$candidates = if ($Browser -eq "Edge") {
    @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
    )
} else {
    @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
}
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw "$Browser was not found in the usual installation folders." }

try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    Write-Host "A browser already answers on port ${Port}: $($existing.Browser)"
    return
} catch {
    # Nothing listens yet: start it.
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check"
)
Start-Process -FilePath $exe -ArgumentList $arguments | Out-Null

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
        Write-Host "$($version.Browser) is ready for pc-control on 127.0.0.1:$Port (profile $ProfileDir)."
        return
    } catch {
    }
}
throw "$Browser started but port $Port did not answer. Close other windows of this profile and try again."
