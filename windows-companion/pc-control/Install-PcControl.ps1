<#
.SYNOPSIS
  Installs the Python packages of the pc-control plugin (browser control,
  Windows UI Automation, MCP server) for the current user.

.DESCRIPTION
  Edge is driven through its own installation (browser.channel: msedge), so no
  browser download is needed. Use -InstallChromium only if config.yaml sets
  browser.channel: chromium.
#>
[CmdletBinding()]
param(
    [switch]$InstallChromium
)

$ErrorActionPreference = "Stop"
$serverDir = Join-Path $PSScriptRoot "server"
$requirements = Join-Path $serverDir "requirements.txt"

function Get-PythonCommand {
    foreach ($candidate in @(@("py", "-3.13"), @("py", "-3"), @("python"))) {
        $exe = $candidate[0]
        if (Get-Command $exe -ErrorAction SilentlyContinue) {
            $extra = @()
            if ($candidate.Count -gt 1) { $extra = $candidate[1..($candidate.Count - 1)] }
            & $exe @extra -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return , $candidate }
        }
    }
    throw "Python 3.10 or newer was not found. Install Python 3.13 from python.org and run this script again."
}

$python = Get-PythonCommand
$exe = $python[0]
$pyArgs = @()
if ($python.Count -gt 1) { $pyArgs = $python[1..($python.Count - 1)] }

Write-Host "Installing pc-control packages with $($python -join ' ')..."
& $exe @pyArgs -m pip install --upgrade --user -r $requirements
if ($LASTEXITCODE -ne 0) { throw "pip install failed." }

if ($InstallChromium) {
    Write-Host "Downloading Playwright Chromium..."
    & $exe @pyArgs -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install chromium failed." }
}

& $exe @pyArgs -c "import fastmcp, playwright, uiautomation, yaml, psutil; print('pc-control packages OK')"
if ($LASTEXITCODE -ne 0) { throw "A package did not import; see the error above." }

Write-Host ""
Write-Host "Done. Restart Claude so it starts the pc-control server again."
Write-Host "Optional: run Launch-PcControlBrowser.ps1 to let the plugin work in a visible Edge window you sign in to once."
