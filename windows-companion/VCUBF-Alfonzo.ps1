param(
  [switch]$Diagnostic,
  [string]$CommandTest,
  [switch]$DesktopLaunch,
  [switch]$Announce,
  [switch]$ShowMonitor
)

$ErrorActionPreference = 'Stop'

# Canonical Alfonzo launcher.
#
# The original runtime file is still named VCUBF-Emma.ps1 for migration
# compatibility with already installed Windows shortcuts and scheduled startup
# entries. New scripts, docs and human-facing instructions must call this file.
# Remove the legacy file only after installed clients have been migrated.

$legacyRuntime = Join-Path $PSScriptRoot 'VCUBF-Emma.ps1'
if (!(Test-Path -LiteralPath $legacyRuntime)) {
  throw "Legacy runtime file not found: $legacyRuntime"
}

& $legacyRuntime @PSBoundParameters
exit $LASTEXITCODE
